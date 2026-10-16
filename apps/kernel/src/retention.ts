// Retention purges (issue #38, plan §4.9): the worker runs crove_kernel.retention_purge() on a pg-boss schedule,
// one batch per call, until no store has expired rows left or the run's batch budget is spent.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import type { BlobStore, StagingSweep } from '@crove/kernel-runtime';

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

// Staging objects (abandoned presigned uploads, ADR-0013) older than this are deleted by the daily job. A grant lives
// 5 minutes and its completion reads the object right after the claim, so an hour old staging object is never read.
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
// Staging keys looked at per store call; a run calls again while more remain, up to STAGING_SWEEP_MAX_CALLS.
export const STAGING_SWEEP_LIMIT = 10_000;
// At most this many calls per run (1,000,000 keys); past it the run logs an ALERT and the next run continues.
export const STAGING_SWEEP_MAX_CALLS = 100;

/**
 * Deletes staging objects older than STAGING_MAX_AGE_MS, for stores without a lifecycle rule on staging/ (issue #223),
 * call after call until none is left or the run's budget is spent. A store without staging objects (local disk) has
 * no sweep. On a versioned bucket the deletes leave noncurrent versions, so only the lifecycle rule frees the space.
 * A failure, or objects left when the budget runs out, is logged as an ALERT; a failure returns null and never stops
 * the rest of the job. The next run tries again.
 */
export async function sweepStaging(
  store: BlobStore,
  now: Date = new Date(),
  limit = STAGING_SWEEP_LIMIT,
  log: Pick<Console, 'log' | 'error'> = console,
  maxCalls = STAGING_SWEEP_MAX_CALLS,
): Promise<StagingSweep | null> {
  if (!store.sweepStaging) return null;
  const before = new Date(now.getTime() - STAGING_MAX_AGE_MS);
  let deleted = 0;
  try {
    for (let call = 1; ; call++) {
      const result = await store.sweepStaging(before, limit);
      deleted += result.deleted;
      // A call that deleted nothing found only young objects in its window: calling again would list the same keys.
      if (!result.more || result.deleted === 0 || call >= maxCalls) {
        log.log(`[retention] staging objects deleted=${deleted}`);
        if (result.more) log.error(`[retention] ALERT staging objects remain after deleting ${deleted}; set a lifecycle rule on staging/ (ADR-0013)`);
        return { deleted, more: result.more };
      }
    }
  } catch (error) {
    log.error(`[retention] ALERT staging sweep failed after deleting ${deleted}`, error);
    return null;
  }
}
