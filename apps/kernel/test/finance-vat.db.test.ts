// VAT working per month or quarter (issue #316), on a real PostgreSQL 17, through the HTTP API: the period's purchase
// invoices by rate (voided documents left out), month and quarter ranges, the form 01/GTGT indicators, the empty sales
// side, the Excel export with its audit row, the roles and the org boundary. The totals logic itself is unit-tested in
// modules/finance/test/vat-return.test.ts.
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
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const SECRET = 'test-only-jwt-secret-for-vat-working-0123456789';
const ISSUER = 'crove-auth';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
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

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('VAT working per month or quarter (#316)', () => {
  const dbName = `crove_test_vat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@vat.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@vat.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@vat.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: owner.session });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: owner.session, mfaAt: Math.floor(Date.now() / 1000) });

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
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // The fixture invoice (1,800,000 at 10%, VAT 180,000) under another number and date.
  const invoice = (number: string, date: string) =>
    new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`));

  // Uploads, reads and approves one invoice; returns its document and journal entry.
  async function record(number: string, date: string) {
    const bytes = invoice(number, date);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-17' }, org.orgId, fileId);
    return runtime.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: 1 },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
  }

  const exportFile = async (token: string, period: string, slug = org.slug) =>
    app.request(`/api/export/vat.xlsx?${new URLSearchParams({ period })}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });

  const exportAudits = () =>
    admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.vat.export' AND outcome = 'ok' ORDER BY occurred_at`, [org.orgId])).rows);

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
    pool = createPool({ connectionString: appUrl, max: 4 });
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

    for (const who of [owner, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Tờ khai GTGT', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrg = { slug: String(other.body?.slug), orgId: String(other.body?.orgId) };

    // September: two invoices, one of them voided by reversing its entry. August: one. October: one.
    await record('9001', '2026-09-15');
    const voided = await record('9002', '2026-09-20');
    await record('8001', '2026-08-20');
    await record('1001', '2026-10-02');
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: voided.journalEntryId, entryDate: '2026-09-30', reason: 'Hóa đơn ghi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved.body).toMatchObject({ voidedDocumentId: voided.documentId });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the month of purchase invoices by rate, without voided documents, and fills the indicators', async () => {
    const report = await rpc('vat/period', await tokenFor(viewer), { period: '2026-09' });
    expect(report.status).toBe(200);
    expect(report.body.period).toEqual({ period: '2026-09', kind: 'month', from: '2026-09-01', to: '2026-09-30' });
    expect(report.body.input.documents).toEqual([
      expect.objectContaining({
        number: '9001',
        issueDate: '2026-09-15',
        partyTaxCode: '0101234564',
        subtotal: '1800000',
        vatAmount: '180000',
        total: '1980000',
        rates: [{ rate: '10', taxable: '1800000', vat: '180000' }],
        warnings: [],
      }),
    ]);
    expect(report.body.input.totals).toMatchObject({ taxable: '1800000', vat: '180000', documents: 1 });
    // No org tax code, so no way to tell sales apart (#313): the output side is not available.
    expect(report.body.output).toMatchObject({ available: false, documents: [], totals: { taxable: '0', vat: '0', documents: 0 } });
    const indicators = new Map((report.body.indicators as Array<{ code: string; amount: string }>).map((i) => [i.code, i.amount]));
    expect(indicators.get('23')).toBe('1800000');
    expect(indicators.get('24')).toBe('180000');
    expect(indicators.get('32')).toBe('0');
  });

  it('covers the three months of a quarter and nothing outside it', async () => {
    const quarter = await rpc('vat/period', await tokenFor(owner), { period: '2026-Q3' });
    expect(quarter.body.period).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect((quarter.body.input.documents as Array<{ number: string }>).map((d) => d.number)).toEqual(['8001', '9001']);
    expect(quarter.body.input.totals).toMatchObject({ taxable: '3600000', vat: '360000', documents: 2 });
    const october = await rpc('vat/period', await tokenFor(owner), { period: '2026-10' });
    expect((october.body.input.documents as Array<{ number: string }>).map((d) => d.number)).toEqual(['1001']);
    expect((await rpc('vat/period', await tokenFor(owner), { period: '2026-07' })).body.input.documents).toEqual([]);
  });

  it('refuses a malformed period', async () => {
    for (const period of ['2026-13', '2026-Q5', '2026-9', '']) {
      expect((await rpc('vat/period', await tokenFor(owner), { period })).status, period).toBe(400);
    }
  });

  it('keeps each org to its own invoices', async () => {
    const own = await rpc('vat/period', await tokenFor(outsider), { period: '2026-09' }, otherOrg.slug);
    expect(own).toMatchObject({ status: 200, body: { input: { documents: [] } } });
    const foreign = await rpc('vat/period', await tokenFor(outsider), { period: '2026-09' }, org.slug);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.body?.input).toBeUndefined();
    expect((await exportFile(await tokenFor(outsider), '2026-09')).status).toBeGreaterThanOrEqual(400);
  });

  it('exports the period to Excel and records the export, for a viewer too', async () => {
    const response = await exportFile(await tokenFor(viewer), '2026-Q3');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="crove-gtgt-2026-Q3-${org.slug}.xlsx"`);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // An xlsx file is a zip archive; its content is checked in modules/finance/test/vat-export.test.ts and the e2e.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(await exportAudits()).toEqual([{ detail: { period: '2026-Q3', documents: 2 } }]);

    // A malformed period downloads nothing and records nothing.
    expect((await exportFile(await tokenFor(owner), '2026-Q9')).status).toBe(422);
    expect(await exportAudits()).toHaveLength(1);
  });
});
