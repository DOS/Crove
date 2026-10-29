// General journal vouchers, NVK (issue #888), on PostgreSQL 17: a member asks for one through kernel.proposal.request,
// an owner approves it (R3, four-eyes, fresh MFA), and the approval numbers it NVK00001, NVK00002 ... without gaps and
// posts its entry, which shows in the journal. Refused: an unbalanced voucher, a line on both sides, an unknown or
// inactive account, a payable without its party, a month already locked, and the table written outside the posting.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { JournalVoucherRequest } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('general journal vouchers (#888)', () => {
  const dbName = `crove_test_nvk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; member: string };
  let vendor = '';
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@nvk.test`, name: null });

  const request = (input: JournalVoucherRequest, user = o.member) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal_voucher.record', input }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });

  async function approve(proposalId: string, user = o.owner) {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ journalEntryId: string; voucherId: string; code: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision },
      { actor: asMfa(user), orgId: o.orgId },
    );
  }

  const accrual = (date = '2026-10-31'): JournalVoucherRequest => ({
    date,
    description: 'Trích trước chi phí điện tháng 10',
    lines: [
      { account: '6422', debit: '1500000', credit: '0', memo: 'Tiền điện văn phòng' },
      { account: '331', partyId: vendor, debit: '0', credit: '1500000' },
    ],
  });

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });

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
    const { rows } = await admin((c) =>
      c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name, tax_code) VALUES ($1, 'Công ty Điện lực Mẫu', '0101234564') RETURNING id`, [orgId]),
    );
    vendor = String(rows[0]?.id);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('posts an approved voucher as NVK00001, then NVK00002, and shows it in the journal', async () => {
    const { proposalId } = await request(accrual());
    const inbox = await rt.query<{ title: string; journalVoucher: unknown; total: string; issueDate: string }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(inbox).toMatchObject({
      title: 'Phiếu kế toán 1.500.000 đ: Trích trước chi phí điện tháng 10',
      total: '1500000',
      issueDate: '2026-10-31',
      journalVoucher: {
        date: '2026-10-31',
        total: '1500000',
        lines: [
          { account: '6422', party: null, debit: '1500000', credit: '0', memo: 'Tiền điện văn phòng' },
          { account: '331', party: { id: vendor, name: 'Công ty Điện lực Mẫu', taxCode: '0101234564' }, debit: '0', credit: '1500000' },
        ],
      },
    });
    // The member asked, so the member cannot approve it (four-eyes).
    await expect(approve(proposalId, o.member)).rejects.toMatchObject({ status: 403 });
    const first = await approve(proposalId);
    expect(first.code).toBe('NVK00001');
    const second = await approve((await request({ ...accrual(), description: 'Khấu hao tháng 10', lines: [
      { account: '6422', debit: '800000', credit: '0' },
      { account: '214', debit: '0', credit: '800000' },
    ] })).proposalId);
    expect(second.code).toBe('NVK00002');

    const journal = await rt.query<Array<{ id: string; description: string; lines: Array<{ accountCode: string; debit: string; credit: string; partyId?: string | null }> }>>(
      'finance.journal.list',
      {},
      { actor: asUser(o.member), orgId: o.orgId },
    );
    const entry = journal.find((e) => e.id === first.journalEntryId);
    expect(entry?.description).toBe('NVK00001 Trích trước chi phí điện tháng 10');
    expect(entry?.lines.map((l) => [l.accountCode, Number(l.debit), Number(l.credit)])).toEqual([
      ['6422', 1500000, 0],
      ['331', 0, 1500000],
    ]);
    const lines = await admin(async (c) => (await c.query('SELECT account_code, party_id, memo FROM crove_finance.journal_line WHERE entry_id = $1 ORDER BY line_no', [first.journalEntryId])).rows);
    expect(lines).toEqual([
      { account_code: '6422', party_id: null, memo: 'Tiền điện văn phòng' },
      { account_code: '331', party_id: vendor, memo: 'Trích trước chi phí điện tháng 10' },
    ]);
    const vouchers = await admin(async (c) => (await c.query('SELECT number, voucher_date::text AS date, proposal_id FROM crove_finance.journal_voucher WHERE org_id = $1 ORDER BY number', [o.orgId])).rows);
    expect(vouchers).toEqual([
      { number: 1, date: '2026-10-31', proposal_id: proposalId },
      { number: 2, date: '2026-10-31', proposal_id: expect.any(String) },
    ]);
  });

  it('refuses a voucher that does not balance, has a line on both sides or none, or names no party on a payable', async () => {
    const invalid = (lines: JournalVoucherRequest['lines']) => request({ ...accrual(), lines });
    await expect(invalid([
      { account: '6422', debit: '100', credit: '0' },
      { account: '331', partyId: vendor, debit: '0', credit: '90' },
    ])).rejects.toMatchObject({ code: 'JOURNAL_VOUCHER_INVALID', details: { problems: ['UNBALANCED'] } });
    await expect(invalid([
      { account: '6422', debit: '100', credit: '100' },
      { account: '331', partyId: vendor, debit: '0', credit: '0' },
    ])).rejects.toMatchObject({ code: 'JOURNAL_VOUCHER_INVALID', details: { problems: ['LINE_SIDE'] } });
    await expect(invalid([
      { account: '6422', debit: '100', credit: '0' },
      { account: '331', debit: '0', credit: '100' },
    ])).rejects.toMatchObject({ code: 'JOURNAL_VOUCHER_INVALID', details: { problems: ['PARTY_REQUIRED'] } });
    await expect(invalid([
      { account: '6422', debit: '100', credit: '0' },
      { account: '999', debit: '0', credit: '100' },
    ])).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    await expect(invalid([
      { account: '6422', debit: '100', credit: '0' },
      { account: '331', partyId: randomUUID(), debit: '0', credit: '100' },
    ])).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
  });

  it('refuses an account deactivated after the request when the proposal is approved', async () => {
    await rt.execute('finance.account.create', { parentCode: '6422', code: '6422.DV', name: 'Dịch vụ' }, { actor: asUser(o.owner), orgId: o.orgId });
    const { proposalId } = await request({ ...accrual(), lines: [
      { account: '6422.DV', debit: '200000', credit: '0' },
      { account: '331', partyId: vendor, debit: '0', credit: '200000' },
    ] });
    await rt.execute('finance.account.update', { code: '6422.DV', active: false }, { actor: asUser(o.owner), orgId: o.orgId });
    await expect(approve(proposalId)).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('refuses a date in a locked month when asked for, and nothing is numbered for it', async () => {
    await rt.execute('finance.period.lock', { month: '2026-08' }, { actor: asMfa(o.owner), orgId: o.orgId });
    await expect(request(accrual('2026-08-20'))).rejects.toMatchObject({ code: 'PERIOD_LOCKED', status: 409, details: { lockedThrough: '2026-08-31', entryDate: '2026-08-20' } });
    const { rows } = await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_finance.journal_voucher WHERE org_id = $1', [o.orgId]));
    expect(rows).toEqual([{ n: 2 }]);
  });

  it('keeps the table append-only and posted only with its entry', async () => {
    // Even the owner of the table cannot change a voucher.
    await expect(admin((c) => c.query(`UPDATE crove_finance.journal_voucher SET description = 'x' WHERE org_id = $1`, [o.orgId]))).rejects.toThrow();
    // A voucher without its journal entry is refused at commit, whoever writes it.
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        await c.query(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description) VALUES ($1, '2026-10-31', 'no entry')`, [o.orgId]);
        await c.query('COMMIT');
      }),
    ).rejects.toThrow(/must be posted as a journal entry dated 2026-10-31/);
  });
});
