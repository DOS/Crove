// The nightly period balance reconciliation (issue #1284, plan §13 Phase 2a: `period_balance` is writable only by the
// posting definer, and reconciled nightly). crove_finance.post_journal_entry() appends one delta row per entry and
// account to crove_finance.period_balance_delta; this job compares those rows with the journal lines across every org
// (crove_finance.period_balance_differences, worker only, one snapshot) and fails on any difference: the job fails
// without a retry, pg-boss keeps it as a dead letter and the prober alerts, as the WORM verifier does. A difference
// means a delta was lost, added or changed outside the posting path, or a ledger row was; the job reports references
// only (org, account, month, entry and what differs), never amounts.
import { sql } from 'kysely';
import type { Db } from '@crove/db';

// 03:40 in Vietnam, after the retention run (02:30) and the WORM verifier (03:10).
export const PERIOD_BALANCE_VERIFY_CRON = '40 3 * * *';
// Differences one run reads at most; the error names the first few.
const MAX_DIFFERENCES = 100;
const NAMED_IN_ERROR = 10;

export interface PeriodBalanceDifference {
  orgId: string;
  accountCode: string;
  // YYYY-MM-DD, the first day of the month.
  periodMonth: string;
  entryId: string;
  // 'missing' (lines without a delta), 'extra' (a delta without lines), 'debit', 'credit' or 'lines'.
  mismatch: string[];
}

export class PeriodBalanceMismatchError extends Error {
  readonly differences: PeriodBalanceDifference[];
  constructor(differences: PeriodBalanceDifference[]) {
    const named = differences
      .slice(0, NAMED_IN_ERROR)
      .map((d) => `org ${d.orgId} account ${d.accountCode} month ${d.periodMonth.slice(0, 7)} entry ${d.entryId} (${d.mismatch.join(', ')})`)
      .join('; ');
    const more = differences.length > NAMED_IN_ERROR ? `; and ${differences.length - NAMED_IN_ERROR} more` : '';
    const count = differences.length >= MAX_DIFFERENCES ? `at least ${MAX_DIFFERENCES}` : String(differences.length);
    super(`PERIOD_BALANCE_MISMATCH: ${count} difference(s) between period_balance_delta and journal_line: ${named}${more}`);
    this.name = 'PeriodBalanceMismatchError';
    this.differences = differences;
  }
}

// Every difference, at most `limit` (1 to 1000). Runs as the worker login.
export async function findPeriodBalanceDifferences(db: Db, limit = MAX_DIFFERENCES): Promise<PeriodBalanceDifference[]> {
  const { rows } = await sql<{ org_id: string; account_code: string; period_month: string; entry_id: string; mismatch: string[] }>`
    SELECT org_id, account_code, period_month::text AS period_month, entry_id, mismatch
    FROM crove_finance.period_balance_differences(${limit}::int)`.execute(db);
  return rows.map((r) => ({ orgId: r.org_id, accountCode: r.account_code, periodMonth: r.period_month, entryId: r.entry_id, mismatch: r.mismatch }));
}

// Resolves when the deltas match the ledger everywhere; throws PeriodBalanceMismatchError otherwise.
export async function runPeriodBalanceReconciliation(db: Db): Promise<void> {
  const differences = await findPeriodBalanceDifferences(db);
  if (differences.length > 0) throw new PeriodBalanceMismatchError(differences);
}
