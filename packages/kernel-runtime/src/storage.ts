import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { link as fsLink, mkdir, open, readFile, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// Object storage adapter. Local disk is the default; S3-compatible stores implement the same interface.
// Bodies are buffered in memory as a Uint8Array in both directions, so a blob costs its full size in RAM while
// it is read or written. Streaming bodies are a later change (#109).
export interface BlobStore {
  // An org key must end in the sha256 of the bytes (a content address); any other key is refused.
  // Writes are create-only: a key that already holds the same bytes is accepted (a re-upload dedupes), and a key
  // that holds different bytes raises BlobConflictError. A stored blob is never replaced.
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  // Throws BlobNotFoundError when nothing is stored under the key.
  get(key: string): Promise<Uint8Array>;
  // Removes the blob; a missing key is not an error.
  delete(key: string): Promise<void>;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fileKey(orgId: string, sha256: string): string {
  return `org/${orgId}/${sha256}`;
}

// Raw inbound email, stored by the API before any org is known, under a random id per delivery so the
// worker can delete it once handled without counting references. Only the worker reads it.
export function inboundKey(blobId: string): string {
  return `inbound/${blobId}`;
}

export function newInboundBlobId(): string {
  return randomBytes(32).toString('hex');
}

const KEY_PATTERN = /^(?:org\/[0-9a-f-]{36}|inbound)\/[0-9a-f]{64}$/;

// Every store accepts the same keys: org/<org_id>/<sha256> (plan §7.6) and inbound/<random id>.
export function assertStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('invalid storage key');
}

// Org keys are content addresses: their last segment must be the sha256 of the bytes stored under them.
export function assertContentAddress(key: string, sha256: string): void {
  if (key.startsWith('org/') && !key.endsWith(`/${sha256}`)) throw new Error('storage key does not match the content sha256');
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
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(key);
    const sha256 = sha256Hex(bytes);
    assertContentAddress(key, sha256);
    await mkdir(dirname(target), { recursive: true });
    if (this.hardLinks) {
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeNewFileDurably(tmp, bytes);
        if (await this.createOrCompare(key, sha256, () => this.link(tmp, target), true)) return;
      } finally {
        await rm(tmp, { force: true });
      }
    }
    await this.createOrCompare(key, sha256, () => writeNewFileDurably(target, bytes), false);
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
  // put writes (inbound/ and org/<org_id>/) and only at the names put gives its temporary files, so it never
  // touches a blob. Returns how many it removed. Called once at startup.
  async sweepTempFiles(maxAgeMs: number = STALE_TEMP_AGE_MS): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const dirs = [join(this.root, 'inbound')];
    for (const org of await entries(join(this.root, 'org'))) {
      if (org.isDirectory() && UUID_DIR.test(org.name)) dirs.push(join(this.root, 'org', org.name));
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
