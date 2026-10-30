// The WORM fact stream (plan §4.10, issues #891 and #977). The worker anchors every audit event, journal entry, voucher
// number, void and number series outside the database, so an edit by the database owner (a trigger disabled, a row
// changed or deleted, a row backdated, a voucher renumbered, a reset policy switched) shows:
//   - writeArchive, every minute: cuts the rows not yet archived into windows whose rows span at most 5 minutes,
//     stopping ARCHIVE_LAG_SECONDS before now so a transaction still open is not cut off. Each window becomes one
//     batch: the hash of each row, a batch hash over them and a chain hash that folds in the previous batch. The
//     batch is written once to the archive store, then recorded in the database.
//   - Batch versions: version 1 (#891) holds audit events and journal entries (crove_kernel.archive_row_hashes).
//     Version 2 (#977) adds the voucher numbers and voids (crove_kernel.archive_number_hashes) created from
//     `numbersFrom` to the end of its window: the epoch for the first version 2 batch, so it takes in every voucher
//     and void made before the switch, and its own window's start for every later one. Version 3 (#1489) adds, the
//     same way from `entitiesFrom`, the legal entity of every entry (and its lines), voucher and void
//     (crove_kernel.archive_entity_hashes), so moving a row to another entity shows. Version 4 (#1594, #1596) adds,
//     the same way from `allocationsFrom`, every number allocation and void of the gapless numbering and each
//     voucher's number, number period and allocation (crove_kernel.archive_allocation_hashes). Version 5 (#1623) adds,
//     the same way from `seriesFrom`, every number series with the reset policy in force for its doc type
//     (crove_kernel.archive_series_hashes), so switching a doc type's reset once it has numbers shows. Version 6
//     (#1337) adds, the same way from `revisionsFrom`, every journal entry's source revision and payload hash
//     (crove_kernel.archive_revision_hashes), so editing either shows. Version 7 (#2007) adds, the same way from
//     `highsFrom`, the highest number each series allocated in the window, with the series' key
//     (crove_kernel.archive_series_highs), so a restore can raise every series above the numbers the archive holds
//     (restore-report.ts). Each batch verifies with the version it was written with; a batch of a lower version after a
//     higher one means rows went unanchored.
//   - verifyArchive, nightly: reads every batch back from the store, checks the chain, and recomputes every row hash
//     from the database. After a restore, the rows the restore lost are named by an acknowledgement the restore check
//     wrote to the store (restores/v1/, #2020): those rows, in those batches, are excused, and nothing else is. A changed, missing or added row, a broken chain, a window gap, or a store and database that
//     disagree fail the run: the job fails without a retry, and the prober alerts on the dead letter. So does an
//     anchored number series whose period key does not fit its reset (crove_kernel.archive_series_misfits, #1820): a
//     reset switched and switched back before the series was anchored, which its row hash alone cannot show.
// The archive holds hashes and references only, never row content, with one exception: a version 7 batch also holds
// its series highs in the clear (`highs`: the series' legal entity, doc type, period key and highest number), which a
// restore reads back. They are ids, a doc type, a period key and a number, no personal data, and each one is checked
// against its row hash, which the chain covers.
//
// Stores, one key layout (chain/v1/<sequence, 12 digits>.json):
//   - s3: an S3 bucket with Object Lock. Every object is written create-only (If-None-Match: *) with a retention in
//     ARCHIVE_LOCK_MODE until ARCHIVE_RETENTION_DAYS from now; the worker refuses to start if the bucket has no Object
//     Lock. This is the store that holds against the database owner.
//   - local: read-only files under ARCHIVE_DIR, written create-only. It keeps the same chain and catches edits made in
//     the database, but whoever controls the host can rewrite it; use s3 in production (docs/runbooks/worm-archive.md).
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListObjectVersionsCommand,
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
// Times one run starts again from the head after another run took its sequence first.
const MAX_RACE_RESTARTS = 3;
// Problems one verifier run records at most.
const MAX_PROBLEMS = 100;
export const GENESIS_SHA256 = createHash('sha256').update('').digest('hex');
const EPOCH = new Date(0).toISOString();

export interface ArchiveStore {
  // Writes the object once. Throws ArchiveObjectExistsError when the key is already taken. On S3, retentionDays
  // overrides the store's Object Lock retention for this object (the outbox archive keeps 13 months, #997).
  put(key: string, body: Uint8Array, options?: { retentionDays?: number }): Promise<void>;
  // The object's bytes, or null when there is none.
  get(key: string): Promise<Uint8Array | null>;
  // Every key under the prefix, in key order.
  list(prefix: string): Promise<string[]>;
  // When the store wrote the object, by its own clock, or null when there is none: S3's LastModified, which the writer
  // cannot set, or the file's modification time. The restore acknowledgements are checked against it (#2020).
  writtenAt?(key: string): Promise<Date | null>;
  // How many versions each key under the prefix has, delete markers included, where the store keeps versions (S3 with
  // Object Lock). A WORM object has exactly one: a second means a PUT over it, or a delete (#2020).
  versionCounts?(prefix: string): Promise<Map<string, number>>;
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

  // Written whole to a temporary file, then linked under its key: a reader never sees half a batch, and link fails
  // when the key is taken.
  async put(key: string, body: Uint8Array): Promise<void> {
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(this.dir, `.tmp-${randomUUID()}`);
    await writeFile(temporary, body, { flag: 'wx', mode: 0o444 });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ArchiveObjectExistsError(key);
      throw error;
    } finally {
      await unlink(temporary);
    }
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

  async writtenAt(key: string): Promise<Date | null> {
    try {
      return (await stat(join(this.dir, key))).mtime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
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

  async put(key: string, body: Uint8Array, options?: { retentionDays?: number }): Promise<void> {
    const retainUntil = new Date(this.now().getTime() + (options?.retentionDays ?? this.retentionDays) * 86_400_000);
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

  async versionCounts(prefix: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
      for (const v of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) if (v.Key) counts.set(v.Key, (counts.get(v.Key) ?? 0) + 1);
      [keyMarker, versionMarker] = page.IsTruncated ? [page.NextKeyMarker, page.NextVersionIdMarker] : [undefined, undefined];
    } while (keyMarker !== undefined);
    return counts;
  }

  // The oldest version's LastModified: Object Lock turns versioning on, and a PUT without If-None-Match makes a new
  // version with a new LastModified, but cannot remove or redate the locked first one. The verifier also fails any key
  // with more than one version (versionCounts), so get and writtenAt read the same, single version.
  async writtenAt(key: string): Promise<Date | null> {
    let oldest: Date | null = null;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
      for (const v of page.Versions ?? []) {
        if (v.Key === key && v.LastModified && (!oldest || v.LastModified < oldest)) oldest = v.LastModified;
      }
      [keyMarker, versionMarker] = page.IsTruncated ? [page.NextKeyMarker, page.NextVersionIdMarker] : [undefined, undefined];
    } while (keyMarker !== undefined);
    return oldest;
  }

  describe(): string {
    return `s3 bucket ${this.bucket}, Object Lock ${this.lockMode} for ${this.retentionDays} days`;
  }
}

// A series high in the clear: [row reference number_high:<org_id>:<series id>, legal entity id, doc type, period key,
// the highest number allocated in the batch's window, as a decimal string].
export type ArchiveHigh = [string, string, string, string, string];

export interface ArchiveBatch {
  format: 'crove-archive';
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  seq: number;
  window: { from: string; to: string };
  // Versions 2 and up: where its voucher numbers and voids start (the epoch, or the window's start).
  numbersFrom?: string;
  // Versions 3 and up: where its legal entity rows start (the epoch, or the window's start).
  entitiesFrom?: string;
  // Versions 4 and up: where its number allocations, voids and voucher numbers start (the epoch, or the window's start).
  allocationsFrom?: string;
  // Versions 5 and up: where its number series and their reset policies start (the epoch, or the window's start).
  seriesFrom?: string;
  // Versions 6 and up: where its journal entries' source revisions and payload hashes start (the epoch, or the window's
  // start).
  revisionsFrom?: string;
  // Version 7: where its series highs start (the epoch, or the window's start), and the highs in the clear, sorted by
  // reference; each is also a row.
  highsFrom?: string;
  highs?: ArchiveHigh[];
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

// The row hash of a series high, as crove_kernel.archive_series_highs computes it (20261107140000): one line of text,
// so it is recomputed here from the clear values.
export function highSha256(ref: string, legalEntityId: string, docType: string, periodKey: string, number: string): string {
  const [, orgId, seriesId] = ref.split(':');
  return sha256(['number_high/v1', orgId, seriesId, legalEntityId, docType, periodKey, number].join('\n'));
}

// The series highs of the allocations made in [from, to), as rows and in the clear.
async function seriesHighs(db: Db, from: string, to: string): Promise<Array<{ row: [string, string]; high: ArchiveHigh }>> {
  const { rows } = await sql<{ ref: string; row_sha256: string; legal_entity_id: string; doc_type: string; period_key: string; high: string }>`
    SELECT ref, row_sha256, legal_entity_id, doc_type, period_key, high::text AS high
    FROM crove_kernel.archive_series_highs(${from}::timestamptz, ${to}::timestamptz)`.execute(db);
  return rows.map((r) => ({ row: [r.ref, r.row_sha256], high: [r.ref, r.legal_entity_id, r.doc_type, r.period_key, r.high] }));
}

const byRef = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// The rows of a batch as the database holds them now: version 1 rows of the window, plus from version 2 the numbers and
// voids from numbersFrom, plus from version 3 the legal entity rows from entitiesFrom, plus from version 4 the number
// allocations, their voids and the vouchers' number periods from allocationsFrom, plus from version 5 the number series
// with their reset policies from seriesFrom, plus from version 6 the journal entries' source revisions and payload
// hashes from revisionsFrom, plus from version 7 the series highs from highsFrom.
async function rowHashes(
  db: Db,
  batch: Pick<ArchiveBatch, 'version' | 'window' | 'numbersFrom' | 'entitiesFrom' | 'allocationsFrom' | 'seriesFrom' | 'revisionsFrom' | 'highsFrom'>,
  // The series highs when the caller has read them already (the writer keeps their clear values from the same read).
  knownHighs?: Array<{ row: [string, string] }>,
): Promise<Array<[string, string]>> {
  const { from, to } = batch.window;
  const { rows } = await sql<{ ref: string; row_sha256: string }>`
    SELECT ref, row_sha256 FROM crove_kernel.archive_row_hashes(${from}::timestamptz, ${to}::timestamptz)`.execute(db);
  const numbers =
    batch.version >= 2
      ? (
          await sql<{ ref: string; row_sha256: string }>`
            SELECT ref, row_sha256 FROM crove_kernel.archive_number_hashes(${batch.numbersFrom ?? from}::timestamptz, ${to}::timestamptz)`.execute(db)
        ).rows
      : [];
  const entities =
    batch.version >= 3
      ? (
          await sql<{ ref: string; row_sha256: string }>`
            SELECT ref, row_sha256 FROM crove_kernel.archive_entity_hashes(${batch.entitiesFrom ?? from}::timestamptz, ${to}::timestamptz)`.execute(db)
        ).rows
      : [];
  const allocations =
    batch.version >= 4
      ? (
          await sql<{ ref: string; row_sha256: string }>`
            SELECT ref, row_sha256 FROM crove_kernel.archive_allocation_hashes(${batch.allocationsFrom ?? from}::timestamptz, ${to}::timestamptz)`.execute(db)
        ).rows
      : [];
  const series =
    batch.version >= 5
      ? (
          await sql<{ ref: string; row_sha256: string }>`
            SELECT ref, row_sha256 FROM crove_kernel.archive_series_hashes(${batch.seriesFrom ?? from}::timestamptz, ${to}::timestamptz)`.execute(db)
        ).rows
      : [];
  const revisions =
    batch.version >= 6
      ? (
          await sql<{ ref: string; row_sha256: string }>`
            SELECT ref, row_sha256 FROM crove_kernel.archive_revision_hashes(${batch.revisionsFrom ?? from}::timestamptz, ${to}::timestamptz)`.execute(db)
        ).rows
      : [];
  const highs = batch.version >= 7 ? (knownHighs ?? (await seriesHighs(db, batch.highsFrom ?? from, to))).map((h) => ({ ref: h.row[0], row_sha256: h.row[1] })) : [];
  return [...rows, ...numbers, ...entities, ...allocations, ...series, ...revisions, ...highs].map((r): [string, string] => [r.ref, r.row_sha256]).sort(byRef);
}

// Where a batch's numbers start: the epoch when it is the first batch of version 2 or above, its window's start after.
const numbersFromAfter = (previous: ArchiveBatch | null, from: string) => ((previous?.version ?? 1) >= 2 ? from : EPOCH);
// Where a batch's legal entity rows start: the epoch when it is the first batch of version 3 or above, its window's start
// after.
const entitiesFromAfter = (previous: ArchiveBatch | null, from: string) => ((previous?.version ?? 1) >= 3 ? from : EPOCH);
// Where a batch's number allocations start: the epoch when it is the first batch of version 4 or above, its window's
// start after.
const allocationsFromAfter = (previous: ArchiveBatch | null, from: string) => ((previous?.version ?? 1) >= 4 ? from : EPOCH);
// Where a batch's number series start: the epoch when it is the first batch of version 5 or above, its window's start
// after.
const seriesFromAfter = (previous: ArchiveBatch | null, from: string) => ((previous?.version ?? 1) >= 5 ? from : EPOCH);
// Where a batch's source revisions start: the epoch when it is the first batch of version 6 or above, its window's start
// after.
const revisionsFromAfter = (previous: ArchiveBatch | null, from: string) => ((previous?.version ?? 1) >= 6 ? from : EPOCH);
// Where a batch's series highs start: the epoch when it is the first batch of version 7, its window's start after.
const highsFromAfter = (previous: ArchiveBatch | null, from: string) => ((previous?.version ?? 1) >= 7 ? from : EPOCH);

// A batch of a lower version after a higher one, and each kind of row a batch does not take from where the last one
// stopped: rows that went unanchored.
function versionProblems(batch: ArchiveBatch, previous: ArchiveBatch | null): ArchiveProblem['code'][] {
  const from = batch.window.from;
  const codes: ArchiveProblem['code'][] = [];
  if (batch.version < (previous?.version ?? 1)) codes.push('version_regressed');
  if (batch.version >= 2 && batch.numbersFrom !== numbersFromAfter(previous, from)) codes.push('numbers_gap');
  if (batch.version >= 3 && batch.entitiesFrom !== entitiesFromAfter(previous, from)) codes.push('entities_gap');
  if (batch.version >= 4 && batch.allocationsFrom !== allocationsFromAfter(previous, from)) codes.push('allocations_gap');
  if (batch.version >= 5 && batch.seriesFrom !== seriesFromAfter(previous, from)) codes.push('series_gap');
  if (batch.version >= 6 && batch.revisionsFrom !== revisionsFromAfter(previous, from)) codes.push('revisions_gap');
  if (batch.version >= 7 && batch.highsFrom !== highsFromAfter(previous, from)) codes.push('highs_gap');
  return codes;
}

// The problems of a version 7 batch's clear highs: each must match its row hash, and every high row must have its clear
// values, so a value changed in the store, or one left out, shows.
function highProblems(batch: ArchiveBatch): string[] {
  if (batch.version < 7) return [];
  const rows = new Map(batch.rows);
  const bad: string[] = [];
  const listed = new Set<string>();
  for (const high of batch.highs ?? []) {
    const [ref, legalEntityId, docType, periodKey, number] = high;
    listed.add(ref);
    if (!ref.startsWith('number_high:') || rows.get(ref) !== highSha256(ref, legalEntityId, docType, periodKey, number)) bad.push(ref);
  }
  for (const [ref] of batch.rows) if (ref.startsWith('number_high:') && !listed.has(ref)) bad.push(ref);
  return bad;
}

function parseBatch(bytes: Uint8Array): ArchiveBatch | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as ArchiveBatch;
    if (!value || value.format !== 'crove-archive' || !Array.isArray(value.rows)) return null;
    if (value.version === 1) return value;
    if (value.version === 2) return typeof value.numbersFrom === 'string' ? value : null;
    if (value.version === 3) return typeof value.numbersFrom === 'string' && typeof value.entitiesFrom === 'string' ? value : null;
    const v4 = typeof value.numbersFrom === 'string' && typeof value.entitiesFrom === 'string' && typeof value.allocationsFrom === 'string';
    if (value.version === 4) return v4 ? value : null;
    const v5 = v4 && typeof value.seriesFrom === 'string';
    if (value.version === 5) return v5 ? value : null;
    const v6 = v5 && typeof value.revisionsFrom === 'string';
    if (value.version === 6) return v6 ? value : null;
    const highs = value.highs;
    const wellFormed = Array.isArray(highs) && highs.every((h) => Array.isArray(h) && h.length === 5 && h.every((v) => typeof v === 'string'));
    return value.version === 7 && v6 && typeof value.highsFrom === 'string' && wellFormed ? value : null;
  } catch {
    return null;
  }
}

// Writes the batches that are due. Returns how many it wrote.
export async function writeArchive(db: Db, store: ArchiveStore, options: { lagSeconds: number }): Promise<number> {
  let written = 0;
  let restarts = 0;
  let restartSeq = 0;
  // Two runs can work on the same sequence (a retried job beside the next minute's): the one that loses the store
  // write or the record reads the head again and goes on from there. The cap counts losses on one sequence, so a run
  // that keeps losing to another on batch after batch finishes, and one stuck on a sequence stops (#1004).
  const restart = (seq: number) => {
    if (seq !== restartSeq) [restartSeq, restarts] = [seq, 0];
    return restarts++ < MAX_RACE_RESTARTS;
  };
  const lostRace = (error: unknown, seq: number) =>
    (error instanceof ArchiveObjectExistsError || (error as { code?: string }).code === '40001') && restart(seq);
  while (written < MAX_BATCHES_PER_RUN) {
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
        // Another run may have recorded this sequence between the two reads above: then the head has moved on.
        const now = (await sql<{ seq: string }>`SELECT seq FROM crove_kernel.archive_head()`.execute(db)).rows[0];
        if (Number(now?.seq ?? 0) >= seq && restart(seq)) continue;
        throw new Error(`archive object ${key} does not continue the chain recorded in the database; run the verifier and see docs/runbooks/worm-archive.md`);
      }
      batch = found;
    } else {
      const end = Math.min(next.horizon.getTime(), next.first_row_at.getTime() + ARCHIVE_WINDOW_MS);
      const to = new Date(end).toISOString();
      // The head's batch tells whether this one is the first of version 2, 3, 4, 5, 6 or 7. When it cannot be read (the
      // verifier reports that), this batch takes the numbers, entities, allocations, series, revisions and highs from
      // the epoch again: anchoring a row twice loses nothing.
      const previousBytes = head ? await store.get(archiveKey(seq - 1)) : null;
      const previous = previousBytes ? parseBatch(previousBytes) : null;
      const shape = {
        version: 7 as const,
        window: { from, to },
        numbersFrom: numbersFromAfter(previous, from),
        entitiesFrom: entitiesFromAfter(previous, from),
        allocationsFrom: allocationsFromAfter(previous, from),
        seriesFrom: seriesFromAfter(previous, from),
        revisionsFrom: revisionsFromAfter(previous, from),
        highsFrom: highsFromAfter(previous, from),
      };
      // The series highs are read once: their rows and their clear values come from the same read.
      const read = await seriesHighs(db, shape.highsFrom, to);
      const rows = await rowHashes(db, shape, read);
      const batchHash = batchSha256(rows);
      const highs = read.map((h) => h.high).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      batch = {
        format: 'crove-archive',
        ...shape,
        highs,
        seq,
        prevChainSha256: prev,
        rows,
        batchSha256: batchHash,
        chainSha256: chainSha256(prev, seq, from, to, batchHash),
      };
      try {
        await store.put(key, new TextEncoder().encode(JSON.stringify(batch)));
      } catch (error) {
        if (lostRace(error, seq)) continue;
        throw error;
      }
    }
    try {
      await sql`SELECT crove_kernel.archive_record(${seq}::bigint, ${batch.window.from}::timestamptz, ${batch.window.to}::timestamptz,
        ${batch.rows.length}::int, ${batch.batchSha256}, ${batch.chainSha256}, ${key})`.execute(db);
    } catch (error) {
      if (lostRace(error, seq)) continue;
      throw error;
    }
    written++;
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
    | 'row_added'
    | 'version_regressed'
    | 'numbers_gap'
    | 'entities_gap'
    | 'allocations_gap'
    | 'series_gap'
    | 'revisions_gap'
    | 'highs_gap'
    | 'high_mismatch'
    | 'restore_ack_unreadable'
    | 'restore_ack_mismatch'
    | 'object_versions'
    | 'series_period_mismatch';
  seq: number;
  ref?: string;
}

export interface ArchiveVerification {
  ok: boolean;
  batches: number;
  rows: number;
  problems: ArchiveProblem[];
  // Rows a restore acknowledgement excused (#2020): lost with a restore, and named by its report. Never silent: the
  // run records the count and the acknowledgement in force (restoreAck, its sequence), and the worker logs them.
  // restoreAckWrittenAt is when the store wrote that acknowledgement (its oldest version), and alertRestoreAck says it
  // is recent (within restoreAlertDays): the worker alerts on every run until it is not. Neither comes from the
  // database, so its owner cannot silence the alert.
  excused: number;
  restoreAck: number | null;
  restoreAckWrittenAt: string | null;
  alertRestoreAck: boolean;
}

// After a restore (#2020): the rows a restore lost, written to the archive store by the restore check
// (restore-report.ts, --acknowledge) before the restored stack starts. Acknowledgements are numbered (sequence, its
// key restores/v1/<sequence>.json) and each one holds every row excused from then on, [batch sequence, reference]: the
// rows of the previous acknowledgement the restored database still lacks, and the rows this restore lost. A row is
// listed when the database lacks it, or, for a series high, holds it with another hash (a window that lost some of
// its numbers). The verifier reads the newest only, so a row a later restore brought back is excused no more. Each
// object is create-only like a batch (Object Lock on s3), so the database owner cannot write one.
// recordedAtRestore is the newest batch the restored database had recorded, batchesAtRestore the newest in the store
// then; no row of a later batch is ever excused.
// A restore loses a suffix in time: every archived row stamped at or after its backup point (the backup's snapshot,
// which the operator gives from the backup run, not from the database). So each restore an acknowledgement carries is
// [first, last, backup point]: the first batch with a row it lost, the store's newest batch then, and the point. Its
// rows are excused only while the restore reads as one (restoreHolds): the database holds no archived row stamped from
// the backup point to the end of batch last, and batch first ends less than RESTORE_SLACK_MS before the point (a row
// lost with a time before the point is one of a transaction still open at the backup, or archived late). A row
// deleted on its own, newer rows still there, is never excused, whoever wrote the acknowledgement.
// Acknowledgements form a chain, checked whole before any is trusted (restoreAckChain): sequences 1..n with no gap,
// each with the sha256 of the one before (prevSha256), each bound to the store's newest batch when it was written
// (batchesAtRestore, with that batch's chain hash): the batch after it must have been written later than the
// acknowledgement, by the store's own clock, so one written later naming an older batch fails. Each carries the
// restores of the one before it, or some of them, and at most one of its own, which ends at its own batchesAtRestore;
// it may drop excuses of earlier restores, never add any.
export const RESTORE_ACK_PREFIX = 'restores/v1/';

export interface RestoreAck {
  format: 'crove-restore-ack';
  version: 1;
  sequence: number;
  // The sha256 of the previous acknowledgement's bytes (GENESIS_SHA256 for the first), and the chain hash of batch
  // batchesAtRestore.
  prevSha256: string;
  lastChainSha256: string;
  acknowledgedAt: string;
  recordedAtRestore: number;
  batchesAtRestore: number;
  intervals: RestoreInterval[];
  refs: Array<[number, string]>;
}

// A restore: [first batch with a row it lost, the store's newest batch then, its backup point (ISO time)].
export type RestoreInterval = [number, number, string];
// How long before its backup point a row a restore lost may be stamped: the archive lag (ARCHIVE_LAG_SECONDS, 10
// minutes by default) and transactions still open at the backup, with room to spare.
export const RESTORE_SLACK_MS = 60 * 60_000;

export const restoreAckKey = (sequence: number) => `${RESTORE_ACK_PREFIX}${String(sequence).padStart(12, '0')}.json`;

function parseRestoreAck(bytes: Uint8Array): RestoreAck | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as RestoreAck;
    if (!value || value.format !== 'crove-restore-ack' || value.version !== 1 || typeof value.acknowledgedAt !== 'string') return null;
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
    if (typeof value.prevSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.prevSha256)) return null;
    if (typeof value.lastChainSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.lastChainSha256) || value.batchesAtRestore < 1) return null;
    if (!Number.isSafeInteger(value.recordedAtRestore) || !Number.isSafeInteger(value.batchesAtRestore) || value.recordedAtRestore < 0) return null;
    if (value.batchesAtRestore < value.recordedAtRestore || !Array.isArray(value.refs) || !Array.isArray(value.intervals)) return null;
    const intervals = value.intervals.every(
      (i) =>
        Array.isArray(i) &&
        i.length === 3 &&
        Number.isSafeInteger(i[0]) &&
        Number.isSafeInteger(i[1]) &&
        i[0] >= 1 &&
        i[0] <= i[1] &&
        i[1] <= value.batchesAtRestore &&
        typeof i[2] === 'string' &&
        Number.isFinite(Date.parse(i[2])),
    );
    // Every reference lies in one of the intervals.
    const refs = value.refs.every(
      (r) => Array.isArray(r) && r.length === 2 && Number.isSafeInteger(r[0]) && typeof r[1] === 'string' && value.intervals.some(([a, b]) => r[0] >= a && r[0] <= b),
    );
    return intervals && refs ? value : null;
  } catch {
    return null;
  }
}

const refKey = ([seq, ref]: [number, string]) => `${seq} ${ref}`;

// Every batch and acknowledgement key with more than one version, where the store keeps versions: a PUT over a WORM
// object, or a delete, which Object Lock keeps in view but does not stop with the writer's key (#2020).
async function multiVersionProblems(store: ArchiveStore): Promise<ArchiveProblem[]> {
  if (!store.versionCounts) return [];
  const problems: ArchiveProblem[] = [];
  for (const prefix of [ARCHIVE_PREFIX, RESTORE_ACK_PREFIX]) {
    for (const [key, count] of await store.versionCounts(prefix)) if (count > 1) problems.push({ code: 'object_versions', seq: 0, ref: key });
  }
  return problems;
}

// Whether an acknowledgement is bound to the store's newest batch when it was written: batch batchesAtRestore holds
// its chain hash, and the batch after it, if any, was written no earlier than the acknowledgement, by the store's own
// clock. A store that cannot tell when it wrote an object cannot bind one.
async function ackBound(store: ArchiveStore, key: string, ack: RestoreAck): Promise<boolean> {
  if (!store.writtenAt) return false;
  const bytes = await store.get(archiveKey(ack.batchesAtRestore));
  const batch = bytes ? parseBatch(bytes) : null;
  if (!batch || batch.chainSha256 !== ack.lastChainSha256) return false;
  const written = await store.writtenAt(key);
  if (!written) return false;
  const next = await store.writtenAt(archiveKey(ack.batchesAtRestore + 1));
  return next === null || next.getTime() >= written.getTime();
}

// Whether an acknowledgement follows the one before it: every restore it carries is one of the previous one's, but at
// most one of its own, which ends at its batchesAtRestore; every row it names in an earlier restore, the previous one
// named too; and the store had not shrunk.
function ackFollows(ack: RestoreAck, previous: RestoreAck | null): boolean {
  const before = new Set((previous?.intervals ?? []).map((i) => JSON.stringify(i)));
  const own = ack.intervals.filter((i) => !before.has(JSON.stringify(i)));
  if (own.length > 1 || own.some(([, last]) => last !== ack.batchesAtRestore)) return false;
  if (previous && ack.batchesAtRestore < previous.batchesAtRestore) return false;
  const named = new Set((previous?.refs ?? []).map(refKey));
  const inOwn = ([s]: [number, string]) => own.some(([a, b]) => s >= a && s <= b);
  return ack.refs.every((r) => inOwn(r) || named.has(refKey(r)));
}

// The acknowledgement in force: the newest of a chain that holds whole, with the sha256 of its bytes. Any break (a
// gap, an object that does not parse, a broken link, one not bound to its newest batch, one that adds to an earlier
// restore) is a problem, and then none is in force: nothing is excused.
async function restoreAckChain(store: ArchiveStore): Promise<{ ack: RestoreAck | null; sha256: string; problems: ArchiveProblem[] }> {
  const keys = await store.list(RESTORE_ACK_PREFIX);
  let previous: RestoreAck | null = null;
  let prevSha = GENESIS_SHA256;
  for (const [i, key] of keys.entries()) {
    const bytes = key === restoreAckKey(i + 1) ? await store.get(key) : null;
    const ack = bytes ? parseRestoreAck(bytes) : null;
    if (!bytes || !ack || ack.sequence !== i + 1 || ack.prevSha256 !== prevSha) {
      return { ack: null, sha256: prevSha, problems: [{ code: 'restore_ack_unreadable', seq: 0, ref: key }] };
    }
    if (!ackFollows(ack, previous) || !(await ackBound(store, key, ack))) {
      return { ack: null, sha256: prevSha, problems: [{ code: 'restore_ack_mismatch', seq: 0, ref: key }] };
    }
    previous = ack;
    prevSha = createHash('sha256').update(bytes).digest('hex');
  }
  return { ack: previous, sha256: prevSha, problems: [] };
}

// Whether a restore still reads as one (see RestoreAck): batch first ends less than RESTORE_SLACK_MS before its backup
// point, and the database holds no row of any kind the archive anchors stamped from the backup point to the end of
// batch last (one read over that range, every kind from the point, so the rows a version's first batch took in from
// the epoch do not count). windows: each batch's window, by sequence.
async function restoreHolds(db: Db, [first, last, point]: RestoreInterval, windows: Map<number, ArchiveBatch['window']>): Promise<boolean> {
  const at = Date.parse(point);
  const firstWindow = windows.get(first);
  const lastWindow = windows.get(last);
  if (!Number.isFinite(at) || !firstWindow || !lastWindow) return false;
  if (Date.parse(firstWindow.to) <= at - RESTORE_SLACK_MS) return false;
  // The point as given, to the microsecond: PostgreSQL reads it, Date.parse would round it to the millisecond.
  const from = point;
  const kept = await rowHashes(db, {
    version: 7,
    window: { from, to: lastWindow.to },
    numbersFrom: from,
    entitiesFrom: from,
    allocationsFrom: from,
    seriesFrom: from,
    revisionsFrom: from,
    highsFrom: from,
  });
  return kept.length === 0;
}
const byBatchRef = (a: [number, string], b: [number, string]) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

// Every row of any kind the archive anchors that the database holds stamped at or after `from`, with no upper bound.
async function rowsSince(db: Db, from: string): Promise<Array<[string, string]>> {
  return rowHashes(db, {
    version: 7,
    window: { from, to: 'infinity' },
    numbersFrom: from,
    entitiesFrom: from,
    allocationsFrom: from,
    seriesFrom: from,
    revisionsFrom: from,
    highsFrom: from,
  });
}

// References that legitimately come back after a restore: a series' row the reseed made again with its archived id, and
// a series' highs, which go on in later batches. Any other excused reference that comes back is an edit restamped.
const comesBack = (ref: string) => ref.startsWith('number_series:') || ref.startsWith('number_high:');

// Checks the whole archive against the database and records the result. Never throws for a problem it finds; it
// throws only when it cannot run (store or database unreachable), and then records nothing.
// Days the worker alerts, on every run, about the restore acknowledgement in force after the store wrote it (#2020).
const RESTORE_ACK_ALERT_DAYS = 14;

export async function verifyArchive(
  db: Db,
  store: ArchiveStore,
  options: { restoreAlertDays?: number; now?: () => Date } = {},
): Promise<ArchiveVerification> {
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
  let previous: ArchiveBatch | null = null;
  let rowsChecked = 0;
  let seq = 0;
  // The batch that anchored each number series, and the rows already found changed, missing or added.
  const seriesSeq = new Map<string, number>();
  const rowProblems = new Set<string>();
  // The rows restores lost, as the newest acknowledgement names them (#2020). A missing row (or a series high with
  // another hash) it names waits in `listed` until every batch is read: its excuse holds only if its restore still
  // reads as one (restoreHolds).
  const acks = await restoreAckChain(store);
  for (const problem of acks.problems) note(problem);
  for (const problem of await multiVersionProblems(store)) note(problem);
  const excuses = new Set((acks.ack?.refs ?? []).map(refKey));
  const listed: Array<{ seq: number; ref: string; code: 'row_missing' | 'row_changed' }> = [];
  const windows = new Map<number, ArchiveBatch['window']>();
  // The references of the batches after the acknowledgement's newest.
  const laterRefs = new Set<string>();
  let excused = 0;
  const isListed = (seq: number, ref: string) => excuses.has(`${seq} ${ref}`);
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
    // Numbers are anchored from the first version 2 batch on, legal entities from the first version 3 batch on, number
    // allocations from the first version 4 batch on, number series from the first version 5 batch on, source
    // revisions from the first version 6 batch on and series highs from the first version 7 batch on, each from where
    // the last one stopped.
    for (const code of versionProblems(batch, previous)) note({ code, seq });
    for (const ref of highProblems(batch)) note({ code: 'high_mismatch', seq, ref });
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
    const current = await rowHashes(db, batch);
    rowsChecked += current.length;
    windows.set(seq, batch.window);
    if (acks.ack && seq > acks.ack.batchesAtRestore) for (const [ref] of batch.rows) laterRefs.add(ref);
    for (const [ref, hash] of current) {
      const kept = archived.get(ref);
      archived.delete(ref);
      // A series high whose window lost some of its numbers to a restore holds another hash now; any other row that
      // differs is a finding, acknowledged or not.
      const lostHigh = kept !== undefined && kept !== hash && ref.startsWith('number_high:');
      if (lostHigh && isListed(seq, ref)) {
        listed.push({ seq, ref, code: 'row_changed' });
        continue;
      }
      if (kept === undefined) note({ code: 'row_added', seq, ref });
      else if (kept !== hash) note({ code: 'row_changed', seq, ref });
      if (kept !== hash) rowProblems.add(ref);
    }
    for (const ref of archived.keys()) {
      if (isListed(seq, ref)) {
        listed.push({ seq, ref, code: 'row_missing' });
        continue;
      }
      note({ code: 'row_missing', seq, ref });
      rowProblems.add(ref);
    }
    for (const [ref] of batch.rows) if (ref.startsWith('number_series:')) seriesSeq.set(ref, seq);

    prev = batch.chainSha256;
    prevTo = batch.window.to;
    previous = batch;
  }
  // The rows the acknowledgement names: excused within an interval that still reads as a restore, findings otherwise.
  const holding: RestoreInterval[] = [];
  for (const interval of acks.ack?.intervals ?? []) {
    if (await restoreHolds(db, interval, windows)) holding.push(interval);
    else if (acks.ack) note({ code: 'restore_ack_mismatch', seq: interval[0], ref: restoreAckKey(acks.ack.sequence) });
  }
  // A row a restore lost never comes back under its own reference: one that does, in a batch after the
  // acknowledgement's newest or among the rows not archived yet, was restamped past the restore, so nothing is excused.
  if (acks.ack && holding.length > 0) {
    const ack = acks.ack;
    const lastWindow = windows.get(seq);
    const later = new Set([...laterRefs, ...(lastWindow ? (await rowsSince(db, lastWindow.to)).map(([ref]) => ref) : [])]);
    const back = ack.refs.find(([, ref]) => !comesBack(ref) && later.has(ref));
    if (back) {
      note({ code: 'restore_ack_mismatch', seq: back[0], ref: back[1] });
      holding.length = 0;
    }
  }
  for (const row of listed) {
    if (holding.some(([a, b]) => row.seq >= a && row.seq <= b)) {
      excused += 1;
      continue;
    }
    note({ code: row.code, seq: row.seq, ref: row.ref });
    rowProblems.add(row.ref);
  }
  // Batches the database recorded that the store does not have.
  for (const recordedSeq of recorded.keys()) if (recordedSeq > seq) note({ code: 'object_missing', seq: recordedSeq });
  // Anchored series whose period key does not fit the reset of their doc type (#1820). A series whose row already
  // differs from its batch is reported as that (its reset was switched after it was anchored); this is the one that
  // verifies as written, its reset switched and switched back before. A series not anchored yet is checked once a batch
  // holds it.
  if (seriesSeq.size > 0) {
    const misfits = (await sql<{ ref: string }>`SELECT ref FROM crove_kernel.archive_series_misfits()`.execute(db)).rows;
    for (const { ref } of misfits) {
      const anchored = seriesSeq.get(ref);
      if (anchored !== undefined && !rowProblems.has(ref)) note({ code: 'series_period_mismatch', seq: anchored, ref });
    }
  }

  // The acknowledgement in force, by the store's own write time: recent ones alert on every run, whatever the run finds.
  const restoreAck = acks.ack?.sequence ?? null;
  const ackWritten = restoreAck !== null && store.writtenAt ? await store.writtenAt(restoreAckKey(restoreAck)) : null;
  const alertDays = options.restoreAlertDays ?? RESTORE_ACK_ALERT_DAYS;
  const now = (options.now ?? (() => new Date()))().getTime();
  // An acknowledgement whose write time the store cannot tell alerts too.
  const alertRestoreAck = restoreAck !== null && (ackWritten === null || now - ackWritten.getTime() < alertDays * 86_400_000);
  await sql`SELECT crove_kernel.archive_verified(${problems.length === 0}, ${seq}::int, ${rowsChecked}::bigint, ${JSON.stringify(problems)}::jsonb, ${excused}::bigint,
    ${restoreAck}::bigint)`.execute(db);
  const result = {
    ok: problems.length === 0,
    batches: seq,
    rows: rowsChecked,
    problems,
    excused,
    restoreAck,
    restoreAckWrittenAt: ackWritten ? ackWritten.toISOString() : null,
    alertRestoreAck,
  };
  return result;
}

// A verifier run that found problems. Its message carries codes and batch sequences only, so the dead letter pg-boss
// keeps (and the worker log) names what failed without any row content.
export class ArchiveMismatchError extends Error {
  readonly problems: ArchiveProblem[];
  readonly result: ArchiveVerification;

  constructor(result: ArchiveVerification) {
    const codes = [...new Set(result.problems.map((p) => p.code))].join(', ');
    const ack = result.restoreAck === null ? '' : `; restore acknowledgement #${result.restoreAck} in force`;
    super(
      `ARCHIVE_MISMATCH: ${result.problems.length} problem(s) over ${result.batches} batch(es): ${codes}${ack}; see crove_kernel.archive_verification and docs/runbooks/worm-archive.md`,
    );
    this.problems = result.problems;
    this.result = result;
  }
}

// The line the worker alerts with while a restore acknowledgement is recent (#2020), in a passing run or a failing one.
export function restoreAckAlert(result: ArchiveVerification): string | null {
  if (!result.alertRestoreAck || result.restoreAck === null) return null;
  return (
    `[archive] ALERT restore acknowledgement #${result.restoreAck}, written ${result.restoreAckWrittenAt ?? 'at a time the store cannot tell'}, ` +
    `excuses ${result.excused} row(s) the WORM archive holds: match it to a restore incident (docs/runbooks/worm-archive.md)`
  );
}

// The nightly job: verifies, records the result, and fails when anything does not match.
export async function runArchiveVerification(db: Db, store: ArchiveStore, options: { restoreAlertDays?: number } = {}): Promise<ArchiveVerification> {
  const result = await verifyArchive(db, store, options);
  if (!result.ok) throw new ArchiveMismatchError(result);
  return result;
}

// After a restore (#2007, plan §7.9): what the archive holds that the restored database lacks. A restore to a backup
// point loses every row made after it, while the archive store, which outlives the database, keeps their references:
// the verifier's row_missing. This groups them per org and kind, and names the batches the restored database never
// recorded. The references carry no content, so a lost row is named by its id only, and its legal entity is not known.
export interface RestoreOrgLoss {
  orgId: string;
  journalEntries: string[];
  cashVouchers: string[];
  journalVouchers: string[];
  // The purchase or sale documents whose void was lost.
  documentVoids: string[];
  allocations: string[];
  numberVoids: string[];
  series: string[];
}

export interface RestoreReport {
  // Nothing lost and nothing else wrong.
  ok: boolean;
  // Batches in the store, and the newest one the restored database recorded.
  batches: number;
  recorded: number;
  // Batches written after the backup point: in the store, not recorded in the restored database.
  beyond: Array<{ seq: number; from: string; to: string }>;
  // Audit events the restored database lacks (their reference names no org).
  auditEvents: number;
  orgs: RestoreOrgLoss[];
  // Series whose next number is not above the highest number the version 7 batches hold for them, or that the restored
  // database lacks: the reseed raises them (kernel.number.reseed).
  reseed: RestoreSeries[];
  // Orgs with lost allocations or series that no version 7 batch covers (the archive ends before its first version 7
  // batch): the archive cannot say which series they were in, so the operator names a floor for each series.
  uncovered: string[];
  // The series the restored database has for those orgs, each of which needs its floor; a series made after the backup
  // point is in the issued vouchers only, which the operator confirms with --floors-complete.
  uncoveredSeries: UncoveredSeries[];
  // Series of an org or legal entity the restored database lacks (made after the backup point, or an org closed since):
  // nothing to raise, their numbers are lost with the org or entity.
  orphaned: RestoreSeries[];
  // Every row of the batches written after the backup point that the restored database lacks, and every series high of
  // those batches that it holds with another hash: [sequence, reference], what this restore lost (#2020).
  lostRefs: Array<[number, string]>;
  // What an acknowledgement of this restore excuses from then on: the rows of the newest acknowledgement the database
  // still lacks, and lostRefs. The newest acknowledgement's sequence (0: none) and refs, to compare.
  acknowledgedRefs: Array<[number, string]>;
  // The restores that acknowledgement carries, each [first batch with a lost row, newest batch then, backup point]
  // (#2020); this restore's only when its backup point was given.
  acknowledgedIntervals: RestoreInterval[];
  latestAck: { sequence: number; sha256: string; intervals: RestoreInterval[]; refs: Array<[number, string]> } | null;
  // Anything else the archive check found (a broken chain, a changed row, a recorded batch the store lacks).
  problems: ArchiveProblem[];
}

export interface RestoreSeries {
  orgId: string;
  // The series the archive names (the restored one when it has another id for the same key).
  seriesId: string;
  legalEntityId: string;
  docType: string;
  periodKey: string;
  // The highest number the archive holds for the series, and the restored next number (null: no such series).
  archivedHigh: string;
  next: string | null;
  // Why the reseed could not raise it, when it could not.
  reason?: string;
}

export interface UncoveredSeries {
  orgId: string;
  seriesId: string;
  legalEntityId: string;
  docType: string;
  periodKey: string;
  next: string;
}

type LossKind = Exclude<keyof RestoreOrgLoss, 'orgId'>;
const LOSS_KINDS: Record<string, LossKind> = {
  journal: 'journalEntries',
  cash_voucher: 'cashVouchers',
  journal_voucher: 'journalVouchers',
  document_void: 'documentVoids',
  number: 'allocations',
  number_void: 'numberVoids',
  number_series: 'series',
};

// The org, kind and id a row reference names, or null for an audit event. Every row of a record (its own row, its legal
// entity row, its revision row, a voucher's number row) names the same record.
function lostRecord(ref: string): { orgId: string; kind: LossKind; id: string } | null {
  const bare = ref.replace(/^(entity|revision|voucher_number):/, '');
  const [type, orgId, id] = bare.split(':');
  const kind = type === undefined ? undefined : LOSS_KINDS[type];
  return kind && orgId && id ? { orgId, kind, id } : null;
}

// Reads every batch back, checks the chain as the verifier does, and compares the rows with the database. Records
// nothing in the database: it runs before the restored stack takes writes, and again whenever an operator asks.
// backupPoint: the backup's snapshot time (meta.env SNAPSHOT_AT, else FINISHED_AT), which this restore's interval
// needs (see RestoreAck); without it the report names what was lost, and nothing can be acknowledged.
export async function restoreReport(db: Db, store: ArchiveStore, options: { backupPoint?: string | null } = {}): Promise<RestoreReport> {
  const problems: ArchiveProblem[] = [];
  const recorded = new Map(
    (
      await sql<{ seq: string; chain_sha256: string }>`SELECT seq, chain_sha256 FROM crove_kernel.archive_batches()`.execute(db)
    ).rows.map((r) => [Number(r.seq), r.chain_sha256]),
  );
  const keys = await store.list(ARCHIVE_PREFIX);
  const beyond: RestoreReport['beyond'] = [];
  const orgs = new Map<string, RestoreOrgLoss>();
  const seen = new Set<string>();
  const lostRefs: Array<[number, string]> = [];
  // Every row of any batch the database lacks, or, for a series high, holds with another hash: "<sequence> <reference>";
  // and per batch whether it lacks every row, and the rows it lacks (or holds changed) from a batch it had recorded.
  const missingNow = new Set<string>();
  const windows = new Map<number, ArchiveBatch['window']>();
  const missingRecorded: Array<[number, string]> = [];
  const acks = await restoreAckChain(store);
  problems.push(...acks.problems, ...(await multiVersionProblems(store)));
  let auditEvents = 0;
  let prev = GENESIS_SHA256;
  let prevTo = EPOCH;
  let seq = 0;
  let previous: ArchiveBatch | null = null;
  let sawV7 = false;
  // The highest archived number per series key (org, legal entity, doc type, period key).
  const highs = new Map<string, { orgId: string; seriesId: string; legalEntityId: string; docType: string; periodKey: string; high: bigint }>();
  for (const key of keys) {
    seq += 1;
    if (key !== archiveKey(seq)) {
      problems.push({ code: 'object_out_of_order', seq });
      break;
    }
    const bytes = await store.get(key);
    const batch = bytes ? parseBatch(bytes) : null;
    if (!batch || batch.seq !== seq) {
      problems.push({ code: 'object_unreadable', seq });
      break;
    }
    if (batch.prevChainSha256 !== prev) problems.push({ code: 'chain_broken', seq });
    if (batch.window.from !== prevTo) problems.push({ code: 'window_gap', seq });
    // A batch of a lower version after a version 7 one (an old worker) leaves the numbers of its window without highs:
    // the series could not be raised above them, so the report fails instead.
    for (const code of versionProblems(batch, previous)) problems.push({ code, seq });
    const batchHash = batchSha256(batch.rows);
    if (batchHash !== batch.batchSha256) problems.push({ code: 'batch_hash_mismatch', seq });
    if (chainSha256(batch.prevChainSha256, seq, batch.window.from, batch.window.to, batch.batchSha256) !== batch.chainSha256) {
      problems.push({ code: 'chain_hash_mismatch', seq });
    }
    const record = recorded.get(seq);
    if (record === undefined) beyond.push({ seq, from: batch.window.from, to: batch.window.to });
    else if (record !== batch.chainSha256) problems.push({ code: 'record_mismatch', seq });
    if (batch.version >= 7) {
      sawV7 = true;
      const bad = highProblems(batch);
      for (const ref of bad) problems.push({ code: 'high_mismatch', seq, ref });
      for (const [ref, legalEntityId, docType, periodKey, number] of batch.highs ?? []) {
        if (bad.includes(ref)) continue;
        // A number the reseed could not take (the series' next number is a bigint) is not trusted either.
        if (!/^[1-9][0-9]{0,17}$/.test(number)) {
          problems.push({ code: 'high_mismatch', seq, ref });
          continue;
        }
        const [, orgId = '', seriesId = ''] = ref.split(':');
        const seriesKey = `${orgId}|${legalEntityId}|${docType}|${periodKey}`;
        const known = highs.get(seriesKey);
        if (!known || BigInt(number) > known.high) highs.set(seriesKey, { orgId, seriesId, legalEntityId, docType, periodKey, high: BigInt(number) });
      }
    }

    const current = new Map(await rowHashes(db, batch));
    windows.set(seq, batch.window);
    for (const [ref, hash] of batch.rows) {
      const now = current.get(ref);
      const high = ref.startsWith('number_high:');
      if (now === undefined || (high && now !== hash)) {
        missingNow.add(`${seq} ${ref}`);
        if (record === undefined) lostRefs.push([seq, ref]);
        else missingRecorded.push([seq, ref]);
      }
      // A series high counts the numbers of its window, so a restore that lost some of them changes it or drops it:
      // the reseed below reads it, and the lost allocations are named by their own rows.
      if (high) continue;
      if (now === undefined) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const lost = lostRecord(ref);
        if (!lost) {
          auditEvents += 1;
          continue;
        }
        let org = orgs.get(lost.orgId);
        if (!org) {
          org = { orgId: lost.orgId, journalEntries: [], cashVouchers: [], journalVouchers: [], documentVoids: [], allocations: [], numberVoids: [], series: [] };
          orgs.set(lost.orgId, org);
        }
        if (!org[lost.kind].includes(lost.id)) org[lost.kind].push(lost.id);
      } else if (now !== hash) {
        problems.push({ code: 'row_changed', seq, ref });
      }
    }

    prev = batch.chainSha256;
    prevTo = batch.window.to;
    previous = batch;
  }
  // The restores the newest acknowledgement carries that still read as restores, and the rows of theirs still missing;
  // then this restore, from the first batch with a row it lost. A row missing from a batch the restored database had
  // recorded, that no acknowledgement in force names, was removed outside a restore: a finding. So is a "restore" that
  // lost a row while a later batch kept rows: a deletion, not a restore.
  const carriedIntervals: RestoreInterval[] = [];
  for (const interval of acks.ack?.intervals ?? []) if (await restoreHolds(db, interval, windows)) carriedIntervals.push(interval);
  const inCarried = ([s]: [number, string]) => carriedIntervals.some(([a, b]) => s >= a && s <= b);
  const carriedRefs = (acks.ack?.refs ?? []).filter((r) => missingNow.has(refKey(r)) && inCarried(r));
  const carried = new Set(carriedRefs.map(refKey));
  for (const r of missingRecorded) if (!carried.has(refKey(r))) problems.push({ code: r[1].startsWith('number_high:') ? 'row_changed' : 'row_missing', seq: r[0], ref: r[1] });
  const first = lostRefs.reduce((min, [s]) => Math.min(min, s), Number.POSITIVE_INFINITY);
  const intervals = [...carriedIntervals];
  const point = options.backupPoint ?? null;
  if (point !== null && Number.isFinite(Date.parse(point))) {
    // A restored database holds no row stamped at or after its backup point, with no upper bound: a row there was
    // restamped, or the database is not a restore of that backup. The rows the reseed of this check writes (its audit
    // events, a series it made again) are the only ones expected, and a series' row only with its archived id.
    const reseeded = new Set(
      (await sql<{ ref: string }>`SELECT ref FROM crove_kernel.archive_reseed_audit(${point}::timestamptz)`.execute(db)).rows.map((r) => r.ref),
    );
    const since = (await rowsSince(db, point)).find(([ref]) => !reseeded.has(ref) && !comesBack(ref));
    if (since) problems.push({ code: 'restore_ack_mismatch', seq: Number.isFinite(first) ? first : 0, ref: since[0] });
    if (Number.isFinite(first)) {
      const own: RestoreInterval = [first, seq, point];
      if (!since && !(await restoreHolds(db, own, windows))) problems.push({ code: 'restore_ack_mismatch', seq: first });
      if (!intervals.some((i) => JSON.stringify(i) === JSON.stringify(own))) intervals.push(own);
    }
  }
  // Batches the restored database recorded that the store does not hold: the archive is not the one this deployment
  // wrote, or it is unreachable.
  for (const recordedSeq of recorded.keys()) if (recordedSeq > seq) problems.push({ code: 'object_missing', seq: recordedSeq });

  const lost = [...orgs.values()].sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
  for (const org of lost) for (const kind of Object.values(LOSS_KINDS)) org[kind].sort();

  // Every series whose restored next number is not above its archived highest, or that the restored database lacks.
  const { rows: restored } = await sql<{ org_id: string; series_id: string; legal_entity_id: string; doc_type: string; period_key: string; next_number: string }>`
    SELECT org_id, series_id, legal_entity_id, doc_type, period_key, next_number::text AS next_number FROM crove_kernel.archive_series_next()`.execute(db);
  const nextByKey = new Map(restored.map((r) => [`${r.org_id}|${r.legal_entity_id}|${r.doc_type}|${r.period_key}`, r]));
  const { rows: entities } = await sql<{ org_id: string; legal_entity_id: string }>`
    SELECT org_id, legal_entity_id FROM crove_kernel.archive_legal_entities()`.execute(db);
  const present = new Set(entities.map((e) => `${e.org_id}|${e.legal_entity_id}`));
  const reseed: RestoreSeries[] = [];
  const orphaned: RestoreSeries[] = [];
  for (const [seriesKey, h] of highs) {
    const now = nextByKey.get(seriesKey);
    if (now && BigInt(now.next_number) > h.high) continue;
    (present.has(`${h.orgId}|${h.legalEntityId}`) ? reseed : orphaned).push({
      orgId: h.orgId,
      seriesId: now?.series_id ?? h.seriesId,
      legalEntityId: h.legalEntityId,
      docType: h.docType,
      periodKey: h.periodKey,
      archivedHigh: h.high.toString(),
      next: now ? now.next_number : null,
    });
  }
  const bySeries = (a: RestoreSeries, b: RestoreSeries) => (a.orgId + a.seriesId < b.orgId + b.seriesId ? -1 : 1);
  reseed.sort(bySeries);
  orphaned.sort(bySeries);
  const uncovered = sawV7 ? [] : lost.filter((o) => o.allocations.length > 0 || o.series.length > 0).map((o) => o.orgId);
  const uncoveredSeries: UncoveredSeries[] = restored
    .filter((r) => uncovered.includes(r.org_id))
    .map((r) => ({ orgId: r.org_id, seriesId: r.series_id, legalEntityId: r.legal_entity_id, docType: r.doc_type, periodKey: r.period_key, next: r.next_number }));
  return {
    ok: problems.length === 0 && auditEvents === 0 && lost.length === 0 && reseed.length === 0 && uncovered.length === 0,
    batches: seq,
    recorded: [...recorded.keys()].reduce((max, s) => (s > max ? s : max), 0),
    beyond,
    auditEvents,
    orgs: lost,
    reseed,
    uncovered,
    uncoveredSeries,
    orphaned,
    lostRefs,
    acknowledgedRefs: [...new Map([...carriedRefs, ...lostRefs].map((r) => [refKey(r), r])).values()].sort(byBatchRef),
    acknowledgedIntervals: intervals,
    latestAck: acks.ack ? { sequence: acks.ack.sequence, sha256: acks.sha256, intervals: acks.ack.intervals, refs: acks.ack.refs } : null,
    problems,
  };
}

// Acknowledges a restore the report found (#2020) and records the batches written after the backup point in the
// restored database, as the archiver would on its next run, so the nightly verifier reads them as the chain they are
// and excuses exactly the rows the report names. Run before the restored stack starts, once its series are safe: an
// archive with a problem, or batches after the backup point that are not the store's newest, in order, are refused.
// A new acknowledgement is written only when the rows to excuse differ from the newest one's: a second run over the
// same restore (one that died after recording some of the batches included) writes none, and records what is left.
// Returns the key of the acknowledgement in force, or null.
export async function acknowledgeRestore(db: Db, store: ArchiveStore, report: RestoreReport, now: Date = new Date()): Promise<string | null> {
  if (report.problems.length > 0) throw new Error('the archive does not match the restored database; nothing is acknowledged');
  // Every row this restore lost, and every row carried, must lie in a restore of the acknowledgement: an object the
  // verifier could not read would stay in a locked store for its whole retention.
  const covered = (r: [number, string]) => report.acknowledgedIntervals.some(([a, b]) => r[0] >= a && r[0] <= b);
  if (!report.lostRefs.every(covered)) throw new Error("rows were lost, but the report had no backup point to read the restore by; give the backup's (--backup-point)");
  if (!report.acknowledgedRefs.every(covered)) throw new Error('the acknowledgement would name rows outside its restores; nothing is acknowledged');
  report.beyond.forEach((b, i) => {
    if (b.seq !== report.recorded + 1 + i) throw new Error(`batch ${b.seq} is not the next after the restored database's ${report.recorded}; nothing is acknowledged`);
  });
  if (report.beyond.length > 0 && report.recorded + report.beyond.length !== report.batches) {
    throw new Error("the batches after the backup point are not the store's newest; nothing is acknowledged");
  }
  const latest = report.latestAck;
  const same = (a: Array<[number, string]>, b: Array<[number, string]>) => JSON.stringify([...a].sort(byBatchRef)) === JSON.stringify([...b].sort(byBatchRef));
  let key = latest ? restoreAckKey(latest.sequence) : null;
  const sameIntervals = JSON.stringify(latest?.intervals ?? []) === JSON.stringify(report.acknowledgedIntervals);
  if (!same(latest?.refs ?? [], report.acknowledgedRefs) || !sameIntervals) {
    // Bound to the store's newest batch: no batch may be written until the batches after the backup point are recorded
    // below (restore.sh runs this with the worker stopped).
    const newest = await store.get(archiveKey(report.batches));
    const newestBatch = newest ? parseBatch(newest) : null;
    if (!newestBatch || (await store.list(ARCHIVE_PREFIX)).length !== report.batches) {
      throw new Error("the store's newest batch moved since the report; run the restore check again with the worker stopped");
    }
    const ack: RestoreAck = {
      format: 'crove-restore-ack',
      version: 1,
      sequence: (latest?.sequence ?? 0) + 1,
      prevSha256: latest?.sha256 ?? GENESIS_SHA256,
      lastChainSha256: newestBatch.chainSha256,
      acknowledgedAt: now.toISOString(),
      recordedAtRestore: report.recorded,
      batchesAtRestore: report.batches,
      intervals: report.acknowledgedIntervals,
      refs: report.acknowledgedRefs,
    };
    key = restoreAckKey(ack.sequence);
    const body = new TextEncoder().encode(JSON.stringify(ack));
    if (!parseRestoreAck(body)) throw new Error('the acknowledgement does not read back as one; nothing is acknowledged');
    try {
      await store.put(key, body);
    } catch (error) {
      if (error instanceof ArchiveObjectExistsError) throw new Error(`${key} was written by another run meanwhile; run the restore check again`);
      throw error;
    }
  }
  for (const b of report.beyond) {
    const bytes = await store.get(archiveKey(b.seq));
    const batch = bytes ? parseBatch(bytes) : null;
    if (!batch) throw new Error(`archive object ${archiveKey(b.seq)} cannot be read`);
    await sql`SELECT crove_kernel.archive_record(${batch.seq}::bigint, ${batch.window.from}::timestamptz, ${batch.window.to}::timestamptz,
      ${batch.rows.length}::int, ${batch.batchSha256}, ${batch.chainSha256}, ${archiveKey(batch.seq)})`.execute(db);
  }
  return key;
}
