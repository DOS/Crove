// Bank statement lines to bank vouchers (issue #326, stage 2a) on a real PostgreSQL 17, through the HTTP API where a
// user would act: the voucher a line makes and the party suggested for it (tax code, open balance, none), a báo Có
// asked for from a line and approved like any voucher (R3, four-eyes), each line's state (open, proposed, matched),
// one voucher proposal per line, a voucher that does not follow its line, a line settled since a proposal was made
// (alone and in a bulk approval), a reversed voucher freeing its line, and the database rules every writer is held to.
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
import { normalizeStatementAmount, type BankStatementRow } from '@crove/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-match-326';
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

const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@bank-match-326.test`, session: randomUUID(), userId: '' });
const suite = ADMIN ? describe : describe.skip;

suite('bank statement lines to bank vouchers (#326)', () => {
  const dbName = `crove_test_bank_match_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner = account('owner');
  const adminUser = account('admin');
  const member = account('member');
  const viewer = account('viewer');
  const outsider = account('outsider');
  let org = { slug: '', orgId: '' };
  let other = { slug: '', orgId: '' };
  // The fixture's seller, owed 1 980 000 on 331 once its invoice is recorded, and a customer.
  let vendor = '';
  let customer = '';
  // The lines by their bank reference.
  const lineId: Record<string, string> = {};

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: owner.session });

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

  let rowNo = 1;
  const row = (date: string, moneyIn: string, moneyOut: string, reference: string, description: string): BankStatementRow => ({
    rowNo: rowNo++,
    date,
    description,
    moneyIn: normalizeStatementAmount(moneyIn),
    moneyOut: normalizeStatementAmount(moneyOut),
    balance: '',
    reference,
  });
  const suggestion = async (id: string, who = member, slug = org.slug) => rpc('bank/lineVoucher', await tokenFor(who), { bankLineId: id }, slug);
  const states = async () => {
    const listed = await rpc('bank/lines', await tokenFor(viewer), { bankAccount: '1121', period: '2026-10' });
    expect(listed.status).toBe(200);
    return Object.fromEntries((listed.body.lines as any[]).map((l) => [l.reference, l.state]));
  };
  const ask = async (who: Account, input: Record<string, unknown>) =>
    rpc('inbox/request', await tokenFor(who), { command: 'finance.voucher.record', input, idempotencyKey: randomUUID() });
  const approve = async (who: Account, id: string) => rpc('inbox/approve', await tokenFor(who, { mfa: true }), { acceptUnverifiedSignature: true, id, revision: 1, idempotencyKey: randomUUID() });
  // The báo Có of the customer's transfer, as the form sends it from the line's suggestion.
  const receipt = (extra: Record<string, unknown> = {}) => ({
    type: 'bank_credit',
    date: '2026-10-01',
    cashAccount: '1121',
    partyId: customer,
    description: 'CTY TNHH THUONG MAI HOA BINH CK MST 0312345670',
    lines: [{ account: '131', amount: '1500000' }],
    bankLineId: lineId.FT101,
    ...extra,
  });

  async function join(who: Account, role: string, slug: string) {
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role }, slug);
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
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
    db = createDb(pool);
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

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Ngân Hàng', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await join(adminUser, 'admin', org.slug);
    await join(member, 'member', org.slug);
    await join(viewer, 'viewer', org.slug);
    const second = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    other = { slug: String(second.body?.slug), orgId: String(second.body?.orgId) };

    // A purchase on credit from the fixture's seller (dated 2026-09-15): 1 980 000 owed to it on 331.
    const bytes = new Uint8Array(FIXTURE);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const proposal = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    const recorded = await approve(adminUser, String(proposal.proposalId));
    expect(recorded.status).toBe(200);
    const [doc] = await admin(async (c) => (await c.query('SELECT party_id FROM crove_finance.purchase_document WHERE id = $1', [recorded.body.documentId])).rows);
    vendor = doc.party_id;
    customer = randomUUID();
    await admin((c) => c.query(`INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Công ty TNHH Thương mại Hòa Bình', '0312345670')`, [org.orgId, customer]));

    const imported = await rpc('bank/import', await tokenFor(member), {
      bankAccount: '1121',
      filename: 'sao-ke-10.xlsx',
      rows: [
        row('01/10/2026', '1.500.000', '', 'FT101', 'CTY TNHH THUONG MAI HOA BINH CK MST 0312345670'),
        row('02/10/2026', '', '1.980.000', 'FT102', 'CHUYEN KHOAN TRA TIEN HANG'),
        row('03/10/2026', '', '11.000', 'FT103', 'Phi SMS'),
        row('04/10/2026', '1.234,50', '', 'FT104', 'Lai tien gui'),
      ],
      idempotencyKey: randomUUID(),
    });
    expect(imported.status).toBe(200);
    for (const r of await admin(async (c) => (await c.query<{ id: string; bank_ref: string }>('SELECT id, bank_ref FROM crove_finance.bank_line WHERE org_id = $1', [org.orgId])).rows)) {
      lineId[r.bank_ref] = r.id;
    }
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

  it('suggests the voucher a line makes and the party: by tax code, by open balance, or nobody', async () => {
    expect(await states()).toEqual({ FT101: { status: 'open' }, FT102: { status: 'open' }, FT103: { status: 'open' }, FT104: { status: 'open' } });

    const money = await suggestion(lineId.FT101 as string);
    expect(money).toMatchObject({
      status: 200,
      body: {
        bankAccount: '1121',
        line: { id: lineId.FT101, amount: '1500000', state: { status: 'open' } },
        voucher: { type: 'bank_credit', date: '2026-10-01', amount: '1500000', counterAccount: '131', description: 'CTY TNHH THUONG MAI HOA BINH CK MST 0312345670' },
        suggested: { party: { id: customer, taxCode: '0312345670' }, reason: 'tax_code' },
      },
    });
    // The name is in the description too: a weaker reason for the same party, listed once.
    expect(money.body.candidates).toEqual([expect.objectContaining({ party: expect.objectContaining({ id: customer }), reason: 'tax_code' })]);

    // Money out of the amount the seller is owed on 331.
    const paid = await suggestion(lineId.FT102 as string);
    expect(paid.body).toMatchObject({ voucher: { type: 'bank_debit', amount: '1980000', counterAccount: '331' }, suggested: { party: { id: vendor }, reason: 'balance' } });

    // A bank fee: nobody to suggest.
    expect((await suggestion(lineId.FT103 as string)).body).toMatchObject({ voucher: { type: 'bank_debit', amount: '11000' }, suggested: null, candidates: [] });
    // Fractions of a dong: no voucher.
    expect((await suggestion(lineId.FT104 as string)).body).toMatchObject({ line: { amount: '1234.5' }, voucher: null });

    // Viewers do not ask for vouchers; another org cannot read the line.
    expect(await suggestion(lineId.FT101 as string, viewer)).toMatchObject({ status: 403 });
    expect(await suggestion(lineId.FT101 as string, outsider, other.slug)).toMatchObject({ status: 404, body: { code: 'BANK_LINE_NOT_FOUND' } });
  });

  it('lists the open lines per account for the Inbox, and the lines whose description names their party (#326, stage 2b)', async () => {
    expect((await rpc('bank/openLines', await tokenFor(viewer), undefined)).body).toEqual({
      accounts: [{ bankAccount: '1121', open: 4, ambiguous: 0, oldest: '2026-10-01' }],
    });
    expect((await rpc('bank/openLines', await tokenFor(outsider), undefined, other.slug)).body).toEqual({ accounts: [] });
    // Only the tax code names a party in this month: the open balance of FT102 is not strong enough to ask in bulk.
    const strong = await rpc('bank/suggestions', await tokenFor(member), { bankAccount: '1121', period: '2026-10' });
    expect(strong.status).toBe(200);
    expect((strong.body as any[]).map((s) => [s.line.reference, s.suggested.reason, s.suggested.party.id, s.voucher.amount])).toEqual([
      ['FT101', 'tax_code', customer, '1500000'],
    ]);
    expect(await rpc('bank/suggestions', await tokenFor(viewer), { bankAccount: '1121', period: '2026-10' })).toMatchObject({ status: 403 });
  });

  let receiptProposal = '';
  let receiptEntry = '';

  it('asks for a báo Có from a line, one proposal per line, and refuses a voucher that does not follow it', async () => {
    for (const [patch, problem] of [
      [{ date: '2026-10-02' }, 'DATE'],
      [{ lines: [{ account: '131', amount: '1400000' }] }, 'AMOUNT'],
      [{ cashAccount: '112' }, 'ACCOUNT'],
      [{ type: 'bank_debit', lines: [{ account: '331', amount: '1500000' }] }, 'TYPE'],
    ] as const) {
      const refused = await ask(member, receipt(patch));
      expect(refused, problem).toMatchObject({ status: 422, body: { code: 'BANK_LINE_MISMATCH' } });
      expect(refused.body.data?.problems ?? refused.body.details?.problems, problem).toContain(problem);
    }
    expect(await ask(member, receipt({ bankLineId: randomUUID() }))).toMatchObject({ status: 422, body: { code: 'BANK_LINE_NOT_FOUND' } });

    const asked = await ask(member, receipt());
    expect(asked).toMatchObject({ status: 200, body: { proposalId: expect.any(String) } });
    receiptProposal = String(asked.body.proposalId);
    expect((await states()).FT101).toEqual({ status: 'proposed', proposalId: receiptProposal });
    // A proposed line is no longer open, nor suggested again.
    expect((await rpc('bank/openLines', await tokenFor(viewer), undefined)).body.accounts).toEqual([{ bankAccount: '1121', open: 3, ambiguous: 0, oldest: '2026-10-02' }]);
    expect((await rpc('bank/suggestions', await tokenFor(member), { bankAccount: '1121', period: '2026-10' })).body).toEqual([]);
    // The proposal carries the line, and the line takes no second proposal.
    const detail = await rpc('inbox/get', await tokenFor(owner), { id: receiptProposal });
    expect(detail.body.voucher).toMatchObject({ bankLineId: lineId.FT101, total: '1500000' });
    expect(await ask(adminUser, receipt())).toMatchObject({ status: 409, body: { code: 'BANK_LINE_PROPOSED' } });
    expect((await suggestion(lineId.FT101 as string)).body.line.state).toEqual({ status: 'proposed', proposalId: receiptProposal });
  });

  it('posts the báo Có on approval: the line is matched, the receivable settled, and no second voucher takes it', async () => {
    const approved = await approve(owner, receiptProposal);
    receiptEntry = String(approved.body?.journalEntryId);
    expect(approved).toMatchObject({ status: 200, body: { voucherId: expect.any(String), journalEntryId: expect.any(String) } });
    expect((await states()).FT101).toEqual({ status: 'matched', voucherId: approved.body.voucherId, code: 'BC00001' });
    const [voucher] = await admin(
      async (c) => (await c.query('SELECT bank_line_id, amount::text, party_id FROM crove_finance.cash_voucher WHERE id = $1', [approved.body.voucherId])).rows,
    );
    expect(voucher).toEqual({ bank_line_id: lineId.FT101, amount: expect.stringMatching(/^1500000(\.0+)?$/), party_id: customer });
    const journal = await admin(
      async (c) =>
        (
          await c.query(`SELECT account_code, debit::numeric::text AS debit, credit::numeric::text AS credit, party_id FROM crove_finance.journal_line WHERE entry_id = $1 ORDER BY line_no`, [
            receiptEntry,
          ])
        ).rows,
    );
    expect(journal.map((l) => [l.account_code, Number(l.debit), Number(l.credit), l.party_id])).toEqual([
      ['1121', 1500000, 0, null],
      ['131', 0, 1500000, customer],
    ]);
    expect(await ask(member, receipt())).toMatchObject({ status: 409, body: { code: 'BANK_LINE_MATCHED' } });
  });

  it('refuses at approval a proposal whose line another voucher settled since, alone or in a bulk approval', async () => {
    const payment = {
      type: 'bank_debit',
      date: '2026-10-02',
      cashAccount: '1121',
      partyId: vendor,
      description: 'Trả tiền hàng',
      lines: [{ account: '331', amount: '1980000' }],
      bankLineId: lineId.FT102,
    };
    const first = String((await ask(member, payment)).body.proposalId);
    // A second proposal for the same line, as a race between two requests would have left it (the request lock prevents
    // it through the API).
    const [copy] = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
             SELECT org_id, kind, command, title, payload, eligible_approvers, authors FROM crove_kernel.proposal WHERE id = $1 RETURNING id`,
            [first],
          )
        ).rows,
    );
    expect((await approve(owner, first)).status).toBe(200);
    expect(await approve(owner, String(copy?.id))).toMatchObject({ status: 409, body: { code: 'BANK_LINE_MATCHED' } });
    const bulk = await rpc('inbox/approveMany', await tokenFor(owner, { mfa: true }), { items: [{ id: String(copy?.id), revision: 1, acceptUnverifiedSignature: true }], idempotencyKey: randomUUID() });
    expect(bulk.body).toEqual({ results: [{ id: copy?.id, outcome: 'refused', code: 'BANK_LINE_MATCHED', rule: null }] });
    expect((await states()).FT102).toMatchObject({ status: 'matched', code: 'BN00001' });
  });

  it('frees the line of a reversed voucher, which can then be matched again', async () => {
    const asked = await rpc('inbox/request', await tokenFor(member), {
      command: 'finance.journal.reverse',
      input: { entryId: receiptEntry, entryDate: '2026-10-05', reason: 'Nhầm khách hàng' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    expect((await approve(adminUser, String(asked.body.proposalId))).status).toBe(200);
    expect((await states()).FT101).toEqual({ status: 'open' });
    const again = await ask(member, receipt());
    expect(again.status).toBe(200);
    expect((await approve(owner, String(again.body.proposalId))).status).toBe(200);
    // A new number: the reversed BC00001 keeps its own.
    expect((await states()).FT101).toMatchObject({ status: 'matched', code: 'BC00002' });
  });

  it('holds every writer to the link in the database', async () => {
    const insert = (c: pg.Client, values: { type?: string; line?: string | undefined; amount?: string; date?: string; account?: string; org?: string }) =>
      c.query(
        `INSERT INTO crove_finance.cash_voucher (org_id, voucher_type, number, voucher_date, cash_account, description, amount, bank_line_id)
         VALUES ($1, $2, 1, $3, $4, 'x', $5, $6)`,
        [values.org ?? org.orgId, values.type ?? 'bank_credit', values.date ?? '2026-10-01', values.account ?? '1121', values.amount ?? '1500000', values.line ?? lineId.FT101],
      );
    const attempt = (values: Parameters<typeof insert>[1]) =>
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await insert(c, values);
          return 'inserted';
        } catch (error) {
          return String((error as Error).message);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    // Settled by BC00002.
    expect(await attempt({})).toMatch(/is already settled by another cash voucher/);
    // Lines the voucher does not follow.
    expect(await attempt({ line: lineId.FT103, type: 'bank_debit', amount: '12000', date: '2026-10-03' })).toMatch(/does not match bank line/);
    expect(await attempt({ line: lineId.FT103, type: 'bank_credit', amount: '11000', date: '2026-10-03' })).toMatch(/does not match bank line/);
    expect(await attempt({ line: lineId.FT103, type: 'bank_debit', amount: '11000', date: '2026-10-04' })).toMatch(/does not match bank line/);
    // Only a bank voucher names a line, and another org's voucher cannot name this org's line.
    expect(await attempt({ line: lineId.FT103, type: 'cash_payment', account: '1111', amount: '11000', date: '2026-10-03' })).toMatch(/cash_voucher_bank_line_type/);
    expect(await attempt({ org: other.orgId, line: lineId.FT103, type: 'bank_debit', amount: '11000', date: '2026-10-03' })).toMatch(/cash_voucher_bank_line_fk/);
    // A line that fits passes this check (and then needs its journal entry by commit, as every voucher does).
    expect(await attempt({ line: lineId.FT103, type: 'bank_debit', amount: '11000', date: '2026-10-03' })).toBe('inserted');
  });
});
