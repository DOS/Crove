// Year-end closing (issue #889), on PostgreSQL 17: a member asks for the closing of a year through
// kernel.proposal.request, an owner approves it (R3, four-eyes, fresh MFA), and the approval posts one general journal
// voucher dated 31/12 that moves classes 5 to 8 to 911 and the result to 4212. Refused: a year closed, not ended or
// with nothing to close, and a proposal the ledger moved past since it was made.
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

suite('year-end closing (#889)', () => {
  const dbName = `crove_test_closing_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; member: string };
  let customer = '';
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@closing.test`, name: null });

  const ask = (command: string, input: unknown, user = o.member) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command, input }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const close = (year: number) => ask('finance.closing.record', { year });
  // A general journal voucher, asked for and approved at once.
  const post = async (date: string, description: string, lines: JournalVoucherRequest['lines']) =>
    approve((await ask('finance.journal_voucher.record', { date, description, lines })).proposalId);

  async function approve(proposalId: string, user = o.owner) {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ journalEntryId: string; voucherId: string; code: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision },
      { actor: asMfa(user), orgId: o.orgId },
    );
  }

  // Each account's net balance (debit minus credit) through a day, as the ledger holds it.
  async function balances(to: string) {
    const { rows } = await admin((c) =>
      c.query<{ account_code: string; net: string }>(
        `SELECT l.account_code, (sum(l.debit) - sum(l.credit))::text AS net
           FROM crove_finance.journal_line l JOIN crove_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
          WHERE l.org_id = $1 AND e.entry_date <= $2 GROUP BY l.account_code`,
        [o.orgId, to],
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.account_code, Number(r.net)]));
  }
  const statements = (period: string) => rt.query<{ b01: { lines: unknown[] }; b02: { lines: unknown[] } }>('finance.statements.period', { period }, { actor: asUser(o.owner), orgId: o.orgId });

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
      c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name, tax_code) VALUES ($1, 'Công ty Khách Hàng Mẫu', '0309876546') RETURNING id`, [orgId]),
    );
    customer = String(rows[0]?.id);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('closes 2025: classes 5 to 8 to 911, the profit to 4212, statements unchanged', async () => {
    await post('2025-03-31', 'Doanh thu bán hàng quý 1', [
      { account: '131', partyId: customer, debit: '10000000', credit: '0' },
      { account: '511', debit: '0', credit: '10000000' },
    ]);
    await post('2025-06-30', 'Lương tháng 6', [
      { account: '6422', debit: '3000000', credit: '0' },
      { account: '334', debit: '0', credit: '3000000' },
    ]);
    await post('2025-07-31', 'Giá vốn hàng bán tháng 7', [
      { account: '632', debit: '2000000', credit: '0' },
      { account: '156', debit: '0', credit: '2000000' },
    ]);
    const before = await statements('2025');

    const { proposalId } = await close(2025);
    const inbox = await rt.query<{ title: string; kind: string; journalVoucher: { date: string; lines: unknown[] } }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(inbox.kind).toBe('finance.journal_voucher');
    expect(inbox.title).toBe('Phiếu kế toán 20.000.000 đ: Kết chuyển xác định kết quả kinh doanh năm 2025');
    expect(inbox.journalVoucher).toMatchObject({
      date: '2025-12-31',
      lines: [
        { account: '511', party: null, debit: '10000000', credit: '0' },
        { account: '911', party: null, debit: '0', credit: '10000000' },
        { account: '911', party: null, debit: '5000000', credit: '0' },
        { account: '632', party: null, debit: '0', credit: '2000000' },
        { account: '6422', party: null, debit: '0', credit: '3000000' },
        { account: '911', party: null, debit: '5000000', credit: '0' },
        { account: '4212', party: null, debit: '0', credit: '5000000' },
      ],
    });
    // Four-eyes: the member who asked cannot approve it.
    await expect(approve(proposalId, o.member)).rejects.toMatchObject({ status: 403 });
    const closed = await approve(proposalId);
    expect(closed.code).toBe('NVK00004');

    const after = await balances('2025-12-31');
    for (const code of ['511', '632', '6422', '911']) expect(after[code]).toBe(0);
    expect(after['4212']).toBe(-5000000);
    const { rows } = await admin((c) => c.query<{ closing_year: number }>('SELECT closing_year FROM crove_finance.journal_voucher WHERE org_id = $1 AND id = $2', [o.orgId, closed.voucherId]));
    expect(rows).toEqual([{ closing_year: 2025 }]);
    // B02 leaves the closing entry out and B01 counts 4212 with the unclosed result: neither moves.
    expect(await statements('2025')).toEqual(before);
  });

  it('refuses a year closed, not ended or with nothing to close', async () => {
    await expect(close(2025)).rejects.toMatchObject({ code: 'YEAR_CLOSED', status: 409 });
    await expect(close(2026)).rejects.toMatchObject({ code: 'YEAR_NOT_ENDED' });
    await expect(close(2024)).rejects.toMatchObject({ code: 'CLOSING_EMPTY' });
  });

  const closingEntry = async (year: number) =>
    (
      await admin((c) =>
        c.query<{ id: string }>(
          `SELECT e.id FROM crove_finance.journal_entry e JOIN crove_finance.journal_voucher v ON v.org_id = e.org_id AND v.id = e.source_id
            WHERE e.org_id = $1 AND e.source_type = 'finance.journal_voucher' AND e.reverses_entry_id IS NULL AND v.closing_year = $2`,
          [o.orgId, year],
        ),
      )
    ).rows.map((r) => r.id);
  const reverse = async (entryId: string | undefined, entryDate: string) => approve((await ask('finance.journal.reverse', { entryId, entryDate, reason: 'Kết chuyển lại' })).proposalId);

  it('refuses a proposal the ledger moved past since it was made', async () => {
    await post('2024-05-31', 'Doanh thu tháng 5', [
      { account: '131', partyId: customer, debit: '1000000', credit: '0' },
      { account: '511', debit: '0', credit: '1000000' },
    ]);
    const stale = await close(2024);
    await post('2024-08-31', 'Chi phí tháng 8', [
      { account: '6422', debit: '400000', credit: '0' },
      { account: '334', debit: '0', credit: '400000' },
    ]);
    await expect(approve(stale.proposalId)).rejects.toMatchObject({ code: 'CLOSING_STALE', status: 409 });
    await approve((await close(2024)).proposalId);
    const after = await balances('2024-12-31');
    expect([after['511'], after['6422'], after['911'], after['4212']]).toEqual([0, 0, 0, -600000]);
  });

  it('keeps a year closed when its closing is reversed later, and opens it when reversed on its last day', async () => {
    const [entry2024] = await closingEntry(2024);
    await reverse(entry2024, '2025-01-05');
    await expect(close(2024)).rejects.toMatchObject({ code: 'YEAR_CLOSED' });

    const [entry2025] = await closingEntry(2025);
    await reverse(entry2025, '2025-12-31');
    // The reversal of the 2024 closing in 2025 brought last year's result back into 2025's balances: it closes with
    // the rest.
    const again = await approve((await close(2025)).proposalId);
    expect(again.code).toMatch(/^NVK\d{5}$/);
    const after = await balances('2025-12-31');
    for (const code of ['511', '632', '6422', '911']) expect(after[code]).toBe(0);
    expect(after['4212']).toBe(-5600000);
  });
});
