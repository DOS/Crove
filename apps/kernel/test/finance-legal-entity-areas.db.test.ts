// The books per legal entity, part 2b (issue #1280) on a real PostgreSQL 17: the finance commands and queries take the
// entity a call is for (legalEntityId; omitted, the org's default entity for an owner) and read and write only its
// books. Cash vouchers and journal vouchers are numbered and posted in the entity named; the journal, the ledger, the
// statements, the vouchers, search and the exports read one entity; opening balances, fixed assets and depreciation,
// bank lines, purchase invoices (a revision moves a proposal to an entity), the VAT working and the learned rules are
// kept per entity; the year-end closing closes one entity's year; and each entity's VAT return carries its own tax
// calendar done mark. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { BankStatementRow, CashVoucherPage, FixedAsset, JournalVoucherRequest, CashVoucherRequest } from '@crove/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, type JournalEntryView, type VatReport } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-legal-entity-areas-0123456789';
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

interface TrialBalanceView {
  trialBalance: { totals: { debit: string; credit: string; openingDebit: string } };
}

const suite = ADMIN ? describe : describe.skip;

suite('finance books per legal entity, part 2b (#1280)', () => {
  const dbName = `crove_test_le_areas_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@le-areas.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@le-areas.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let defaultEntity = '';
  let branch = '';
  let hue = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: owner.session });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: owner.session, mfaAt: Math.floor(Date.now() / 1000) });
  const as = (who: Account) => ({ actor: asUser(who.userId), orgId: org.orgId });

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

  async function rpc(path: string, who: Account, input: unknown, slug: string | null = org.slug, options: { mfa?: boolean } = {}) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const request = (command: string, input: unknown, who = member) =>
    runtime.execute<{ proposalId: string }>('kernel.proposal.request', { command, input }, { ...as(who), idempotencyKey: randomUUID() });

  async function approve(proposalId: string) {
    const detail = await runtime.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, as(owner));
    return runtime.execute<{ journalEntryId: string; voucherId?: string; code?: string; documentId?: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision, acceptUnverifiedSignature: true },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
  }

  const entityOf = (table: string, id: string) =>
    admin(async (c) => (await c.query<{ e: string }>(`SELECT legal_entity_id AS e FROM ${table} WHERE org_id = $1 AND id = $2`, [org.orgId, id])).rows[0]?.e);
  // The entity the Inbox list gives a proposal (#1543).
  const listedEntityOf = async (proposalId: string) =>
    (await runtime.query<Array<{ id: string; legalEntityId: string | null }>>('kernel.inbox.list', {}, as(owner))).find((p) => p.id === proposalId)?.legalEntityId;

  const payment = (date: string, amount: string, legalEntityId?: string): CashVoucherRequest => ({
    type: 'cash_payment',
    date,
    cashAccount: '1111',
    description: `Chi tiếp khách ${amount}`,
    lines: [{ account: '6422', amount }],
    ...(legalEntityId ? { legalEntityId } : {}),
  });

  const nvk = (date: string, amount: string, description: string, legalEntityId?: string, accounts: [string, string] = ['6422', '3388']): JournalVoucherRequest => ({
    date,
    description,
    lines: [
      { account: accounts[0], debit: amount, credit: '0' },
      { account: accounts[1], debit: '0', credit: amount },
    ],
    ...(legalEntityId ? { legalEntityId } : {}),
  });

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
    const db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, member]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Công ty Nhiều Pháp Nhân', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', owner, { email: member.email, role: 'member' }, org.slug, { mfa: true });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', member, { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])).rows[0]?.id as string;
      const add = async (name: string) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'branch', $3) RETURNING id`, [org.orgId, name, owner.userId]))
          .rows[0]?.id as string;
      branch = await add('Chi nhánh Đà Nẵng');
      hue = await add('Chi nhánh Huế');
    });
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

  it('numbers and posts cash and journal vouchers in the entity named, and lists them per entity', async () => {
    const inBranch = await approve((await request('finance.voucher.record', payment('2026-10-02', '300000', branch))).proposalId);
    const inDefault = await approve((await request('finance.voucher.record', payment('2026-10-03', '120000'))).proposalId);
    // Each entity numbers its own series.
    expect([inBranch.code, inDefault.code]).toEqual(['PC00001', 'PC00001']);
    expect(await entityOf('crove_finance.cash_voucher', inBranch.voucherId as string)).toBe(branch);
    expect(await entityOf('crove_finance.journal_entry', inBranch.journalEntryId)).toBe(branch);
    expect(await entityOf('crove_finance.cash_voucher', inDefault.voucherId as string)).toBe(defaultEntity);

    const branchVouchers = await runtime.query<CashVoucherPage>('finance.vouchers.list', { legalEntityId: branch }, as(member));
    expect(branchVouchers.items.map((v) => v.id)).toEqual([inBranch.voucherId]);
    const plainVouchers = await runtime.query<CashVoucherPage>('finance.vouchers.list', {}, as(member));
    expect(plainVouchers.items.map((v) => v.id)).toEqual([inDefault.voucherId]);
    const cash = await runtime.query<Array<{ code: string }>>('finance.vouchers.cash', { type: 'cash_payment', legalEntityId: branch }, as(member));
    expect(cash).toHaveLength(1);

    const journal = await approve((await request('finance.journal_voucher.record', nvk('2026-10-05', '450000', 'Trích trước tiền điện chi nhánh', branch))).proposalId);
    expect(journal.code).toBe('NVK00001');
    expect(await entityOf('crove_finance.journal_voucher', journal.voucherId as string)).toBe(branch);

    // The journal, the ledger and search read one entity.
    const branchJournal = await runtime.query<JournalEntryView[]>('finance.journal.list', { legalEntityId: branch }, as(member));
    expect(branchJournal.map((e) => e.id).sort()).toEqual([inBranch.journalEntryId, journal.journalEntryId].sort());
    const plainJournal = await runtime.query<JournalEntryView[]>('finance.journal.list', {}, as(member));
    expect(plainJournal.map((e) => e.id)).toEqual([inDefault.journalEntryId]);
    const branchLedger = await runtime.query<TrialBalanceView>('finance.ledger.period', { period: '2026-10', legalEntityId: branch }, as(member));
    expect(branchLedger.trialBalance.totals.debit).toBe('750000');
    const plainLedger = await runtime.query<TrialBalanceView>('finance.ledger.period', { period: '2026-10' }, as(member));
    expect(plainLedger.trialBalance.totals.debit).toBe('120000');
    const found = await runtime.query<{ entries: Array<{ id: string }> }>('finance.search', { q: 'tien dien', legalEntityId: branch }, as(member));
    expect(found.entries.map((e) => e.id)).toEqual([journal.journalEntryId]);
    expect((await runtime.query<{ entries: unknown[] }>('finance.search', { q: 'tien dien' }, as(member))).entries).toEqual([]);

    // An entity that is not the org's is refused, for reads and requests.
    await expect(runtime.query('finance.journal.list', { legalEntityId: randomUUID() }, as(member))).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    await expect(request('finance.voucher.record', payment('2026-10-04', '1000', randomUUID()))).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
  });

  it('keeps opening balances, fixed assets and their depreciation per entity', async () => {
    const opening = {
      asOf: '2025-12-31',
      rows: [
        { rowNo: 1, accountCode: '1111', accountName: '', debit: '5000000', credit: '0' },
        { rowNo: 2, accountCode: '4111', accountName: '', debit: '0', credit: '5000000' },
      ],
      legalEntityId: branch,
    };
    const posted = await runtime.execute<{ journalEntryId: string }>('finance.opening_balance.post', opening, { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });
    expect(await entityOf('crove_finance.journal_entry', posted.journalEntryId)).toBe(branch);
    // The branch has its opening entry; the default entity still has none.
    expect(await runtime.query<{ openingEntry: unknown }>('finance.opening_balance.preview', opening, as(owner))).toMatchObject({ openingEntry: { id: posted.journalEntryId } });
    const { legalEntityId: _branch, ...plain } = opening;
    expect(await runtime.query<{ openingEntry: unknown }>('finance.opening_balance.preview', plain, as(owner))).toMatchObject({ openingEntry: null });
    expect(await runtime.query<{ openingDate: string | null }>('finance.period.lock_state', { legalEntityId: branch }, as(owner))).toMatchObject({ openingDate: '2025-12-31' });
    expect(await runtime.query<{ openingDate: string | null }>('finance.period.lock_state', {}, as(owner))).toMatchObject({ openingDate: null });

    const asset = await runtime.execute<{ assetId: string }>(
      'finance.fixed_asset.create',
      { kind: 'prepaid_cost', name: 'Bàn ghế chi nhánh', cost: '1200000', assetAccount: '242', expenseAccount: '6422', startMonth: '2026-01', months: 12, legalEntityId: branch },
      as(member),
    );
    expect(await entityOf('crove_finance.fixed_asset', asset.assetId)).toBe(branch);
    expect((await runtime.query<FixedAsset[]>('finance.fixed_assets.list', { legalEntityId: branch }, as(member))).map((a) => a.id)).toEqual([asset.assetId]);
    expect(await runtime.query<FixedAsset[]>('finance.fixed_assets.list', {}, as(member))).toEqual([]);
    // The default entity's register has nothing to depreciate; the branch's month posts there.
    await expect(request('finance.depreciation.record', { month: '2026-01' })).rejects.toMatchObject({ code: 'DEPRECIATION_EMPTY' });
    const depreciated = await approve((await request('finance.depreciation.record', { month: '2026-01', legalEntityId: branch })).proposalId);
    expect(depreciated.code).toBe('NVK00002');
    expect(await entityOf('crove_finance.journal_entry', depreciated.journalEntryId)).toBe(branch);
    expect((await runtime.query<FixedAsset[]>('finance.fixed_assets.list', { legalEntityId: branch }, as(member)))[0]).toMatchObject({ posted: '100000', postedMonths: 1 });
  });

  it('reads and settles bank lines in their entity', async () => {
    const row = (rowNo: number, date: string, moneyOut: string, reference: string): BankStatementRow => ({ rowNo, date, description: 'Phi chuyen tien', moneyIn: '', moneyOut, balance: '', reference });
    const imported = await runtime.execute<{ counts: { new: number } }>(
      'finance.bank.import',
      { bankAccount: '1121', filename: 'sao-ke.xlsx', rows: [row(1, '06/10/2026', '22000', 'FT201')], legalEntityId: branch },
      { ...as(member), idempotencyKey: randomUUID() },
    );
    expect(imported.counts.new).toBe(1);
    const lines = await runtime.query<{ lines: Array<{ id: string }> }>('finance.bank.lines', { bankAccount: '1121', period: '2026-10', legalEntityId: branch }, as(member));
    expect(lines.lines).toHaveLength(1);
    expect((await runtime.query<{ lines: unknown[] }>('finance.bank.lines', { bankAccount: '1121', period: '2026-10' }, as(member))).lines).toEqual([]);
    expect((await runtime.query<{ accounts: unknown[] }>('finance.bank.open_lines', { legalEntityId: branch }, as(member))).accounts).toEqual([
      { bankAccount: '1121', open: 1, ambiguous: 0, oldest: '2026-10-06' },
    ]);
    expect((await runtime.query<{ accounts: unknown[] }>('finance.bank.open_lines', {}, as(member))).accounts).toEqual([]);

    const lineId = lines.lines[0]?.id as string;
    const fee = { type: 'bank_debit' as const, date: '2026-10-06', cashAccount: '1121', description: 'Phí chuyển tiền', lines: [{ account: '6422', amount: '22000' }], bankLineId: lineId };
    // A voucher of the line in another entity finds no such line.
    await expect(request('finance.voucher.record', { ...fee, legalEntityId: defaultEntity })).rejects.toMatchObject({ code: 'BANK_LINE_NOT_FOUND' });
    // Without an entity, the voucher is the line's.
    const { proposalId } = await request('finance.voucher.record', fee);
    const asked = await runtime.query<{ voucher: { legalEntityId?: string } }>('kernel.inbox.get', { id: proposalId }, as(owner));
    expect(asked.voucher.legalEntityId).toBe(branch);
    // The Inbox list names it too (#1543).
    expect(await listedEntityOf(proposalId)).toBe(branch);
    const settled = await approve(proposalId);
    expect(settled.code).toBe('BN00001');
    expect(await entityOf('crove_finance.cash_voucher', settled.voucherId as string)).toBe(branch);
  });

  it('records a purchase invoice in the entity it was uploaded in, never moved by a revision, with its VAT working and rules per entity', async () => {
    const bytes = new Uint8Array(FIXTURE);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const ingest = (legalEntityId: string) =>
      runtime.execute<{ fileId: string }>(
        'kernel.file.ingest',
        { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', legalEntityId },
        as(owner),
      );
    // An entity that does not exist and one of another org answer the same, and store nothing (#1764).
    const elsewhere = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id <> $1 LIMIT 1', [org.orgId])).rows[0]?.id);
    for (const hidden of [randomUUID(), ...(elsewhere ? [elsewhere] : [])]) {
      await expect(ingest(hidden)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    }
    // The owner uploads the invoice in the branch (#1764): its reading and its proposal are the branch's.
    const { fileId } = await ingest(branch);
    const read = (version?: number) => extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId, version);
    const versionOf = async () =>
      (await admin((c) => c.query<{ v: number }>('SELECT max(version)::int AS v FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [org.orgId, fileId]))).rows[0]?.v as number;
    const first = String((await read()).proposalId);
    expect(await entityOf('crove_kernel.proposal', first)).toBe(branch);
    // Uploaded again in another entity while its proposal waits: refused with the reason.
    await expect(ingest(defaultEntity)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_MOVE_REFUSED', status: 409 });
    // Once rejected, uploading it again in another entity reads it again there: a new proposal in that entity.
    await runtime.execute('kernel.proposal.reject', { id: first, reason: 'nhầm pháp nhân' }, as(owner));
    await expect(ingest(defaultEntity)).resolves.toMatchObject({ fileId, duplicate: true });
    const inDefault = String((await read(await versionOf())).proposalId);
    expect(inDefault).not.toBe(first);
    expect(await entityOf('crove_kernel.proposal', inDefault)).toBe(defaultEntity);
    // And back to the branch the same way, where it is booked below.
    await runtime.execute('kernel.proposal.reject', { id: inDefault, reason: 'nhầm lần nữa' }, as(owner));
    await ingest(branch);
    const proposalId = String((await read(await versionOf())).proposalId);
    expect(await entityOf('crove_kernel.proposal', proposalId)).toBe(branch);

    // A member limited to the default entity (an external accountant's assignment) reaches the branch no way.
    const scopedId = await upsertIdentity(createDb(pool), { issuer: 'le-areas', subject: randomUUID(), email: 'scoped@le-areas.test', name: null });
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [org.orgId, scopedId]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        org.orgId,
        scopedId,
        defaultEntity,
        owner.userId,
      ]);
    });
    const scoped = { actor: asUser(scopedId), orgId: org.orgId };
    const readings = async () => Number((await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [org.orgId, fileId]))).rows[0]?.n);
    const before = await readings();
    // Uploading in the branch: refused, the same way as an entity that does not exist.
    await expect(
      runtime.execute(
        'kernel.file.ingest',
        { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', legalEntityId: branch },
        scoped,
      ),
    ).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    // Nor by writing the file row itself.
    const rawFile = await (async () => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(scopedId, org.orgId)]);
        const sha = randomUUID().replaceAll('-', '').padEnd(64, '0');
        await c.query(
          `INSERT INTO crove_kernel.file (org_id, sha256, storage_key, filename, content_type, size_bytes, source, upload_entity_id)
           VALUES ($1, $2, $3, 'x.xml', 'application/xml', 1, 'upload', $4)`,
          [org.orgId, sha, fileKey(org.orgId, sha), branch],
        );
        return null;
      } catch (error) {
        return error as { code?: string; message?: string };
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    })();
    expect(rawFile).toMatchObject({ code: '42501', message: 'LEGAL_ENTITY_NOT_ALLOWED' });
    // Reading the branch's document again: refused, in its own entity or naming the branch, and naming nothing of the
    // branch's reading.
    await expect(runtime.execute('kernel.file.reextract', { fileId }, scoped)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(runtime.execute('kernel.file.reextract', { fileId, legalEntityId: branch }, scoped)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    // Uploading the branch's bytes again in its own entity starts no reading there.
    await expect(
      runtime.execute(
        'kernel.file.ingest',
        { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', legalEntityId: defaultEntity },
        scoped,
      ),
    ).resolves.toMatchObject({ fileId, duplicate: true });
    expect(await readings()).toBe(before);
    // The Inbox list (#1543) names the proposal's own entity.
    expect(await listedEntityOf(proposalId)).toBe(branch);
    // A revision may name its own entity, but never move it to another (#1764): the command and the database refuse.
    const edited = await rpc('inbox/edit', owner, { id: proposalId, revision: 1, legalEntityId: branch, idempotencyKey: randomUUID() });
    expect(edited).toMatchObject({ status: 200, body: { changed: true, revision: 2 } });
    const moved = await rpc('inbox/edit', owner, { id: proposalId, revision: 2, legalEntityId: defaultEntity, idempotencyKey: randomUUID() });
    expect(moved).toMatchObject({ status: 409, body: { code: 'LEGAL_ENTITY_MOVE_REFUSED' } });
    // In SQL too, as the owner on the API's login role.
    const rawMove = await (async () => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(owner.userId, org.orgId)]);
        await c.query(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{legalEntityId}', to_jsonb($2::text)) WHERE id = $1`, [proposalId, defaultEntity]);
        return null;
      } catch (error) {
        return error as { code?: string; message?: string };
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    })();
    expect(rawMove).toMatchObject({ code: '23514', message: 'LEGAL_ENTITY_MOVE_REFUSED' });
    // The file keeps the entity it was uploaded in.
    await expect(admin((c) => c.query('UPDATE crove_kernel.file SET upload_entity_id = $2 WHERE id = $1', [fileId, defaultEntity]))).rejects.toThrow(/LEGAL_ENTITY_IMMUTABLE/);
    const recorded = await approve(proposalId);
    expect(await entityOf('crove_finance.purchase_document', recorded.documentId as string)).toBe(branch);
    expect(await entityOf('crove_finance.journal_entry', recorded.journalEntryId)).toBe(branch);

    const branchDocuments = await runtime.query<Array<{ id: string }>>('finance.documents.list', { legalEntityId: branch }, as(member));
    expect(branchDocuments.map((d) => d.id)).toEqual([recorded.documentId]);
    expect(await runtime.query('finance.documents.list', {}, as(member))).toEqual([]);
    const branchVat = await runtime.query<VatReport>('finance.vat.period', { period: '2026-09', legalEntityId: branch }, as(member));
    expect(branchVat.input.documents.map((d) => d.id)).toEqual([recorded.documentId]);
    expect((await runtime.query<VatReport>('finance.vat.period', { period: '2026-09' }, as(member))).input.documents).toEqual([]);
    expect((await runtime.query<Array<{ id: string }>>('finance.vouchers.purchases', { legalEntityId: branch }, as(member))).length).toBe(1);
    expect(await runtime.query('finance.vouchers.purchases', {}, as(member))).toEqual([]);

    // Learned rules are kept per entity.
    const rule = await runtime.execute<{ id: string }>('finance.categorization_rule.create', { keyword: 'cuoc internet', accountCode: '6422', legalEntityId: branch }, as(owner));
    expect(await entityOf('crove_finance.categorization_rule', rule.id)).toBe(branch);
    expect((await runtime.query<Array<{ id: string }>>('finance.categorization_rules.list', { legalEntityId: branch }, as(member))).map((r) => r.id)).toContain(rule.id);
    expect((await runtime.query<Array<{ id: string }>>('finance.categorization_rules.list', {}, as(member))).map((r) => r.id)).not.toContain(rule.id);
    // The same keyword is a new rule in another entity.
    await runtime.execute('finance.categorization_rule.create', { keyword: 'cuoc internet', accountCode: '6422' }, as(owner));
  });

  it('marks a VAT return per entity, each with its own tax calendar mark', async () => {
    await runtime.execute('finance.vat.return_mark', { period: '2026-08', done: true, legalEntityId: branch }, as(owner));
    const marks = () =>
      admin(async (c) => ({
        filed: (await c.query<{ e: string }>(`SELECT legal_entity_id AS e FROM crove_finance.vat_return_filed WHERE org_id = $1 AND period = '2026-08' ORDER BY created_at`, [org.orgId])).rows.map(
          (r) => r.e,
        ),
        calendar: Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_kernel.tax_obligation_done WHERE org_id = $1 AND obligation = 'vat_return' AND period = '2026-08'`, [org.orgId])).rows[0]?.n),
      }));
    expect(await marks()).toEqual({ filed: [branch], calendar: 1 });
    await runtime.execute('finance.vat.return_mark', { period: '2026-08', done: true }, as(owner));
    expect(await marks()).toEqual({ filed: [branch, defaultEntity], calendar: 2 });
    // The default entity's [22] does not come from the branch's return.
    const next = await runtime.query<VatReport>('finance.vat.period', { period: '2026-09' }, as(member));
    expect(next.carryForward.previous?.period).toBe('2026-08');
  });

  it('closes one entity’s year', async () => {
    // Huế's 2025: revenue it earned, and nothing in the default entity's 2025.
    await approve((await request('finance.journal_voucher.record', nvk('2025-06-30', '900000', 'Doanh thu dịch vụ Huế', hue, ['1111', '5113']))).proposalId);
    await expect(request('finance.closing.record', { year: 2025 })).rejects.toMatchObject({ code: 'CLOSING_EMPTY' });
    const closed = await approve((await request('finance.closing.record', { year: 2025, legalEntityId: hue })).proposalId);
    expect(closed.code).toBe('NVK00002');
    expect(await entityOf('crove_finance.journal_entry', closed.journalEntryId)).toBe(hue);
    await expect(request('finance.closing.record', { year: 2025, legalEntityId: hue })).rejects.toMatchObject({ code: 'YEAR_CLOSED' });
    const check = await runtime.query<{ warnings: string[] }>('finance.statements.htkk_check', { year: 2025, legalEntityId: hue }, as(member));
    expect(check.warnings).not.toContain('YEAR_NOT_CLOSED');
    expect((await runtime.query<{ warnings: string[] }>('finance.statements.htkk_check', { year: 2025 }, as(member))).warnings).toContain('YEAR_NOT_CLOSED');
    const statements = await runtime.query<{ b02: { lines: Array<{ code: string; amount: string }> } }>('finance.statements.period', { period: '2025', legalEntityId: hue }, as(member));
    expect(statements.b02.lines.length).toBeGreaterThan(0);
    // The comparison columns read the entity named (#2090): Huế's 2025 is its previous year and its start of year, and the
    // default entity, which booked nothing in 2025, compares against zeros.
    type Compared = { comparison: { startOfYear: { amounts: Record<string, string> } | null; lastYear: { amounts: Record<string, string> } | null } };
    const next = await runtime.query<Compared>('finance.statements.period', { period: '2026', legalEntityId: hue }, as(member));
    expect(next.comparison.lastYear?.amounts).toEqual(Object.fromEntries(statements.b02.lines.map((l) => [l.code, l.amount])));
    expect(Object.values(next.comparison.lastYear?.amounts ?? {}).some((amount) => amount !== '0')).toBe(true);
    // Cash B01 reads: the 900,000 the voucher debited on 1111 is still there at the end of 2025.
    expect(next.comparison.startOfYear?.amounts['110']).toBe('900000');
    const other = await runtime.query<Compared>('finance.statements.period', { period: '2026' }, as(member));
    expect(Object.keys(other.comparison.lastYear?.amounts ?? {}).length).toBeGreaterThan(0);
    expect(Object.values(other.comparison.lastYear?.amounts ?? {}).every((amount) => amount === '0')).toBe(true);
  });

  it('exports the books of the entity named, and records it', async () => {
    const download = async (path: string) =>
      app.request(path, { headers: { authorization: `Bearer ${await tokenFor(member)}`, 'x-crove-org': org.slug } });
    const ok = await download(`/api/export/journal.xlsx?legalEntityId=${branch}`);
    expect(ok.status).toBe(200);
    const audit = await admin(
      async (c) =>
        (await c.query<{ detail: { legal_entity_id?: string; entries: number } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.journal.export' ORDER BY occurred_at DESC LIMIT 1`, [org.orgId]))
          .rows[0]?.detail,
    );
    // The branch's entries: a cash voucher, a journal voucher, its opening entry, a depreciation, a bank voucher and a purchase.
    expect(audit).toMatchObject({ legal_entity_id: branch, entries: 6 });
    expect((await download(`/api/export/ledger.xlsx?period=2026-10&legalEntityId=${randomUUID()}`)).status).toBe(403);
    expect((await download('/api/export/fixed-assets.xlsx')).status).toBe(200);
  });

  it('shows a proposal under the same legal entity in the Inbox list and on its own screen, read from the same kinds (#1625)', async () => {
    // Proposals written by the database owner, each kept in the default entity, whose payloads name another entity.
    const insert = (kind: string, command: string, named: unknown) =>
      admin(async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, legal_entity_id)
             VALUES ($1, $2, $3, 'Đề xuất', $4::jsonb, ARRAY[$5::uuid], '[]', $6) RETURNING id`,
            [org.orgId, kind, command, JSON.stringify({ legalEntityId: named }), owner.userId, defaultEntity],
          )
        ).rows[0]?.id as string,
      );
    const shown = async (id: string) => ({
      list: await listedEntityOf(id),
      get: (await runtime.query<{ legalEntityId: string | null }>('kernel.inbox.get', { id }, as(owner))).legalEntityId,
    });
    // A kind whose revision names no entity: its payload's key is not read, by either.
    const reversal = await insert('finance.journal_reversal', 'finance.journal.reverse', branch);
    expect(await shown(reversal)).toEqual({ list: defaultEntity, get: defaultEntity });
    // A kind that names one: the revision's entity, by both; a value that is no id falls back to the proposal's own.
    const voucher = await insert('finance.cash_voucher', 'finance.voucher.record', hue.toUpperCase());
    expect(await shown(voucher)).toEqual({ list: hue, get: hue });
    const malformed = await insert('finance.cash_voucher', 'finance.voucher.record', 'không phải mã');
    expect(await shown(malformed)).toEqual({ list: defaultEntity, get: defaultEntity });
  });

  it("lists a customer's receivable on 131 per legal entity, and a scoped member only in its own (#1534)", async () => {
    const customer = await admin(
      async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Khách Hai Sổ') RETURNING id`, [org.orgId])).rows[0]?.id as string,
    );
    // A sale on credit in each entity's books, posted and committed as the owner.
    const owe = async (entity: string, amount: string) => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(owner.userId, org.orgId)]);
        await c.query(`SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'bán chịu', 'test.sale', $1::uuid, $2::jsonb, NULL, 1, $3::uuid)`, [
          randomUUID(),
          JSON.stringify([
            { line_no: 1, account_code: '131', debit: amount, credit: '0', party_id: customer },
            { line_no: 2, account_code: '5111', debit: '0', credit: amount },
          ]),
          entity,
        ]);
        await c.query('COMMIT');
      } finally {
        await c.end();
      }
    };
    await owe(defaultEntity, '500000');
    await owe(branch, '200000');
    type Page = { items: Array<{ id: string; receivable: string }> };
    const receivable = async (who: { actor: ReturnType<typeof asUser>; orgId: string }, legalEntityId?: string) =>
      (await runtime.query<Page>('finance.customers.list', { q: 'khách hai sổ', ...(legalEntityId ? { legalEntityId } : {}) }, who)).items.find((i) => i.id === customer)?.receivable ?? null;
    // The owner: the default entity's books unless another is named; the third entity has none of it.
    expect(await receivable(as(owner))).toBe('500000');
    expect(await receivable(as(owner), defaultEntity)).toBe('500000');
    expect(await receivable(as(owner), branch)).toBe('200000');
    expect(await receivable(as(owner), hue)).toBeNull();
    // A member limited to the branch: its books by default, never the default entity's, whatever it names.
    const branchOnly = await upsertIdentity(createDb(pool), { issuer: 'le-areas', subject: randomUUID(), email: 'branch-only@le-areas.test', name: null });
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [org.orgId, branchOnly]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        org.orgId,
        branchOnly,
        branch,
        owner.userId,
      ]);
    });
    const limited = { actor: asUser(branchOnly), orgId: org.orgId };
    expect(await receivable(limited)).toBe('200000');
    expect(await receivable(limited, branch)).toBe('200000');
    for (const other of [defaultEntity, hue, randomUUID()]) {
      await expect(runtime.query('finance.customers.list', { legalEntityId: other }, limited)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
    }
  });
});
