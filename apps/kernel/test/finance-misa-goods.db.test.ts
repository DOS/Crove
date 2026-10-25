// MISA SME goods purchases (issue #1398) on a real PostgreSQL 17, through the HTTP API where a user acts: the org's
// MISA item and warehouse codes per stock account (set, changed and cleared by owners and admins, audited, refused for
// other accounts and for members, invisible to another org), and an invoice with both stock and service lines exported
// as a goods voucher (GET /api/export/misa/goods-purchases.xlsx) and a services voucher (/api/export/misa/purchases.xlsx),
// each export audited and named in the document's history. The files' cells are covered by the unit tests
// (modules/finance/test/misa.test.ts) and the Playwright spec; here the rows come from the same query and mapper the
// routes use. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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
import {
  extractAndPropose,
  financeCommands,
  financeQueries,
  goodsPurchaseRows,
  servicePurchaseRows,
  type PurchaseVoucher,
} from '@crove/mod-finance';
import { accountParents, type MisaGoodsCode } from '@crove/kernel-contract';
import { money } from '@crove/l10n-vn';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-misa-goods-0123456789';
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

suite('MISA SME goods purchases: codes per stock account and the goods template (#1398)', () => {
  const dbName = `crove_test_misa_goods_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@misa-goods.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@misa-goods.test', session: randomUUID(), userId: '' };
  const other: Account = { subject: randomUUID(), email: 'other@misa-goods.test', session: randomUUID(), userId: '' };
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

  // Downloads an export as a member would; answers its file name.
  async function download(path: string, who: Account = owner) {
    const response = await app.request(path, { headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-crove-org': org.slug } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');
    return response.headers.get('content-disposition') ?? '';
  }

  // The rows each MISA file holds, from the query and mapper the routes use.
  async function fileRows(from: string) {
    const ctx = { actor: asUser(owner.userId), orgId: org.orgId };
    const vouchers = await runtime.query<PurchaseVoucher[]>('finance.vouchers.purchases', { from }, ctx);
    const codes = await runtime.query<MisaGoodsCode[]>('finance.misa_goods_codes.list', {}, ctx);
    const parents = accountParents(await runtime.query<Array<{ code: string; parentCode: string | null }>>('finance.accounts.list', {}, ctx));
    return { goods: vouchers.flatMap((v) => goodsPurchaseRows(v, codes, parents)), services: vouchers.flatMap(servicePurchaseRows) };
  }

  // Uploads the fixture invoice under a new number, reads it into a proposal, puts each line on the given account and
  // approves it. The fixture has lines 1 and 2 (1,000,000 each at 10%) and a trade discount line 3 (-200,000).
  async function record(number: string, accounts: Record<number, string>) {
    const bytes = new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`));
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const proposal = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    const id = String(proposal.proposalId);
    const before = (await rpc('inbox/get', owner, { id })).body as { revision: number; payload: { lines: Array<{ lineNo: number }> } };
    const edited = await rpc('inbox/edit', owner, {
      id,
      revision: before.revision,
      lineAccounts: before.payload.lines.map((l) => ({ lineNo: l.lineNo, debitAccount: accounts[l.lineNo] ?? '6422' })),
      idempotencyKey: randomUUID(),
    });
    expect(edited).toMatchObject({ status: 200, body: { changed: true } });
    return runtime.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id, revision: Number(edited.body.revision) },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
  }

  const audits = (command: string) =>
    admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at, id`, [org.orgId, command])).rows.map((r) => r.detail));

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
    const created = await rpc('org/create', owner, { name: 'Công ty Mua hàng', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const createdB = await rpc('org/create', other, { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    orgB = { slug: String(createdB.body?.slug), orgId: String(createdB.body?.orgId) };
    // A member (no Settings changes) through an invite; inviting is R3, so the owner holds a fresh second factor.
    const invite = await rpc('org/invite', owner, { email: member.email, role: 'member' }, org.slug, { mfa: true });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', member, { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    // A sub-account of 156, for the parent fallback.
    expect((await rpc('accounts/create', owner, { parentCode: '156', code: '1561', name: 'Hàng hóa Hà Nội' })).status).toBe(200);
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

  it('sets, changes and clears an account codes, each change audited, and keeps them to the org', async () => {
    expect((await rpc('misaGoodsCodes/list', member, {})).body).toEqual([]);
    const set = await rpc('misaGoodsCodes/set', owner, { accountCode: '156', itemCode: 'HH01', warehouseCode: 'KHO.HN' });
    expect(set).toMatchObject({ status: 200, body: { accountCode: '156', itemCode: 'HH01', warehouseCode: 'KHO.HN' } });
    const changed = await rpc('misaGoodsCodes/set', owner, { accountCode: '156', itemCode: 'HANGHOA', warehouseCode: null });
    expect(changed).toMatchObject({ status: 200, body: { itemCode: 'HANGHOA', warehouseCode: null } });
    expect((await rpc('misaGoodsCodes/set', owner, { accountCode: '153', itemCode: ' CCDC01 ', warehouseCode: 'KCC' })).status).toBe(200);
    // Every member reads them (every member may export); trimmed as stored.
    expect((await rpc('misaGoodsCodes/list', member, {})).body).toEqual([
      { accountCode: '153', itemCode: 'CCDC01', warehouseCode: 'KCC', updatedAt: expect.any(String) },
      { accountCode: '156', itemCode: 'HANGHOA', warehouseCode: null, updatedAt: expect.any(String) },
    ]);
    expect((await rpc('misaGoodsCodes/remove', owner, { accountCode: '153' })).body).toEqual({ removed: true });
    expect((await rpc('misaGoodsCodes/remove', owner, { accountCode: '153' })).body).toEqual({ removed: false });
    expect(await audits('finance.misa_goods_code.set')).toEqual([
      { accountCode: '156', itemCode: 'HH01', warehouseCode: 'KHO.HN', previous: null },
      { accountCode: '156', itemCode: 'HANGHOA', warehouseCode: null, previous: { itemCode: 'HH01', warehouseCode: 'KHO.HN' } },
      { accountCode: '153', itemCode: 'CCDC01', warehouseCode: 'KCC', previous: null },
    ]);
    expect(await audits('finance.misa_goods_code.remove')).toEqual([
      { accountCode: '153', previous: { itemCode: 'CCDC01', warehouseCode: 'KCC' } },
      { accountCode: '153', previous: null },
    ]);
    // Another org sees none of them.
    expect((await rpc('misaGoodsCodes/list', other, {}, orgB.slug)).body).toEqual([]);
  });

  it('refuses a non-stock account, an account outside the chart, a malformed code and members', async () => {
    expect(await rpc('misaGoodsCodes/set', owner, { accountCode: '6422', itemCode: 'DV01', warehouseCode: null })).toMatchObject({
      status: 422,
      body: { code: 'NOT_STOCK_ACCOUNT' },
    });
    expect(await rpc('misaGoodsCodes/set', owner, { accountCode: '1569', itemCode: 'HH01', warehouseCode: null })).toMatchObject({
      status: 422,
      body: { code: 'UNKNOWN_ACCOUNT' },
    });
    for (const itemCode of ['HH 01', '=HYPERLINK("x")', 'A'.repeat(26), '']) {
      const refused = await rpc('misaGoodsCodes/set', owner, { accountCode: '156', itemCode, warehouseCode: null });
      expect(refused.status, itemCode).toBeGreaterThanOrEqual(400);
      expect(refused.status, itemCode).toBeLessThan(500);
    }
    expect((await rpc('misaGoodsCodes/set', member, { accountCode: '156', itemCode: 'HH02', warehouseCode: null })).status).toBe(403);
    expect((await rpc('misaGoodsCodes/remove', member, { accountCode: '156' })).status).toBe(403);
    // The database holds the same formats, whatever writes the row.
    await expect(
      admin((c) => c.query(`INSERT INTO crove_finance.misa_goods_code (org_id, account_code, item_code) VALUES ($1, '6422', 'X')`, [org.orgId])),
    ).rejects.toThrow(/misa_goods_code_account_format/);
    await expect(
      admin((c) => c.query(`INSERT INTO crove_finance.misa_goods_code (org_id, account_code, item_code) VALUES ($1, '152', '=1+1 ')`, [org.orgId])),
    ).rejects.toThrow(/misa_goods_code_item_format/);
  });

  it('exports an invoice with stock and service lines as a goods voucher and a services voucher, each audited and in the document history', async () => {
    // 156 has HANGHOA and no warehouse (above); its sub-account 1561 takes them; 6422 stays a service line.
    const { documentId, journalEntryId } = await record('5001', { 1: '1561', 2: '6422', 3: '1561' });
    const tail = journalEntryId.replace(/-/g, '').slice(-12).toUpperCase();

    const rows = await fileRows('2026-01-01');
    expect(rows.goods.map((r) => [r.voucherNo, r.goods.itemCode, r.goods.warehouseCode, r.goods.from, r.line.debitAccount, money(r.line.amount).toFixed(), r.vatAmount, r.vatAccount])).toEqual([
      [`CRMH${tail}`, 'HANGHOA', null, '156', '1561', '1000000', '100000', '1331'],
      [`CRMH${tail}`, 'HANGHOA', null, '156', '1561', '-200000', '-20000', '1331'],
    ]);
    expect(rows.goods[0]?.voucher.invoice).toMatchObject({ series: 'C26TAB', number: '5001' });
    expect(rows.services.map((r) => [r.voucherNo, r.line.debitAccount, money(r.line.amount).toFixed(), r.vatAmount])).toEqual([[`CRMDV${tail}`, '6422', '1000000', '100000']]);
    expect(await download('/api/export/misa/goods-purchases.xlsx?from=2026-01-01')).toContain('misa-mua-hang-nhap-kho');
    expect(await download('/api/export/misa/purchases.xlsx?from=2026-01-01')).toContain('misa-mua-dich-vu');

    // A services-only invoice is in the services file only; the goods file still has the one voucher.
    await record('5002', {});
    const after = await fileRows('2026-01-01');
    expect(after.goods).toHaveLength(2);
    expect(after.services).toHaveLength(4);
    await download('/api/export/misa/goods-purchases.xlsx?from=2026-01-01');
    await download('/api/export/misa/purchases.xlsx?from=2026-01-01', member);

    const exports = (await audits('finance.journal.export')).filter((d) => String(d.format).includes('purchases'));
    expect(exports).toEqual([
      { entries: 1, format: 'misa_sme_goods_purchases', from: '2026-01-01', to: null },
      { entries: 1, format: 'misa_sme_purchases', from: '2026-01-01', to: null, stockLines: 'excluded' },
      { entries: 1, format: 'misa_sme_goods_purchases', from: '2026-01-01', to: null },
      { entries: 2, format: 'misa_sme_purchases', from: '2026-01-01', to: null, stockLines: 'excluded' },
    ]);

    // The mixed document went out in both kinds of file.
    const history = await rpc('documents/exports', member, { documentId });
    expect(history.status).toBe(200);
    expect((history.body as Array<{ format: string }>).map((e) => e.format)).toEqual([
      'misa_sme_goods_purchases',
      'misa_sme_purchases',
      'misa_sme_goods_purchases',
      'misa_sme_purchases',
    ]);
  });

  it('names a stock-only document in goods files only, but in every services file made before the split', async () => {
    const { documentId } = await record('5003', { 1: '152', 2: '152', 3: '152' });
    // No codes set for 152: the defaults.
    const rows = await fileRows('2026-01-01');
    expect(rows.goods.filter((r) => r.voucher.invoice.number === '5003').map((r) => [r.goods.itemCode, r.goods.warehouseCode, r.goods.from])).toEqual([
      ['NVL', 'KNVL', null],
      ['NVL', 'KNVL', null],
      ['NVL', 'KNVL', null],
    ]);
    expect(rows.services.filter((r) => r.voucher.invoice.number === '5003')).toEqual([]);
    await download('/api/export/misa/goods-purchases.xlsx?from=2026-01-01');
    await download('/api/export/misa/purchases.xlsx?from=2026-01-01');
    // A services export recorded before #1398 (no stockLines): it held every line, so it names the document too.
    await runtime.execute('finance.journal.export', { from: '2026-01-01', entries: 3, format: 'misa_sme_purchases' }, { actor: asUser(owner.userId), orgId: org.orgId });
    const history = await rpc('documents/exports', owner, { documentId });
    expect((history.body as Array<{ format: string }>).map((e) => e.format)).toEqual(['misa_sme_goods_purchases', 'misa_sme_purchases']);
  });

  it('takes a sub-account codes along the chart, never from a sibling whose code it starts with', async () => {
    for (const code of ['156.A', '156.AB']) {
      expect((await rpc('accounts/create', owner, { parentCode: '156', code, name: `Kho ${code}` })).status).toBe(200);
    }
    expect((await rpc('misaGoodsCodes/set', owner, { accountCode: '156.A', itemCode: 'HH-A', warehouseCode: 'KHO-A' })).status).toBe(200);
    await record('5004', { 1: '156.AB', 2: '156.A', 3: '156.AB' });
    const rows = (await fileRows('2026-01-01')).goods.filter((r) => r.voucher.invoice.number === '5004');
    // 156.AB sits under 156, beside 156.A: it takes 156's codes (set in the first test), not 156.A's.
    expect(rows.map((r) => [r.line.debitAccount, r.goods.itemCode, r.goods.warehouseCode, r.goods.from])).toEqual([
      ['156.AB', 'HANGHOA', null, '156'],
      ['156.A', 'HH-A', 'KHO-A', '156.A'],
      ['156.AB', 'HANGHOA', null, '156'],
    ]);
  });
});
