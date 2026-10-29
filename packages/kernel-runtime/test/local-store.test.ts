// LocalDiskStore writes are create-only, like the S3 store: the same bytes dedupe, different bytes conflict,
// concurrent writers of one key never clobber each other, and no temporary file is left behind.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobConflictError, BlobNotFoundError, BlobTooLargeError, LocalDiskStore, fileKey, inboundKey, newInboundBlobId, readVerified, sha256Hex } from '../src/index.ts';

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

  it('refuses a capped read of a larger file before reading it, and readVerified checks the cap (#1126)', async () => {
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const sha256 = sha256Hex(bytes);
    const key = fileKey(orgId, sha256);
    await store.put(key, bytes);
    expect(await store.get(key, null, bytes.byteLength)).toEqual(bytes);
    await expect(store.get(key, null, bytes.byteLength - 1)).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(readVerified(store, { key, generation: null, sha256 }, bytes.byteLength)).resolves.toEqual(bytes);
    await expect(readVerified(store, { key, generation: null, sha256 }, bytes.byteLength - 1)).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(store.get(fileKey(orgId, sha256Hex('missing')), null, 10)).rejects.toBeInstanceOf(BlobNotFoundError);
    // A store that ignores the cap is still checked after the read.
    const ignoring = { get: async () => bytes, put: async () => 'content:x', delete: async () => undefined };
    await expect(readVerified(ignoring, { key, generation: null, sha256 }, 3)).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(readVerified(store, { key, generation: null, sha256 }, -1)).rejects.toThrow(/invalid read cap/);
  });

  // #1189: every one of these compares false against the file's size, so a store that took it would read the file whole.
  it('refuses a read cap that is not a whole number of bytes, before reading (#1189)', async () => {
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    await store.put(key, bytes);
    for (const cap of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53]) {
      await expect(store.get(key, null, cap), String(cap)).rejects.toThrow(RangeError);
      await expect(store.get(key, null, cap), String(cap)).rejects.toThrow(/invalid read cap/);
    }
    // Even for a key with nothing under it: the cap is checked first.
    await expect(store.get(fileKey(orgId, sha256Hex('missing')), null, Number.NaN)).rejects.toThrow(/invalid read cap/);
    expect(await store.get(key, null, 0).catch((error: unknown) => error)).toBeInstanceOf(BlobTooLargeError);
    expect(await store.get(key)).toEqual(bytes);
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

  it('falls back to an exclusive create on a filesystem without hard links, warning once', async () => {
    const warnings: string[] = [];
    let links = 0;
    const noLinks = new LocalDiskStore(root, {
      link: async () => {
        links++;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
      log: (message) => warnings.push(message),
    });
    // Concurrent writes (of different keys: without links a concurrent writer of the same key can read a half
    // written file) all find out at once; there is still one warning.
    const keys = Array.from({ length: 4 }, () => inboundKey(newInboundBlobId()));
    await Promise.all(keys.map((k) => noLinks.put(k, encode(k))));
    for (const k of keys) expect(await store.get(k)).toEqual(encode(k));
    const bytes = encode(`<HDon>${randomUUID()}</HDon>`);
    const key = fileKey(orgId, sha256Hex(bytes));
    await noLinks.put(key, bytes);
    await noLinks.put(key, bytes);
    expect(await store.get(key)).toEqual(bytes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/does not support hard links \(EPERM\)/);
    // Once the store knows, it stops trying to link.
    const linksBefore = links;
    const inbound = inboundKey(newInboundBlobId());
    await noLinks.put(inbound, encode('first delivery'));
    expect(links).toBe(linksBefore);
    // Still create-only: different bytes conflict and the original stays.
    await expect(noLinks.put(inbound, encode('a different message'))).rejects.toBeInstanceOf(BlobConflictError);
    expect(await store.get(inbound)).toEqual(encode('first delivery'));
    expect((await filesNextTo(inbound)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // Any other link failure is an error, not a fallback.
    const broken = new LocalDiskStore(root, {
      link: async () => {
        throw Object.assign(new Error('i/o error'), { code: 'EIO' });
      },
      log: (message) => warnings.push(message),
    });
    await expect(broken.put(inboundKey(newInboundBlobId()), encode('raw'))).rejects.toMatchObject({ code: 'EIO' });
    expect(warnings).toHaveLength(1);
  });

  it('sweeps temporary files older than the cutoff and nothing else', async () => {
    const sweepRoot = await mkdtemp(join(tmpdir(), 'crove-local-sweep-'));
    try {
      const sweeper = new LocalDiskStore(sweepRoot);
      const blob = encode('raw');
      const key = inboundKey(newInboundBlobId());
      await sweeper.put(key, blob);
      const orgDir = join(sweepRoot, 'org', orgId);
      await mkdir(orgDir, { recursive: true });
      const tempName = () => `${'b'.repeat(64)}.123.${randomUUID()}.tmp`;
      const stale = [join(sweepRoot, 'inbound', tempName()), join(orgDir, tempName())];
      const fresh = join(orgDir, tempName());
      // Old files that are not temporary files of put, or not where put writes, are left alone.
      const kept = [join(sweepRoot, key), join(orgDir, 'notes.tmp'), join(sweepRoot, tempName())];
      for (const file of [...stale, fresh, ...kept.slice(1)]) await writeFile(file, 'partial');
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      for (const file of [...stale, ...kept]) await utimes(file, old, old);

      expect(await sweeper.sweepTempFiles()).toBe(2);
      for (const file of stale) await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const file of [fresh, ...kept]) await expect(stat(file)).resolves.toBeDefined();
      expect(await sweeper.get(key)).toEqual(blob);
      expect(await new LocalDiskStore(join(sweepRoot, 'missing')).sweepTempFiles()).toBe(0);
    } finally {
      await rm(sweepRoot, { recursive: true, force: true });
    }
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
