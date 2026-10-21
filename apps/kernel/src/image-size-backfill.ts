// The backfill of Social image sizes (#668): images uploaded before sizes were read at upload have none, so the
// Instagram and Threads shape checks skip them. A pass reads each one's header from storage (the whole file, checked
// against its sha256) and records the size once. It walks the files by id after a cursor kept in memory, so a header
// that cannot be read is tried again only on the next round, a day later, never holding the others.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { BlobIntegrityError, BlobNotFoundError, BlobTooLargeError, readVerified, type BlobStore, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { imageSize } from './media-probe.ts';

export const IMAGE_SIZE_SWEEP_MS = 10 * 60_000;
const BATCH = 50;
// The wait between two rounds over every file still without a size.
const ROUND_PAUSE_MS = 24 * 60 * 60_000;
const ACTOR: SystemActor = { type: 'system', component: 'kernel.image_size' };

export interface ImageSizeBackfill {
  // The id the next pass starts after; null starts a new round from the first file.
  after: string | null;
  // No pass before this time (milliseconds since the epoch): set when a round ends.
  pausedUntil: number;
}

// One pass of at most BATCH files; returns how many sizes it recorded and how many headers it could not read. At the
// end of the files the cursor goes back to the start, for the next round.
export async function backfillImageSizes(deps: { runtime: Runtime; workerDb: Db; store: BlobStore }, state: ImageSizeBackfill): Promise<{ recorded: number; unreadable: number }> {
  const now = Date.now();
  if (now < state.pausedUntil) return { recorded: 0, unreadable: 0 };
  const { rows } = await sql<{ org_id: string; file_id: string; storage_key: string; generation: string | null; sha256: string; content_type: string }>`
    SELECT org_id, file_id, storage_key, generation, sha256, content_type FROM crove_kernel.image_size_due(${state.after}::uuid, ${BATCH}::int)`.execute(deps.workerDb);
  const out = { recorded: 0, unreadable: 0 };
  // A failure that is not a header Crove cannot read (storage or the database away): the round does not end on it,
  // so those files are tried again on the next pass rather than a day later.
  let failed = false;
  for (const row of rows) {
    try {
      const bytes = await readVerified(deps.store, { key: row.storage_key, generation: row.generation, sha256: row.sha256 });
      const size = imageSize(bytes, row.content_type);
      if (!size) {
        out.unreadable += 1;
        continue;
      }
      const done = await deps.runtime.execute<{ recorded: boolean }>('kernel.file.image_size.record', { fileId: row.file_id, width: size.width, height: size.height }, { actor: ACTOR, orgId: row.org_id });
      if (done.recorded) out.recorded += 1;
    } catch (error) {
      out.unreadable += 1;
      // A file that is gone, changed or too large stays unreadable; anything else may pass on the next try.
      if (!(error instanceof BlobNotFoundError || error instanceof BlobIntegrityError || error instanceof BlobTooLargeError)) failed = true;
      console.warn(`[image-size] file ${row.file_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
    }
  }
  if (failed) return out;
  if (rows.length < BATCH) {
    state.after = null;
    state.pausedUntil = now + ROUND_PAUSE_MS;
  } else state.after = rows.at(-1)?.file_id ?? null;
  return out;
}
