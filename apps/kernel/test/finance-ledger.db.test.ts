// Ledger reports per month, quarter or year (issue #321), on a real PostgreSQL 17, through the HTTP API: the trial
// balance with opening balances from earlier entries and the reversal counted as posted, sub-accounts rolled up, the
// general ledger with its running balance, payables per vendor, the Excel export with its audit row, the roles and
// the org boundary. The report math itself is unit-tested in modules/finance/test/ledger-reports.test.ts.
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
import { F01_ACCOUNTS, extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const SECRET = 'test-only-jwt-secret-for-ledger-reports-0123456789';
const ISSUER = 'crove-auth';
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const SELLER_TAX_CODE = '0101234564';

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

interface OrgRef {
  slug: string;
  orgId: string;
}

interface TrialRow {
  accountCode: string;
  level: number;
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  closingDebit: string;
  closingCredit: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('ledger reports per month, quarter or year (#321)', () => {
  const dbName = `crove_test_ledger_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@ledger.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@ledger.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@ledger.test', session: randomUUID(), userId: '' };
  let org: OrgRef = { slug: '', orgId: '' };
  let otherOrg: OrgRef = { slug: '', orgId: '' };

  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal1' as const, sessionId: who.session });
  const asMfa = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: who.session, mfaAt: Math.floor(Date.now() / 1000) });

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

  // The fixture invoice (1,800,000 + VAT 180,000 = 1,980,000 owed to the seller on 331) under another number and date.
  const invoice = (number: string, date: string) =>
    new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`));

  // Uploads, reads and approves one invoice in an org as its owner; returns its document and journal entry.
  async function record(target: OrgRef, who: Account, number: string, date: string) {
    const bytes = invoice(number, date);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(target.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(who), orgId: target.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-17' }, target.orgId, fileId);
    return runtime.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id: proposalId, revision: 1 },
      { actor: asMfa(who), orgId: target.orgId, idempotencyKey: randomUUID() },
    );
  }

  const exportFile = async (token: string, period: string, slug = org.slug) =>
    app.request(`/api/export/ledger.xlsx?${new URLSearchParams({ period })}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });

  const exportAudits = (orgId = org.orgId) =>
    admin(
      async (c) =>
        (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.ledger.export' AND outcome = 'ok' ORDER BY occurred_at`, [orgId]))
          .rows,
    );

  const rowOf = (rows: TrialRow[], code: string) => rows.find((r) => r.accountCode === code);
  const amounts = (row: TrialRow | undefined) => row && [row.openingDebit, row.openingCredit, row.debit, row.credit, row.closingDebit, row.closingCredit];

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
    appUrl = login('crove_app', 'test-app-pw');
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
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Sổ sách', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrg = { slug: String(other.body?.slug), orgId: String(other.body?.orgId) };

    // August: one invoice (the opening balance of September). September: two, the second reversed on 2026-09-30.
    // October: one. The other org: one in September.
    await record(org, owner, '8001', '2026-08-20');
    await record(org, owner, '9001', '2026-09-15');
    const reversed = await record(org, owner, '9002', '2026-09-20');
    await record(org, owner, '1001', '2026-10-02');
    await record(otherOrg, outsider, '7001', '2026-09-10');
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: reversed.journalEntryId, entryDate: '2026-09-30', reason: 'Hóa đơn ghi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved.status).toBe(200);
  });

  // A runtime of its own pool whose connection runs `between` once, right after the first statement that reads
  // journal lines has returned and before the next one is sent (#365): whatever `between` commits lands between the
  // reads of a report that reads in more than one statement.
  function pausedRuntime(between: () => Promise<void>) {
    let pending: (() => Promise<void>) | null = between;
    const paused = createPool({ connectionString: appUrl, max: 1 });
    paused.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = (async (...args: unknown[]) => {
        const result = await query(...args);
        if (pending && typeof args[0] === 'string' && args[0].includes('journal_line')) {
          const run = pending;
          pending = null;
          await run();
        }
        return result;
      }) as typeof client.query;
    });
    const reader = new Runtime(createDb(paused)).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    return { runtime: reader, ran: () => pending === null, end: () => paused.end() };
  }

  // A new org of the owner's with one September invoice, for the tests that post while a report reads.
  async function freshOrg(name: string, invoiceNumber: string): Promise<OrgRef> {
    const created = await rpc('org/create', await tokenFor(owner), { name, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    const fresh = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await record(fresh, owner, invoiceNumber, '2026-09-10');
    return fresh;
  }

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('builds the month trial balance from the opening balance, counting the reversal as posted', async () => {
    const report = await rpc('ledger/period', await tokenFor(viewer), { period: '2026-09' });
    expect(report.status).toBe(200);
    expect(report.body.period).toEqual({ period: '2026-09', kind: 'month', from: '2026-09-01', to: '2026-09-30' });
    const rows = report.body.trialBalance.rows as TrialRow[];
    // 331: August's invoice owed at the start, two invoices in September and the reversal of one of them.
    expect(amounts(rowOf(rows, '331'))).toEqual(['0', '1980000', '1980000', '3960000', '0', '3960000']);
    // 1331 rolls up into 133.
    expect(rowOf(rows, '1331')).toMatchObject({ level: 1 });
    expect(amounts(rowOf(rows, '133'))).toEqual(['180000', '0', '360000', '180000', '360000', '0']);
    expect(amounts(rowOf(rows, '133'))).toEqual(amounts(rowOf(rows, '1331')));
    expect(report.body.trialBalance.balanced).toBe(true);
    expect(report.body.trialBalance.totals).toMatchObject({ openingDebit: '1980000', openingCredit: '1980000', debit: '5940000', credit: '5940000' });
  });

  it('lists payables per vendor, and no receivables', async () => {
    const report = await rpc('ledger/period', await tokenFor(owner), { period: '2026-09' });
    expect(report.body.payables.rows).toEqual([
      {
        partyId: expect.any(String),
        partyName: SELLER,
        partyTaxCode: SELLER_TAX_CODE,
        opening: '1980000',
        increase: '3960000',
        decrease: '1980000',
        closing: '3960000',
      },
    ]);
    expect(report.body.receivables).toEqual({ accountCode: '131', rows: [], totals: { opening: '0', increase: '0', decrease: '0', closing: '0' } });
  });

  it('covers a quarter and a year, each with its own opening balance', async () => {
    const october = await rpc('ledger/period', await tokenFor(owner), { period: '2026-10' });
    expect(amounts(rowOf(october.body.trialBalance.rows, '331'))).toEqual(['0', '3960000', '0', '1980000', '0', '5940000']);
    const quarter = await rpc('ledger/period', await tokenFor(owner), { period: '2026-Q3' });
    expect(amounts(rowOf(quarter.body.trialBalance.rows, '331'))).toEqual(['0', '0', '1980000', '5940000', '0', '3960000']);
    const year = await rpc('ledger/period', await tokenFor(owner), { period: '2026' });
    expect(year.body.period).toEqual({ period: '2026', kind: 'year', from: '2026-01-01', to: '2026-12-31' });
    expect(amounts(rowOf(year.body.trialBalance.rows, '331'))).toEqual(['0', '0', '1980000', '7920000', '0', '5940000']);
    const before = await rpc('ledger/period', await tokenFor(owner), { period: '2026-07' });
    expect(before.body.trialBalance.rows).toEqual([]);
  });

  it('runs the general ledger of an account from its opening balance', async () => {
    const ledger = await rpc('ledger/account', await tokenFor(viewer), { period: '2026-09', accountCode: '331' });
    expect(ledger.status).toBe(200);
    expect(ledger.body).toMatchObject({ account: { code: '331', name: 'Phải trả cho người bán' }, opening: '-1980000', debit: '1980000', credit: '3960000', closing: '-3960000' });
    const lines = ledger.body.lines as Array<{ reference: string | null; reversal: boolean; debit: string; credit: string; balance: string; counterAccounts: string[]; partyName: string | null }>;
    expect(lines.map((l) => [l.reference, l.reversal, l.debit, l.credit, l.balance, l.partyName])).toEqual([
      ['C26TAB-9001', false, '0', '1980000', '-3960000', SELLER],
      ['C26TAB-9002', false, '0', '1980000', '-5940000', SELLER],
      [null, true, '1980000', '0', '-3960000', SELLER],
    ]);
    expect(lines[0]?.counterAccounts).toContain('1331');

    // A parent account shows its sub-accounts' lines.
    const vat = await rpc('ledger/account', await tokenFor(owner), { period: '2026-09', accountCode: '133' });
    expect((vat.body.lines as Array<{ accountCode: string }>).map((l) => l.accountCode)).toEqual(['1331', '1331', '1331']);
    expect(vat.body).toMatchObject({ opening: '180000', closing: '360000' });
  });

  it('refuses a malformed period and an account outside the chart', async () => {
    for (const period of ['2026-13', '2026-Q5', '2026-9', '1999', '']) {
      expect((await rpc('ledger/period', await tokenFor(owner), { period })).status, period).toBe(400);
    }
    expect(await rpc('ledger/account', await tokenFor(owner), { period: '2026-09', accountCode: '999' })).toMatchObject({ status: 422, body: { code: 'UNKNOWN_ACCOUNT' } });
    expect((await rpc('ledger/account', await tokenFor(owner), { period: '2026-09', accountCode: '33x' })).status).toBe(400);
  });

  it('keeps each org to its own ledger', async () => {
    const own = await rpc('ledger/period', await tokenFor(outsider), { period: '2026-09' }, otherOrg.slug);
    expect(own.status).toBe(200);
    expect(amounts(rowOf(own.body.trialBalance.rows, '331'))).toEqual(['0', '0', '0', '1980000', '0', '1980000']);
    expect(own.body.payables.rows).toHaveLength(1);
    const foreign = await rpc('ledger/period', await tokenFor(outsider), { period: '2026-09' }, org.slug);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.body?.trialBalance).toBeUndefined();
    const foreignAccount = await rpc('ledger/account', await tokenFor(outsider), { period: '2026-09', accountCode: '331' }, org.slug);
    expect(foreignAccount.status).toBeGreaterThanOrEqual(400);
    expect(foreignAccount.body?.lines).toBeUndefined();
    const before = (await exportAudits()).length;
    expect((await exportFile(await tokenFor(outsider), '2026-09')).status).toBeGreaterThanOrEqual(400);
    expect(await exportAudits()).toHaveLength(before);
    expect(await exportAudits(otherOrg.orgId)).toEqual([]);
  });

  it('exports the period to Excel and records the export first, for a viewer too', async () => {
    const before = (await exportAudits()).length;
    const response = await exportFile(await tokenFor(viewer), '2026-09');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="crove-so-sach-2026-09-${org.slug}.xlsx"; filename*=UTF-8''crove-so-sach-2026-09-${org.slug}.xlsx`);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    // An xlsx file is a zip archive; its content is checked in modules/finance/test/ledger-export.test.ts and the e2e.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // The audit row holds the period and the number of journal lines only: 3 lines for each of two invoices and the
    // reversal, at least (the fixture's expense lines decide the exact count).
    const audits = await exportAudits();
    expect(audits).toHaveLength(before + 1);
    const detail = audits.at(-1)?.detail as { period: string; lines: number };
    expect(Object.keys(detail).sort()).toEqual(['lines', 'period']);
    expect(detail.period).toBe('2026-09');
    expect(detail.lines).toBeGreaterThanOrEqual(9);

    // A year works too; a malformed period downloads nothing and records nothing.
    expect((await exportFile(await tokenFor(owner), '2026')).status).toBe(200);
    expect((await exportFile(await tokenFor(owner), '2026-Q9')).status).toBe(422);
    expect(await exportAudits()).toHaveLength(before + 2);
  });

  // The DRAFT financial statements (issue #154) from the same entries; the mapping itself is unit-tested in
  // modules/finance/test/tt133-reports.test.ts.
  const statementsFile = async (token: string, period: string, slug = org.slug) =>
    app.request(`/api/export/statements.xlsx?${new URLSearchParams({ period })}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });
  const statementAudits = (orgId = org.orgId) =>
    admin(
      async (c) =>
        (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.statements.export' AND outcome = 'ok' ORDER BY occurred_at`, [orgId]))
          .rows,
    );
  type StatementLine = { code: string; amount: string; total: boolean };
  const nonZero = (lines: StatementLine[]) => lines.filter((l) => l.amount !== '0').map((l) => [l.code, l.amount, l.total]);

  it('builds B01 at the period end and B02 for the period, counting the reversal as undoing its invoice', async () => {
    const statements = await rpc('ledger/statements', await tokenFor(viewer), { period: '2026-09' });
    expect(statements.status).toBe(200);
    expect(statements.body.period).toEqual({ period: '2026-09', kind: 'month', from: '2026-09-01', to: '2026-09-30' });
    // At 30 September: two invoices stand (August's and one of September's): their VAT to deduct, what is owed to the
    // seller, and the unclosed expenses as a loss in undistributed profit.
    expect(statements.body.b01.asOf).toBe('2026-09-30');
    expect(nonZero(statements.body.b01.lines)).toEqual([
      ['181', '360000', false],
      ['180', '360000', true],
      ['200', '360000', true],
      ['311', '3960000', false],
      ['300', '3960000', true],
      ['417', '-3600000', false],
      ['400', '-3600000', true],
      ['500', '360000', true],
    ]);
    expect(statements.body.b01).toMatchObject({ balanced: true, unmapped: [] });
    // September: two invoices and the reversal of one leave one invoice's expense.
    expect(statements.body.b02).toMatchObject({ from: '2026-09-01', to: '2026-09-30', unmapped: [] });
    expect(nonZero(statements.body.b02.lines)).toEqual([
      ['24', '1800000', false],
      ['30', '-1800000', true],
      ['50', '-1800000', true],
      ['60', '-1800000', true],
    ]);
    // B01's payable is the trial balance's closing credit on 331.
    const report = await rpc('ledger/period', await tokenFor(viewer), { period: '2026-09' });
    expect(rowOf(report.body.trialBalance.rows, '331')?.closingCredit).toBe('3960000');
  });

  it('reads a quarter and a year the same way, and an empty period as zeros', async () => {
    const quarter = await rpc('ledger/statements', await tokenFor(owner), { period: '2026-Q3' });
    expect(quarter.body.b01.asOf).toBe('2026-09-30');
    expect(nonZero(quarter.body.b02.lines)[0]).toEqual(['24', '3600000', false]);
    const year = await rpc('ledger/statements', await tokenFor(owner), { period: '2026' });
    expect(year.body.b01.asOf).toBe('2026-12-31');
    expect(nonZero(year.body.b01.lines).filter(([code]) => ['181', '311', '417', '500'].includes(String(code)))).toEqual([
      ['181', '540000', false],
      ['311', '5940000', false],
      ['417', '-5400000', false],
      ['500', '540000', true],
    ]);
    expect(nonZero(year.body.b02.lines)[0]).toEqual(['24', '5400000', false]);
    const empty = await rpc('ledger/statements', await tokenFor(owner), { period: '2026-07' });
    expect(nonZero(empty.body.b01.lines)).toEqual([]);
    expect(nonZero(empty.body.b02.lines)).toEqual([]);
    expect(empty.body.b01.balanced).toBe(true);
    for (const period of ['2026-13', '2026-Q5', '']) expect((await rpc('ledger/statements', await tokenFor(owner), { period })).status, period).toBe(400);
  });

  it('keeps each org to its own statements', async () => {
    const own = await rpc('ledger/statements', await tokenFor(outsider), { period: '2026-09' }, otherOrg.slug);
    expect(nonZero(own.body.b02.lines)[0]).toEqual(['24', '1800000', false]);
    const foreign = await rpc('ledger/statements', await tokenFor(outsider), { period: '2026-09' }, org.slug);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.body?.b01).toBeUndefined();
    expect((await statementsFile(await tokenFor(outsider), '2026-09')).status).toBeGreaterThanOrEqual(400);
    expect(await statementAudits()).toEqual([]);
  });

  it('exports the statements to Excel and records the export first, for a viewer too', async () => {
    const response = await statementsFile(await tokenFor(viewer), '2026-09');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="crove-bao-cao-tai-chinh-2026-09-${org.slug}.xlsx"`);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    // The workbook's content is checked in modules/finance/test/statements-export.test.ts.
    expect(Array.from(new Uint8Array(await response.arrayBuffer()).subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect((await statementAudits()).map((r) => r.detail)).toEqual([{ period: '2026-09' }]);
    expect((await statementsFile(await tokenFor(owner), '2026-Q9')).status).toBe(422);
    expect(await statementAudits()).toHaveLength(1);
  });

  // The year's statements as HTKK XML (issue #920); the layout itself is unit-tested in
  // modules/finance/test/statements-htkk-xml.test.ts.
  const htkkFile = async (token: string, year: string, slug = org.slug) =>
    app.request(`/api/export/statements-htkk.xml?${new URLSearchParams({ year })}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });
  const xmlValue = (xml: string, path: string) => {
    let rest = xml;
    for (const tag of path.split('/')) {
      const start = rest.indexOf(`<${tag}>`);
      if (start === -1) return undefined;
      rest = rest.slice(start + tag.length + 2);
    }
    return rest.slice(0, rest.indexOf('<'));
  };

  it('says what the HTKK statements of a year would miss, then writes them for a viewer and records the export', async () => {
    const check = await rpc('ledger/statementsHtkkCheck', await tokenFor(viewer), { year: 2026 });
    expect(check.status).toBe(200);
    // The year has no closing entries (#889) yet; every account is in HTKK's trial balance list.
    expect(check.body).toEqual({ year: 2026, warnings: ['YEAR_NOT_CLOSED'], uncovered: [] });
    const before = (await statementAudits()).length;
    // No tax code yet: refused, nothing recorded.
    const refused = await htkkFile(await tokenFor(viewer), '2026');
    expect(refused.status).toBe(422);
    expect((await refused.json()).code).toBe('TAX_CODE_REQUIRED');
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: '0312345670' })).status).toBe(200);

    const response = await htkkFile(await tokenFor(viewer), '2026');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('content-disposition')).toContain('crove-bctc-2026');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const xml = await response.text();
    expect(xmlValue(xml, 'maTKhai')).toBe('683');
    expect(xmlValue(xml, 'mst')).toBe('0312345670');
    expect(xmlValue(xml, 'kyKKhai')).toBe('2026');
    // B01 at 31 December 2026 and at 31 December 2025 (nothing posted then), B02 of 2026, and F01's payable.
    expect(xmlValue(xml, 'SoCuoiNam/ct311')).toBe('5940000');
    expect(xmlValue(xml, 'SoCuoiNam/ct500')).toBe('540000');
    expect(xmlValue(xml, 'SoDauNam/ct500')).toBe('0');
    expect(xmlValue(xml, 'NamNay/ct24')).toBe('5400000');
    expect(xmlValue(xml, 'NamTruoc/ct24')).toBe('0');
    expect(xmlValue(xml, 'SoDuCuoiKy/Co/ct331')).toBe('5940000');
    // F01 is summed per account in SQL rather than from every line: it must equal the year's trial balance of the
    // ledger report on every account HTKK lists.
    const year = await rpc('ledger/period', await tokenFor(viewer), { period: '2026' });
    const sides = [
      ['SoDuDauKy/No', 'openingDebit'],
      ['SoDuDauKy/Co', 'openingCredit'],
      ['SoPhatSinhTrongKy/No', 'debit'],
      ['SoPhatSinhTrongKy/Co', 'credit'],
      ['SoDuCuoiKy/No', 'closingDebit'],
      ['SoDuCuoiKy/Co', 'closingCredit'],
    ] as const;
    const listed = (year.body.trialBalance.rows as TrialRow[]).filter((r) => F01_ACCOUNTS.includes(r.accountCode as (typeof F01_ACCOUNTS)[number]));
    expect(listed.length).toBeGreaterThan(3);
    for (const row of listed) {
      for (const [path, key] of sides) expect(xmlValue(xml, `${path}/ct${row.accountCode}`), `${path} ${row.accountCode}`).toBe(String(Math.round(Number(row[key]))));
    }
    expect((await statementAudits()).slice(before).map((r) => r.detail)).toEqual([{ period: '2026', format: 'htkk_bctc_xml', warnings: ['YEAR_NOT_CLOSED'] }]);

    // A malformed or out-of-range year, and another org's member, get no file and record nothing.
    for (const year of ['26', '2100', '2026-09', '']) expect((await htkkFile(await tokenFor(owner), year)).status, year).toBe(422);
    expect((await htkkFile(await tokenFor(outsider), '2026')).status).toBeGreaterThanOrEqual(400);
    expect((await rpc('ledger/statementsHtkkCheck', await tokenFor(owner), { year: 2100 })).status).toBe(400);
    expect(await statementAudits()).toHaveLength(before + 1);
  });

  it('reads the ledger reports at one moment while entries are posted (#365)', async () => {
    const fresh = await freshOrg('Công ty Một thời điểm', '5001');
    const actor = { actor: asUser(owner), orgId: fresh.orgId };
    // Posted while the report reads: an August invoice, then its reversal in September. Read at two moments, the
    // report would show the reversal (a September line) without the invoice it undoes (an opening balance).
    const post = async () => {
      const late = await record(fresh, owner, '5002', '2026-08-25');
      const asked = await rpc(
        'inbox/request',
        await tokenFor(owner),
        { command: 'finance.journal.reverse', input: { entryId: late.journalEntryId, entryDate: '2026-09-28', reason: 'Hóa đơn ghi nhầm' }, idempotencyKey: randomUUID() },
        fresh.slug,
      );
      expect(asked.status).toBe(200);
      const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() }, fresh.slug);
      expect(approved.status).toBe(200);
    };

    const before = await runtime.query<{ trialBalance: { rows: TrialRow[] } }>('finance.ledger.book', { period: '2026-09' }, actor);
    expect(amounts(rowOf(before.trialBalance.rows, '331'))).toEqual(['0', '0', '0', '1980000', '0', '1980000']);
    const paused = pausedRuntime(post);
    let during: unknown;
    try {
      during = await paused.runtime.query('finance.ledger.book', { period: '2026-09' }, actor);
    } finally {
      await paused.end();
    }
    expect(paused.ran()).toBe(true);
    // The whole report is the moment its one statement began: none of what was posted while it read.
    expect(during).toEqual(before);

    // Both entries are committed: the next read has the August invoice as the opening balance and its reversal.
    const after = await runtime.query<{ trialBalance: { rows: TrialRow[]; balanced: boolean } }>('finance.ledger.book', { period: '2026-09' }, actor);
    expect(amounts(rowOf(after.trialBalance.rows, '331'))).toEqual(['0', '1980000', '1980000', '1980000', '0', '1980000']);
    expect(after.trialBalance.balanced).toBe(true);
  });

  it('reads B01 and B02 at one moment while entries are posted (#365)', async () => {
    const fresh = await freshOrg('Công ty Báo cáo một thời điểm', '6001');
    const actor = { actor: asUser(owner), orgId: fresh.orgId };
    type Statements = { b01: { lines: StatementLine[] }; b02: { lines: StatementLine[] } };
    const before = await runtime.query<Statements>('finance.statements.period', { period: '2026-09' }, actor);
    expect(nonZero(before.b02.lines)[0]).toEqual(['24', '1800000', false]);
    // A September invoice posted while the statements read. Read at two moments, B02 could count its expense while
    // B01 at the period end does not.
    const paused = pausedRuntime(async () => {
      await record(fresh, owner, '6002', '2026-09-20');
    });
    let during: unknown;
    try {
      during = await paused.runtime.query('finance.statements.period', { period: '2026-09' }, actor);
    } finally {
      await paused.end();
    }
    expect(paused.ran()).toBe(true);
    expect(during).toEqual(before);
    const after = await runtime.query<Statements>('finance.statements.period', { period: '2026-09' }, actor);
    expect(nonZero(after.b02.lines)[0]).toEqual(['24', '3600000', false]);
    expect(nonZero(after.b01.lines).find(([code]) => code === '417')).toEqual(['417', '-3600000', false]);
  });
});
