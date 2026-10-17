// Per-deployment module enablement on a real PostgreSQL 17 (plan Decision 12, ADR-0031): a kernel booted with
// CROVE_MODULES=kernel registers no finance command, query, job or route, a lookup into finance answers
// not_installed, and the kernel's own flows still work. Migrations still apply to every schema. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { ORG_HEADER } from '@crove/kernel-contract';
import { createOrg, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, defineQuery, sha256Hex, type BlobStore, type Lookup } from '@crove/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createKernel, defaultAdapters, moduleDefinitions, type IdentityPort } from '../src/kernel.ts';
import { QUEUES, migrateJobs } from '../src/worker.ts';
import { startExtractService } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SESSION = '3a1f0c7e-6b2d-4e8a-9c51-2d7f4b8e0a13';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// A lookup from one module into another, run from a query and from a command.
const probeQuery = defineQuery({
  name: 'probe.lookup',
  input: z.object({ name: z.string() }),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: (ctx, input) => ctx.query<unknown[]>(input.name, {}),
});
const probeCommand = defineCommand({
  name: 'probe.lookup_in_command',
  input: z.object({ name: z.string() }),
  risk: 'R1',
  access: ['owner', 'admin', 'member'],
  handler: (ctx, input) => ctx.query<unknown[]>(input.name, {}),
});

const suite = ADMIN ? describe : describe.skip;

suite('module enablement on PostgreSQL (plan Decision 12, ADR-0031)', () => {
  const dbName = `crove_test_modules_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let pool: pg.Pool;
  let db: Db;
  let stopExtract: (() => Promise<void>) | undefined;
  let extractUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let owner = '';
  let orgId = '';
  let slug = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const configFor = (modules: string | undefined, port = 8080) =>
    loadConfig({
      DATABASE_URL: appUrl,
      WORKER_DATABASE_URL: workerUrl,
      EXTRACT_URL: extractUrl,
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-module-enablement',
      AUTH_ISSUER: 'test-auth',
      WEB_DIST: '/nonexistent',
      HOST: '127.0.0.1',
      PORT: String(port),
      ...(modules === undefined ? {} : { CROVE_MODULES: modules }),
    });

  async function adminQuery<R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return (await client.query<R>(text, values)).rows;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    const url = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    await migrateJobs(adminUrl);
    const loginUrl = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    const service = await startExtractService();
    stopExtract = service.stop;
    extractUrl = service.url;
    pool = createPool({ connectionString: appUrl, max: 2 });
    db = createDb(pool);
    // The kernel alone creates the org: kernel flows need no other module.
    const kernelOnly = new Runtime(db).register(moduleDefinitions(configFor('kernel')));
    owner = await upsertIdentity(db, { issuer: 'test', subject: 'modules-owner', email: 'modules-owner@example.com', name: null });
    ({ orgId, slug } = await createOrg(kernelOnly, asUser(owner), 'Org Modules'));
  });

  afterAll(async () => {
    await stopExtract?.();
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('applies migrations to every schema, whatever CROVE_MODULES says', async () => {
    const schemas = await adminQuery<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname IN ('crove_kernel', 'crove_finance')");
    expect(schemas.map((s) => s.nspname).sort()).toEqual(['crove_finance', 'crove_kernel']);
  });

  it('registers only the enabled modules', () => {
    const kernelOnly = moduleDefinitions(configFor('kernel'));
    const names = [...kernelOnly.commands, ...kernelOnly.queries].map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !name.startsWith('kernel.'))).toEqual([]);
    const all = moduleDefinitions(configFor(undefined));
    expect(all.commands.map((c) => c.name)).toContain('finance.purchase.record');
    expect(all.queries.map((q) => q.name)).toContain('finance.journal.list');
  });

  it('answers COMMAND_NOT_FOUND for a disabled module and not_installed for a lookup into it', async () => {
    // createKernel passes the modules CROVE_MODULES leaves out, so a lookup into them answers not_installed.
    const runtime = new Runtime(db, { absentModules: ['finance'] })
      .register(moduleDefinitions(configFor('kernel')))
      .register({ commands: [probeCommand], queries: [probeQuery] });
    const actor = asUser(owner);
    expect(runtime.installed('kernel')).toBe(true);
    expect(runtime.installed('finance')).toBe(false);
    expect(runtime.modules()).toEqual(['kernel', 'probe']);
    await expect(runtime.execute('finance.purchase.record', {}, { actor, orgId })).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND', status: 404 });
    await expect(runtime.query('finance.journal.list', {}, { actor, orgId })).rejects.toMatchObject({ code: 'QUERY_NOT_FOUND' });

    const fromQuery = await runtime.query<Lookup<unknown[]>>('probe.lookup', { name: 'finance.accounts.list' }, { actor, orgId });
    expect(fromQuery).toEqual({ status: 'not_installed', module: 'finance' });
    const fromCommand = await runtime.execute<Lookup<unknown[]>>('probe.lookup_in_command', { name: 'finance.accounts.list' }, { actor, orgId });
    expect(fromCommand).toEqual({ status: 'not_installed', module: 'finance' });
    // A query the installed kernel does not have is a caller bug, not a missing module.
    await expect(runtime.query('probe.lookup', { name: 'kernel.no_such_query' }, { actor, orgId })).rejects.toBeInstanceOf(DomainError);
    await expect(runtime.query('probe.lookup', { name: 'kernel.no_such_query' }, { actor, orgId })).rejects.toMatchObject({ code: 'QUERY_NOT_FOUND' });

    // With finance installed the same lookup runs the query in the caller's transaction.
    const full = new Runtime(db).register(moduleDefinitions(configFor(undefined))).register({ commands: [probeCommand], queries: [probeQuery] });
    const ok = await full.query<Lookup<unknown[]>>('probe.lookup', { name: 'finance.accounts.list' }, { actor, orgId });
    expect(ok.status).toBe('ok');
    expect(ok.status === 'ok' && Array.isArray(ok.value)).toBe(true);
  });

  it('boots with only kernel: no finance route or job, kernel flows still work', { timeout: 90_000 }, async () => {
    const port = await freePort();
    const config = configFor('kernel', port);
    const identity: IdentityPort = {
      sessions: { mode: 'off', liveCheckForR3: false, check: async () => {} },
      revoker: null,
      authenticator: () => async () => {
        const user: AuthUser = { userId: owner, email: 'modules-owner@example.com', name: null, aal: 'aal1', sessionId: SESSION, mfaAt: null };
        return user;
      },
    };
    const storage = new MemoryStore();
    const kernel = createKernel(config, { ...defaultAdapters(config), identity, ai: null, storage });
    expect(kernel.modules).toEqual(['kernel']);
    const stop = await kernel.start('all');
    try {
      const origin = `http://127.0.0.1:${port}`;
      const headers = { authorization: 'Bearer fake-token', [ORG_HEADER]: slug };
      const rpc = (path: string, input?: unknown) =>
        fetch(`${origin}/api/rpc/${path}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(input === undefined ? {} : { json: input }),
        });

      // The SPA learns which menus to show.
      expect(await (await fetch(`${origin}/api/config`)).json()).toMatchObject({ modules: ['kernel'] });

      // Finance routes are not registered.
      const exported = await fetch(`${origin}/api/export/journal.xlsx`, { headers });
      expect(exported.status).toBe(404);
      expect(await exported.json()).toEqual({ code: 'NOT_FOUND' });
      expect((await fetch(`${origin}/api/export/misa/purchases.xlsx`, { headers })).status).toBe(404);
      for (const path of ['journal/list', 'accounts/list', 'parties/list', 'documents/list']) {
        expect((await rpc(path, {})).status, path).toBe(404);
      }

      // Kernel flows: read the org, list the inbox, upload a file.
      const org = await rpc('org/get');
      expect(org.status).toBe(200);
      expect(((await org.json()) as { json: { slug: string } }).json.slug).toBe(slug);
      expect((await rpc('inbox/list', {})).status).toBe(200);
      const form = new FormData();
      form.append('file', new File([new Uint8Array([...PNG, ...randomBytes(64)])], 'hd.png', { type: 'image/png' }));
      const upload = await fetch(`${origin}/api/files`, { method: 'POST', headers, body: form });
      expect(upload.status).toBe(200);
      expect(storage.blobs.size).toBe(1);

      // The worker relays the upload's event but queues no finance job: the file is stored and stays unread.
      const deadline = Date.now() + 30_000;
      for (;;) {
        const [pending] = await adminQuery<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.outbox_pending');
        if (pending?.n === '0') break;
        if (Date.now() > deadline) throw new Error('the worker did not drain the outbox');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const [jobs] = await adminQuery<{ n: string }>('SELECT count(*)::text AS n FROM crove_jobs.job WHERE name = $1', [QUEUES.extract]);
      expect(jobs?.n).toBe('0');
      const runs = await adminQuery<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.extraction');
      expect(runs[0]?.n).toBe('0');
    } finally {
      await stop();
    }
  });
});
