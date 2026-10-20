// A late purchase invoice (issue #478), on a real PostgreSQL 17, through the HTTP API: an invoice dated in a locked
// month is refused as before unless the approver chooses a posting date in an open month. Then the document keeps its
// invoice date, the journal entry and the ledger use the posting date, the VAT working declares the invoice in the
// period of the posting date (flagged declared_late), and so does the HTKK XML of the return, and the audit rows record
// the choice. A posting date is refused for an invoice whose month is open, before the invoice date, after today,
// inside the locked months, for a sale and for any proposal but an invoice; a bulk approval never sets one. An unlock
// that races a late approval either lands first (the invoice's month is open again, so the late date is refused) or
// is rolled back (the late posting goes through). The portal reconciliation agrees with the VAT working: the late
// invoice is matched in its own month and said to be declared later, and reported as declared late in the month it
// was posted in (#560). Every purchase document commits only with its journal entry (#560).
// The dates are relative to today in Vietnam (the database clock decides the lock and the "not after today" bound, so
// it cannot be pinned): the locked month is the one before last, the open month is last month.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { vietnamToday } from '@crove/kernel-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, importPortalList } from '@crove/mod-finance';
import { portalListXlsx, type PortalInvoiceSpec } from '../../extract/test/xlsx-fixture.ts';
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
// The fixture's seller and buyer.
const SELLER = '0101234564';
const BUYER = '0309876546';

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
const vietnamDay = (days: number) => vietnamToday(new Date(Date.now() + days * 86_400_000));
// 'YYYY-MM', `by` months from this month in Vietnam; a day of it; its last day; its quarter; 'MM/YYYY' as in a return.
function monthFromNow(by: number): string {
  const [year, month] = vietnamToday().split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const quarterOf = (month: string) => `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
const dmy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
// The month the tests lock (the one before last: over, and the first lock may name any month that is), and the open
// month after it (last month: over, so every day of it is before today).
const LOCKED = monthFromNow(-2);
const OPEN = monthFromNow(-1);

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
  // The invoice number of each proposal, for the portal list.
  const numbers = new Map<string, string>();

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

  const settledWithin = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([promise.then(() => 'settled' as const), new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);

  // The fixture invoice (1,800,000 + VAT 180,000 = 1,980,000 owed to the seller on 331) under a new number and date.
  const invoice = (number: string, date: string) =>
    new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`));

  // The owner uploads and reads one invoice dated `date`; returns the purchase proposal waiting for approval.
  async function propose(date: string): Promise<string> {
    const number = String(invoiceNo++);
    const bytes = invoice(number, date);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId: org.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => vietnamToday() }, org.orgId, fileId);
    if (!proposalId) throw new Error('the invoice raised no proposal');
    numbers.set(proposalId, number);
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

  // Read from the tests that follow: the late invoice of the second test, and the open month's invoice of the first.
  let lateProposal = '';
  let lateDocument = '';
  let openProposal = '';

  it('refuses a posting date while the invoice month is open, and posts on the invoice date without one', async () => {
    const open = await propose(day(OPEN, 2));
    openProposal = open;
    expect(await approve(open, { postingDate: day(OPEN, 3) })).toMatchObject({
      status: 422,
      body: { code: 'POSTING_DATE_NOT_ALLOWED', data: { issueDate: day(OPEN, 2), lockedThrough: null } },
    });
    expect(await statusOf(open)).toBe('pending');
    // The invoice date itself is no choice: the ordinary posting, with no posting date in the answer.
    const approved = await approve(open, { postingDate: day(OPEN, 2) });
    expect(approved.status).toBe(200);
    expect(approved.body.postingDate).toBeUndefined();
    const entry = await rpc('journal/get', await tokenFor(owner), { id: approved.body.journalEntryId });
    expect(entry.body).toMatchObject({ entryDate: day(OPEN, 2), document: { issueDate: day(OPEN, 2) } });
  });

  it('posts an invoice of a locked month in an open month only when the approver chooses a date there', async () => {
    const late = await propose(day(LOCKED, 20));
    lateProposal = late;
    expect((await rpc('periodLock/lock', await tokenFor(adminUser), { month: LOCKED, idempotencyKey: randomUUID() })).status).toBe(200);

    // Without a choice: refused, as before #478. Inside the locked months, before the invoice date or after today:
    // refused too, and nothing is posted.
    expect(await approve(late)).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED', data: { lockedThrough: lastDay(LOCKED), entryDate: day(LOCKED, 20) } } });
    expect(await approve(late, { postingDate: lastDay(LOCKED) })).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED', data: { entryDate: lastDay(LOCKED) } } });
    expect(await approve(late, { postingDate: day(LOCKED, 19) })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED' } });
    expect(await approve(late, { postingDate: vietnamDay(2) })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_IN_FUTURE' } });
    expect((await approve(late, { postingDate: `${LOCKED.slice(0, 4)}-13-01` })).status).toBe(400);
    expect(await statusOf(late)).toBe('pending');

    // A bulk approval never chooses a date: the item is refused on its own.
    const bulk = await rpc('inbox/approveMany', await tokenFor(adminUser, { mfa: true }), { items: [{ id: late, revision: 1 }], idempotencyKey: randomUUID() });
    expect(bulk.body.results).toEqual([expect.objectContaining({ id: late, outcome: 'refused', code: 'PERIOD_LOCKED' })]);

    const approved = await approve(late, { postingDate: day(OPEN, 1) });
    expect(approved).toMatchObject({ status: 200, body: { postingDate: day(OPEN, 1) } });
    const { documentId, journalEntryId } = approved.body as { documentId: string; journalEntryId: string };
    lateDocument = documentId;

    // The document keeps the invoice date; the entry is dated on the posting date; the Inbox shows the date chosen.
    const doc = await admin(async (c) => (await c.query(`SELECT invoice_date::text FROM crove_finance.purchase_document WHERE id = $1`, [documentId])).rows[0]);
    expect(doc).toEqual({ invoice_date: day(LOCKED, 20) });
    expect((await rpc('journal/get', await tokenFor(owner), { id: journalEntryId })).body).toMatchObject({
      entryDate: day(OPEN, 1),
      document: { id: documentId, issueDate: day(LOCKED, 20) },
    });
    expect((await rpc('inbox/get', await tokenFor(owner), { id: late })).body).toMatchObject({
      status: 'executed',
      result: { documentId, journalEntryId, postingDate: day(OPEN, 1) },
    });

    // The choice is on the approval's audit row and on the recording's, and in the document's activity.
    const approvals = (await auditsOf('kernel.proposal.approve')).filter((a) => a.outcome === 'ok' && a.detail.posting_date === day(OPEN, 1));
    expect(approvals).toEqual([expect.objectContaining({ detail: expect.objectContaining({ posting_date: day(OPEN, 1) }) })]);
    const records = (await auditsOf('finance.purchase.record')).filter((a) => a.outcome === 'ok' && a.detail.posting_date !== undefined);
    expect(records).toEqual([expect.objectContaining({ detail: expect.objectContaining({ invoice_date: day(LOCKED, 20), posting_date: day(OPEN, 1) }) })]);
    const activity = await admin(async (c) => (await c.query(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2`, [org.orgId, documentId])).rows);
    expect(activity).toEqual([{ summary: expect.stringContaining(`vào ngày ${dmy(day(OPEN, 1))} (tháng của hóa đơn đã khóa sổ)`) }]);

    // The ledger counts it in the open month, not in the locked one.
    const lockedLedger = await rpc('ledger/period', await tokenFor(owner), { period: LOCKED });
    const openLedger = await rpc('ledger/period', await tokenFor(owner), { period: OPEN });
    expect(lockedLedger.body.payables.totals.increase).toBe('0');
    // The open month's invoice of the first test and this one.
    expect(openLedger.body.payables.totals.increase).toBe('3960000');

    // The VAT working declares it in the open month, flagged, and no longer in the locked one. A quarter is the same
    // unless both months fall in it: then the invoice is of that quarter, and not late there.
    const vat = async (period: string) => (await rpc('vat/period', await tokenFor(owner), { period })).body;
    const sameQuarter = quarterOf(LOCKED) === quarterOf(OPEN);
    for (const period of sameQuarter ? [LOCKED] : [LOCKED, quarterOf(LOCKED)]) expect((await vat(period)).input.documents).toEqual([]);
    for (const period of [OPEN, quarterOf(OPEN)]) {
      const input = (await vat(period)).input;
      expect(input.totals).toMatchObject({ documents: 2, vat: '360000' });
      const flagged = input.documents.find((d: { id: string }) => d.id === documentId);
      const declaredLate = period === OPEN || !sameQuarter;
      expect(flagged).toMatchObject({ issueDate: day(LOCKED, 20), postingDate: day(OPEN, 1), warnings: declaredLate ? ['declared_late'] : [] });
      expect(input.documents.find((d: { id: string }) => d.id !== documentId)).toMatchObject({ issueDate: day(OPEN, 2), postingDate: day(OPEN, 2), warnings: [] });
    }
  });

  it('refuses a posting date for a proposal that is not an invoice', async () => {
    const entries = await admin(async (c) => (await c.query(`SELECT id FROM crove_finance.journal_entry WHERE org_id = $1 AND entry_date = $2`, [org.orgId, day(OPEN, 2)])).rows);
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: entries[0].id, entryDate: day(OPEN, 5), reason: 'Ghi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    expect(await approve(asked.body.proposalId, { postingDate: day(OPEN, 6) })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED' } });
    expect(await statusOf(asked.body.proposalId)).toBe('pending');
  });

  it('declares the late invoice in the HTKK XML of the month it was posted in, not of its own month', async () => {
    // The return names the org's tax code: the fixture's buyer, so the invoices stay purchases.
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: BUYER })).status).toBe(200);
    const exportXml = async (period: string) => {
      const response = await app.request(`/api/export/vat-01gtgt.xml?${new URLSearchParams({ period })}`, {
        headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'x-crove-org': org.slug },
      });
      expect(response.status, period).toBe(200);
      return response.text();
    };
    const valueOf = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
    const open = await exportXml(OPEN);
    expect(valueOf(open, 'kyKKhai')).toBe(`${OPEN.slice(5, 7)}/${OPEN.slice(0, 4)}`);
    // Both purchases of the month (1,800,000 + VAT 180,000 each), the late one included; no sales.
    expect(valueOf(open, 'ct23')).toBe('3600000');
    expect(valueOf(open, 'ct24')).toBe('360000');
    expect(valueOf(open, 'ct32')).toBe('0');
    const locked = await exportXml(LOCKED);
    expect(valueOf(locked, 'ct23')).toBe('0');
    expect(valueOf(locked, 'ct24')).toBe('0');
  });

  it('agrees with the VAT working in the portal reconciliation: declared later in its own month, declared late where posted', async () => {
    // The org's tax code is the fixture's buyer (set above), which the portal list's check needs.
    const spec = (proposalId: string, date: string): PortalInvoiceSpec => ({
      template: 1,
      series: 'C26TAB',
      number: numbers.get(proposalId) ?? '',
      date: dmy(date),
      sellerTaxCode: SELLER,
      subtotal: 1_800_000,
      vat: 180_000,
      total: 1_980_000,
    });
    // The portal lists each invoice by its invoice date: the late one in the locked month, the other in the open month.
    const lists: Array<[string, PortalInvoiceSpec[]]> = [
      [LOCKED, [spec(lateProposal, day(LOCKED, 20))]],
      [OPEN, [spec(openProposal, day(OPEN, 2))]],
    ];
    for (const [period, invoices] of lists) {
      const form = new FormData();
      form.append('file', new File([Buffer.from(portalListXlsx(invoices))], `ds-${period}.xlsx`));
      form.append('purpose', 'import');
      const uploaded = await app.request('/api/files', { method: 'POST', headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'x-crove-org': org.slug }, body: form });
      expect(uploaded.status).toBe(200);
      const fileId = ((await uploaded.json()) as { files: Array<{ fileId: string }> }).files[0]?.fileId;
      const imported = await rpc('portalList/import', await tokenFor(owner), { period, fileId });
      expect(imported.status, JSON.stringify(imported.body)).toBe(200);
      await importPortalList({ runtime: workerRuntime, store, extract }, org.orgId, imported.body.listId);
    }
    const reconcile = async (period: string) => (await rpc('portalList/reconcile', await tokenFor(owner), { period })).body;

    // Its own month: on the portal and matched, and said to be declared in the later month of its posting date.
    const locked = await reconcile(LOCKED);
    expect(locked.items).toEqual([
      expect.objectContaining({
        outcome: 'matched',
        declaredInLaterPeriod: true,
        crove: expect.objectContaining({ id: lateDocument, issueDate: day(LOCKED, 20), postingDate: day(OPEN, 1) }),
      }),
    ]);
    expect(locked.summary).toMatchObject({ matched: 1, missing: 0, notOnPortal: 0, declaredLate: 0 });

    // The month it was posted in: the month's own invoice matched, and the late one declared late, neither missing from
    // the portal nor unexplained, as the VAT working counts it here.
    const open = await reconcile(OPEN);
    expect(open.items.map((i: any) => [i.crove?.id ?? null, i.outcome, i.declaredInLaterPeriod])).toEqual([
      [expect.any(String), 'matched', false],
      [lateDocument, 'declared_late', false],
    ]);
    expect(open.items[1].crove).toMatchObject({ issueDate: day(LOCKED, 20), postingDate: day(OPEN, 1) });
    expect(open.summary).toMatchObject({ matched: 1, missing: 0, notOnPortal: 0, declaredLate: 1 });
  });

  it('lets an unlock that lands first refuse the late date, and a late approval through when the unlock rolls back', async () => {
    const late = await propose(day(LOCKED, 21));
    const entriesOf = async (proposalId: string) =>
      admin(
        async (c) =>
          (
            await c.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM crove_finance.purchase_document d
               JOIN crove_finance.journal_entry j ON j.org_id = d.org_id AND j.source_type = 'finance.purchase_document' AND j.source_id = d.id
               WHERE d.org_id = $1 AND d.proposal_id = $2`,
              [org.orgId, proposalId],
            )
          ).rows[0]?.n,
      );
    // An unlock of the locked month in flight (held open by the database owner, writing what unlock_period() writes
    // for the first locked month): the late approval waits on the lock row, then reads the invoice's month as open.
    const holdUnlock = async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM crove_finance.period_lock WHERE org_id = $1 FOR UPDATE`, [org.orgId]);
      await client.query(`UPDATE crove_finance.period_lock SET locked_from = NULL, locked_through = NULL WHERE org_id = $1`, [org.orgId]);
      return client;
    };

    // The unlock commits first: the invoice's month is open, so the late date is refused (it posts on its own date or
    // not at all, never late), and nothing is written.
    let client = await holdUnlock();
    try {
      const approving = approve(late, { postingDate: day(OPEN, 1) });
      expect(await settledWithin(approving, 500)).toBe('pending');
      await client.query('COMMIT');
      expect(await approving).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED', data: { issueDate: day(LOCKED, 21), lockedThrough: null } } });
    } finally {
      await client.end();
    }
    expect(await statusOf(late)).toBe('pending');
    expect(await entriesOf(late)).toBe(0);

    // Locked again, and an unlock in flight that rolls back: the late approval waits, then posts late.
    expect((await rpc('periodLock/lock', await tokenFor(adminUser), { month: LOCKED, idempotencyKey: randomUUID() })).status).toBe(200);
    client = await holdUnlock();
    try {
      const approving = approve(late, { postingDate: day(OPEN, 1) });
      expect(await settledWithin(approving, 500)).toBe('pending');
      await client.query('ROLLBACK');
      expect(await approving).toMatchObject({ status: 200, body: { postingDate: day(OPEN, 1) } });
    } finally {
      await client.end();
    }
    expect(await entriesOf(late)).toBe(1);
    expect((await rpc('periodLock/state', await tokenFor(owner), undefined)).body).toMatchObject({ lockedThrough: lastDay(LOCKED) });
  });

  it('refuses a posting date for a sale, whose own date decides', async () => {
    // The org's own invoices are sales: with the fixture's seller as the org's tax code, the fixture reads as a sale.
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: SELLER })).status).toBe(200);
    const lockedSale = await propose(day(LOCKED, 22));
    const openSale = await propose(day(OPEN, 10));
    for (const id of [lockedSale, openSale]) expect((await rpc('inbox/get', await tokenFor(owner), { id })).body.payload).toMatchObject({ direction: 'sale' });
    // In a locked month: no later date, and without one the lock refuses it as before.
    expect(await approve(lockedSale, { postingDate: day(OPEN, 1) })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED', data: { postingDate: day(OPEN, 1) } } });
    expect(await approve(lockedSale)).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED' } });
    // In an open month: no other date either; on its invoice date it posts.
    expect(await approve(openSale, { postingDate: day(OPEN, 11) })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED' } });
    for (const id of [lockedSale, openSale]) expect(await statusOf(id)).toBe('pending');
    const approved = await approve(openSale);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await rpc('journal/get', await tokenFor(owner), { id: approved.body.journalEntryId })).body).toMatchObject({ entryDate: day(OPEN, 10) });
  });

  it('commits a purchase document only together with its own journal entry', async () => {
    // A document written by the database owner (the check holds every writer), then the given steps, in one transaction.
    const attempt = async (steps: (c: pg.Client, id: string) => Promise<void>) =>
      admin(async (c) => {
        const id = randomUUID();
        await c.query('BEGIN');
        try {
          await c.query(
            `INSERT INTO crove_finance.purchase_document (org_id, id, direction, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total)
             SELECT org_id, $2, 'purchase', party_id, 'C26TZZ', $3, $4, 100, 10, 110
             FROM crove_finance.purchase_document WHERE org_id = $1 AND direction = 'purchase' LIMIT 1`,
            [org.orgId, id, id.slice(0, 8), day(OPEN, 15)],
          );
          await steps(c, id);
          await c.query('COMMIT');
          return { ok: true as const };
        } catch (error) {
          await c.query('ROLLBACK').catch(() => undefined);
          const e = error as { code?: string; message: string };
          return { ok: false as const, code: e.code, message: e.message };
        }
      });
    // A balanced entry for the document (or another source), posted after it.
    const post = async (c: pg.Client, sourceId: string, sourceType = 'finance.purchase_document') => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, $2, 'test', $3, $4) RETURNING id`,
        [org.orgId, day(OPEN, 15), sourceType, sourceId],
      );
      const lines: Array<[number, string, number, number]> = [
        [1, '642', 100, 0],
        [2, '1331', 10, 0],
        [3, '331', 0, 110],
      ];
      for (const [n, account, debit, credit] of lines) {
        await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)`, [
          org.orgId,
          rows[0]?.id,
          n,
          account,
          debit,
          credit,
        ]);
      }
    };
    // Without an entry, or with an entry of another source: refused at commit.
    expect(await attempt(async () => undefined)).toMatchObject({ ok: false, code: '23514', message: expect.stringMatching(/must be posted as a journal entry/) });
    expect(await attempt((c, id) => post(c, id, 'test'))).toMatchObject({ ok: false, code: '23514' });
    // Checked early, before the entry is posted: refused.
    expect(
      await attempt(async (c, id) => {
        await c.query('SET CONSTRAINTS crove_finance.purchase_document_entry IMMEDIATE');
        await post(c, id);
      }),
    ).toMatchObject({ ok: false, code: '23514' });
    // With its entry posted after it in the same transaction: committed.
    expect(await attempt((c, id) => post(c, id))).toEqual({ ok: true });
  });

  it('posts an invoice dated on or before the opening balances on a later posting date, and refuses a sale there (#366)', async () => {
    // A new org whose opening balances are as at the 10th of last month, no month locked. The tests below act in it.
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Số dư đầu kỳ', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: adminUser.email, role: 'admin' });
    expect((await rpc('invites/accept', await tokenFor(adminUser), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    const opening = day(OPEN, 10);
    const imported = await rpc('openingBalance/post', await tokenFor(owner, { mfa: true }), {
      asOf: opening,
      rows: [
        { rowNo: 2, accountCode: '111', accountName: '', debit: '50000000', credit: '' },
        { rowNo: 3, accountCode: '411', accountName: '', debit: '', credit: '50000000' },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);

    // An invoice dated before the opening balances, in an open month: on its own date the guard refuses it and says to
    // choose a posting date; on or before the opening date too; after it, it posts.
    const early = await propose(day(OPEN, 5));
    expect(await approve(early)).toMatchObject({
      status: 409,
      body: { code: 'BEFORE_OPENING_BALANCE', data: { openingDate: opening, entryDate: day(OPEN, 5), rule: 'before_opening_posting_date' } },
    });
    expect((await approve(early)).body.message).toContain('Hãy chọn ngày ghi sổ sau ngày');
    expect(await approve(early, { postingDate: opening })).toMatchObject({ status: 409, body: { code: 'BEFORE_OPENING_BALANCE', data: { entryDate: opening } } });
    const approved = await approve(early, { postingDate: day(OPEN, 15) });
    expect(approved).toMatchObject({ status: 200, body: { postingDate: day(OPEN, 15) } });
    const records = (await auditsOf('finance.purchase.record')).filter((a) => a.outcome === 'ok' && a.detail.late_reason === 'opening');
    expect(records).toEqual([expect.objectContaining({ detail: expect.objectContaining({ invoice_date: day(OPEN, 5), posting_date: day(OPEN, 15) }) })]);
    const activity = await admin(
      async (c) => (await c.query(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2`, [org.orgId, approved.body.documentId])).rows,
    );
    expect(activity).toEqual([{ summary: expect.stringContaining(`vào ngày ${dmy(day(OPEN, 15))} (ngày hóa đơn không sau ngày số dư đầu kỳ)`) }]);

    // The VAT working counts it in the period of its posting date: the same month here, so an ordinary invoice of it,
    // not declared late.
    const input = (await rpc('vat/period', await tokenFor(owner), { period: OPEN })).body.input;
    expect(input.documents).toEqual([expect.objectContaining({ id: approved.body.documentId, issueDate: day(OPEN, 5), postingDate: day(OPEN, 15), warnings: [] })]);

    // An invoice dated after the opening balances in an open month: no other posting date.
    const later = await propose(day(OPEN, 12));
    expect(await approve(later, { postingDate: day(OPEN, 16) })).toMatchObject({
      status: 422,
      body: { code: 'POSTING_DATE_NOT_ALLOWED', data: { issueDate: day(OPEN, 12), lockedThrough: null, openingDate: opening } },
    });

    // The SPA reads the opening date with the lock state, to offer the posting date.
    expect((await rpc('periodLock/state', await tokenFor(owner), undefined)).body).toMatchObject({ lockedThrough: null, openingDate: opening });

    // A sale posts on its invoice date only: before the opening balances it cannot post, and the refusal says why.
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: SELLER })).status).toBe(200);
    const sale = await propose(day(OPEN, 6));
    expect(await approve(sale, { postingDate: day(OPEN, 15) })).toMatchObject({ status: 422, body: { code: 'POSTING_DATE_NOT_ALLOWED' } });
    const refused = await approve(sale);
    expect(refused).toMatchObject({ status: 409, body: { code: 'BEFORE_OPENING_BALANCE', data: { rule: 'before_opening_fixed' } } });
    expect(refused.body.message).toContain('không chọn được ngày khác');
  });
});
