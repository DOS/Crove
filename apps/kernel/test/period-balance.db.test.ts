// The nightly period balance reconciliation and the backfill of the deltas (issue #1284) on a real PostgreSQL 17. The
// backfill migration gives every entry posted before the deltas existed its deltas, once, however often it runs; the
// worker job resolves while the deltas match the journal lines and fails with references, not amounts, when they do
// not. The database rules are in test/invariant/period-balance.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { PERIOD_BALANCE_VERIFY_CRON, PeriodBalanceMismatchError, findPeriodBalanceDifferences, runPeriodBalanceReconciliation } from '../src/period-balance.ts';
import { QUEUES } from '../src/jobs-schema.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const BACKFILL = readFileSync(new URL('../../../supabase/migrations/20261031030100_crove_finance_period_balance_backfill.sql', import.meta.url), 'utf8');

const suite = ADMIN ? describe : describe.skip;

suite('period balance reconciliation (#1284)', () => {
  const dbName = `crove_test_period_reconcile_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let userId = '';
  let orgId = '';

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const post = async (date: string, debit: string) => {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      const lines = [
        { line_no: 1, account_code: '6422', debit, credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: debit },
      ];
      const { rows } = await c.query<{ id: string }>(
        `SELECT crove_finance.post_journal_entry($1::date, 'reconcile', 'test.reconcile', $2::uuid, $3::jsonb, NULL::uuid, 1) AS id`,
        [date, randomUUID(), JSON.stringify(lines)],
      );
      await c.query('COMMIT');
      return rows[0]?.id as string;
    } finally {
      await c.end();
    }
  };

  // An entry written by the database owner, as one posted before the deltas existed: lines, no deltas.
  const legacyEntry = (date: string, amount: string) =>
    withAdmin(async (a) => {
      await a.query('BEGIN');
      const { rows } = await a.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, $2, 'legacy', 'test.legacy', $3) RETURNING id`,
        [orgId, date, randomUUID()],
      );
      await a.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '1111', $3, 0), ($1, $2, 2, '5111', 0, $3)`, [
        orgId,
        rows[0]?.id,
        amount,
      ]);
      await a.query('COMMIT');
      return rows[0]?.id as string;
    });

  const deltaCount = () =>
    withAdmin(async (a) => Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM crove_finance.period_balance_delta WHERE org_id = $1`, [orgId])).rows[0]?.n));

  const runBackfill = () =>
    withAdmin(async (a) => {
      await a.query('BEGIN');
      await a.query(BACKFILL);
      await a.query('COMMIT');
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
    appUrl = app.toString();
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: worker.toString(), max: 1 });
    workerDb = createDb(workerPool);
    pool = createPool({ connectionString: appUrl, max: 1 });
    const db = createDb(pool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'period-reconcile', email: 'reconcile@period.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Reconcile')).orgId;
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

  it('has the queue the worker schedules nightly', async () => {
    expect(QUEUES.periodBalanceVerify).toBe('finance-period-balance-verify');
    expect(PERIOD_BALANCE_VERIFY_CRON).toBe('40 3 * * *');
    const queues = await withAdmin(async (a) => (await a.query<{ name: string }>(`SELECT name FROM crove_jobs.queue WHERE name = $1`, [QUEUES.periodBalanceVerify])).rows);
    expect(queues).toEqual([{ name: QUEUES.periodBalanceVerify }]);
  });

  it('backfills the deltas of entries posted without them, once however often it runs', async () => {
    await post('2026-08-10', '400000');
    const legacy = [await legacyEntry('2026-07-31', '120000'), await legacyEntry('2026-08-01', '80000')];
    const before = await deltaCount();
    expect(await findPeriodBalanceDifferences(workerDb)).toHaveLength(4);
    await runBackfill();
    expect(await deltaCount()).toBe(before + 4);
    await runBackfill();
    expect(await deltaCount()).toBe(before + 4);
    const months = await withAdmin(async (a) =>
      (
        await a.query<{ entry: string; month: string; account: string; debit: string }>(
          `SELECT entry_id AS entry, period_month::text AS month, account_code AS account, debit::numeric(30,4)::text AS debit
           FROM crove_finance.period_balance_delta WHERE org_id = $1 AND entry_id = ANY($2::uuid[]) ORDER BY month, account`,
          [orgId, legacy],
        )
      ).rows,
    );
    expect(months).toEqual([
      { entry: legacy[0], month: '2026-07-01', account: '1111', debit: '120000.0000' },
      { entry: legacy[0], month: '2026-07-01', account: '5111', debit: '0.0000' },
      { entry: legacy[1], month: '2026-08-01', account: '1111', debit: '80000.0000' },
      { entry: legacy[1], month: '2026-08-01', account: '5111', debit: '0.0000' },
    ]);
    await expect(runPeriodBalanceReconciliation(workerDb)).resolves.toBeUndefined();
  });

  it('fails the run with references and no amounts when a delta and the ledger disagree', async () => {
    const entry = await post('2026-09-03', '777777');
    await expect(runPeriodBalanceReconciliation(workerDb)).resolves.toBeUndefined();
    await withAdmin(async (a) => {
      await a.query('BEGIN');
      await a.query('SET LOCAL session_replication_role = replica');
      await a.query(`UPDATE crove_finance.period_balance_delta SET credit = credit + 1 WHERE org_id = $1 AND entry_id = $2 AND account_code = '331'`, [orgId, entry]);
      await a.query('COMMIT');
    });
    const error = await runPeriodBalanceReconciliation(workerDb).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PeriodBalanceMismatchError);
    const mismatch = error as PeriodBalanceMismatchError;
    expect(mismatch.differences).toEqual([{ orgId, accountCode: '331', periodMonth: '2026-09-01', entryId: entry, mismatch: ['credit'] }]);
    expect(mismatch.message).toBe(
      `PERIOD_BALANCE_MISMATCH: 1 difference(s) between period_balance_delta and journal_line: org ${orgId} account 331 month 2026-09 entry ${entry} (credit)`,
    );
    expect(mismatch.message).not.toContain('777777');
  });
});
