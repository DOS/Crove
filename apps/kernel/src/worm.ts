// The WORM fact stream (plan §4.10, issue #891). The worker anchors every audit event and journal entry outside the
// database, so an edit by the database owner (a trigger disabled, a row changed or deleted, a row backdated) shows:
//   - writeArchive, every minute: cuts the rows not yet archived into windows whose rows span at most 5 minutes,
//     stopping ARCHIVE_LAG_SECONDS before now so a transaction still open is not cut off. Each window becomes one
//     batch: the version 1 hash of each row (crove_kernel.archive_row_hashes), a batch hash over them and a chain hash
//     that folds in the previous batch. The batch is written once to the archive store, then recorded in the database.
//   - verifyArchive, nightly: reads every batch back from the store, checks the chain, and recomputes every row hash
//     from the database. A changed, missing or added row, a broken chain, a window gap, or a store and database that
//     disagree fail the run: the job fails without a retry, and the prober alerts on the dead letter.
// The archive holds hashes and references only, never row content.
//
// Stores, one key layout (chain/v1/<sequence, 12 digits>.json):
//   - s3: an S3 bucket with Object Lock. Every object is written create-only (If-None-Match: *) with a retention in
//     ARCHIVE_LOCK_MODE until ARCHIVE_RETENTION_DAYS from now; the worker refuses to start if the bucket has no Object
//     Lock. This is the store that holds against the database owner.
//   - local: read-only files under ARCHIVE_DIR, written create-only. It keeps the same chain and catches edits made in
//     the database, but whoever controls the host can rewrite it; use s3 in production (docs/runbooks/worm-archive.md).
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import type { Db } from '@crove/db';

export const ARCHIVE_PREFIX = 'chain/v1/';
export const ARCHIVE_WRITE_CRON = '* * * * *';
// 03:10 in Vietnam, after the retention run (02:30).
export const ARCHIVE_VERIFY_CRON = '10 3 * * *';
// The rows of one batch span at most this long.
export const ARCHIVE_WINDOW_MS = 5 * 60_000;
// Batches one run writes at most (a long outage catches up over several runs).
const MAX_BATCHES_PER_RUN = 50;
// Problems one verifier run records at most.
const MAX_PROBLEMS = 100;
export const GENESIS_SHA256 = createHash('sha256').update('').digest('hex');
const EPOCH = new Date(0).toISOString();

export interface ArchiveStore {
  // Writes the object once. Throws ArchiveObjectExistsError when the key is already taken.
  put(key: string, body: Uint8Array): Promise<void>;
  // The object's bytes, or null when there is none.
  get(key: string): Promise<Uint8Array | null>;
  // Every key under the prefix, in key order.
  list(prefix: string): Promise<string[]>;
  describe(): string;
}

export class ArchiveObjectExistsError extends Error {
  constructor(key: string) {
    super(`archive object ${key} already exists`);
  }
}

export class LocalArchiveStore implements ArchiveStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, body, { flag: 'wx', mode: 0o444 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ArchiveObjectExistsError(key);
      throw error;
    }
    await chmod(path, 0o444);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(join(this.dir, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const names = await readdir(join(this.dir, prefix)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    return names.map((name) => `${prefix}${name}`).sort();
  }

  describe(): string {
    return `local read-only files in ${this.dir}`;
  }
}

export type ArchiveLockMode = 'GOVERNANCE' | 'COMPLIANCE';
export type ArchiveS3Sender = Pick<S3Client, 'send'>;

export class S3ArchiveStore implements ArchiveStore {
  private readonly client: ArchiveS3Sender;
  private readonly bucket: string;
  private readonly lockMode: ArchiveLockMode;
  private readonly retentionDays: number;
  private readonly now: () => Date;

  constructor(options: { client: ArchiveS3Sender; bucket: string; lockMode: ArchiveLockMode; retentionDays: number; now?: () => Date }) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.lockMode = options.lockMode;
    this.retentionDays = options.retentionDays;
    this.now = options.now ?? (() => new Date());
  }

  // Refuses a bucket without Object Lock: its objects could be overwritten or deleted.
  async assertObjectLock(): Promise<void> {
    const answer = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.bucket }));
    if (answer.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
      throw new Error(`archive bucket ${this.bucket} has no Object Lock; create it with Object Lock enabled (docs/runbooks/worm-archive.md)`);
    }
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const retainUntil = new Date(this.now().getTime() + this.retentionDays * 86_400_000);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
          ObjectLockMode: this.lockMode,
          ObjectLockRetainUntilDate: retainUntil,
          // Object Lock writes need a checksum; sent up front, so no aws-chunked trailer.
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        }),
      );
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 412 || status === 409) throw new ArchiveObjectExistsError(key);
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const answer = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return answer.Body ? await answer.Body.transformToByteArray() : new Uint8Array();
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  describe(): string {
    return `s3 bucket ${this.bucket}, Object Lock ${this.lockMode} for ${this.retentionDays} days`;
  }
}

export interface ArchiveBatch {
  format: 'crove-archive';
  version: 1;
  seq: number;
  window: { from: string; to: string };
  prevChainSha256: string;
  // [ref, row hash], sorted by ref.
  rows: Array<[string, string]>;
  batchSha256: string;
  chainSha256: string;
}

export const archiveKey = (seq: number) => `${ARCHIVE_PREFIX}${String(seq).padStart(12, '0')}.json`;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function batchSha256(rows: Array<[string, string]>): string {
  return sha256(rows.map(([ref, hash]) => `${ref} ${hash}\n`).join(''));
}

export function chainSha256(prev: string, seq: number, from: string, to: string, batch: string): string {
  return sha256(`${prev}\n${seq}\n${from}\n${to}\n${batch}`);
}

const byRef = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

async function rowHashes(db: Db, from: string, to: string): Promise<Array<[string, string]>> {
  const { rows } = await sql<{ ref: string; row_sha256: string }>`
    SELECT ref, row_sha256 FROM crove_kernel.archive_row_hashes(${from}::timestamptz, ${to}::timestamptz)`.execute(db);
  return rows.map((r): [string, string] => [r.ref, r.row_sha256]).sort(byRef);
}

function parseBatch(bytes: Uint8Array): ArchiveBatch | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as ArchiveBatch;
    return value && value.format === 'crove-archive' && value.version === 1 && Array.isArray(value.rows) ? value : null;
  } catch {
    return null;
  }
}

// Writes the batches that are due. Returns how many it wrote.
export async function writeArchive(db: Db, store: ArchiveStore, options: { lagSeconds: number }): Promise<number> {
  let written = 0;
  for (; written < MAX_BATCHES_PER_RUN; written++) {
    const head = (await sql<{ seq: string; window_to: Date; chain_sha256: string }>`SELECT * FROM crove_kernel.archive_head()`.execute(db)).rows[0];
    const next = (
      await sql<{ window_from: Date; horizon: Date; first_row_at: Date | null }>`
        SELECT * FROM crove_kernel.archive_next_window(${options.lagSeconds}::int)`.execute(db)
    ).rows[0];
    if (!next?.first_row_at) return written;
    const seq = head ? Number(head.seq) + 1 : 1;
    const prev = head?.chain_sha256 ?? GENESIS_SHA256;
    const from = next.window_from.toISOString();
    const key = archiveKey(seq);

    let batch: ArchiveBatch;
    // A run that wrote the object but died before recording it left it in the store: take it as written, once it
    // continues the chain from this head.
    const existing = await store.get(key);
    if (existing) {
      const found = parseBatch(existing);
      if (!found || found.seq !== seq || found.prevChainSha256 !== prev || found.window.from !== from) {
        throw new Error(`archive object ${key} does not continue the chain recorded in the database; run the verifier and see docs/runbooks/worm-archive.md`);
      }
      batch = found;
    } else {
      const end = Math.min(next.horizon.getTime(), next.first_row_at.getTime() + ARCHIVE_WINDOW_MS);
      const to = new Date(end).toISOString();
      const rows = await rowHashes(db, from, to);
      const batchHash = batchSha256(rows);
      batch = {
        format: 'crove-archive',
        version: 1,
        seq,
        window: { from, to },
        prevChainSha256: prev,
        rows,
        batchSha256: batchHash,
        chainSha256: chainSha256(prev, seq, from, to, batchHash),
      };
      await store.put(key, new TextEncoder().encode(JSON.stringify(batch)));
    }
    await sql`SELECT crove_kernel.archive_record(${seq}::bigint, ${batch.window.from}::timestamptz, ${batch.window.to}::timestamptz,
      ${batch.rows.length}::int, ${batch.batchSha256}, ${batch.chainSha256}, ${key})`.execute(db);
  }
  return written;
}

export interface ArchiveProblem {
  code:
    | 'object_unreadable'
    | 'object_out_of_order'
    | 'window_gap'
    | 'chain_broken'
    | 'batch_hash_mismatch'
    | 'chain_hash_mismatch'
    | 'object_missing'
    | 'record_mismatch'
    | 'row_changed'
    | 'row_missing'
    | 'row_added';
  seq: number;
  ref?: string;
}

export interface ArchiveVerification {
  ok: boolean;
  batches: number;
  rows: number;
  problems: ArchiveProblem[];
}

// Checks the whole archive against the database and records the result. Never throws for a problem it finds; it
// throws only when it cannot run (store or database unreachable), and then records nothing.
export async function verifyArchive(db: Db, store: ArchiveStore): Promise<ArchiveVerification> {
  const problems: ArchiveProblem[] = [];
  const note = (problem: ArchiveProblem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };
  const recorded = new Map(
    (
      await sql<{ seq: string; window_from: Date; window_to: Date; chain_sha256: string; object_key: string }>`
        SELECT seq, window_from, window_to, chain_sha256, object_key FROM crove_kernel.archive_batches()`.execute(db)
    ).rows.map((r) => [Number(r.seq), r]),
  );
  const keys = await store.list(ARCHIVE_PREFIX);
  let prev = GENESIS_SHA256;
  let prevTo = EPOCH;
  let rowsChecked = 0;
  let seq = 0;
  for (const key of keys) {
    seq += 1;
    if (key !== archiveKey(seq)) {
      note({ code: 'object_out_of_order', seq });
      break;
    }
    const bytes = await store.get(key);
    const batch = bytes ? parseBatch(bytes) : null;
    if (!batch || batch.seq !== seq) {
      note({ code: 'object_unreadable', seq });
      break;
    }
    if (batch.prevChainSha256 !== prev) note({ code: 'chain_broken', seq });
    if (batch.window.from !== prevTo) note({ code: 'window_gap', seq });
    const batchHash = batchSha256(batch.rows);
    if (batchHash !== batch.batchSha256) note({ code: 'batch_hash_mismatch', seq });
    if (chainSha256(batch.prevChainSha256, seq, batch.window.from, batch.window.to, batch.batchSha256) !== batch.chainSha256) {
      note({ code: 'chain_hash_mismatch', seq });
    }
    // The database's record of the batch. The newest object may still be unrecorded (a run that died in between);
    // the next run records it.
    const record = recorded.get(seq);
    if (!record) {
      if (key !== keys.at(-1)) note({ code: 'record_mismatch', seq });
    } else if (record.chain_sha256 !== batch.chainSha256 || record.window_from.toISOString() !== batch.window.from || record.window_to.toISOString() !== batch.window.to) {
      note({ code: 'record_mismatch', seq });
    }

    const archived = new Map(batch.rows);
    const current = await rowHashes(db, batch.window.from, batch.window.to);
    rowsChecked += current.length;
    for (const [ref, hash] of current) {
      const kept = archived.get(ref);
      if (kept === undefined) note({ code: 'row_added', seq, ref });
      else if (kept !== hash) note({ code: 'row_changed', seq, ref });
      archived.delete(ref);
    }
    for (const ref of archived.keys()) note({ code: 'row_missing', seq, ref });

    prev = batch.chainSha256;
    prevTo = batch.window.to;
  }
  // Batches the database recorded that the store does not have.
  for (const recordedSeq of recorded.keys()) if (recordedSeq > seq) note({ code: 'object_missing', seq: recordedSeq });

  const result = { ok: problems.length === 0, batches: seq, rows: rowsChecked, problems };
  await sql`SELECT crove_kernel.archive_verified(${result.ok}, ${result.batches}::int, ${result.rows}::bigint, ${JSON.stringify(problems)}::jsonb)`.execute(db);
  return result;
}

// A verifier run that found problems. Its message carries codes and batch sequences only, so the dead letter pg-boss
// keeps (and the worker log) names what failed without any row content.
export class ArchiveMismatchError extends Error {
  readonly problems: ArchiveProblem[];

  constructor(result: ArchiveVerification) {
    const codes = [...new Set(result.problems.map((p) => p.code))].join(', ');
    super(`ARCHIVE_MISMATCH: ${result.problems.length} problem(s) over ${result.batches} batch(es): ${codes}; see crove_kernel.archive_verification and docs/runbooks/worm-archive.md`);
    this.problems = result.problems;
  }
}

// The nightly job: verifies, records the result, and fails when anything does not match.
export async function runArchiveVerification(db: Db, store: ArchiveStore): Promise<ArchiveVerification> {
  const result = await verifyArchive(db, store);
  if (!result.ok) throw new ArchiveMismatchError(result);
  return result;
}
