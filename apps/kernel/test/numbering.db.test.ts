// Gapless numbering (#1401, ADR-0021 section 2) on PostgreSQL 17: the backfill that keeps the numbers of vouchers
// issued before the migration (a 'never' series that continues them), the yearly reset by default (31 December, then
// 1 January starts at 1), the monthly reset, the policy setter and the void command with their permissions, the
// series query, and a switch of the reset from a future 1 January (#1595). The invariants (gapless under parallel
// posts, voids, direct writes, scope) are in test/invariant/numbering.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type NumberSeriesPage } from '@crove/kernel';
import { Runtime, type InputHashMode } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { enterUser } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const THIS_VERSION = '20261103030000';
const suite = ADMIN ? describe : describe.skip;
const LINES = JSON.stringify([
  { line_no: 1, account_code: '6422', debit: '50000', credit: '0' },
  { line_no: 2, account_code: '331', debit: '0', credit: '50000' },
]);

suite('gapless numbering on PostgreSQL (#1401)', () => {
  const dbName = `crove_test_numbering_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let before = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let owner = '';
  let adminUser = '';
  let member = '';
  let legacyOrg = '';
  let orgId = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // The database starts before the keyed input hash's migration (20261103180000_crove_kernel_input_hash.sql), where
  // crove_kernel.command_input_hash does not exist yet: the runtime that seeds it writes the plain hash (#1741).
  function connect(inputHash: InputHashMode = 'keyed', upgraded = false) {
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    // Before the upgrade no context token key: the database is at a version before enter_user_context. After it the
    // suite's key, which migrate installed: crove_app may no longer call enter_context (#1822).
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, ...(upgraded ? {} : { contextTokenKey: null }), inputHash }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }

  // The voucher's number columns, also before the migration added number_period and number_allocation_id.
  const RETURNED = `v.id, v.number, to_jsonb(v) ->> 'number_period' AS number_period, to_jsonb(v) ->> 'number_allocation_id' AS number_allocation_id`;

  // As crove_app in the user's context: a voucher and its entry, committed.
  async function post(user: string, org: string, kind: 'journal' | 'cash_receipt', date: string): Promise<{ id: string; number: number; period: string; allocation: string }> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, user, org);
      const { rows } = await (kind === 'journal'
        ? c.query<{ id: string; number: number; number_period: string; number_allocation_id: string }>(
            `INSERT INTO crove_finance.journal_voucher AS v (org_id, voucher_date, description) VALUES ($1, $2, 'test')
             RETURNING ${RETURNED}`,
            [org, date],
          )
        : c.query<{ id: string; number: number; number_period: string; number_allocation_id: string }>(
            `INSERT INTO crove_finance.cash_voucher AS v (org_id, voucher_type, voucher_date, cash_account, description, amount, number)
             VALUES ($1, 'cash_receipt', $2, '1111', 'test', 50000, 999) RETURNING ${RETURNED}`,
            [org, date],
          ));
      const v = rows[0]!;
      const lines =
        kind === 'journal'
          ? LINES
          : JSON.stringify([
              { line_no: 1, account_code: '1111', debit: '50000', credit: '0' },
              { line_no: 2, account_code: '131', debit: '0', credit: '50000' },
            ]);
      await c.query(`SELECT crove_finance.post_journal_entry($1::date, 'test', $2, $3::uuid, $4::jsonb)`, [
        date,
        kind === 'journal' ? 'finance.journal_voucher' : 'finance.cash_voucher',
        v.id,
        lines,
      ]);
      await c.query('COMMIT');
      return { id: v.id, number: v.number, period: v.number_period, allocation: v.number_allocation_id };
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-numbering-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < THIS_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    connect('sha256');
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@numbering.test', name: null });
    adminUser = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'admin@numbering.test', name: null });
    member = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'member@numbering.test', name: null });
    ({ orgId: legacyOrg } = await createOrg(rt, asUser(owner), 'Sổ cũ'));
    // Vouchers issued before the migration, numbered by the old max() + 1 triggers: PT 1..3 and NVK 1..2.
    for (let i = 0; i < 3; i += 1) await post(owner, legacyOrg, 'cash_receipt', `2026-0${i + 1}-15`);
    for (let i = 0; i < 2; i += 1) await post(owner, legacyOrg, 'journal', `2026-0${i + 4}-15`);

    await migrate({ adminUrl, dir: MIGRATIONS });
    // Connections opened before the migration may hold plans of the tables as they were.
    await pool.end();
    connect('keyed', true);

    ({ orgId } = await createOrg(rt, asUser(owner), 'Sổ mới'));
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, adminUser, member]),
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the numbers issued before the migration and continues them in a series that never resets', async () => {
    const rows = await admin(
      async (c) =>
        (
          await c.query<{ doc_type: string; reset: string; period_key: string; next_number: string; numbers: number[]; allocated: string[] }>(
            `SELECT s.doc_type, p.reset, s.period_key, s.next_number::text AS next_number,
                    array_agg(v.number ORDER BY v.number) AS numbers, array_agg(a.number::text ORDER BY v.number) AS allocated
             FROM crove_kernel.number_series s
             JOIN crove_kernel.number_series_policy p ON p.org_id = s.org_id AND p.legal_entity_id = s.legal_entity_id AND p.doc_type = s.doc_type
             JOIN crove_kernel.number_allocation a ON a.org_id = s.org_id AND a.series_id = s.id
             JOIN (SELECT org_id, id, number, number_period, number_allocation_id FROM crove_finance.cash_voucher
                   UNION ALL SELECT org_id, id, number, number_period, number_allocation_id FROM crove_finance.journal_voucher) v
               ON v.org_id = a.org_id AND v.number_allocation_id = a.id AND v.id = a.target_id AND v.number_period = s.period_key
             WHERE s.org_id = $1 GROUP BY 1, 2, 3, 4 ORDER BY 1`,
            [legacyOrg],
          )
        ).rows,
    );
    expect(rows).toEqual([
      { doc_type: 'finance.cash_voucher.cash_receipt', reset: 'never', period_key: '-', next_number: '4', numbers: [1, 2, 3], allocated: ['1', '2', '3'] },
      { doc_type: 'finance.journal_voucher', reset: 'never', period_key: '-', next_number: '3', numbers: [1, 2], allocated: ['1', '2'] },
    ]);
    // The next voucher continues the series, whatever its year; the caller's number is ignored.
    expect(await post(owner, legacyOrg, 'cash_receipt', '2027-01-02')).toMatchObject({ number: 4, period: '-' });
    expect(await post(owner, legacyOrg, 'journal', '2027-01-02')).toMatchObject({ number: 3, period: '-' });
    // A cash payment had no voucher before: its series is yearly, as for any new org.
    const policies = await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.number_series_policy WHERE org_id = $1', [legacyOrg])).rows[0]);
    expect(policies).toEqual({ n: 2 });
  });

  it('resets yearly by default: 31 December, then 1 January starts again at 1', async () => {
    expect(await post(owner, orgId, 'journal', '2026-12-30')).toMatchObject({ number: 1, period: '2026' });
    expect(await post(owner, orgId, 'journal', '2026-12-31')).toMatchObject({ number: 2, period: '2026' });
    expect(await post(owner, orgId, 'journal', '2027-01-01')).toMatchObject({ number: 1, period: '2027' });
    // A back-dated voucher takes the next number of its own year.
    expect(await post(owner, orgId, 'journal', '2026-11-05')).toMatchObject({ number: 3, period: '2026' });
    expect(await post(owner, orgId, 'cash_receipt', '2027-01-01')).toMatchObject({ number: 1, period: '2027' });
  });

  it('lets owners and admins set the reset policy of a series not yet used, and a monthly series starts each month at 1', async () => {
    const set = (user: string, input: unknown, org = orgId) => rt.execute<{ previous: string; reset: string }>('kernel.number.policy.set', input, { actor: asUser(user), orgId: org });
    await expect(set(member, { docType: 'finance.cash_voucher.cash_payment', reset: 'monthly' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // The definer refuses a member on its own too.
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, member, orgId);
      await expect(c.query(`SELECT crove_kernel.number_series_policy_set(NULL, 'finance.cash_voucher.cash_payment', 'monthly')`)).rejects.toMatchObject({
        code: '42501',
        message: 'NUMBER_FORBIDDEN',
      });
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    await expect(set(adminUser, { docType: 'finance.cash_voucher.cash_payment', reset: 'weekly' })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    // A series that already gave out numbers keeps its reset: switching it would number a period again from 1 next to
    // the numbers it already holds (review of #1573). Restating the reset in force is accepted.
    await expect(set(owner, { docType: 'finance.journal_voucher', reset: 'monthly' })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    await expect(set(owner, { docType: 'finance.journal_voucher', reset: 'yearly' }, legacyOrg)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    await expect(set(owner, { docType: 'finance.cash_voucher.cash_receipt', reset: 'yearly' }, legacyOrg)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(await set(owner, { docType: 'finance.cash_voucher.cash_receipt', reset: 'never' }, legacyOrg)).toMatchObject({ previous: 'never', reset: 'never' });
    // The series goes on where it was, in the same never-resetting period.
    expect(await post(owner, legacyOrg, 'cash_receipt', '2026-10-01')).toMatchObject({ number: 5, period: '-' });

    // A new org, no voucher yet: its admins choose the reset before the first number.
    const { orgId: fresh } = await createOrg(rt, asUser(owner), 'Sổ theo tháng');
    await admin((c2) => c2.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [fresh, adminUser]));
    expect(await set(adminUser, { docType: 'finance.journal_voucher', reset: 'monthly' }, fresh)).toMatchObject({ previous: 'yearly', reset: 'monthly' });
    expect(await set(owner, { docType: 'finance.journal_voucher', reset: 'monthly' }, fresh)).toMatchObject({ previous: 'monthly', reset: 'monthly' });
    expect(await post(owner, fresh, 'journal', '2027-03-31')).toMatchObject({ number: 1, period: '2027-03' });
    expect(await post(owner, fresh, 'journal', '2027-03-31')).toMatchObject({ number: 2, period: '2027-03' });
    expect(await post(owner, fresh, 'journal', '2027-04-01')).toMatchObject({ number: 1, period: '2027-04' });
    await expect(set(owner, { docType: 'finance.journal_voucher', reset: 'yearly' }, fresh)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    const audit = await admin(
      async (c2) =>
        (await c2.query(`SELECT detail ->> 'reset' AS reset, detail ->> 'previous' AS previous FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.number.policy.set' AND outcome = 'ok' ORDER BY occurred_at`, [fresh]))
          .rows,
    );
    expect(audit).toEqual([
      { reset: 'monthly', previous: 'yearly' },
      { reset: 'monthly', previous: 'monthly' },
    ]);
  });

  it('voids a number through kernel.number.void (R2, owners and admins), never a voucher number, and lists the series with its voids', async () => {
    // A number of a series of its own, as a module would take one through ctx.numbering.
    const allocate = async () => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, owner, orgId);
        const { rows } = await c.query<{ number: string; allocation_id: string }>(
          `SELECT number::text AS number, allocation_id FROM crove_kernel.allocate_number(NULL, 'test.doc', '2027-04-02', 'test.record', $1::uuid)`,
          [randomUUID()],
        );
        await c.query('COMMIT');
        return { number: Number(rows[0]!.number), allocation: rows[0]!.allocation_id };
      } finally {
        await c.end();
      }
    };
    const first = await allocate();
    const second = await allocate();
    const exec = (user: string, input: unknown) => rt.execute<{ voidId: string; number: number; periodKey: string }>('kernel.number.void', input, { actor: asUser(user), orgId });
    await expect(exec(member, { allocationId: second.allocation, reason: 'nhầm' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(exec(owner, { allocationId: randomUUID(), reason: 'nhầm' })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(exec(owner, { allocationId: second.allocation, reason: ' ' })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    expect(await exec(adminUser, { allocationId: second.allocation, reason: 'Chứng từ lập nhầm' })).toMatchObject({ number: second.number, periodKey: '2027' });
    await expect(exec(owner, { allocationId: second.allocation, reason: 'lần hai' })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    // A voucher number is never voided on its own: the voucher is reversed and keeps its number (review of #1573).
    const voucher = await post(owner, orgId, 'journal', '2027-04-02');
    await expect(exec(owner, { allocationId: voucher.allocation, reason: 'hủy phiếu' })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, owner, orgId);
      await expect(c.query(`SELECT crove_kernel.void_number($1, 'hủy phiếu')`, [voucher.allocation])).rejects.toMatchObject({
        code: '42501',
        message: 'NUMBER_SERIES_RESERVED',
      });
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    // Another org's allocation is not found.
    const legacyVoucher = await admin(
      async (c2) => (await c2.query<{ id: string }>('SELECT number_allocation_id AS id FROM crove_finance.journal_voucher WHERE org_id = $1 LIMIT 1', [legacyOrg])).rows[0]!.id,
    );
    await expect(exec(owner, { allocationId: legacyVoucher, reason: 'khác tổ chức' })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const page = await rt.query<NumberSeriesPage>('kernel.number.allocations', { docType: 'test.doc', periodKey: '2027' }, { actor: asUser(member), orgId });
    expect(page).toMatchObject({ docType: 'test.doc', periodKey: '2027', nextNumber: 3, more: false });
    expect(page.items.map((i) => [i.number, i.targetType, i.void?.reason ?? null])).toEqual([
      [second.number, 'test.record', 'Chứng từ lập nhầm'],
      [first.number, 'test.record', null],
    ]);
    const empty = await rt.query<NumberSeriesPage>('kernel.number.allocations', { docType: 'test.none', periodKey: '2027' }, { actor: asUser(owner), orgId });
    expect(empty).toMatchObject({ nextNumber: 1, items: [], more: false });
  });

  it('makes a policy change wait for the first allocation of a document type, then refuses it (#1607)', async () => {
    const open = async (user: string) => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      await c.query('BEGIN');
      await enterUser(c, user, orgId);
      return c;
    };
    let first: pg.Client | undefined;
    let change: pg.Client | undefined;
    try {
      first = await open(owner);
      change = await open(owner);
      // The first number of a new document type, under the default yearly reset, not committed yet.
      const { rows } = await first.query<{ period_key: string; number: string }>(
        `SELECT period_key, number::text AS number FROM crove_kernel.allocate_number(NULL, 'test.race', '2026-06-01', 'test.record', $1::uuid)`,
        [randomUUID()],
      );
      expect(rows[0]).toEqual({ period_key: '2026', number: '1' });
      // The switch to 'never' waits for it, instead of committing beside it and numbering PT 1 again in 2026.
      let settled = false;
      const switched = change.query(`SELECT crove_kernel.number_series_policy_set(NULL, 'test.race', 'never')`).finally(() => {
        settled = true;
      });
      switched.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await first.query('COMMIT');
      await expect(switched).rejects.toMatchObject({ code: '55000', message: 'NUMBER_POLICY_IN_USE' });
    } finally {
      await first?.end().catch(() => {});
      await change?.query('ROLLBACK').catch(() => {});
      await change?.end().catch(() => {});
    }
  });

  // #1595: an org whose vouchers predate #1401 (reset 'never') moves to a yearly reset from a future 1 January; a
  // voucher dated before it continues the old series.
  it('switches a reset from 1 January of a future year with no number dated then or later, and keeps the old one before it (#1595)', async () => {
    const schedule = (user: string, input: unknown) =>
      rt.execute<{ previous: string; reset: string; from: string }>('kernel.number.policy.schedule', input, { actor: asUser(user), orgId: legacyOrg });
    const doc = 'finance.journal_voucher';
    // A year after today and after every voucher the tests above dated.
    const year = Math.max(new Date().getFullYear() + 1, 2028);
    const from = (y: number) => `${y}-01-01`;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [legacyOrg, member]));

    await expect(schedule(member, { docType: doc, reset: 'yearly', from: from(year) })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // A boundary that is not 1 January, or one already past.
    await expect(schedule(owner, { docType: doc, reset: 'yearly', from: `${year}-03-01` })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(schedule(owner, { docType: doc, reset: 'yearly', from: '2020-01-01' })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    // A voucher already dated in that year: the year has numbers in the '-' series.
    expect(await post(owner, legacyOrg, 'journal', `${year}-02-01`)).toMatchObject({ number: 4, period: '-' });
    await expect(schedule(owner, { docType: doc, reset: 'yearly', from: from(year) })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    // The next year is free. A second switch from the same date replaces the first.
    expect(await schedule(owner, { docType: doc, reset: 'monthly', from: from(year + 1) })).toMatchObject({ previous: 'never', reset: 'monthly' });
    expect(await schedule(owner, { docType: doc, reset: 'yearly', from: from(year + 1) })).toMatchObject({ previous: 'monthly', reset: 'yearly' });
    const policy = await admin(
      async (c) =>
        (await c.query<{ reset: string; schedule: unknown }>('SELECT reset, schedule FROM crove_kernel.number_series_policy WHERE org_id = $1 AND doc_type = $2', [legacyOrg, doc])).rows,
    );
    expect(policy).toEqual([{ reset: 'never', schedule: [{ from: from(year + 1), reset: 'yearly' }] }]);

    // From the switch on, each year starts at 1; a voucher dated before it continues the '-' series.
    expect(await post(owner, legacyOrg, 'journal', `${year + 1}-01-05`)).toMatchObject({ number: 1, period: String(year + 1) });
    expect(await post(owner, legacyOrg, 'journal', `${year}-12-20`)).toMatchObject({ number: 5, period: '-' });
    // An earlier date after a later one: the series keeps its latest date (greatest).
    expect(await post(owner, legacyOrg, 'journal', `${year}-03-01`)).toMatchObject({ number: 6, period: '-' });
    expect(await post(owner, legacyOrg, 'journal', `${year + 1}-02-01`)).toMatchObject({ number: 2, period: String(year + 1) });
    // Now that year has numbers, its switch stays.
    await expect(schedule(owner, { docType: doc, reset: 'monthly', from: from(year + 1) })).rejects.toMatchObject({ code: 'CONFLICT' });

    // Each series fits its reset, so the WORM verifier reports none as a misfit; the audit row names the switch.
    const checked = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SET SESSION AUTHORIZATION crove_worker');
        const misfits = (await c.query<{ ref: string }>('SELECT ref FROM crove_kernel.archive_series_misfits()')).rows.map((r) => r.ref);
        await c.query('RESET SESSION AUTHORIZATION');
        const series = (
          await c.query<{ period_key: string; reset: string; last_doc_date: string | null }>(
            `SELECT s.period_key, crove_kernel.number_series_reset(s.org_id, s.legal_entity_id, s.doc_type, s.period_key) AS reset, s.last_doc_date::text AS last_doc_date
             FROM crove_kernel.number_series s WHERE s.org_id = $1 AND s.doc_type = $2 ORDER BY s.period_key`,
            [legacyOrg, doc],
          )
        ).rows;
        const audits = (
          await c.query<{ detail: unknown }>(
            `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.number.policy.schedule' AND outcome = 'ok' ORDER BY occurred_at`,
            [legacyOrg],
          )
        ).rows.map((r) => r.detail);
        return { misfits, series, audits };
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(checked.misfits.filter((ref) => ref.includes(legacyOrg))).toEqual([]);
    expect(checked.series).toEqual([
      { period_key: '-', reset: 'never', last_doc_date: `${year}-12-20` },
      { period_key: String(year + 1), reset: 'yearly', last_doc_date: `${year + 1}-02-01` },
    ]);
    // A switch written outside the definer into a year the '-' series already numbered, with the series' last document
    // date cleared too (it is not anchored): the vouchers the archive anchors make that series a misfit.
    const tampered = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE crove_kernel.number_series_policy SET schedule = $3::jsonb WHERE org_id = $1 AND doc_type = $2`, [
          legacyOrg,
          doc,
          JSON.stringify([{ from: from(year), reset: 'yearly' }]),
        ]);
        await c.query(`UPDATE crove_kernel.number_series SET last_doc_date = NULL WHERE org_id = $1 AND doc_type = $2`, [legacyOrg, doc]);
        await c.query('SET SESSION AUTHORIZATION crove_worker');
        return (await c.query<{ ref: string }>('SELECT ref FROM crove_kernel.archive_series_misfits()')).rows.map((r) => r.ref).filter((ref) => ref.includes(legacyOrg));
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const dash = await admin(
      async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.number_series WHERE org_id = $1 AND doc_type = $2 AND period_key = '-'`, [legacyOrg, doc])).rows[0]?.id,
    );
    expect(tampered).toEqual([`number_series:${legacyOrg}:${dash}`]);
    expect(checked.audits).toEqual([
      expect.objectContaining({ docType: doc, reset: 'monthly', from: from(year + 1), previous: 'never' }),
      expect.objectContaining({ docType: doc, reset: 'yearly', from: from(year + 1), previous: 'monthly' }),
    ]);
  });
});
