// The register of fixed assets and prepaid costs and its monthly depreciation (issue #919), on PostgreSQL 17: a member
// enters assets, asks for a month's depreciation through kernel.proposal.request, and an owner approves it (R3,
// four-eyes, fresh MFA); the approval posts one NVK and writes a depreciation line per asset. Refused: accounts of the
// wrong kind, a month already posted or locked, a stale proposal, an end before a posted month, and the tables written
// outside their commands.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { FixedAsset, FixedAssetCreate } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('fixed assets and prepaid costs (#919)', () => {
  const dbName = `crove_test_fa_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; member: string };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@fa.test`, name: null });

  const request = (month: string, user = o.member) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.depreciation.record', input: { month } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const create = (input: FixedAssetCreate, user = o.member) => rt.execute<{ assetId: string }>('finance.fixed_asset.create', input, { actor: asUser(user), orgId: o.orgId });
  const list = () => rt.query<FixedAsset[]>('finance.fixed_assets.list', {}, { actor: asUser(o.member), orgId: o.orgId });

  async function approve(proposalId: string, user = o.owner) {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ journalEntryId: string; voucherId: string; code: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision },
      { actor: asMfa(user), orgId: o.orgId },
    );
  }

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });

    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    o = { orgId, owner, member: await person('member') };
    // A second approver, so the owner may approve what the member asked for (P10, four-eyes).
    const second = await person('admin');
    for (const [user, role] of [
      [o.member, 'member'],
      [second, 'admin'],
    ] as const) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const machine = (over: Partial<FixedAssetCreate> = {}): FixedAssetCreate => ({
    kind: 'fixed_asset',
    name: 'Máy in văn phòng',
    cost: '36000000',
    assetAccount: '2111',
    accumulatedAccount: '2141',
    expenseAccount: '6422',
    startMonth: '2026-08',
    months: 36,
    ...over,
  });
  const software = (over: Partial<FixedAssetCreate> = {}): FixedAssetCreate => ({
    kind: 'prepaid_cost',
    name: 'Bản quyền phần mềm 1 năm',
    cost: '10000000',
    assetAccount: '242',
    expenseAccount: '6421',
    startMonth: '2026-09',
    months: 3,
    ...over,
  });
  let printer = '';
  let licence = '';

  it('refuses accounts of the wrong kind', async () => {
    await expect(create(machine({ accumulatedAccount: null }))).rejects.toMatchObject({ code: 'ASSET_ACCOUNTS' });
    await expect(create(machine({ assetAccount: '242' }))).rejects.toMatchObject({ code: 'ASSET_ACCOUNTS' });
    await expect(create(software({ accumulatedAccount: '2141' }))).rejects.toMatchObject({ code: 'ASSET_ACCOUNTS' });
    await expect(create(machine({ expenseAccount: '511' }))).rejects.toMatchObject({ code: 'ASSET_ACCOUNTS' });
    expect(await list()).toEqual([]);
  });

  it('posts a month as one NVK approved by an owner, and records each asset once', async () => {
    printer = (await create(machine())).assetId;
    licence = (await create(software())).assetId;
    const { proposalId } = await request('2026-09');
    const inbox = await rt.query<{ total: string; issueDate: string; journalVoucher: { lines: unknown[] } }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(inbox).toMatchObject({
      total: '4333333',
      issueDate: '2026-09-30',
      journalVoucher: {
        lines: [
          { account: '6421', debit: '3333333', credit: '0' },
          { account: '6422', debit: '1000000', credit: '0' },
          { account: '2141', debit: '0', credit: '1000000' },
          { account: '242', debit: '0', credit: '3333333' },
        ],
      },
    });
    // The member asked, so the member cannot approve it (four-eyes).
    await expect(approve(proposalId, o.member)).rejects.toMatchObject({ status: 403 });
    const posted = await approve(proposalId);
    expect(posted.code).toBe('NVK00001');
    const rows = await admin(async (c) => (await c.query('SELECT asset_id, month::text AS month, amount::text AS amount, entry_id FROM crove_finance.depreciation_line WHERE org_id = $1 ORDER BY amount', [o.orgId])).rows);
    expect(rows).toEqual([
      { asset_id: printer, month: '2026-09-01', amount: '1000000.0000', entry_id: posted.journalEntryId },
      { asset_id: licence, month: '2026-09-01', amount: '3333333.0000', entry_id: posted.journalEntryId },
    ]);
    const entry = await admin(async (c) => (await c.query('SELECT entry_date::text AS date FROM crove_finance.journal_entry WHERE id = $1', [posted.journalEntryId])).rows);
    expect(entry).toEqual([{ date: '2026-09-30' }]);
    await expect(request('2026-09')).rejects.toMatchObject({ code: 'DEPRECIATION_DONE' });
    // August has the printer only, not yet posted.
    await expect(request('2026-07')).rejects.toMatchObject({ code: 'DEPRECIATION_EMPTY' });

    const register = await list();
    expect(register.find((a) => a.id === printer)).toMatchObject({ posted: '1000000', postedMonths: 1, remaining: '35000000', lastPostedMonth: '2026-09', lastMonth: '2029-07' });
    expect(register.find((a) => a.id === licence)).toMatchObject({ posted: '3333333', remaining: '6666667', lastMonth: '2026-11', accumulatedAccount: null });
  });

  it('refuses a proposal the register changed under', async () => {
    const { proposalId } = await request('2026-10');
    await create(machine({ name: 'Máy chiếu', cost: '12000000', months: 12, startMonth: '2026-10' }));
    await expect(approve(proposalId)).rejects.toMatchObject({ code: 'DEPRECIATION_STALE' });
    const { rows } = await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_finance.depreciation_line WHERE org_id = $1 AND month = '2026-10-01'`, [o.orgId]));
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('ends a schedule once, not before a posted month', async () => {
    const end = (month: string) => rt.execute('finance.fixed_asset.end', { assetId: printer, month, reason: 'Thanh lý' }, { actor: asUser(o.member), orgId: o.orgId });
    await expect(end('2026-08')).rejects.toMatchObject({ code: 'ASSET_END_BEFORE_POSTED' });
    await end('2026-10');
    await expect(end('2026-11')).rejects.toMatchObject({ code: 'ASSET_ENDED' });
    expect((await list()).find((a) => a.id === printer)?.ended).toEqual({ month: '2026-10', reason: 'Thanh lý' });
  });

  it('refuses a locked month', async () => {
    await rt.execute('finance.period.lock', { month: '2026-08' }, { actor: asMfa(o.owner), orgId: o.orgId });
    await expect(request('2026-08')).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
  });

  it('keeps depreciation lines append-only and the register fixed but for its end', async () => {
    await expect(admin((c) => c.query(`UPDATE crove_finance.depreciation_line SET amount = 1 WHERE org_id = $1`, [o.orgId]))).rejects.toThrow();
    await expect(admin((c) => c.query(`DELETE FROM crove_finance.depreciation_line WHERE org_id = $1`, [o.orgId]))).rejects.toThrow();
    await expect(admin((c) => c.query(`UPDATE crove_finance.fixed_asset SET name = 'x' WHERE org_id = $1 AND id = $2`, [o.orgId, licence]))).rejects.toThrow(/only the end/);
    await expect(admin((c) => c.query(`UPDATE crove_finance.fixed_asset SET end_reason = 'y' WHERE org_id = $1 AND id = $2`, [o.orgId, printer]))).rejects.toThrow(/already ended/);
  });
});
