// Outbox retention (issue #997, plan §4.9): events older than OUTBOX_KEEP_DAYS are archived to the WORM archive store
// as one JSONL object per org and UTC day, with a manifest, and only then deleted from crove_kernel.outbox_event. The
// daily retention run calls archiveOutbox; the database decides what may be deleted (migration
// 20261028100000_crove_kernel_outbox_retention.sql), so a bug here can fail a run but never delete an event that the
// archive does not hold.
//
// Keys: outbox/v1/<org_id>/<day>.jsonl (one canonical JSON line per event, in created_at, id order) and
// outbox/v1/<org_id>/<day>.manifest.json. On S3 both are locked for OUTBOX_ARCHIVE_LOCK_DAYS (13 months, plan §7.9
// deletion map); a bucket lifecycle rule on outbox/ removes them afterwards (docs/runbooks/worm-archive.md).
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { ArchiveObjectExistsError, type ArchiveStore } from './worm.ts';

export const OUTBOX_KEEP_DAYS = 30;
// 13 months and a margin: the plan's deletion map keeps the outbox archive 13 months.
export const OUTBOX_ARCHIVE_LOCK_DAYS = 400;
export const OUTBOX_ARCHIVE_PREFIX = 'outbox/v1/';
// Org days one run handles at most; a backlog (the first run on an old deployment) continues on later runs.
const MAX_DAYS_PER_RUN = 500;

export interface OutboxManifest {
  format: 'crove-outbox-archive';
  version: 1;
  orgId: string;
  day: string;
  rows: number;
  firstId: string;
  lastId: string;
  object: string;
  sha256: string;
}

export interface OutboxRetentionResult {
  archived: number;
  purged: number;
  // Org days left for the next run: an event still waiting for the relay, or the run's budget spent.
  deferred: number;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Writes the object once. When an earlier run already wrote it (it stopped before recording the day), the stored
// bytes must be the same, or the day is left alone and the run fails loudly.
async function putOnce(store: ArchiveStore, key: string, body: Uint8Array): Promise<void> {
  try {
    await store.put(key, body, { retentionDays: OUTBOX_ARCHIVE_LOCK_DAYS });
  } catch (error) {
    if (!(error instanceof ArchiveObjectExistsError)) throw error;
  }
  const stored = await store.get(key);
  if (!stored || sha256(stored) !== sha256(body)) {
    throw new Error(`OUTBOX_ARCHIVE_MISMATCH: ${key} in the archive store differs from the events in the database`);
  }
}

export async function archiveOutboxDay(workerDb: Db, store: ArchiveStore, orgId: string, day: string): Promise<OutboxManifest | null> {
  const { rows } = await sql<{ id: string; line: string }>`
    SELECT id, line FROM crove_kernel.outbox_archive_rows(${orgId}::uuid, ${day}::date)`.execute(workerDb);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return null;
  const body = new TextEncoder().encode(`${rows.map((r) => r.line).join('\n')}\n`);
  const object = `${OUTBOX_ARCHIVE_PREFIX}${orgId}/${day}.jsonl`;
  await putOnce(store, object, body);
  const manifest: OutboxManifest = {
    format: 'crove-outbox-archive',
    version: 1,
    orgId,
    day,
    rows: rows.length,
    firstId: first.id,
    lastId: last.id,
    object,
    sha256: sha256(body),
  };
  await putOnce(store, `${OUTBOX_ARCHIVE_PREFIX}${orgId}/${day}.manifest.json`, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  await sql`SELECT crove_kernel.outbox_archive_record(${orgId}::uuid, ${day}::date, ${object}, ${manifest.sha256}, ${manifest.rows}::int)`.execute(workerDb);
  return manifest;
}

/**
 * Archives and purges every org day that is past the keep period, oldest first, up to the run's budget. Each step is
 * its own short transaction. A failure stops the run (the next one starts where this one stopped) and is rethrown.
 */
export async function archiveOutbox(workerDb: Db, store: ArchiveStore, keepDays = OUTBOX_KEEP_DAYS): Promise<OutboxRetentionResult> {
  const result: OutboxRetentionResult = { archived: 0, purged: 0, deferred: 0 };
  // The day as text: pg turns a date into a local-midnight Date, which would move it a day in a zone ahead of UTC.
  const { rows: due } = await sql<{ org_id: string; day: string; archived: boolean }>`
    SELECT org_id, day::text AS day, archived FROM crove_kernel.outbox_archive_due(${keepDays}::int, ${MAX_DAYS_PER_RUN}::int)`.execute(workerDb);
  for (const { org_id: orgId, day, archived } of due) {
    if (!archived) {
      if (!(await archiveOutboxDay(workerDb, store, orgId, day))) continue;
      result.archived += 1;
    }
    const { rows } = await sql<{ n: number }>`
      SELECT crove_kernel.outbox_archive_purge(${orgId}::uuid, ${day}::date, ${keepDays}::int) AS n`.execute(workerDb);
    const n = rows[0]?.n ?? 0;
    if (n < 0) result.deferred += 1;
    else result.purged += n;
  }
  if (due.length === MAX_DAYS_PER_RUN) result.deferred += 1;
  return result;
}
