// Bank statement import (issue #326, stage 1), on a real PostgreSQL 17, through the HTTP API: a statement becomes the
// lines of a bank account, an overlapping re-import stores only what it adds, "+X, -X, +X" on one day keeps all three,
// lines with neither reference nor balance are flagged instead of dropped or doubled, a newest-first file is stored
// oldest first, a mid-day overlap shows as a break in the running balance, and the account, the roles and the org
// boundary are checked. A bank feed's lines (ADR-0039, #2044) go through the same path: finance.bank.ingest, a system
// command, stores what is new, and a transaction the feed and a statement file both report is one line. The rules
// themselves are unit-tested in modules/finance/test/bank-statement.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeStatementAmount, type BankFeedLine, type BankImportResult, type BankStatementRow } from '@crove/kernel-contract';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-statements-0123456789';
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

suite('bank statement import (#326)', () => {
  const dbName = `crove_test_bank_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  // With the sandbox bank feed on (ADR-0039, #2044), and a credential key to seal its secret.
  let feedApp: ReturnType<typeof createHttpApp>;
  // The API's runtime, and the worker's, which runs feed jobs as the system.
  let api: Runtime;
  let worker: Runtime;
  const workerPools: pg.Pool[] = [];
  const owner: Account = { subject: randomUUID(), email: 'owner@bank.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@bank.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@bank.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@bank.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';
  let otherSlug = '';

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

  async function rpc(path: string, token: string, input: unknown, org: string | null = slug, on: ReturnType<typeof createHttpApp> = app) {
    const response = await on.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // A row as the browser sends it: amounts printed as text cells, normalized.
  let rowNo = 1;
  const row = (date: string, moneyIn: string, moneyOut: string, balance = '', reference = '', description = 'Giao dịch'): BankStatementRow => ({
    rowNo: rowNo++,
    date,
    description,
    moneyIn: normalizeStatementAmount(moneyIn),
    moneyOut: normalizeStatementAmount(moneyOut),
    balance: normalizeStatementAmount(balance),
    reference,
  });
  const file = (rows: BankStatementRow[], bankAccount = '1121') => ({ bankAccount, filename: 'sao-ke.xlsx', rows });
  const preview = async (rows: BankStatementRow[], bankAccount = '1121', who = member) => rpc('bank/preview', await tokenFor(who), file(rows, bankAccount));
  const importFile = async (rows: BankStatementRow[], bankAccount = '1121', who = member, org = slug) =>
    rpc('bank/import', await tokenFor(who), { ...file(rows, bankAccount), idempotencyKey: randomUUID() }, org);
  const lines = async (period: string, bankAccount = '1121', who = viewer) => rpc('bank/lines', await tokenFor(who), { bankAccount, period });
  const stored = (account = '1121') =>
    admin(
      async (c) =>
        (
          await c.query<{ value_date: string; amount: string; running_balance: string | null; bank_ref: string | null; dedupe_key: string | null; ambiguous: boolean; position: number }>(
            `SELECT to_char(value_date, 'YYYY-MM-DD') AS value_date, amount::text, running_balance::text, bank_ref, dedupe_key, ambiguous, position
             FROM crove_finance.bank_line WHERE org_id = $1 AND bank_account = $2 ORDER BY value_date, import_id, position`,
            [orgId, account],
          )
        ).rows,
    );

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    const db: Db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    api = runtime;
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    feedApp = createHttpApp({
      config,
      runtime,
      store: new MemoryStore(),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      channels: { broker: vault, sandbox: false, bankFeedSandbox: true },
    });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    workerPools.push(workerPool);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });

    for (const who of [owner, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Ngân hàng', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    for (const [who, role] of [
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role });
      expect(invite.status).toBe(200);
      expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    }
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherSlug = String(other.body?.slug);
    // A bank sub-account per bank (#319), and one the org stopped using.
    for (const [code, name] of [
      ['1121.VCB', 'Vietcombank'],
      ['1121.OLD', 'Tài khoản cũ'],
    ]) {
      expect((await rpc('accounts/create', await tokenFor(owner), { parentCode: '1121', code, name })).status).toBe(200);
    }
    expect((await rpc('accounts/update', await tokenFor(owner), { code: '1121.OLD', active: false })).status).toBe(200);
    // The other org's own sub-account, which this org cannot use.
    expect((await rpc('accounts/create', await tokenFor(outsider), { parentCode: '1121', code: '1121.ACB', name: 'ACB' }, otherSlug)).status).toBe(200);
  });

  afterAll(async () => {
    await pool?.end();
    for (const p of workerPools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('imports a statement, then stores only the lines an overlapping one adds', async () => {
    const first = [
      row('01/09/2026', '50.000.000', '', '50.000.000', 'FT001', 'Góp vốn'),
      row('03/09/2026', '', '11.000', '49.989.000', 'FT002', 'Phí SMS'),
      row('05/09/2026', '', '19.800.000', '30.189.000', 'FT003', 'Trả tiền hàng'),
    ];
    const checked = await preview(first);
    expect(checked).toMatchObject({ status: 200, body: { ok: true, order: 'oldest_first', counts: { new: 3, duplicate: 0, ambiguous: 0, invalid: 0 }, breaks: [], from: '2026-09-01', to: '2026-09-05' } });
    expect(await stored()).toEqual([]);
    const imported = await importFile(first);
    expect(imported).toMatchObject({ status: 200, body: { counts: { new: 3 }, breaks: [] } });
    // The overlapping export repeats two lines and adds one.
    const again = await importFile([first[1] as BankStatementRow, first[2] as BankStatementRow, row('07/09/2026', '2.000.000', '', '32.189.000', 'FT004', 'Khách trả tiền')]);
    expect(again).toMatchObject({ status: 200, body: { counts: { new: 1, duplicate: 2, ambiguous: 0, invalid: 0 }, breaks: [] } });
    expect((await stored()).map((l) => [l.value_date, l.amount, l.bank_ref, l.dedupe_key])).toEqual([
      ['2026-09-01', '50000000.0000', 'FT001', 'ref:FT001'],
      ['2026-09-03', '-11000.0000', 'FT002', 'ref:FT002'],
      ['2026-09-05', '-19800000.0000', 'FT003', 'ref:FT003'],
      ['2026-09-07', '2000000.0000', 'FT004', 'ref:FT004'],
    ]);
    const audits = await admin(
      async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.bank.import' AND outcome = 'ok' ORDER BY occurred_at`, [orgId])).rows,
    );
    expect(audits.map((a) => a.detail)).toEqual([
      expect.objectContaining({ bankAccount: '1121', new: 3, duplicate: 0, from: '2026-09-01', to: '2026-09-05', breaks: 0, filename: 'sao-ke.xlsx' }),
      expect.objectContaining({ bankAccount: '1121', new: 1, duplicate: 2 }),
    ]);
    // The lines of September, with money in and out.
    expect(await lines('2026-09')).toMatchObject({
      status: 200,
      body: { from: '2026-09-01', to: '2026-09-30', moneyIn: '52000000', moneyOut: '19811000', lines: [{ amount: '50000000', balance: '50000000', reference: 'FT001' }, {}, {}, { date: '2026-09-07' }] },
    });
  });

  it('keeps "+X, -X, +X" on one day, and a re-import of it stores nothing', async () => {
    const day = [row('10/09/2026', '5.000', '', '1.005.000'), row('10/09/2026', '', '5.000', '1.000.000'), row('10/09/2026', '5.000', '', '1.005.000')];
    expect(await importFile(day, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 3, duplicate: 0 } } });
    expect(await importFile(day, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 0, duplicate: 3 } } });
    expect((await stored('1121.VCB')).map((l) => l.dedupe_key)).toEqual([
      'bal:2026-09-10|5000|1005000|0',
      'bal:2026-09-10|-5000|1000000|0',
      'bal:2026-09-10|5000|1005000|1',
    ]);
  });

  it('flags lines with neither reference nor balance when an earlier import has the same date and amount', async () => {
    const plain = [row('12/09/2026', '', '22.000'), row('12/09/2026', '', '22.000')];
    // Identical lines in one file are both kept.
    expect(await importFile(plain, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 2, ambiguous: 0 } } });
    // The same file again: both kept, flagged for a person to decide, never dropped silently.
    expect(await importFile(plain, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 0, ambiguous: 2 } } });
    const twelfth = (await stored('1121.VCB')).filter((l) => l.value_date === '2026-09-12');
    expect(twelfth.map((l) => [l.dedupe_key, l.ambiguous])).toEqual([
      [null, false],
      [null, false],
      [null, true],
      [null, true],
    ]);
    expect((await lines('2026-09', '1121.VCB')).body.lines.filter((l: { ambiguous: boolean }) => l.ambiguous)).toHaveLength(2);
  });

  it('stores a newest-first file oldest first', async () => {
    await importFile(
      [row('22/09/2026', '', '300', '700', 'NB3'), row('21/09/2026', '', '200', '1.000', 'NB2'), row('20/09/2026', '1.200', '', '1.200', 'NB1')],
      '1121.VCB',
    );
    const newest = (await stored('1121.VCB')).filter((l) => l.bank_ref?.startsWith('NB'));
    expect(newest.map((l) => [l.bank_ref, l.position])).toEqual([
      ['NB1', 1],
      ['NB2', 2],
      ['NB3', 3],
    ]);
  });

  it('shows a mid-day overlap that would drop a line as a break in the running balance', async () => {
    // Stored: an export that ended at noon on the 25th.
    await importFile([row('24/09/2026', '100.000', '', '100.000'), row('25/09/2026', '5.000', '', '105.000')], '1121');
    // The next export starts at noon: -5,000 then +5,000 (same date, amount, balance and occurrence as the stored line),
    // then +1,000. The repeated +5,000 is taken for the stored one, so the +1,000 no longer follows from the balance.
    const next = [row('25/09/2026', '', '5.000', '100.000'), row('25/09/2026', '5.000', '', '105.000'), row('25/09/2026', '1.000', '', '106.000')];
    const checked = await preview(next, '1121');
    expect(checked.body.counts).toMatchObject({ new: 2, duplicate: 1 });
    expect(checked.body.breaks).toEqual([{ date: '2026-09-25', rowNo: next[2]?.rowNo, expected: '101000', balance: '106000' }]);
    expect(await importFile(next, '1121')).toMatchObject({ status: 200, body: { breaks: [{ date: '2026-09-25', expected: '101000' }] } });
  });

  it('refuses a file with an unreadable row, and stores none of it', async () => {
    const bad = [row('26/09/2026', '1.000', '', '', 'OK1'), row('Tổng cộng', '1.000', ''), row('27/09/2026', '1', '2', '', 'OK2')];
    const checked = await preview(bad);
    expect(checked.body).toMatchObject({ ok: false, counts: { new: 1, invalid: 2 } });
    expect(checked.body.rows.map((r: { errors: string[] }) => r.errors)).toEqual([[], ['DATE_INVALID'], ['AMOUNT_BOTH']]);
    expect(await importFile(bad)).toMatchObject({ status: 422, body: { code: 'BANK_IMPORT_INVALID', data: { rows: [bad[1]?.rowNo, bad[2]?.rowNo] } } });
    expect((await stored()).some((l) => l.bank_ref === 'OK1')).toBe(false);
  });

  it('takes only bank accounts the org uses, and only importers import', async () => {
    const one = [row('28/09/2026', '1', '')];
    for (const code of ['331', '1111', '1121.ACB', '9999']) {
      expect(await preview(one, code), code).toMatchObject({ status: 422, body: { code: 'NOT_A_BANK_ACCOUNT' } });
    }
    expect(await importFile(one, '1121.OLD')).toMatchObject({ status: 422, body: { code: 'ACCOUNT_INACTIVE' } });
    // An inactive account's lines can still be read.
    expect((await lines('2026-09', '1121.OLD')).status).toBe(200);
    expect(await importFile(one, '1121', viewer)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect((await preview(one, '1121', viewer)).status).toBe(403);
    expect((await importFile(one, '1121', owner)).status).toBe(200);
  });

  it('keeps each org to its own lines, and the lines append-only', async () => {
    expect((await lines('2026-09', '1121', outsider)).status).toBe(403);
    const theirs = await rpc('bank/lines', await tokenFor(outsider), { bankAccount: '1121', period: '2026-09' }, otherSlug);
    expect(theirs).toMatchObject({ status: 200, body: { lines: [], moneyIn: '0', moneyOut: '0' } });
    await expect(admin((c) => c.query(`UPDATE crove_finance.bank_line SET amount = 1 WHERE org_id = $1`, [orgId]))).rejects.toMatchObject({ code: '42501' });
    await expect(admin((c) => c.query(`DELETE FROM crove_finance.bank_line WHERE org_id = $1`, [orgId]))).rejects.toMatchObject({ code: '42501' });
    // The database refuses a line on an account that is not a bank account, whoever writes it.
    await expect(
      admin((c) =>
        c.query(
          `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount) VALUES ($1, '331', $2, 1, '2026-09-01', 'x', 1)`,
          [orgId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  // ADR-0039, #2044: a feed's lines are stored as a statement's are.
  const SYSTEM = { type: 'system' as const, component: 'finance.bank_feed' };
  const feedLine = (date: string, amount: string, reference: string, balance: string | null = null, description = 'Giao dịch'): BankFeedLine => ({
    date,
    description,
    amount,
    balance,
    reference,
  });
  const defaultEntity = () =>
    admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string);
  const ingest = async (lines: BankFeedLine[], bankAccount = '1121.VCB') =>
    worker.execute<BankImportResult>('finance.bank.ingest', { bankAccount, legalEntityId: await defaultEntity(), source: 'sandbox', lines }, { actor: SYSTEM, orgId });

  it("stores a feed's lines once, whether they come again from the feed or in a statement file", async () => {
    const first = await ingest([
      feedLine('2026-11-03', '-22000', 'FT9002', '977978000', 'Phí chuyển tiền'),
      feedLine('2026-11-02', '1000000', 'FT9001', '978000000', 'Khách trả tiền'),
    ]);
    expect(first.counts).toEqual({ new: 2, duplicate: 0, ambiguous: 0, invalid: 0 });
    // The next pull overlaps the first and adds one line.
    const next = await ingest([feedLine('2026-11-03', '-22000', 'FT9002', '977978000'), feedLine('2026-11-04', '5000000', 'FT9003', '982978000')]);
    expect(next.counts).toEqual({ new: 1, duplicate: 1, ambiguous: 0, invalid: 0 });
    expect(next.breaks).toEqual([]);
    // The month's statement file has the same transactions: nothing new.
    const statement = await importFile(
      [row('02/11/2026', '1.000.000', '', '978.000.000', 'FT9001'), row('03/11/2026', '', '22.000', '977.978.000', 'FT9002')],
      '1121.VCB',
    );
    expect(statement.body?.counts).toMatchObject({ new: 0, duplicate: 2 });
    const kept = (await stored('1121.VCB')).filter((l) => l.value_date >= '2026-11-01');
    expect(kept.map((l) => [l.value_date, l.amount, l.dedupe_key])).toEqual([
      ['2026-11-02', '1000000.0000', 'ref:FT9001'],
      ['2026-11-03', '-22000.0000', 'ref:FT9002'],
      ['2026-11-04', '5000000.0000', 'ref:FT9003'],
    ]);
    // The import and the pulls are audited with their source.
    const audits = await admin(
      async (c) =>
        (await c.query<{ detail: { source: string; new: number } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.bank.ingest' AND outcome = 'ok' ORDER BY occurred_at`, [orgId]))
          .rows,
    );
    expect(audits.map((a) => [a.detail.source, a.detail.new])).toEqual([
      ['sandbox', 2],
      ['sandbox', 1],
    ]);
  });

  it('takes feed lines only with a reference, so overlapping pulls never store one twice', async () => {
    const legalEntityId = await defaultEntity();
    const lines = [{ date: '2026-11-10', description: 'Phí', amount: '-11000', balance: null, reference: null }];
    await expect(worker.execute('finance.bank.ingest', { bankAccount: '1121.VCB', legalEntityId, source: 'sandbox', lines }, { actor: SYSTEM, orgId })).rejects.toBeTruthy();
    const fee = [feedLine('2026-11-10', '-11000', 'FT9010')];
    expect((await ingest(fee)).counts).toMatchObject({ new: 1 });
    expect((await ingest(fee)).counts).toEqual({ new: 0, duplicate: 1, ambiguous: 0, invalid: 0 });
  });

  it('refuses a batch with an amount of zero or more than 2 decimals, or a day no statement has, storing none of it', async () => {
    const before = (await stored('1121.VCB')).length;
    await expect(
      ingest([feedLine('2026-11-12', '10000', 'FT9100'), feedLine('2026-11-12', '0', 'FT9101'), feedLine('2026-11-12', '1.005', 'FT9102'), feedLine('9999-12-31', '1', 'FT9103')]),
    ).rejects.toMatchObject({
      code: 'BANK_FEED_INVALID',
      status: 422,
      details: { rows: [2, 3, 4] },
    });
    expect((await stored('1121.VCB')).length).toBe(before);
  });

  it('takes feed lines only from the system, and only for an active bank account of the org', async () => {
    const lines = [feedLine('2026-11-15', '10000', 'FT9200')];
    const legalEntityId = await defaultEntity();
    // On the API's runtime, where an owner's context opens: the command itself refuses anyone but the system.
    await expect(api.execute('finance.bank.ingest', { bankAccount: '1121.VCB', legalEntityId, source: 'sandbox', lines }, { actor: { type: 'user', userId: owner.userId, aal: 'aal2', sessionId: owner.session, mfaAt: null }, orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Không có quyền thực hiện',
    });
    await expect(ingest(lines, '1121.OLD')).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    await expect(ingest(lines, '331')).rejects.toMatchObject({ code: 'NOT_A_BANK_ACCOUNT' });
    await expect(ingest(lines, '1121.ACB')).rejects.toMatchObject({ code: 'NOT_A_BANK_ACCOUNT' });
  });

  // ADR-0039, #2044 part 2a: a bank feed connection's accounts mapped to the org's bank accounts.
  const feed = async (path: string, who: Account, input?: unknown) => rpc(`bankFeeds/${path}`, await tokenFor(who), input, slug, feedApp);

  it('offers the sandbox bank feed only where the deployment turns it on', async () => {
    expect(((await (await feedApp.request('/api/config')).json()) as { bankFeeds: unknown }).bankFeeds).toEqual({ sandbox: true });
    expect(((await (await app.request('/api/config')).json()) as { bankFeeds: unknown }).bankFeeds).toEqual({ sandbox: false });
    expect(await rpc('bankFeeds/connectSandbox', await tokenFor(owner), { displayName: 'Ngân hàng thử' })).toMatchObject({ status: 404, body: { code: 'BANK_FEED_DISABLED' } });
  });

  it('connects the sandbox, maps an account to a bank account, and keeps the connection out of the Social channels', async () => {
    expect((await feed('connectSandbox', member, { displayName: 'Ngân hàng thử' })).status).toBe(403);
    const connected = await feed('connectSandbox', owner, { displayName: 'Ngân hàng thử' });
    expect(connected.status).toBe(200);
    expect(connected.body.accounts.map((a: { externalAccountId: string }) => a.externalAccountId)).toEqual(['SBX-001', 'SBX-002']);
    const connectionId = String(connected.body.connectionId);
    // Sealed like any channel's: a credential row holds it, and no audit row or answer carries a sandbox secret.
    const stored = await admin(async (c) => (await c.query<{ provider: string }>('SELECT provider FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId])).rows);
    expect(stored).toEqual([{ provider: 'bank_sandbox' }]);
    expect(Number((await admin(async (c) => (await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.credential WHERE org_id = $1', [orgId])).rows[0]?.n)))).toBeGreaterThan(0);
    expect(JSON.stringify(connected.body)).not.toMatch(/sbx_/);
    expect(
      await admin(async (c) => (await c.query(`SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%sbx\\_%'`, [orgId])).rows),
    ).toEqual([]);
    expect((await rpc('channels/list', await tokenFor(owner), {}, slug, feedApp)).body.map((c: { id: string }) => c.id)).not.toContain(connectionId);

    const map = (who: Account, input: Record<string, unknown>) => feed('map', who, { connectionId, externalAccountId: 'SBX-001', bankAccount: '1121.VCB', idempotencyKey: randomUUID(), ...input });
    expect((await map(member, {})).status).toBe(403);
    expect((await map(viewer, {})).status).toBe(403);
    expect(await map(owner, { bankAccount: '331' })).toMatchObject({ status: 422, body: { code: 'NOT_A_BANK_ACCOUNT' } });
    expect(await map(owner, { bankAccount: '1121.OLD' })).toMatchObject({ status: 422, body: { code: 'ACCOUNT_INACTIVE' } });
    const mapped = await map(owner, {});
    expect(mapped.status).toBe(200);
    // Mapping it again points it at another bank account of the same entity; another entity takes an unmap first.
    const again = await map(owner, { bankAccount: '1121' });
    expect(again.body.feedAccountId).toBe(mapped.body.feedAccountId);
    const branch = await admin(
      async (c) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh ngân hàng', 'branch', $2) RETURNING id`, [orgId, owner.userId])).rows[0]
          ?.id as string,
    );
    expect(await map(owner, { bankAccount: '1121', legalEntityId: branch })).toMatchObject({ status: 409, body: { code: 'BANK_FEED_ACCOUNT_MAPPED' } });
    const listed = await feed('accounts', viewer);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject([
      { id: mapped.body.feedAccountId, connectionId, provider: 'bank_sandbox', connectionName: 'Ngân hàng thử', connectionStatus: 'active', externalAccountId: 'SBX-001', bankAccount: '1121', lastSyncedAt: null },
    ]);
    // Another org sees none of it, and cannot map this connection.
    expect((await rpc('bankFeeds/accounts', await tokenFor(outsider), {}, otherSlug, feedApp)).body).toEqual([]);
    expect(
      await rpc('bankFeeds/map', await tokenFor(outsider), { connectionId, externalAccountId: 'SBX-001', bankAccount: '1121', idempotencyKey: randomUUID() }, otherSlug, feedApp),
    ).toMatchObject({ status: 404, body: { code: 'BANK_FEED_NOT_FOUND' } });

    // Unmapped, it is gone from the list; a second unmap finds nothing.
    expect((await feed('unmap', member, { feedAccountId: mapped.body.feedAccountId, idempotencyKey: randomUUID() })).status).toBe(403);
    expect((await feed('unmap', owner, { feedAccountId: mapped.body.feedAccountId, idempotencyKey: randomUUID() })).status).toBe(200);
    expect((await feed('accounts', owner)).body).toEqual([]);
    expect(await feed('unmap', owner, { feedAccountId: mapped.body.feedAccountId, idempotencyKey: randomUUID() })).toMatchObject({ status: 404, body: { code: 'BANK_FEED_ACCOUNT_NOT_FOUND' } });
  });

  it('maps only a bank feed connection, and only an active one', async () => {
    const social = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.channel_connection (org_id, provider, external_account_id, display_name, connected_by) VALUES ($1, 'sandbox', $2, 'Trang', $3) RETURNING id`,
            [orgId, randomUUID(), owner.userId],
          )
        ).rows[0]?.id as string,
    );
    expect(await feed('map', owner, { connectionId: social, externalAccountId: 'SBX-001', bankAccount: '1121', idempotencyKey: randomUUID() })).toMatchObject({
      status: 404,
      body: { code: 'BANK_FEED_NOT_FOUND' },
    });
    const connectionId = String((await feed('connectSandbox', owner, { displayName: 'Ngân hàng cũ' })).body.connectionId);
    await admin((c) => c.query(`UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2`, [orgId, connectionId]));
    expect(await feed('map', owner, { connectionId, externalAccountId: 'SBX-001', bankAccount: '1121', idempotencyKey: randomUUID() })).toMatchObject({
      status: 422,
      body: { code: 'BANK_FEED_INACTIVE' },
    });
  });
});
