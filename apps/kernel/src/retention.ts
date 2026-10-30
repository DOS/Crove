// Retention purges (issue #38, plan §4.9): the worker runs crove_kernel.retention_purge() on a pg-boss schedule,
// one batch per call, until no store has expired rows left or the run's batch budget is spent.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { EXPORT_EXPIRY_GRACE_HOURS } from '@crove/kernel';
import type { BlobStore, ListedBlob, ListPrefix, Runtime, StagingSweep } from '@crove/kernel-runtime';
import { opsAlert } from './ops-alert.ts';

// Where an ALERT line goes: the operational alerts (log and webhook, #1993) when the job logs to the console, else the
// log a caller passed (a test's).
function alertTo(log: Pick<Console, 'error'>): (line: string, error?: unknown) => void {
  return log === console ? opsAlert : (line, error) => (error === undefined ? log.error(line) : log.error(line, error));
}

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
      alertTo(log)(`[retention] ALERT purge deleted 0 rows while expired rows remain: ${stuck.join(', ')}`);
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
        if (result.more) alertTo(log)(`[retention] ALERT staging objects remain after deleting ${deleted}; set a lifecycle rule on staging/ (ADR-0013)`);
        return { deleted, more: result.more };
      }
    }
  } catch (error) {
    alertTo(log)(`[retention] ALERT staging sweep failed after deleting ${deleted}`, error);
    return null;
  }
}

// Raw inbound mail (inbound/<blob_id>) is deleted by the worker once a message is filed or dropped, and kept after the
// last failed attempt for investigation. The daily job deletes such leftovers once they are this old, the same window as
// the inbound drop counts (issue #212).
export const INBOUND_BLOB_MAX_AGE_DAYS = 30;
// Keys one list call looks at; a run lists page after page, up to BLOB_SWEEP_MAX_PAGES.
export const BLOB_SWEEP_PAGE = 1000;
// At most this many pages per prefix and run (100,000 keys); past it the run logs an ALERT and the next run continues.
export const BLOB_SWEEP_MAX_PAGES = 100;
const BLOB_DELETES_IN_FLIGHT = 10;
// Export blobs younger than this are never deleted, recorded or not: an export being written has not been recorded
// yet. Older ones go unless a record that has not expired lists them.
const EXPORT_UNRECORDED_MAX_AGE_MS = 2 * 86_400_000;
// The pg-boss queue of inbound mail (worker.ts QUEUES.inbound).
const INBOUND_QUEUE = 'kernel-inbound-email';

export interface BlobSweep {
  // Blobs deleted.
  deleted: number;
  // Old enough, but kept because something still references them.
  kept: number;
  // The run stopped at its page budget, so more blobs may remain for the next run.
  more: boolean;
}

interface SweepOptions {
  prefix: ListPrefix;
  label: string;
  cutoff: Date;
  // Of the old blobs of one page, the keys that must be kept. Called once per page.
  referenced: (blobs: ListedBlob[]) => Promise<Set<string>>;
  log: Pick<Console, 'log' | 'error'>;
  pageSize: number;
  maxPages: number;
}

// Lists a prefix page by page and deletes the blobs older than the cutoff that `referenced` does not keep. A failure is
// logged as an ALERT and returns null; it never stops the rest of the retention job.
async function sweepPrefix(store: BlobStore, options: SweepOptions): Promise<BlobSweep | null> {
  if (!store.list) {
    options.log.log(`[retention] ${options.label}: the blob store cannot list; not swept`);
    return null;
  }
  let deleted = 0;
  let kept = 0;
  let after: string | null = null;
  try {
    for (let page = 1; ; page++) {
      const listing = await store.list(options.prefix, after, options.pageSize);
      const old = listing.blobs.filter((b) => b.lastModified.getTime() < options.cutoff.getTime());
      const keep = old.length > 0 ? await options.referenced(old) : new Set<string>();
      const doomed = old.filter((b) => !keep.has(b.key)).map((b) => b.key);
      kept += old.length - doomed.length;
      for (let i = 0; i < doomed.length; i += BLOB_DELETES_IN_FLIGHT) {
        const settled = await Promise.allSettled(doomed.slice(i, i + BLOB_DELETES_IN_FLIGHT).map((key) => store.delete(key)));
        deleted += settled.filter((r) => r.status === 'fulfilled').length;
        const failure = settled.find((r) => r.status === 'rejected');
        if (failure) throw failure.reason;
      }
      after = listing.next;
      if (after === null || page >= options.maxPages) {
        const more = after !== null;
        options.log.log(`[retention] ${options.label} deleted=${deleted} kept=${kept}`);
        if (more) alertTo(options.log)(`[retention] ALERT ${options.label}: blobs remain after ${page} pages (deleted ${deleted}); the next run continues`);
        return { deleted, kept, more };
      }
    }
  } catch (error) {
    alertTo(options.log)(`[retention] ALERT ${options.label} sweep failed after deleting ${deleted}`, error);
    return null;
  }
}

/**
 * Of the given raw inbound blobs, the keys still waiting for the worker: a row in crove_kernel.inbound_pending (read
 * through the worker-only definer inbound_pending_blobs) or a live pg-boss job of the inbound queue. The pending rows
 * are read first: the relay sends the job before it commits the claim that deletes the row, so a blob is always in at
 * least one of the two places this order reads.
 */
export async function referencedInboundBlobs(workerDb: Db, keys: readonly string[], jobSchema = 'crove_jobs'): Promise<Set<string>> {
  const ids = keys.map((k) => k.slice('inbound/'.length));
  const pending = await sql<{ blob_id: string }>`SELECT crove_kernel.inbound_pending_blobs(${ids}::text[]) AS blob_id`.execute(workerDb);
  const live = await sql<{ blob_id: string }>`
    SELECT j.data->>'blobId' AS blob_id FROM ${sql.table(`${jobSchema}.job`)} j
    WHERE j.name = ${INBOUND_QUEUE} AND j.state IN ('created', 'retry', 'active') AND j.data->>'blobId' = ANY (${ids}::text[])`.execute(workerDb);
  return new Set([...pending.rows, ...live.rows].map((r) => `inbound/${r.blob_id}`));
}

/** Deletes raw inbound mail older than INBOUND_BLOB_MAX_AGE_DAYS that nothing waits for (issue #212). */
export async function sweepInboundBlobs(
  store: BlobStore,
  workerDb: Db,
  now: Date = new Date(),
  log: Pick<Console, 'log' | 'error'> = console,
  limits: { pageSize?: number; maxPages?: number; maxAgeDays?: number } = {},
): Promise<BlobSweep | null> {
  return sweepPrefix(store, {
    prefix: 'inbound/',
    label: 'inbound blobs',
    cutoff: new Date(now.getTime() - (limits.maxAgeDays ?? INBOUND_BLOB_MAX_AGE_DAYS) * 86_400_000),
    referenced: (blobs) => referencedInboundBlobs(workerDb, blobs.map((b) => b.key)),
    log,
    pageSize: limits.pageSize ?? BLOB_SWEEP_PAGE,
    maxPages: limits.maxPages ?? BLOB_SWEEP_MAX_PAGES,
  });
}

/**
 * Deletes org export blobs (export/<org_id>/...) once no export record that has not expired lists them (plan §7.9:
 * 35 to 90 days). Each org's live keys come from its records (kernel.org.export.live_keys), so the expiry date the
 * owner was shown decides, plus a day of grace, whatever EXPORT_RETENTION_DAYS is now; blobs of failed attempts go
 * after two days. When an org's records cannot be read (its tenant row is closed or gone), its blobs fall back to their
 * age: kept until retentionDays plus the grace day. File blobs live under org/ and are never listed here. On a
 * versioned bucket a delete leaves a noncurrent version, which the bucket's lifecycle rule removes; it stays sealed
 * (export-seal.ts).
 */
export async function expireExports(
  store: BlobStore,
  runtime: Pick<Runtime, 'query'>,
  retentionDays: number,
  now: Date = new Date(),
  log: Pick<Console, 'log' | 'error'> = console,
  limits: { pageSize?: number; maxPages?: number } = {},
): Promise<BlobSweep | null> {
  const byAge = now.getTime() - retentionDays * 86_400_000 - EXPORT_EXPIRY_GRACE_HOURS * 3_600_000;
  const live = new Map<string, Set<string> | null>();
  return sweepPrefix(store, {
    prefix: 'export/',
    label: 'export blobs',
    cutoff: new Date(now.getTime() - EXPORT_UNRECORDED_MAX_AGE_MS),
    referenced: async (blobs) => {
      const keep = new Set<string>();
      for (const blob of blobs) {
        const orgId = blob.key.split('/')[1] as string;
        if (!live.has(orgId)) {
          try {
            const keys = await runtime.query<string[]>('kernel.org.export.live_keys', {}, { actor: { type: 'system', component: 'retention' }, orgId });
            live.set(orgId, new Set(keys));
          } catch (error) {
            log.error(`[retention] export records of org ${orgId} unreadable; its export blobs expire by age`, error);
            live.set(orgId, null);
          }
        }
        const keys = live.get(orgId);
        if (keys ? keys.has(blob.key) : blob.lastModified.getTime() >= byAge) keep.add(blob.key);
      }
      return keep;
    },
    log,
    pageSize: limits.pageSize ?? BLOB_SWEEP_PAGE,
    maxPages: limits.maxPages ?? BLOB_SWEEP_MAX_PAGES,
  });
}
