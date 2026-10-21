// Fiscal year archive packages (issue #922), on a real PostgreSQL 17, through the HTTP API: an owner asks for the
// package of a year once every month is locked (R3), the worker builds it once, and owners download and verify it. A
// part whose bytes change, or an original that disappears, fails the verification.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, Runtime, archiveKey, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { runYearArchive, type YearArchiveManifest } from '../src/year-archive.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const SECRET = 'test-only-jwt-secret-for-year-archive-0123456789';
const ISSUER = 'crove-auth';
// The fixture invoice's buyer: the org's own tax code (checksum-invalid, no real company).
const BUYER_TAX_CODE = '0309876546';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    if (!this.blobs.has(key)) this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new BlobNotFoundError(key);
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('fiscal year archive packages (#922)', () => {
  const dbName = `crove_test_year_archive_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@archive.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@archive.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@archive.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };
  let invoiceNo = 7000;
  const originals: string[] = [];

  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal1' as const, sessionId: who.session });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    // oRPC answers JSON; a test reads it untyped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  async function get(path: string, who: Account = owner, slug = org.slug) {
    return app.request(path, { headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-crove-org': slug } });
  }

  const build = async (year: number, who: Account = owner, mfa = true) =>
    rpc('yearArchive/build', await tokenFor(who, { mfa }), { year, idempotencyKey: randomUUID() });

  // Uploads, reads and (as the admin, four-eyes) approves one invoice dated `date`.
  async function record(date: string) {
    const bytes = new TextEncoder().encode(
      FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${invoiceNo++}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`),
    );
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    originals.push(storageKey);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: `hd-${date}.xml`, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-21' }, org.orgId, fileId);
    const approved = await rpc('inbox/approve', await tokenFor(adminUser, { mfa: true }), { acceptUnverifiedSignature: true, id: proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved.status).toBe(200);
  }

  beforeAll(async () => {
    extract = inProcessExtract();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    const db: Db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, adminUser, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Lưu trữ', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: adminUser.email, role: 'admin' });
    expect((await rpc('invites/accept', await tokenFor(adminUser), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: BUYER_TAX_CODE })).status).toBe(200);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrg = { slug: String(other.body?.slug), orgId: String(other.body?.orgId) };

    await record('2025-03-10');
    await record('2025-11-20');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses a year with an unlocked month, an admin, and an owner without a fresh second factor', async () => {
    expect(await build(2025)).toMatchObject({ status: 422, body: { code: 'ARCHIVE_YEAR_OPEN' } });
    for (let month = 1; month <= 12; month++) {
      const locked = await rpc('periodLock/lock', await tokenFor(owner), { month: `2025-${String(month).padStart(2, '0')}`, idempotencyKey: randomUUID() });
      expect(locked.status).toBe(200);
    }
    expect(await build(2025, adminUser)).toMatchObject({ status: 403 });
    expect(await build(2025, owner, false)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    // 2026 is still open.
    expect(await build(2026)).toMatchObject({ status: 422, body: { code: 'ARCHIVE_YEAR_OPEN' } });
  });

  it('builds the package of a locked year once, from the request the owner made', async () => {
    const asked = await build(2025);
    expect(asked).toMatchObject({ status: 200, body: { year: 2025, state: 'requested' } });
    // A second request while the first is in progress is refused.
    expect(await build(2025)).toMatchObject({ status: 409, body: { code: 'ARCHIVE_PENDING' } });
    const event = await admin(async (c) => (await c.query(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.archive_requested'`, [org.orgId])).rows);
    expect(event).toEqual([{ payload: { year: 2025, requestCommandId: expect.any(String) } }]);
    const requestCommandId = String(event[0]?.payload.requestCommandId);

    // The worker's job.
    const built = await runYearArchive({ runtime: workerRuntime, store }, org.orgId, 2025, { requestCommandId });
    expect(built.recorded).toBe(true);
    expect(built.manifestKey).toMatch(new RegExp(`^archive/${org.orgId}/2025/[0-9a-f]{64}$`));
    // A retried job builds again but keeps the first record.
    expect((await runYearArchive({ runtime: workerRuntime, store }, org.orgId, 2025, { requestCommandId })).recorded).toBe(false);
    expect(await build(2025)).toMatchObject({ status: 409, body: { code: 'ARCHIVE_EXISTS' } });

    const list = await rpc('yearArchive/list', await tokenFor(owner), undefined);
    expect(list).toMatchObject({ status: 200, body: { lockedThrough: '2025-12-31', archives: [{ year: 2025, state: 'built', documents: 2 }] } });
    // Owners only.
    expect((await rpc('yearArchive/list', await tokenFor(adminUser), undefined)).status).toBe(403);

    const manifestResponse = await get('/api/finance-archive/2025/manifest');
    expect(manifestResponse.status).toBe(200);
    const manifest = (await manifestResponse.json()) as YearArchiveManifest;
    expect(manifest).toMatchObject({ format: 'crove-year-archive-v1', orgId: org.orgId, year: 2025, lockedThrough: '2025-12-31', requestCommandId });
    const kinds = manifest.parts.map((p) => p.kind);
    expect(kinds.filter((k) => k === 'journal' || k === 'ledger' || k === 'statements')).toEqual(['journal', 'ledger', 'statements']);
    expect(kinds.filter((k) => k === 'vat_working')).toHaveLength(12);
    expect(kinds.filter((k) => k === 'vat_xml')).toHaveLength(12);
    expect(manifest.documents.map((d) => d.key).sort()).toEqual([...originals].sort());
    // The build's audit row names the manifest and the request.
    const audit = await admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.archive.record' ORDER BY occurred_at, id`, [org.orgId])).rows);
    expect(audit).toEqual([
      { detail: expect.objectContaining({ year: 2025, manifest_key: built.manifestKey, documents: 2 }) },
      // The retried job's record is audited as a duplicate and keeps the first.
      { detail: expect.objectContaining({ year: 2025, duplicate: true }) },
    ]);

    // A part downloads with the bytes the manifest names.
    const journal = manifest.parts.find((p) => p.kind === 'journal');
    const part = await get(`/api/finance-archive/2025/${journal?.sha256}`);
    expect(part.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await part.arrayBuffer()))).toBe(journal?.sha256);
    // Nothing the manifest does not list, no other org, no admin.
    expect((await get(`/api/finance-archive/2025/${sha256Hex('not a part')}`)).status).toBe(404);
    expect((await get(`/api/finance-archive/2025/${journal?.sha256}`, adminUser)).status).toBe(403);
    expect((await get(`/api/finance-archive/2025/manifest`, outsider, otherOrg.slug)).status).toBe(404);
    expect((await get('/api/finance-archive/2024/manifest')).status).toBe(404);

    expect(await (await get('/api/finance-archive/2025/verify')).json()).toEqual({ year: 2025, ok: true, checked: 1 + manifest.parts.length + 2, problems: [] });
  });

  it('fails the verification when a part changes or an original disappears', async () => {
    const manifest = (await (await get('/api/finance-archive/2025/manifest')).json()) as YearArchiveManifest;
    const ledger = manifest.parts.find((p) => p.kind === 'ledger');
    store.blobs.set(String(ledger?.key), new TextEncoder().encode('not the ledger'));
    const original = manifest.documents[0];
    store.blobs.delete(String(original?.key));
    const verification = await (await get('/api/finance-archive/2025/verify')).json();
    expect(verification).toMatchObject({ year: 2025, ok: false });
    expect(verification.problems).toEqual(
      expect.arrayContaining([
        { code: 'changed', name: ledger?.name },
        { code: 'missing', name: original?.filename },
      ]),
    );
  });

  it('reports a recorded manifest of another shape as changed, never as a server error', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ format: 'something-else' }));
    const sha256 = sha256Hex(bytes);
    const manifestKey = archiveKey(org.orgId, 2024, sha256);
    const manifestGeneration = await store.put(manifestKey, bytes);
    await workerRuntime.execute('finance.archive.record', { year: 2024, manifestKey, manifestSha256: sha256, manifestGeneration, parts: 0, documents: 0 }, {
      actor: { type: 'system', component: 'finance.archive' },
      orgId: org.orgId,
    });
    expect(await (await get('/api/finance-archive/2024/verify')).json()).toEqual({
      year: 2024,
      ok: false,
      checked: 1,
      problems: [{ code: 'manifest_changed', name: 'manifest' }],
    });
  });
});
