import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// Object storage adapter. Local disk is the default; S3-compatible stores implement the same interface.
export interface BlobStore {
  // An org key must end in the sha256 of the bytes (a content address); any other key is refused.
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

export class LocalDiskStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertStorageKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(key);
    assertContentAddress(key, sha256Hex(bytes));
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }

  async get(key: string): Promise<Uint8Array> {
    const target = this.path(key);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
