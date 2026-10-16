// Retention purges (issue #38, plan §4.9): the worker runs crove_kernel.retention_purge() on a pg-boss schedule,
// one batch per call, until no store has expired rows left or the run's batch budget is spent.
import { sql } from 'kysely';
import type { Db } from '@crove/db';

// Every day at 02:30 in Vietnam, outside working hours.
export const RETENTION_CRON = '30 2 * * *';
export const RETENTION_TZ = 'Asia/Ho_Chi_Minh';
export const RETENTION_BATCH = 10_000;
// At most this many calls per run (each deletes up to RETENTION_BATCH rows per store); the next run continues.
const MAX_BATCHES_PER_RUN = 100;

interface PurgeRow {
  store: string;
  deleted: number;
  more: boolean;
}

export interface RetentionResult {
  // Rows deleted per store in this run.
  deleted: Record<string, number>;
  // Stores that still hold expired rows when the run stopped.
  remaining: string[];
}

/**
 * Purges expired rows. Each call is its own short transaction (autocommit), so a long purge never holds locks for
 * the whole run. A batch that deletes nothing while expired rows remain (rows locked by other transactions, or a
 * purge that stopped working) is logged as an ALERT, as the plan asks.
 */
export async function runRetention(workerDb: Db, batch = RETENTION_BATCH, log: Pick<Console, 'log' | 'error'> = console): Promise<RetentionResult> {
  const deleted: Record<string, number> = {};
  let remaining: string[] = [];
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const { rows } = await sql<PurgeRow>`SELECT store, deleted, more FROM crove_kernel.retention_purge(${batch}::int)`.execute(workerDb);
    for (const row of rows) deleted[row.store] = (deleted[row.store] ?? 0) + row.deleted;
    remaining = rows.filter((r) => r.more).map((r) => r.store);
    const stuck = rows.filter((r) => r.more && r.deleted === 0).map((r) => r.store);
    if (stuck.length > 0) {
      log.error(`[retention] ALERT purge deleted 0 rows while expired rows remain: ${stuck.join(', ')}`);
      break;
    }
    if (remaining.length === 0) break;
  }
  log.log(`[retention] ${Object.entries(deleted).map(([store, n]) => `${store}=${n}`).join(' ')}${remaining.length ? ` (more left: ${remaining.join(', ')})` : ''}`);
  return { deleted, remaining };
}
