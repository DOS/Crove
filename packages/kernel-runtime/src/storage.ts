import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// Object storage adapter. Local disk is the default; S3-compatible stores implement the same interface.
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
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

export class LocalDiskStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!/^(?:org\/[0-9a-f-]{36}|inbound)\/[0-9a-f]{64}$/.test(key)) throw new Error('invalid storage key');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
