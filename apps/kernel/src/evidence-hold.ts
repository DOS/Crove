// Retention holds on evidence files (issue #1009, ADR-0013). The original file of a posted invoice is held in the bucket
// for EVIDENCE_LOCK_DAYS from its posting, as an S3 Object Lock retention in GOVERNANCE mode on the version its file
// row records. Posting writes nothing for it: crove_kernel.evidence_hold_due finds the files whose hold is missing or
// too short, and this job, outside any transaction, asks the store to hold each one and records the outcome with
// kernel.file.hold.record. A failure never touches the posting: the file keeps held_until null (or its shorter hold),
// the reason goes to hold_error, the job logs an ALERT and tries again with a backoff (5 minutes, doubling, at least
// daily). On a bucket without Object Lock nothing is attempted and nothing is recorded per file; the job logs one ALERT
// a day while files wait. On local disk there are no holds at all (the worker says so at start).
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { BlobIntegrityError, BlobNotFoundError, type BlobStore, type Runtime, type SystemActor } from '@crove/kernel-runtime';

export const EVIDENCE_HOLD_SWEEP_MS = 5 * 60_000;
const BATCH = 100;
const ALERT_EVERY_MS = 24 * 60 * 60_000;
const ACTOR: SystemActor = { type: 'system', component: 'kernel.evidence_hold' };

export interface EvidenceHoldState {
  // When the job last reported a bucket without Object Lock (milliseconds since the epoch), so it says so once a day.
  unavailableReportedAt: number;
}

export interface EvidenceHoldRun {
  held: number;
  failed: number;
  // Files that wait because the store cannot hold them (no Object Lock), in this batch.
  waiting: number;
}

// What hold_error records: a stable code, never the store's message. Members of the org can read their file rows, so
// bucket names, request ids and the like stay in the worker's log.
export function holdErrorText(error: unknown): string {
  if (error instanceof BlobNotFoundError) return 'BLOB_NOT_FOUND';
  if (error instanceof BlobIntegrityError) return 'BLOB_INTEGRITY';
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? `STORE_ERROR:${name}` : 'STORE_ERROR';
}

// One batch of at most BATCH files. Returns what it did; throws only when the scan itself fails.
export async function runEvidenceHolds(
  deps: { runtime: Runtime; workerDb: Db; store: BlobStore },
  days: number,
  state: EvidenceHoldState,
  now: () => number = Date.now,
): Promise<EvidenceHoldRun> {
  const out: EvidenceHoldRun = { held: 0, failed: 0, waiting: 0 };
  const holds = deps.store.holds;
  if (days <= 0 || !holds) return out;
  const { rows } = await sql<{ org_id: string; file_id: string; storage_key: string; generation: string | null; sha256: string; retain_until: Date }>`
    SELECT org_id, file_id, storage_key, generation, sha256, retain_until FROM crove_kernel.evidence_hold_due(${days}::int, ${BATCH}::int)`.execute(deps.workerDb);
  if (rows.length === 0) return out;
  if (!(await holds.available())) {
    out.waiting = rows.length;
    if (now() - state.unavailableReportedAt >= ALERT_EVERY_MS) {
      state.unavailableReportedAt = now();
      console.error(
        `[evidence-hold] ALERT the bucket has no Object Lock: ${rows.length}${rows.length === BATCH ? '+' : ''} posted file(s) wait for their retention hold ` +
          '(docs/runbooks/evidence-holds.md)',
      );
    }
    return out;
  }
  for (const row of rows) {
    const scope = { actor: ACTOR, orgId: row.org_id };
    let heldUntil: Date;
    try {
      heldUntil = await holds.hold({ key: row.storage_key, generation: row.generation, sha256: row.sha256 }, new Date(row.retain_until));
    } catch (error) {
      out.failed += 1;
      console.error(`[evidence-hold] file ${row.file_id} of org ${row.org_id}:`, error instanceof Error ? error.message : error);
      await deps.runtime.execute('kernel.file.hold.record', { fileId: row.file_id, error: holdErrorText(error) }, scope);
      continue;
    }
    await deps.runtime.execute('kernel.file.hold.record', { fileId: row.file_id, heldUntil: heldUntil.toISOString() }, scope);
    out.held += 1;
  }
  if (out.failed > 0) console.error(`[evidence-hold] ALERT ${out.failed} retention hold(s) failed; see hold_error on crove_kernel.file (docs/runbooks/evidence-holds.md)`);
  return out;
}
