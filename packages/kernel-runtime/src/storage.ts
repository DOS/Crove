import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { link as fsLink, mkdir, open, opendir, readFile, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// Object storage adapter. Local disk is the default; S3-compatible stores implement the same interface.
// Bodies are buffered in memory as a Uint8Array in both directions, so a blob costs its full size in RAM while
// it is read or written (at most MAX_UPLOAD_BYTES for a file, MAX_EMAIL_BYTES for a raw message).
//
// Evidence integrity (ADR-0013, plan §7.6, red-team S25): every write returns the generation of the object it
// created or found, and every file row keeps the triple (key, generation, sha256). Reads go through readVerified,
// which asks the store for that exact generation and refuses bytes whose sha256 differs, so an object swapped
// after approval is never served or read as the original.
export interface BlobStore {
  // An org key must end in the sha256 of the bytes (a content address); any other key is refused.
  // Writes are create-only: a key that already holds the same bytes is accepted (a re-upload dedupes), and a key
  // that holds different bytes raises BlobConflictError. A stored blob is never replaced.
  // Returns the generation (see GENERATION_PATTERN) of the object now under the key.
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  // Throws BlobNotFoundError when nothing is stored under the key. With a versioned generation (s3:, gcs:) the store
  // reads that exact version; content: and null read the current object. Callers that hold a file reference use
  // readVerified, which also checks the sha256.
  get(key: string, generation?: string | null): Promise<Uint8Array>;
  // Removes the blob; a missing key is not an error.
  delete(key: string): Promise<void>;
  // Present when browsers transfer bytes to and from the store directly (S3 presigned URLs); absent for local
  // disk, where uploads and downloads stream through the kernel.
  direct?: DirectTransfers | undefined;
  // Deletes staging/ objects last modified before `before` (abandoned presigned uploads), looking at no more than
  // `limit` keys per call. For stores without a lifecycle rule on staging/; the worker's daily retention job calls
  // it. Absent where no staging objects exist (local disk).
  sweepStaging?(before: Date, limit: number): Promise<StagingSweep>;
  // One page of the blobs under inbound/ or export/, in key order, starting after the key `after` (null: from the
  // start) and looking at no more than `limit` keys. For the daily retention job, which decides what to delete (issue
  // #212); keys outside the prefix's pattern (temporary files, foreign objects) are never returned. Absent on a store
  // that cannot list.
  list?(prefix: ListPrefix, after: string | null, limit: number): Promise<BlobListing>;
}

// The prefixes the retention job sweeps: raw inbound mail and org exports. Never org/ (evidence) or staging/ (its own
// sweep).
export type ListPrefix = 'inbound/' | 'export/';

export interface ListedBlob {
  key: string;
  lastModified: Date;
}

export interface BlobListing {
  blobs: ListedBlob[];
  // Pass as `after` for the next page; null when the listing reached the end.
  next: string | null;
}

export interface StagingSweep {
  // Staging objects deleted.
  deleted: number;
  // The listing stopped at the limit, so older objects may remain for the next run.
  more: boolean;
}

// What a file row records about its object: the triple of plan §7.6. generation is null only on rows written
// before ADR-0013, whose reads are checked by sha256 alone.
export interface BlobRef {
  key: string;
  generation: string | null;
  sha256: string;
}

// A presigned S3 POST form: the browser sends `fields` plus the file (last) as multipart/form-data to `url`.
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
  maxBytes: number;
}

export interface DirectTransfers {
  // A form for one staging key (plan §7.6 step 1): valid for UPLOAD_TTL_SECONDS, 1 to maxBytes bytes. The grant row
  // in crove_kernel.file_upload makes it single-use: the server reads the staging key at most once.
  presignUpload(stagingKey: string, maxBytes: number): Promise<PresignedUpload>;
  // A short-lived GET for the exact version, as an attachment. null when the generation cannot be pinned (content:
  // or a row from before ADR-0013): the caller then streams the bytes through readVerified instead.
  presignDownload(ref: BlobRef, file: { filename: string; contentType: string }): Promise<string | null>;
  // Streams a staged object, refusing more than maxBytes, and returns its bytes with their sha256.
  readStaged(stagingKey: string, maxBytes: number): Promise<{ bytes: Uint8Array; sha256: string }>;
}

// Presigned uploads live 5 minutes (plan §7.6); presigned downloads 60 seconds.
export const UPLOAD_TTL_SECONDS = 300;
export const DOWNLOAD_TTL_SECONDS = 60;

// The generation of an object, tagged by where it lives:
//   s3:<VersionId>      an S3 object version (bucket versioning on)
//   gcs:<generation>    a GCS object generation (x-goog-generation)
//   content:<sha256>    no native version (local disk, or an S3 bucket run with S3_VERSIONING=off): the object is
//                       known by its content address only, and the sha256 check on read is the whole guarantee.
export const GENERATION_PATTERN = /^(?:s3|gcs):[!-~]{1,1024}$|^content:[0-9a-f]{64}$/;

export function contentGeneration(sha256: string): string {
  return `content:${sha256}`;
}

// The version id a versioned generation names, or null for content: and rows from before ADR-0013.
export function versionOf(generation: string | null | undefined): string | null {
  if (!generation) return null;
  const match = /^(?:s3|gcs):(.+)$/.exec(generation);
  return match?.[1] ?? null;
}

// The stored bytes do not match the reference a file row holds: the object was replaced or corrupted after it
// was recorded (red-team S25). Never served, never parsed; an operator must investigate.
export class BlobIntegrityError extends Error {
  readonly key: string;
  constructor(ref: BlobRef) {
    super(`stored blob does not match its recorded sha256: ${ref.key} (generation ${ref.generation ?? 'none'})`);
    this.name = 'BlobIntegrityError';
    this.key = ref.key;
  }
}

// A staged upload is larger than its grant allows. S3 enforces the presigned POST's content-length-range; the
// server checks again while it streams, so a store that ignores the condition cannot pass a larger file.
export class BlobTooLargeError extends Error {
  readonly key: string;
  constructor(key: string, maxBytes: number) {
    super(`staged object exceeds ${maxBytes} bytes: ${key}`);
    this.name = 'BlobTooLargeError';
    this.key = key;
  }
}

// Writes a file's bytes and returns the generation its reference records. A store that reports none (one written
// against the interface before ADR-0013, which returned nothing) has no versions, so the generation is the content
// address and reads rest on the sha256 check. S3BlobStore always returns a version or throws (S3_VERSIONING).
export async function putFile(store: BlobStore, key: string, bytes: Uint8Array, contentType: string, sha256: string): Promise<string> {
  const generation: string | undefined = await store.put(key, bytes, contentType);
  return generation ?? contentGeneration(sha256);
}

// Reads the object a file row references and fails closed unless its bytes hash to the recorded sha256.
export async function readVerified(store: BlobStore, ref: BlobRef): Promise<Uint8Array> {
  const bytes = await store.get(ref.key, ref.generation);
  if (sha256Hex(bytes) !== ref.sha256) throw new BlobIntegrityError(ref);
  return bytes;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fileKey(orgId: string, sha256: string): string {
  return `org/${orgId}/${sha256}`;
}

// An org export part (issue #212): content addressed like a file, under its own prefix, so the retention job can
// expire exports without ever touching a file blob (org/<org_id>/...), even one with the same bytes.
export function exportKey(orgId: string, sha256: string): string {
  return `export/${orgId}/${sha256}`;
}

// Raw inbound email, stored by the API before any org is known, under a random id per delivery so the
// worker can delete it once handled without counting references. Only the worker reads it.
export function inboundKey(blobId: string): string {
  return `inbound/${blobId}`;
}

export function newInboundBlobId(): string {
  return randomBytes(32).toString('hex');
}

// A presigned upload lands here first (plan §7.6 step 1), under a random name, and never becomes a file itself: the
// server reads it, hashes it and writes the bytes it hashed to the org key.
export function stagingKey(id: string): string {
  return `staging/${id}`;
}

export function newStagingKey(): string {
  return stagingKey(randomBytes(32).toString('hex'));
}

export function isStagingKey(key: string): boolean {
  return /^staging\/[0-9a-f]{64}$/.test(key);
}

const KEY_PATTERN = /^(?:(?:org|export)\/[0-9a-f-]{36}|inbound|staging)\/[0-9a-f]{64}$/;
// The keys a listing of each sweepable prefix returns.
const LISTED_KEY: Record<ListPrefix, RegExp> = {
  'inbound/': /^inbound\/[0-9a-f]{64}$/,
  'export/': /^export\/[0-9a-f-]{36}\/[0-9a-f]{64}$/,
};

// Every store accepts the same keys: org/<org_id>/<sha256> (plan §7.6), export/<org_id>/<sha256>, inbound/<random id>
// and staging/<random id>.
export function assertStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('invalid storage key');
}

// Whether a listing of the prefix may return the key.
export function isListedKey(prefix: ListPrefix, key: string): boolean {
  return LISTED_KEY[prefix].test(key);
}

// Checks the arguments of BlobStore.list, the same for every store.
export function assertListArgs(prefix: ListPrefix, after: string | null, limit: number): void {
  if (!Object.hasOwn(LISTED_KEY, prefix)) throw new Error('invalid list prefix');
  if (after !== null && (typeof after !== 'string' || !after.startsWith(prefix) || after.length > 200)) throw new Error('invalid list cursor');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid list limit');
}

// Org and export keys are content addresses: their last segment must be the sha256 of the bytes stored under them.
export function assertContentAddress(key: string, sha256: string): void {
  if ((key.startsWith('org/') || key.startsWith('export/')) && !key.endsWith(`/${sha256}`)) {
    throw new Error('storage key does not match the content sha256');
  }
}

// Raised by every store for a missing blob, so callers never depend on which store is configured.
// The code matches the ENOENT that local disk surfaced before this class existed.
export class BlobNotFoundError extends Error {
  readonly code = 'ENOENT';
  readonly key: string;
  constructor(key: string) {
    super(`blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
    this.key = key;
  }
}

// The key already holds other bytes. Stored blobs are evidence and are never silently replaced.
export class BlobConflictError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`blob already exists with different content: ${key}`);
    this.name = 'BlobConflictError';
    this.key = key;
  }
}

export interface LocalDiskStoreOptions {
  // The hard link call; tests replace it to simulate a filesystem without hard links.
  link?: (existing: string, target: string) => Promise<void>;
  // Where the one-time "no hard links" warning goes.
  log?: (message: string) => void;
}

// link() fails with one of these when the filesystem has no hard links (SMB/CIFS, exFAT, some NFS servers,
// Docker Desktop bind mounts from a Windows host).
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);
// A directory fsync is not available everywhere (Windows, some network filesystems). Skipping it there only loses
// the guarantee that the new name survives a power cut, never the bytes behind it.
const NO_DIRECTORY_SYNC = new Set(['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF']);
// <64 hex>.<pid>.<uuid>.tmp, the names put gives its temporary files.
const TEMP_FILE = /^[0-9a-f]{64}\.\d+\.[0-9a-f-]{36}\.tmp$/;
const UUID_DIR = /^[0-9a-f-]{36}$/;
export const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

// Writes the bytes to a new file and flushes them to disk before returning, so a name linked to it later never
// points at empty or truncated data after a crash. Fails with EEXIST when the path exists; a file it created but
// could not finish is removed.
async function writeNewFileDurably(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
}

// Flushes a directory entry (a new name) to disk where the platform supports it.
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (error) {
    if (!NO_DIRECTORY_SYNC.has(errorCode(error) ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

export class LocalDiskStore implements BlobStore {
  private readonly root: string;
  private readonly link: (existing: string, target: string) => Promise<void>;
  private readonly log: (message: string) => void;
  private hardLinks = true;

  constructor(root: string, options: LocalDiskStoreOptions = {}) {
    this.root = resolve(root);
    this.link = options.link ?? fsLink;
    this.log = options.log ?? ((message) => console.warn(`[storage] ${message}`));
  }

  private path(key: string): string {
    assertStorageKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return full;
  }

  // Create-only, like the S3 store. The bytes go to a temporary file in the same directory and are flushed to disk
  // (fsync); the file is then hard linked to the key, and the directory is flushed too where the platform allows.
  // link() is atomic and fails with EEXIST when the key already exists, so a reader never sees a partial file, of
  // two concurrent writers exactly one creates the key, and after a crash the key is either missing or holds all
  // of its bytes. A writer that finds the key compares bytes: the same bytes dedupe, different bytes raise
  // BlobConflictError. The temporary file is removed on every path.
  //
  // On a filesystem without hard links the store warns once and creates the key itself exclusively ('wx'). That is
  // still create-only, but a concurrent reader (or a second writer comparing bytes) can see a file that is still
  // being written, and a crash during a write can leave it truncated.
  //
  // Local disk has no object versions, so the generation is the content address (content:<sha256>): the store only
  // ever creates a key once, and a file replaced behind its back is caught by the sha256 check on read. An inode
  // number or a modification time would change on a backup restore without any change in content.
  async put(key: string, bytes: Uint8Array): Promise<string> {
    const target = this.path(key);
    const sha256 = sha256Hex(bytes);
    assertContentAddress(key, sha256);
    await mkdir(dirname(target), { recursive: true });
    if (this.hardLinks) {
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeNewFileDurably(tmp, bytes);
        if (await this.createOrCompare(key, sha256, () => this.link(tmp, target), true)) return contentGeneration(sha256);
      } finally {
        await rm(tmp, { force: true });
      }
    }
    await this.createOrCompare(key, sha256, () => writeNewFileDurably(target, bytes), false);
    return contentGeneration(sha256);
  }

  // Runs create() until it makes the key, or compares the bytes already stored there. Returns false when link()
  // showed that the filesystem has no hard links, so the caller falls back to an exclusive create.
  private async createOrCompare(key: string, sha256: string, create: () => Promise<void>, linking: boolean): Promise<boolean> {
    const target = this.path(key);
    // A key deleted between EEXIST and the read-back is created once more; a second disappearance is an error.
    for (let attempt = 1; ; attempt++) {
      try {
        await create();
        await syncDirectory(dirname(target));
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'EEXIST') {
          if (linking && code !== undefined && NO_HARD_LINKS.has(code)) {
            // Concurrent puts can all find out at once; warn only the first time.
            if (this.hardLinks) this.log(
              `${this.root} does not support hard links (${code}); writes fall back to an exclusive create, which ` +
                'concurrent readers can see half written and a crash can leave truncated. Use a local filesystem.',
            );
            this.hardLinks = false;
            return false;
          }
          throw error;
        }
      }
      let stored: Uint8Array;
      try {
        stored = await this.get(key);
      } catch (error) {
        if (error instanceof BlobNotFoundError && attempt < 2) continue;
        throw error;
      }
      if (sha256Hex(stored) !== sha256) throw new BlobConflictError(key);
      return true;
    }
  }

  // Removes temporary files that a crashed put left behind, once they are older than maxAgeMs. It looks only where
  // put writes (inbound/, org/<org_id>/ and export/<org_id>/) and only at the names put gives its temporary files,
  // so it never touches a blob. Returns how many it removed. Called once at startup.
  async sweepTempFiles(maxAgeMs: number = STALE_TEMP_AGE_MS): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const dirs = [join(this.root, 'inbound')];
    for (const top of ['org', 'export']) {
      for (const org of await entries(join(this.root, top))) {
        if (org.isDirectory() && UUID_DIR.test(org.name)) dirs.push(join(this.root, top, org.name));
      }
    }
    let removed = 0;
    for (const dir of dirs) {
      for (const entry of await entries(dir)) {
        if (!entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
        const file = join(dir, entry.name);
        try {
          if ((await stat(file)).mtimeMs >= cutoff) continue;
          await rm(file);
          removed++;
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
    }
    return removed;
  }

  // One copy per key (see put), so the generation selects nothing; readVerified checks the bytes.
  async get(key: string): Promise<Uint8Array> {
    const target = this.path(key);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  // Lists inbound/<id> or export/<org_id>/<sha256> files in key order. The directories are walked once per call and
  // only the smallest keys after `after` are kept (one more than the limit, to know whether more remain), so memory
  // stays bounded by the page however many files there are. Temporary files of put are skipped.
  async list(prefix: ListPrefix, after: string | null, limit: number): Promise<BlobListing> {
    assertListArgs(prefix, after, limit);
    const keep = limit + 1;
    let page: string[] = [];
    const consider = (key: string) => {
      if (!isListedKey(prefix, key) || (after !== null && key <= after)) return;
      page.push(key);
      if (page.length >= keep * 4) page = page.sort().slice(0, keep);
    };
    if (prefix === 'inbound/') {
      for await (const entry of walk(join(this.root, 'inbound'))) if (entry.isFile()) consider(`inbound/${entry.name}`);
    } else {
      for await (const org of walk(join(this.root, 'export'))) {
        if (!org.isDirectory() || !UUID_DIR.test(org.name)) continue;
        // Every key of a directory before the cursor's directory sorts before the cursor.
        if (after !== null && `export/${org.name}/` < after.slice(0, 'export/'.length + 37)) continue;
        for await (const entry of walk(join(this.root, 'export', org.name))) if (entry.isFile()) consider(`export/${org.name}/${entry.name}`);
      }
    }
    page = page.sort().slice(0, keep);
    const keys = page.slice(0, limit);
    const blobs: ListedBlob[] = [];
    for (const key of keys) {
      try {
        blobs.push({ key, lastModified: (await stat(this.path(key))).mtime });
      } catch (error) {
        // Deleted since the walk: not listed.
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    return { blobs, next: page.length > limit ? (keys.at(-1) ?? null) : null };
  }
}

// The entries of a directory one by one, or none when it does not exist yet.
async function* walk(dir: string): AsyncGenerator<Dirent> {
  let handle;
  try {
    handle = await opendir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  for await (const entry of handle) yield entry;
}

// The entries of a directory, or none when it does not exist yet.
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}
