// The composition root on a real PostgreSQL 17 (ADR-0030): a kernel built by createKernel with replaced identity,
// AI and storage adapters runs the api and worker roles, and every replaced port is the one the request and the
// job use. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvoiceReader } from '@crove/agent';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { ORG_HEADER } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, contentGeneration, sha256Hex, type BlobStore, type SessionStatusSource } from '@crove/kernel-runtime';
import type { ParsedInvoice } from '@crove/l10n-vn';
import { financeQueries } from '@crove/mod-finance';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createKernel, defaultAdapters, type IdentityPort } from '../src/kernel.ts';
import { startExtractService } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SESSION = '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c01';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return contentGeneration(sha256Hex(bytes));
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

const suite = ADMIN ? describe : describe.skip;

suite('composition root on PostgreSQL (ADR-0030)', () => {
  const dbName = `crove_test_kernel_root_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let pool: pg.Pool;
  let stopExtract: (() => Promise<void>) | undefined;
  let extractUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let owner = '';
  let orgId = '';
  let slug = '';
  let base: ParsedInvoice;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

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
    const loginUrl = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: [] });
    owner = await upsertIdentity(db, { issuer: 'test', subject: 'root-owner', email: 'root-owner@example.com', name: null });
    ({ orgId, slug } = await createOrg(runtime, asUser(owner), 'Org Root'));
    const service = await startExtractService();
    stopExtract = service.stop;
    extractUrl = service.url;
    const parsed = await service.client.extract('einvoice_xml', FIXTURE);
    if (!parsed.ok) throw new Error('fixture did not parse');
    base = parsed.invoice;
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

  it('runs api and worker with the adapters the entrypoint passed', { timeout: 90_000 }, async () => {
    const port = await freePort();
    const config = loadConfig({
      DATABASE_URL: appUrl,
      WORKER_DATABASE_URL: workerUrl,
      EXTRACT_URL: extractUrl,
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-kernel-root-0123',
      AUTH_ISSUER: 'test-auth',
      WEB_DIST: '/nonexistent',
      HOST: '127.0.0.1',
      PORT: String(port),
    });
    const defaults = defaultAdapters(config);
    // Identity: a fixed user for the one header this test sends. The session source records each check and refuses
    // a session listed in `revoked`, so the test sees that requests go through the port.
    const headers: string[] = [];
    const checks: Array<{ sessionId: string; orgId: string | null }> = [];
    const revoked = new Set<string>();
    const sessions: SessionStatusSource = {
      mode: 'off',
      liveCheckForR3: false,
      check: async (_trx, actor, checkedOrg) => {
        checks.push({ sessionId: actor.sessionId, orgId: checkedOrg });
        if (revoked.has(actor.sessionId)) throw new DomainError('UNAUTHENTICATED', 401, 'revoked');
      },
    };
    const identity: IdentityPort = {
      sessions,
      revoker: null,
      authenticator: () => async (header) => {
        headers.push(header ?? '');
        const user: AuthUser = { userId: owner, email: 'root-owner@example.com', name: null, aal: 'aal1', sessionId: SESSION, mfaAt: null };
        return user;
      },
    };
    const reads: string[] = [];
    const ai: InvoiceReader = {
      fromText: async () => null,
      fromImage: async (_bytes, mediaType) => {
        reads.push(mediaType);
        return { ...base, number: '8801' };
      },
    };
    const storage = new MemoryStore();
    const kernel = createKernel(config, { ...defaults, identity, ai, storage });
    const stop = await kernel.start('all');
    try {
      const origin = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${origin}/api/config`)).json()).toMatchObject({ aiEnabled: true });

      const send = () => {
        const form = new FormData();
        form.append('file', new File([new Uint8Array([...PNG, ...randomBytes(64)])], 'hd.png', { type: 'image/png' }));
        return fetch(`${origin}/api/files`, { method: 'POST', headers: { authorization: 'Bearer fake-token', [ORG_HEADER]: slug }, body: form });
      };
      // A session the identity port refuses gets 401 and stores nothing.
      revoked.add(SESSION);
      expect((await send()).status).toBe(401);
      expect(storage.blobs.size).toBe(0);
      revoked.clear();
      checks.length = 0;

      const upload = await send();
      expect(upload.status).toBe(200);
      expect(checks).toContainEqual({ sessionId: SESSION, orgId });
      const { files } = (await upload.json()) as { files: Array<{ fileId: string }> };
      const fileId = files[0]?.fileId as string;
      expect(headers).toContain('Bearer fake-token');
      expect([...storage.blobs.keys()].some((key) => key.includes(orgId))).toBe(true);

      // The worker reads the file with the AI adapter passed in and raises a proposal from its answer.
      const reader = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
      const deadline = Date.now() + 60_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        const recent = await reader.query<Array<{ id: string; status: string }>>('kernel.files.recent', {}, { actor: asUser(owner), orgId });
        status = recent.find((f) => f.id === fileId)?.status;
        if (status === 'proposed' || status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(status).toBe('proposed');
      expect(reads).toEqual(['image/png']);
    } finally {
      await stop();
    }
  });
});
