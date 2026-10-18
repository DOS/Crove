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
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
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
      { id: proposalId, revision: 1 },
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
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved.status).toBe(200);
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
});
