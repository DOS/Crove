// The multi-client home screen (issue #318), on a real PostgreSQL 17, through the HTTP API: me.clients lists every org
// the user belongs to, and only those, each with its own pending proposals, failed files, last activity and next VAT
// deadline; owners and admins set the VAT filing period (audited); an org the user leaves drops off the list.
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
import { nextVatDeadline, taxDues, vietnamToday, type TaxProfile } from '@crove/kernel-contract';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, recordExtractionFailure } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url)).toString('utf8');
const SECRET = 'test-only-jwt-secret-for-clients-0123456789';
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

interface Org {
  slug: string;
  orgId: string;
}

interface ClientRow {
  orgId: string;
  slug: string;
  name: string;
  role: string;
  overview: {
    pendingProposals: number;
    failedFiles: number;
    lastActivityAt: string | null;
    vatFilingPeriod: 'month' | 'quarter' | null;
    vatDeadline: { period: string; dueDate: string; daysLeft: number } | null;
    taxDues: Array<{ obligation: string; period: string; dueDate: string; daysLeft: number; confirmed: boolean }>;
  };
}

const suite = ADMIN ? describe : describe.skip;

suite('multi-client home screen (#318)', () => {
  const dbName = `crove_test_clients_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  // The accountant, a client company's owner, and a stranger to both.
  const accountant: Account = { subject: randomUUID(), email: 'ke-toan@clients.test', session: randomUUID(), userId: '' };
  const client: Account = { subject: randomUUID(), email: 'chu-dn@clients.test', session: randomUUID(), userId: '' };
  const stranger: Account = { subject: randomUUID(), email: 'nguoi-la@clients.test', session: randomUUID(), userId: '' };
  let firm: Org;
  let quiet: Org;
  let clientOrg: Org;
  let strangerOrg: Org;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
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

  async function rpc(path: string, token: string, input: unknown, slug: string | null) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const clients = async (who: Account): Promise<ClientRow[]> => {
    const answer = await rpc('me/clients', await tokenFor(who), undefined, null);
    expect(answer.status).toBe(200);
    const { clients: rows, total } = answer.body as { clients: ClientRow[]; total: number };
    // Far below the 200 a screen lists, so every org of the user is there.
    expect(total).toBe(rows.length);
    return rows;
  };
  const row = (rows: ClientRow[], org: Org) => rows.find((r) => r.orgId === org.orgId);
  const setPeriod = async (who: Account, org: Org, vatFilingPeriod: unknown) =>
    rpc('org/setVatFilingPeriod', await tokenFor(who), { vatFilingPeriod }, org.slug);

  async function createOrg(who: Account, name: string): Promise<Org> {
    const created = await rpc('org/create', await tokenFor(who), { name, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    return { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
  }

  async function invite(owner: Account, org: Org, who: Account, role: 'member' | 'viewer' | 'admin') {
    const sent = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role }, org.slug);
    expect(sent.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(who), { token: String(sent.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
  }

  async function ingest(org: Org, who: Account, bytes: Uint8Array, filename: string) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: { type: 'user', userId: who.userId, aal: 'aal1', sessionId: who.session }, orgId: org.orgId },
    );
    return fileId;
  }

  // A readable e-invoice (a pending proposal) or a file the reader gave up on (a failed file).
  const invoice = (number: string) => new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`));
  async function propose(org: Org, who: Account, number: string) {
    const fileId = await ingest(org, who, invoice(number), `hd-${number}.xml`);
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    expect(proposalId).toBeTruthy();
  }
  async function failFile(org: Org, who: Account, salt: string) {
    const fileId = await ingest(org, who, new TextEncoder().encode(`<not-an-invoice>${salt}</not-an-invoice>`), `loi-${salt}.xml`);
    await recordExtractionFailure(workerRuntime, org.orgId, fileId, 'Không đọc được chứng từ');
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
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {} }).register({
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

    for (const who of [accountant, client, stranger]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    firm = await createOrg(accountant, 'Công ty Kế toán Sao Mai');
    quiet = await createOrg(accountant, 'Công ty Lặng Im');
    clientOrg = await createOrg(client, 'Công ty Khách hàng');
    strangerOrg = await createOrg(stranger, 'Công ty Người lạ');
    await invite(client, clientOrg, accountant, 'member');

    // The accountant's own firm: two invoices waiting, one file that could not be read.
    await propose(firm, accountant, '7001');
    await propose(firm, accountant, '7002');
    await failFile(firm, accountant, 'a');
    // The client's company: one invoice waiting.
    await propose(clientOrg, client, '7101');
    // The stranger's company: plenty going on, none of it the accountant's business.
    await propose(strangerOrg, stranger, '7201');
    await propose(strangerOrg, stranger, '7202');
    await propose(strangerOrg, stranger, '7203');
    await failFile(strangerOrg, stranger, 'b');
    await failFile(strangerOrg, stranger, 'c');
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

  it("lists exactly the orgs the user belongs to, each with that org's own figures", async () => {
    const rows = await clients(accountant);
    expect(rows.map((r) => r.orgId).sort()).toEqual([firm.orgId, quiet.orgId, clientOrg.orgId].sort());
    expect(row(rows, strangerOrg)).toBeUndefined();
    expect(row(rows, firm)).toMatchObject({ slug: firm.slug, role: 'owner', overview: { pendingProposals: 2, failedFiles: 1, vatFilingPeriod: null, vatDeadline: null } });
    expect(row(rows, firm)?.overview.lastActivityAt).toEqual(expect.any(String));
    expect(row(rows, clientOrg)).toMatchObject({ role: 'member', overview: { pendingProposals: 1, failedFiles: 0 } });
    // Nothing has happened in a new org yet.
    expect(row(rows, quiet)).toMatchObject({ overview: { pendingProposals: 0, failedFiles: 0, lastActivityAt: null } });

    const theirs = await clients(stranger);
    expect(theirs.map((r) => r.orgId)).toEqual([strangerOrg.orgId]);
    expect(theirs[0]).toMatchObject({ overview: { pendingProposals: 3, failedFiles: 2 } });

    const owner = await clients(client);
    expect(owner.map((r) => r.orgId)).toEqual([clientOrg.orgId]);
  });

  it('counts the same pending proposals and failed files the Inbox shows', async () => {
    const token = await tokenFor(accountant);
    const pending = await rpc('inbox/list', token, { status: 'pending' }, firm.slug);
    const files = await rpc('files/recent', token, {}, firm.slug);
    expect(pending.status).toBe(200);
    expect(files.status).toBe(200);
    const overview = row(await clients(accountant), firm)?.overview;
    expect(overview?.pendingProposals).toBe(pending.body.length);
    expect(overview?.failedFiles).toBe((files.body as Array<{ status: string }>).filter((f) => f.status === 'failed').length);
  });

  it("gives one org's overview with the same figures as the home screen, to its members only (#1249)", async () => {
    const token = await tokenFor(accountant);
    const home = await clients(accountant);
    for (const org of [firm, clientOrg, quiet]) {
      const answer = await rpc('org/overview', token, undefined, org.slug);
      expect(answer.status, org.slug).toBe(200);
      expect(answer.body).toEqual(row(home, org)?.overview);
    }
    // Another org's figures stay its own: the accountant is not a member of the stranger's company.
    expect((await rpc('org/overview', token, undefined, strangerOrg.slug)).status).toBe(403);
  });

  it('lets owners and admins choose the VAT filing period, audited, and shows the next deadline', async () => {
    // A member of the client's company may not choose it; a value that is not a period is refused.
    expect(await setPeriod(accountant, clientOrg, 'quarter')).toMatchObject({ status: 403 });
    expect((await setPeriod(accountant, firm, 'year')).status).toBeGreaterThanOrEqual(400);

    expect(await setPeriod(accountant, firm, 'month')).toMatchObject({ status: 200, body: { vatFilingPeriod: 'month' } });
    expect(await setPeriod(client, clientOrg, 'quarter')).toMatchObject({ status: 200, body: { vatFilingPeriod: 'quarter' } });
    expect((await rpc('org/get', await tokenFor(accountant), undefined, firm.slug)).body).toMatchObject({ vatFilingPeriod: 'month' });

    const today = vietnamToday();
    const rows = await clients(accountant);
    expect(row(rows, firm)?.overview).toMatchObject({ vatFilingPeriod: 'month', vatDeadline: nextVatDeadline('month', today) });
    expect(row(rows, clientOrg)?.overview).toMatchObject({ vatFilingPeriod: 'quarter', vatDeadline: nextVatDeadline('quarter', today) });
    expect(row(rows, quiet)?.overview).toMatchObject({ vatFilingPeriod: null, vatDeadline: null });

    const audit = await admin(
      async (c) =>
        (
          await c.query(
            `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.set_vat_filing_period' AND outcome = 'ok'`,
            [firm.orgId],
          )
        ).rows,
    );
    expect(audit).toEqual([{ detail: expect.objectContaining({ previous: null, vatFilingPeriod: 'month' }) }]);
    const activity = await admin(
      async (c) =>
        (await c.query(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND kind = 'org.vat_filing_period_changed'`, [firm.orgId])).rows,
    );
    expect(activity).toEqual([{ summary: 'Chọn kỳ khai thuế GTGT theo tháng' }]);

    // Clearing it brings the deadline back to unknown.
    expect(await setPeriod(accountant, firm, null)).toMatchObject({ status: 200, body: { vatFilingPeriod: null } });
    expect(row(await clients(accountant), firm)?.overview).toMatchObject({ vatFilingPeriod: null, vatDeadline: null });
  });

  it('keeps a tax calendar per org: owners and admins choose the obligations, members mark them done (#921)', async () => {
    const profile: TaxProfile = { obligations: ['pit_withholding', 'cit_provisional', 'cit_finalization', 'pit_finalization', 'financial_statements'], pitFilingPeriod: 'quarter', fiscalYearEndMonth: 12 };
    // A member may not choose them; PIT withholding needs its frequency.
    expect((await rpc('org/setTaxProfile', await tokenFor(accountant), profile, clientOrg.slug)).status).toBe(403);
    expect(await rpc('org/setTaxProfile', await tokenFor(accountant), { ...profile, pitFilingPeriod: null }, firm.slug)).toMatchObject({ status: 422, body: { code: 'PIT_FILING_PERIOD_REQUIRED' } });
    const saved = await rpc('org/setTaxProfile', await tokenFor(accountant), profile, firm.slug);
    expect(saved).toMatchObject({ status: 200, body: { ...profile, since: vietnamToday() } });
    expect((await rpc('org/taxProfile', await tokenFor(accountant), undefined, firm.slug)).body).toEqual(saved.body);
    expect(await setPeriod(accountant, firm, 'month')).toMatchObject({ status: 200 });

    // The home screen lists what the rules give for the next 30 days (the profile is new, so nothing overdue).
    const today = vietnamToday();
    const inMonth = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    const expected = taxDues({ ...profile, vatFilingPeriod: 'month' }, today, inMonth).map((d) => [d.obligation, d.period, d.dueDate]);
    const listed = () => clients(accountant).then((rows) => row(rows, firm)?.overview.taxDues ?? []);
    const first = await listed();
    expect(first.map((d) => [d.obligation, d.period, d.dueDate])).toEqual(expected);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((d) => d.confirmed === false && d.daysLeft >= 0 && d.daysLeft <= 30)).toBe(true);
    // An org without a profile or VAT period lists nothing.
    expect(row(await clients(accountant), quiet)?.overview.taxDues).toEqual([]);

    // Marked done, it leaves the list; the mark is audited, and taking it back brings the item back.
    const item = first[0] as (typeof first)[number];
    const mark = async (done: boolean) => rpc('org/markTaxObligation', await tokenFor(accountant), { obligation: item.obligation, period: item.period, done }, firm.slug);
    expect(await mark(true)).toMatchObject({ status: 200, body: { done: true } });
    expect((await listed()).map((d) => [d.obligation, d.period])).not.toContainEqual([item.obligation, item.period]);
    // Twice is the same as once.
    expect((await mark(true)).status).toBe(200);
    expect((await mark(false)).status).toBe(200);
    expect((await listed()).map((d) => [d.obligation, d.period, d.dueDate])).toEqual(expected);
    // A period of another frequency is refused.
    expect(await rpc('org/markTaxObligation', await tokenFor(accountant), { obligation: 'vat_return', period: '2026', done: true }, firm.slug)).toMatchObject({
      status: 422,
      body: { code: 'TAX_PERIOD_MISMATCH' },
    });

    const audit = await admin(
      async (c) =>
        (
          await c.query(`SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.tax_%' AND outcome = 'ok' ORDER BY occurred_at`, [
            firm.orgId,
          ])
        ).rows,
    );
    expect(audit.map((r) => r.command)).toEqual(['kernel.tax_profile.save', 'kernel.tax_obligation.done', 'kernel.tax_obligation.done', 'kernel.tax_obligation.undo']);
    expect(audit[1]?.detail).toMatchObject({ obligation: item.obligation, period: item.period, already: false });
    expect(audit[2]?.detail).toMatchObject({ already: true });
    expect(await setPeriod(accountant, firm, null)).toMatchObject({ status: 200 });
  });

  it("shows the newest entry of the org's activity feed as its last activity", async () => {
    expect(row(await clients(accountant), quiet)?.overview.lastActivityAt).toBeNull();
    await propose(quiet, accountant, '7301');
    const after = row(await clients(accountant), quiet)?.overview;
    expect(after?.pendingProposals).toBe(1);
    const newest = await admin(
      async (c) => (await c.query<{ at: Date }>(`SELECT max(occurred_at) AS at FROM crove_kernel.activity WHERE org_id = $1`, [quiet.orgId])).rows[0]?.at,
    );
    expect(after?.lastActivityAt).toBe(newest?.toISOString());
  });

  it('drops an org the user no longer belongs to', async () => {
    const removed = await rpc('org/removeMember', await tokenFor(client, { mfa: true }), { userId: accountant.userId, idempotencyKey: randomUUID() }, clientOrg.slug);
    expect(removed.status).toBe(200);
    const rows = await clients(accountant);
    expect(row(rows, clientOrg)).toBeUndefined();
    expect(rows.map((r) => r.orgId).sort()).toEqual([firm.orgId, quiet.orgId].sort());
  });

  it("loads one home screen per user at a time, and another user's meanwhile (#495)", async () => {
    // The accountant's first load is held inside an org's read: the activity table is locked until the end.
    const lock = new pg.Client({ connectionString: adminUrl });
    await lock.connect();
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE crove_kernel.activity IN ACCESS EXCLUSIVE MODE');
    let first: ReturnType<typeof rpc> | undefined;
    let other: ReturnType<typeof rpc> | undefined;
    try {
      first = rpc('me/clients', await tokenFor(accountant), undefined, null);
      const deadline = Date.now() + 20_000;
      const waiting = async () =>
        (
          await admin((c) =>
            c.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%crove_kernel%activity%'`,
            ),
          )
        ).rows[0]?.n ?? 0;
      while ((await waiting()) === 0) {
        if (Date.now() > deadline) throw new Error('the first load never reached the lock');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // A second load by the same user is refused at once; another user's is not.
      expect(await rpc('me/clients', await tokenFor(accountant), undefined, null)).toMatchObject({ status: 503, body: { code: 'OVERLOADED' } });
      other = rpc('me/clients', await tokenFor(stranger), undefined, null);
    } finally {
      await lock.query('ROLLBACK');
      await lock.end();
    }
    expect((await first)?.status).toBe(200);
    expect((await other)?.status).toBe(200);
    // The slot is free again.
    expect((await clients(accountant)).length).toBeGreaterThan(0);
  });

  it('needs a signed-in user', async () => {
    const response = await app.request('/api/rpc/me/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
  });
});
