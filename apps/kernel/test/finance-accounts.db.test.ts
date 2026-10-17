// The org's chart of accounts (issue #319) on a real PostgreSQL 17, through the HTTP API where a user acts: sub-accounts
// under TT133 accounts (added, renamed, deactivated and reactivated by owners and admins), a vendor default that is a
// sub-account and the posting that uses it, and the rules that keep posted entries on their account: a sub-account is
// never deleted and its code never changes, a journal line names only an account of its own org, and a deactivated
// sub-account still reverses. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-sub-accounts-0123456789';
const ISSUER = 'crove-auth';
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

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

suite('chart of accounts: TT133 plus the org sub-accounts (#319)', () => {
  const dbName = `crove_test_sub_accounts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@sub-accounts.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@sub-accounts.test', session: randomUUID(), userId: '' };
  const other: Account = { subject: randomUUID(), email: 'other@sub-accounts.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let orgB = { slug: '', orgId: '' };

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

  // One statement as crove_app in the given user's context of an org, rolled back.
  async function asApp<T>(userId: string, orgId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }

  // The same, committed.
  async function commitAsApp<T>(userId: string, orgId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
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

  async function rpc(path: string, who: Account, input: unknown, slug: string | null = org.slug, options: { mfa?: boolean } = {}) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const invoice = (number: string) =>
    new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`));

  // Uploads the fixture invoice under a new number and reads it into a proposal.
  async function propose(number: string) {
    const bytes = invoice(number);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const proposal = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    return String(proposal.proposalId);
  }

  const detail = async (id: string) => (await rpc('inbox/get', owner, { id })).body as { revision: number; payload: { lines: Array<{ lineNo: number; debitAccount: string }> } };

  const approve = (id: string, revision: number) =>
    runtime.execute<{ documentId?: string; journalEntryId: string }>('kernel.proposal.approve', { id, revision }, { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });

  // Sets every line of a pending proposal to `account` (a new revision), then approves it.
  async function recordOn(id: string, account: string) {
    const before = await detail(id);
    const edited = await rpc('inbox/edit', owner, {
      id,
      revision: before.revision,
      lineAccounts: before.payload.lines.map((l) => ({ lineNo: l.lineNo, debitAccount: account })),
      idempotencyKey: randomUUID(),
    });
    expect(edited).toMatchObject({ status: 200, body: { changed: true } });
    return approve(id, Number(edited.body.revision));
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
    appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, member, other]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Công ty Tài khoản con', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const createdB = await rpc('org/create', other, { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    orgB = { slug: String(createdB.body?.slug), orgId: String(createdB.body?.orgId) };
    // A member (no chart changes) through an invite; inviting is R3, so the owner holds a fresh second factor.
    const invite = await rpc('org/invite', owner, { email: member.email, role: 'member' }, org.slug, { mfa: true });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', member, { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
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

  let documentEntry = '';

  it('adds sub-accounts under TT133 accounts and digit sub-accounts, which inherit the TT133 root', async () => {
    expect(await rpc('accounts/create', owner, { parentCode: '1121', code: '11211', name: 'Tài khoản thanh toán' })).toMatchObject({ status: 200, body: { code: '11211' } });
    expect(await rpc('accounts/create', owner, { parentCode: '11211', code: '11211.VCB', name: 'Vietcombank' })).toMatchObject({ status: 200 });
    expect(await rpc('accounts/create', owner, { parentCode: '6422', code: '6422.MKT', name: 'Marketing' })).toMatchObject({ status: 200 });
    // In org B, a sub-account org A cannot see or use.
    expect(await rpc('accounts/create', other, { parentCode: '6422', code: '64229', name: 'Chỉ của org B' }, orgB.slug)).toMatchObject({ status: 200 });

    const list = await rpc('accounts/list', member, undefined);
    expect(list.status).toBe(200);
    const byCode = new Map((list.body as Array<{ code: string }>).map((a) => [a.code, a]));
    expect(byCode.get('112')).toEqual({ code: '112', name: 'Tiền gửi ngân hàng', parentCode: null, rootCode: '112', active: true, custom: false });
    // The whole TT133 appendix is in the chart: 1121 is a TT133 account, so the org's accounts go under it.
    expect(byCode.get('1121')).toEqual({ code: '1121', name: 'Tiền Việt Nam', parentCode: '112', rootCode: '1121', active: true, custom: false });
    expect(byCode.get('11211')).toEqual({ code: '11211', name: 'Tài khoản thanh toán', parentCode: '1121', rootCode: '1121', active: true, custom: true });
    expect(byCode.get('11211.VCB')).toEqual({ code: '11211.VCB', name: 'Vietcombank', parentCode: '11211', rootCode: '1121', active: true, custom: true });
    expect(byCode.get('33311')).toMatchObject({ parentCode: '3331', custom: false });
    expect(byCode.has('64229')).toBe(false);
    // Ordered by code, so each sub-account follows its parent.
    const codes = (list.body as Array<{ code: string }>).map((a) => a.code);
    expect(codes.indexOf('1121')).toBeLessThan(codes.indexOf('11211'));
    expect(codes.indexOf('11211')).toBeLessThan(codes.indexOf('11211.VCB'));
  });

  it('refuses codes outside the rules, TT133 changes and members', async () => {
    const create = (input: Record<string, string>, who = owner) => rpc('accounts/create', who, input);
    expect(await create({ parentCode: '112', code: '1131', name: 'x' })).toMatchObject({ status: 422, body: { code: 'INVALID_SUB_ACCOUNT_CODE' } });
    expect(await create({ parentCode: '112', code: '112.vcb', name: 'x' })).toMatchObject({ status: 400 });
    expect(await create({ parentCode: '11211.VCB', code: '112111', name: 'x' })).toMatchObject({ status: 422, body: { code: 'PARENT_TAGGED' } });
    expect(await create({ parentCode: '112', code: '1121', name: 'x' })).toMatchObject({ status: 409, body: { code: 'ACCOUNT_CODE_TAKEN' } });
    // A digit code goes under the most detailed account it extends, at the database too.
    expect(await create({ parentCode: '133', code: '13321', name: 'x' })).toMatchObject({ status: 422, body: { code: 'PARENT_NOT_DEEPEST', data: { parentCode: '1332' } } });
    expect(await create({ parentCode: '1121', code: '112112', name: 'x' })).toMatchObject({ status: 422, body: { code: 'PARENT_NOT_DEEPEST', data: { parentCode: '11211' } } });
    await expect(
      admin((c) => c.query(`INSERT INTO crove_finance.org_account (org_id, code, name, parent_code) VALUES ($1, '13321', 'x', '133')`, [org.orgId])),
    ).rejects.toThrow(/most detailed account/);
    expect(await create({ parentCode: '133', code: '1331', name: 'x' })).toMatchObject({ status: 409, body: { code: 'ACCOUNT_CODE_TAKEN' } });
    expect(await create({ parentCode: '6422', code: '6422.MKT', name: 'x' })).toMatchObject({ status: 409, body: { code: 'ACCOUNT_CODE_TAKEN' } });
    expect(await create({ parentCode: '999', code: '999.X', name: 'x' })).toMatchObject({ status: 422, body: { code: 'PARENT_NOT_FOUND' } });
    // Another org's sub-account is no parent here.
    expect(await create({ parentCode: '64229', code: '642291', name: 'x' })).toMatchObject({ status: 422, body: { code: 'PARENT_NOT_FOUND' } });
    expect(await create({ parentCode: '6422', code: '6422.BAD', name: 'x' }, member)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('accounts/update', owner, { code: '6422', name: 'Đổi tên' })).toMatchObject({ status: 422, body: { code: 'ACCOUNT_READ_ONLY' } });
    expect(await rpc('accounts/update', owner, { code: '64229', active: false })).toMatchObject({ status: 404, body: { code: 'ACCOUNT_NOT_FOUND' } });
    expect(await rpc('accounts/update', member, { code: '6422.MKT', name: 'x' })).toMatchObject({ status: 403 });
  });

  it('posts an approved invoice on a sub-account and makes it the vendor default the next invoice uses', async () => {
    const first = await propose('9001');
    const recorded = await recordOn(first, '6422.MKT');
    documentEntry = recorded.journalEntryId;
    const entry = await rpc('journal/get', member, { id: documentEntry });
    expect(entry.body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountCode: '6422.MKT', accountName: 'Marketing' })]));
    const vendors = await rpc('parties/list', member, {});
    expect(vendors.body).toEqual([expect.objectContaining({ name: SELLER, defaultAccount: '6422.MKT' })]);

    // The next invoice of the vendor is proposed on its default, and approving it as proposed posts there.
    const second = await propose('9002');
    const proposed = await detail(second);
    expect(proposed.payload.lines.every((l) => l.debitAccount === '6422.MKT')).toBe(true);
    const posted = await approve(second, proposed.revision);
    const lines = await admin(async (c) =>
      (await c.query<{ account_code: string }>('SELECT DISTINCT account_code FROM crove_finance.journal_line WHERE entry_id = $1 ORDER BY 1', [posted.journalEntryId])).rows,
    );
    expect(lines.map((l) => l.account_code)).toEqual(['1331', '331', '6422.MKT']);
  });

  it('rolls sub-accounts up in the ledger reports: trial balance, the parent general ledger and payables per vendor', async () => {
    // A payable on a sub-account of 331, for the vendor, in the same month as the invoices.
    expect(await rpc('accounts/create', owner, { parentCode: '331', code: '331.NCC', name: 'Phải trả nhà cung cấp dịch vụ' })).toMatchObject({ status: 200 });
    const [vendor] = (await rpc('parties/list', owner, {})).body as Array<{ id: string }>;
    await commitAsApp(owner.userId, org.orgId, (c) =>
      c.query(`SELECT crove_finance.post_journal_entry('2026-09-20', 'Phí dịch vụ', 'test', $1::uuid, $2::jsonb)`, [
        randomUUID(),
        JSON.stringify([
          { line_no: 1, account_code: '6422.MKT', debit: '50000', credit: '0' },
          { line_no: 2, account_code: '331.NCC', debit: '0', credit: '50000', party_id: vendor?.id },
        ]),
      ]),
    );
    const sums = await admin(async (c) =>
      (await c.query<{ prefix: string; debit: string; credit: string }>(
        `SELECT p AS prefix, coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
           FROM unnest(ARRAY['642', '6422', '6422.MKT', '331']) p
           LEFT JOIN crove_finance.journal_line l ON l.org_id = $1 AND l.account_code LIKE p || '%'
           LEFT JOIN crove_finance.journal_entry j ON j.org_id = l.org_id AND j.id = l.entry_id
          WHERE j.entry_date IS NULL OR j.entry_date BETWEEN '2026-09-01' AND '2026-09-30'
          GROUP BY p`,
        [org.orgId],
      )).rows,
    );
    const sum = (prefix: string) => sums.find((r) => r.prefix === prefix);
    const report = await runtime.query<{
      trialBalance: { rows: Array<{ accountCode: string; parentCode: string | null; level: number; debit: string; credit: string }>; balanced: boolean };
      payables: { rows: Array<{ partyId: string | null; increase: string; closing: string }> };
    }>('finance.ledger.period', { period: '2026-09' }, { actor: asUser(owner.userId), orgId: org.orgId });
    const row = (code: string) => report.trialBalance.rows.find((r) => r.accountCode === code);
    // The sub-account sits under 6422, under 642, and the parents count its lines.
    expect(row('6422.MKT')).toMatchObject({ parentCode: '6422', level: 2 });
    expect(row('331.NCC')).toMatchObject({ parentCode: '331', level: 1 });
    expect(Number(row('6422.MKT')?.debit)).toBe(Number(sum('6422.MKT')?.debit));
    expect(Number(row('6422')?.debit)).toBe(Number(sum('6422')?.debit));
    expect(Number(row('642')?.debit)).toBe(Number(sum('642')?.debit));
    expect(Number(row('331')?.credit)).toBe(Number(sum('331')?.credit));
    expect(report.trialBalance.rows.filter((r) => r.level === 0).map((r) => r.accountCode)).not.toContain('6422.MKT');
    expect(report.trialBalance.balanced).toBe(true);
    // The general ledger of 6422 lists the lines on its sub-account.
    const ledger = await runtime.query<{ lines: Array<{ accountCode: string }> }>(
      'finance.ledger.account',
      { period: '2026-09', accountCode: '6422' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(ledger.lines.length).toBeGreaterThan(0);
    expect(ledger.lines.every((l) => l.accountCode.startsWith('6422'))).toBe(true);
    expect(ledger.lines.some((l) => l.accountCode === '6422.MKT')).toBe(true);
    // Payables per vendor include the 331 sub-account: the vendor owes the two invoices plus the fee.
    const payable = report.payables.rows.find((r) => r.partyId === vendor?.id);
    expect(Number(payable?.increase)).toBe(Number(sum('331')?.credit));
  });

  it('sets a vendor default by hand, only to an account of the org that is in use', async () => {
    const [vendor] = (await rpc('parties/list', owner, {})).body as Array<{ id: string }>;
    const partyId = String(vendor?.id);
    expect(await rpc('parties/setDefaultAccount', member, { partyId, accountCode: '11211.VCB' })).toMatchObject({ status: 403 });
    expect(await rpc('parties/setDefaultAccount', owner, { partyId, accountCode: '64229' })).toMatchObject({ status: 422, body: { code: 'UNKNOWN_ACCOUNT' } });
    expect(await rpc('parties/setDefaultAccount', owner, { partyId, accountCode: '11211.VCB' })).toEqual({ status: 200, body: { partyId, accountCode: '11211.VCB' } });
    expect(await rpc('parties/setDefaultAccount', owner, { partyId, accountCode: '6422.MKT' })).toEqual({ status: 200, body: { partyId, accountCode: '6422.MKT' } });
    const audit = await admin(async (c) =>
      (await c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.vendor.set_default_account' AND outcome = 'ok' ORDER BY occurred_at, id`,
        [org.orgId],
      )).rows,
    );
    expect(audit.map((a) => [a.detail.previous, a.detail.accountCode])).toEqual([
      ['6422.MKT', '11211.VCB'],
      ['11211.VCB', '6422.MKT'],
    ]);
  });

  it('keeps a vendor default and a parent with active sub-accounts in use, and says why', async () => {
    const refused = await rpc('accounts/update', owner, { code: '6422.MKT', active: false });
    expect(refused).toMatchObject({ status: 409, body: { code: 'ACCOUNT_IS_VENDOR_DEFAULT', data: { count: 1 } } });
    expect(String(refused.body.message)).toContain(SELLER);
    expect(await rpc('accounts/update', owner, { code: '11211', active: false })).toMatchObject({ status: 409, body: { code: 'ACCOUNT_HAS_SUB_ACCOUNTS' } });
    // The database refuses the same, whoever writes.
    await expect(admin((c) => c.query(`UPDATE crove_finance.org_account SET active = false WHERE org_id = $1 AND code = '6422.MKT'`, [org.orgId]))).rejects.toThrow(
      /default account of a vendor/,
    );
  });

  it('deactivates and renames without touching posted entries, refuses new postings, and still reverses', async () => {
    const [vendor] = (await rpc('parties/list', owner, {})).body as Array<{ id: string }>;
    expect((await rpc('parties/setDefaultAccount', owner, { partyId: vendor?.id, accountCode: '6422' })).status).toBe(200);
    // A proposal edited onto the sub-account while it was in use.
    const pending = await propose('9003');
    const edited = await rpc('inbox/edit', owner, { id: pending, revision: 1, lineAccounts: [{ lineNo: 1, debitAccount: '6422.MKT' }], idempotencyKey: randomUUID() });
    expect(edited).toMatchObject({ status: 200, body: { revision: 2, changed: true } });
    expect(await rpc('accounts/update', owner, { code: '6422.MKT', name: 'Quảng cáo', active: false })).toEqual({
      status: 200,
      body: { code: '6422.MKT', name: 'Quảng cáo', active: false },
    });
    // The posted line keeps its code; the journal shows the account's current name.
    const entry = await rpc('journal/get', owner, { id: documentEntry });
    expect(entry.body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountCode: '6422.MKT', accountName: 'Quảng cáo' })]));
    // Listed as inactive; not usable for a new posting, a revision or a vendor default.
    const list = (await rpc('accounts/list', owner, undefined)).body as Array<{ code: string; active: boolean }>;
    expect(list.find((a) => a.code === '6422.MKT')).toMatchObject({ active: false });
    await expect(approve(pending, 2)).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE', status: 422 });
    const edit = await rpc('inbox/edit', owner, { id: pending, revision: 2, lineAccounts: [{ lineNo: 2, debitAccount: '6422.MKT' }], idempotencyKey: randomUUID() });
    expect(edit).toMatchObject({ status: 422, body: { code: 'ACCOUNT_INACTIVE' } });
    expect(await rpc('parties/setDefaultAccount', owner, { partyId: vendor?.id, accountCode: '6422.MKT' })).toMatchObject({ status: 422, body: { code: 'ACCOUNT_INACTIVE' } });
    await expect(
      asApp(owner.userId, org.orgId, (c) =>
        c.query(`INSERT INTO crove_finance.vendor_account_rule (org_id, party_id, debit_account) VALUES ($1, $2, '6422.MKT')
                 ON CONFLICT (org_id, party_id) DO UPDATE SET debit_account = excluded.debit_account`, [org.orgId, vendor?.id]),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // A reversal mirrors the entry's lines, inactive sub-account included.
    const asked = await rpc('inbox/request', owner, {
      command: 'finance.journal.reverse',
      input: { entryId: documentEntry, entryDate: '2026-10-15', reason: 'Ghi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const reversal = await approve(String(asked.body.proposalId), 1);
    const mirrored = await admin(async (c) =>
      (await c.query<{ account_code: string }>(`SELECT account_code FROM crove_finance.journal_line WHERE entry_id = $1 AND account_code LIKE '6422.%'`, [reversal.journalEntryId])).rows,
    );
    expect(mirrored.length).toBeGreaterThan(0);

    // Reactivating brings it back; a sub-account under an inactive parent waits for the parent.
    expect(await rpc('accounts/update', owner, { code: '11211.VCB', active: false })).toMatchObject({ status: 200 });
    expect(await rpc('accounts/update', owner, { code: '11211', active: false })).toMatchObject({ status: 200 });
    expect(await rpc('accounts/update', owner, { code: '11211.VCB', active: true })).toMatchObject({ status: 409, body: { code: 'PARENT_INACTIVE' } });
    // No new sub-account goes under an inactive one, at the database either.
    expect(await rpc('accounts/create', owner, { parentCode: '11211', code: '11211.ACB', name: 'x' })).toMatchObject({ status: 422, body: { code: 'PARENT_INACTIVE' } });
    await expect(
      admin((c) => c.query(`INSERT INTO crove_finance.org_account (org_id, code, name, parent_code) VALUES ($1, '11211.ACB', 'x', '11211')`, [org.orgId])),
    ).rejects.toThrow(/active sub-account/);
    expect(await rpc('accounts/update', owner, { code: '6422.MKT', active: true })).toMatchObject({ status: 200, body: { active: true } });

    const audit = await admin(async (c) =>
      (await c.query<{ command: string; n: number }>(
        `SELECT command, count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.account.%' AND outcome = 'ok' GROUP BY 1 ORDER BY 1`,
        [org.orgId],
      )).rows,
    );
    expect(audit).toEqual([
      { command: 'finance.account.create', n: 4 },
      { command: 'finance.account.update', n: 4 },
    ]);
  });

  it('imports opening balances onto active sub-accounts only (#320)', async () => {
    expect(await rpc('accounts/create', owner, { parentCode: '1121', code: '1121.ACB', name: 'ACB' })).toMatchObject({ status: 200 });
    const input = (code: string) => ({
      asOf: '2026-08-31',
      rows: [
        { rowNo: 2, accountCode: code, accountName: '', debit: '1000000', credit: '' },
        { rowNo: 3, accountCode: '4111', accountName: '', debit: '', credit: '1000000' },
      ],
    });
    const preview = (code: string) =>
      runtime.query<{ ok: boolean; rows: Array<{ accountCode: string; accountName: string; errors: string[] }> }>('finance.opening_balance.preview', input(code), {
        actor: asUser(owner.userId),
        orgId: org.orgId,
      });
    // 11211.VCB was deactivated above; 64229 is org B's.
    expect((await preview('11211.VCB')).rows[0]).toMatchObject({ errors: ['ACCOUNT_INACTIVE'] });
    expect((await preview('64229')).rows[0]).toMatchObject({ errors: ['ACCOUNT_UNKNOWN'] });
    const ok = await preview('1121.ACB');
    expect(ok.ok).toBe(true);
    expect(ok.rows[0]).toMatchObject({ accountCode: '1121.ACB', accountName: 'ACB', errors: [] });
    const posted = await runtime.execute<{ journalEntryId: string }>('finance.opening_balance.post', input('1121.ACB'), {
      actor: asMfa(owner.userId),
      orgId: org.orgId,
      idempotencyKey: randomUUID(),
    });
    const lines = await admin(async (c) =>
      (await c.query<{ account_code: string }>('SELECT account_code FROM crove_finance.journal_line WHERE entry_id = $1 ORDER BY line_no', [posted.journalEntryId])).rows,
    );
    expect(lines.map((l) => l.account_code)).toEqual(['1121.ACB', '4111']);
  });

  it('never deletes a sub-account or changes its code, and keeps the TT133 codes', async () => {
    await expect(asApp(owner.userId, org.orgId, (c) => c.query(`DELETE FROM crove_finance.org_account WHERE code = '6422.MKT'`))).rejects.toThrow(/permission denied/);
    await expect(asApp(owner.userId, org.orgId, (c) => c.query(`UPDATE crove_finance.org_account SET code = '6422.ADS' WHERE code = '6422.MKT'`))).rejects.toThrow(
      /permission denied/,
    );
    // Not even the owner of the table.
    await expect(admin((c) => c.query(`DELETE FROM crove_finance.org_account WHERE org_id = $1`, [org.orgId]))).rejects.toThrow(/never deleted/);
    await expect(admin((c) => c.query(`UPDATE crove_finance.org_account SET code = '6422.ADS' WHERE code = '6422.MKT'`))).rejects.toThrow(/only its name/);
    await expect(admin((c) => c.query(`TRUNCATE crove_finance.org_account CASCADE`))).rejects.toThrow(/never deleted/);
    await expect(admin((c) => c.query(`DELETE FROM crove_finance.account WHERE code = '811'`))).rejects.toThrow(/never deleted or changed/);
    await expect(admin((c) => c.query(`UPDATE crove_finance.account SET code = '8111' WHERE code = '811'`))).rejects.toThrow(/never deleted or changed/);
    // A TT133 code that an org already uses for a sub-account cannot be added to the global chart.
    await expect(admin((c) => c.query(`INSERT INTO crove_finance.account (code, name, parent_code) VALUES ('11211', 'Tài khoản thanh toán', '1121')`))).rejects.toThrow(
      /already a sub-account/,
    );
    expect(await admin(async (c) => (await c.query(`UPDATE crove_finance.account SET name = name WHERE code = '811'`)).rowCount)).toBe(1);
  });

  it('posts only on accounts of the org: another org sub-account or an unknown code is a foreign key error', async () => {
    const post = (account: string) =>
      asApp(owner.userId, org.orgId, (c) =>
        c.query(`SELECT crove_finance.post_journal_entry('2026-10-01', 'x', 'test', $1::uuid, $2::jsonb)`, [
          randomUUID(),
          JSON.stringify([
            { line_no: 1, account_code: account, debit: '100', credit: '0' },
            { line_no: 2, account_code: '331', debit: '0', credit: '100' },
          ]),
        ]),
      );
    await expect(post('64229')).rejects.toMatchObject({ code: '23503', message: expect.stringMatching(/foreign key/) });
    await expect(post('6429')).rejects.toMatchObject({ code: '23503' });
    expect((await post('11211.VCB')).rowCount).toBe(1);
    // Purchase lines are held to the same rule.
    await expect(
      asApp(owner.userId, org.orgId, async (c) => {
        const { rows } = await c.query<{ id: string }>(`SELECT id FROM crove_finance.purchase_document LIMIT 1`);
        return c.query(
          `INSERT INTO crove_finance.purchase_line (org_id, document_id, line_no, description, amount, debit_account) VALUES ($1, $2, 99, 'x', 1, '64229')`,
          [org.orgId, rows[0]?.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
