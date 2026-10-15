// LocalDiskStore writes are create-only, like the S3 store: the same bytes dedupe, different bytes conflict,
// concurrent writers of one key never clobber each other, and no temporary file is left behind.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobConflictError, BlobNotFoundError, LocalDiskStore, fileKey, inboundKey, newInboundBlobId, sha256Hex } from '../src/index.ts';

const encode = (s: string) => new TextEncoder().encode(s);

describe('LocalDiskStore', () => {
  let root = '';
  let store: LocalDiskStore;
  const orgId = randomUUID();

  // Every file in the key's directory: the key itself and any leftover temporary file.
  const filesNextTo = async (key: string) => readdir(dirname(join(root, key)));

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crove-local-store-'));
    store = new LocalDiskStore(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores bytes that a new store instance reads back, and refuses keys that are not content addresses', async () => {
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    await store.put(key, bytes);
    expect(await new LocalDiskStore(root).get(key)).toEqual(bytes);
    await expect(store.put(fileKey(orgId, sha256Hex('other')), bytes)).rejects.toThrow(/does not match/);
    await expect(store.put('inbound/../escape', bytes)).rejects.toThrow(/invalid storage key/);
  });

  it('never overwrites: the same bytes dedupe, different bytes conflict and the original stays', async () => {
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    await store.put(key, bytes);
    await store.put(key, bytes);
    expect(await store.get(key)).toEqual(bytes);

    const inbound = inboundKey(newInboundBlobId());
    const original = encode('first delivery');
    await store.put(inbound, original);
    await expect(store.put(inbound, encode('a different message'))).rejects.toBeInstanceOf(BlobConflictError);
    expect(await store.get(inbound)).toEqual(original);
    expect(await filesNextTo(inbound)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });

  it('concurrent writes of the same bytes all succeed and leave one file', async () => {
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = inboundKey(newInboundBlobId());
    await Promise.all(Array.from({ length: 16 }, () => store.put(key, bytes)));
    expect(await store.get(key)).toEqual(bytes);
    expect((await filesNextTo(key)).filter((name) => name.startsWith(key.slice('inbound/'.length)))).toEqual([key.slice('inbound/'.length)]);
  });

  it('of concurrent writes of different bytes, exactly one wins and the others conflict', async () => {
    const key = inboundKey(newInboundBlobId());
    const bodies = Array.from({ length: 16 }, (_, i) => encode(`message ${i} ${randomUUID()}`));
    const results = await Promise.allSettled(bodies.map((b) => store.put(key, b)));
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(BlobConflictError);
    }
    expect(await store.get(key)).toEqual(bodies[won[0] ?? -1]);
    expect((await filesNextTo(key)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the key again when it is deleted between the conflict and the read-back', async () => {
    // A store whose first read-back deletes the key, as a concurrent delete would.
    class RacingStore extends LocalDiskStore {
      deletes = 0;
      override async get(key: string): Promise<Uint8Array> {
        if (this.deletes === 0) {
          this.deletes++;
          await this.delete(key);
        }
        return super.get(key);
      }
    }
    const bytes = encode('raw');
    const key = inboundKey(newInboundBlobId());
    await store.put(key, bytes);
    const racing = new RacingStore(root);
    await racing.put(key, bytes);
    expect(racing.deletes).toBe(1);
    expect(await store.get(key)).toEqual(bytes);
    expect((await filesNextTo(key)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('maps a missing blob to BlobNotFoundError and deletes idempotently; a deleted key can be written again', async () => {
    const key = inboundKey(newInboundBlobId());
    await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.put(key, encode('raw'));
    await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT', key });
    await expect(store.delete(key)).resolves.toBeUndefined();
    await store.put(key, encode('raw again'));
    expect(await store.get(key)).toEqual(encode('raw again'));
  });
});
