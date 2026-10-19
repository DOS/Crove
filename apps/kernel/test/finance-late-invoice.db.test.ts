// A late purchase invoice (issue #478), on a real PostgreSQL 17, through the HTTP API: an invoice dated in a locked
// month is refused as before unless the approver chooses a posting date in an open month. Then the document keeps its
// invoice date, the journal entry and the ledger use the posting date, the VAT working declares the invoice in the
// period of the posting date (flagged declared_late), and the audit rows record the choice. A posting date is refused
// for an invoice whose month is open, before the invoice date, after today, inside the locked months and for any
// proposal but an invoice; a bulk approval never sets one.
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
const SECRET = 'test-only-jwt-secret-for-late-invoice-0123456789';
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

// YYYY-MM-DD in Vietnam, `days` from now.
function vietnamDay(days: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    new Date(Date.now() + days * 86_400_000),
  );
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const suite = ADMIN ? describe : describe.skip;

suite('late purchase invoice in an open month (#478)', () => {
  const dbName = `crove_test_late_invoice_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@late.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@late.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let invoiceNo = 7000;

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
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // The fixture invoice (1,800,000 + VAT 180,000 = 1,980,000 owed to the seller on 331) under a new number and date.
  const invoice = (number: string, date: string) =>
    new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`));

  // The owner uploads and reads one invoice dated `date`; returns the purchase proposal waiting for approval.
  async function propose(date: string): Promise<string> {
    const bytes = invoice(String(invoiceNo++), date);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-17' }, org.orgId, fileId);
    if (!proposalId) throw new Error('the invoice raised no proposal');
    return proposalId;
  }

  // The admin approves what the owner uploaded (four-eyes, P10).
  const approve = async (proposalId: string, extra: Record<string, unknown> = {}) =>
    rpc('inbox/approve', await tokenFor(adminUser, { mfa: true }), { id: proposalId, revision: 1, idempotencyKey: randomUUID(), ...extra });

  const auditsOf = (command: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ outcome: string; detail: Record<string, unknown> }>(
            `SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at, id`,
            [org.orgId, command],
          )
        ).rows,
    );

  const statusOf = async (proposalId: string) => (await rpc('inbox/get', await tokenFor(owner), { id: proposalId })).body.status;

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

    for (const who of [owner, adminUser]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Hóa đơn muộn', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: adminUser.email, role: 'admin' });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(adminUser), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
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

  it('refuses a posting date while the invoice month is open, and posts on the invoice date without one', async () => {
    const october = await propose('2026-10-02');
    expect(await approve(october, { postingDate: '2026-10-03' })).toMatchObject({
      status: 422,
      body: { code: 'POSTING_DATE_NOT_ALLOWED', data: { issueDate: '2026-10-02', lockedThrough: null } },
    });
    expect(await statusOf(october)).toBe('pending');
    // The invoice date itself is no choice: the ordinary posting, with no posting date in the answer.
    const approved = await approve(october, { postingDate: '2026-10-02' });
    expect(approved.status).toBe(200);
    expect(approved.body.postingDate).toBeUndefined();
    const entry = await rpc('journal/get', await tokenFor(owner), { id: approved.body.journalEntryId });
    expect(entry.body).toMatchObject({ entryDate: '2026-10-02', document: { issueDate: '2026-10-02' } });
  });

  it('posts an invoice of a locked month in an open month only when the approver chooses a date there', async () => {
    const late = await propose('2026-09-20');
    expect((await rpc('periodLock/lock', await tokenFor(adminUser), { month: '2026-09', idempotencyKey: randomUUID() })).status).toBe(200);

    // Without a choice: refused, as before #478. Inside the locked months, before the invoice date or after today:
    // refused too, and nothing is posted.
    expect(await approve(late)).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED', data: { lockedThrough: '2026-09-30', entryDate: '2026-09-20' } } });
    expect(await approve(late, { postingDate: '2026-09-30' })).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED', data: { entryDate: '2026-09-30' } } });
    expect(await approve(late, { postingDate: '2026-09-19' })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED' } });
    expect(await approve(late, { postingDate: vietnamDay(2) })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_IN_FUTURE' } });
    expect((await approve(late, { postingDate: '2026-13-01' })).status).toBe(400);
    expect(await statusOf(late)).toBe('pending');

    // A bulk approval never chooses a date: the item is refused on its own.
    const bulk = await rpc('inbox/approveMany', await tokenFor(adminUser, { mfa: true }), { items: [{ id: late, revision: 1 }], idempotencyKey: randomUUID() });
    expect(bulk.body.results).toEqual([expect.objectContaining({ id: late, outcome: 'refused', code: 'PERIOD_LOCKED' })]);

    const approved = await approve(late, { postingDate: '2026-10-01' });
    expect(approved).toMatchObject({ status: 200, body: { postingDate: '2026-10-01' } });
    const { documentId, journalEntryId } = approved.body as { documentId: string; journalEntryId: string };

    // The document keeps the invoice date; the entry is dated on the posting date; the Inbox shows the date chosen.
    const doc = await admin(async (c) => (await c.query(`SELECT invoice_date::text FROM crove_finance.purchase_document WHERE id = $1`, [documentId])).rows[0]);
    expect(doc).toEqual({ invoice_date: '2026-09-20' });
    expect((await rpc('journal/get', await tokenFor(owner), { id: journalEntryId })).body).toMatchObject({
      entryDate: '2026-10-01',
      document: { id: documentId, issueDate: '2026-09-20' },
    });
    expect((await rpc('inbox/get', await tokenFor(owner), { id: late })).body).toMatchObject({
      status: 'executed',
      result: { documentId, journalEntryId, postingDate: '2026-10-01' },
    });

    // The choice is on the approval's audit row and on the recording's, and in the document's activity.
    const approvals = (await auditsOf('kernel.proposal.approve')).filter((a) => a.outcome === 'ok' && a.detail.posting_date === '2026-10-01');
    expect(approvals).toEqual([expect.objectContaining({ detail: expect.objectContaining({ posting_date: '2026-10-01' }) })]);
    const records = (await auditsOf('finance.purchase.record')).filter((a) => a.outcome === 'ok' && a.detail.posting_date !== undefined);
    expect(records).toEqual([expect.objectContaining({ detail: expect.objectContaining({ invoice_date: '2026-09-20', posting_date: '2026-10-01' }) })]);
    const activity = await admin(async (c) => (await c.query(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2`, [org.orgId, documentId])).rows);
    expect(activity).toEqual([{ summary: expect.stringContaining('vào ngày 01/10/2026 (tháng của hóa đơn đã khóa sổ)') }]);

    // The ledger counts it in October, not in the locked September.
    const september = await rpc('ledger/period', await tokenFor(owner), { period: '2026-09' });
    const octoberLedger = await rpc('ledger/period', await tokenFor(owner), { period: '2026-10' });
    expect(september.body.payables.totals.increase).toBe('0');
    // The October invoice of the first test and this one.
    expect(octoberLedger.body.payables.totals.increase).toBe('3960000');

    // The VAT working declares it in October (and Q4), flagged, and no longer in September (or Q3).
    const vat = async (period: string) => (await rpc('vat/period', await tokenFor(owner), { period })).body;
    for (const period of ['2026-09', '2026-Q3']) expect((await vat(period)).input.documents).toEqual([]);
    for (const period of ['2026-10', '2026-Q4']) {
      const input = (await vat(period)).input;
      expect(input.totals).toMatchObject({ documents: 2, vat: '360000' });
      const flagged = input.documents.find((d: { id: string }) => d.id === documentId);
      expect(flagged).toMatchObject({ issueDate: '2026-09-20', postingDate: '2026-10-01', warnings: ['declared_late'] });
      expect(input.documents.find((d: { id: string }) => d.id !== documentId)).toMatchObject({ issueDate: '2026-10-02', postingDate: '2026-10-02', warnings: [] });
    }
  });

  it('refuses a posting date for a proposal that is not an invoice', async () => {
    const entries = await admin(async (c) => (await c.query(`SELECT id FROM crove_finance.journal_entry WHERE org_id = $1 AND entry_date = '2026-10-02'`, [org.orgId])).rows);
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: entries[0].id, entryDate: '2026-10-05', reason: 'Ghi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    expect(await approve(asked.body.proposalId, { postingDate: '2026-10-06' })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED' } });
    expect(await statusOf(asked.body.proposalId)).toBe('pending');
  });
});
