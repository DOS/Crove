// BlobStore.list (issue #212): the retention job lists inbound/ and export/ page by page, in key order, and never sees
// org/ or staging/ keys, temporary files or foreign objects. Local disk on a temporary directory; S3 on a fake client.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStore, S3BlobStore, exportKey, fileKey, inboundKey, newInboundBlobId, newStagingKey, sha256Hex, type S3Sender } from '../src/index.ts';

const encode = (s: string) => new TextEncoder().encode(s);

describe('LocalDiskStore.list', () => {
  let root = '';
  let store: LocalDiskStore;
  const orgA = '00000000-0000-4000-8000-00000000000a';
  const orgB = '00000000-0000-4000-8000-00000000000b';
  const inbound: string[] = [];
  const exports: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crove-blob-list-'));
    store = new LocalDiskStore(root);
    for (let i = 0; i < 7; i++) {
      const key = inboundKey(newInboundBlobId());
      await store.put(key, encode(`mail ${i}`));
      inbound.push(key);
    }
    for (const org of [orgB, orgA]) {
      for (let i = 0; i < 3; i++) {
        const bytes = encode(`${org} part ${i}`);
        const key = exportKey(org, sha256Hex(bytes));
        await store.put(key, bytes);
        exports.push(key);
      }
    }
    inbound.sort();
    exports.sort();
    // Never listed: an org file, a temporary file of put, and a foreign name.
    const file = encode('evidence');
    await store.put(fileKey(orgA, sha256Hex(file)), file);
    await writeFile(join(root, 'inbound', `${'a'.repeat(64)}.123.${randomUUID()}.tmp`), 'partial');
    await writeFile(join(root, 'inbound', 'README'), 'x');
    await mkdir(join(root, 'export', 'not-an-org'), { recursive: true });
    await writeFile(join(root, 'export', 'not-an-org', 'b'.repeat(64)), 'x');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function all(prefix: 'inbound/' | 'export/', limit: number): Promise<{ keys: string[]; pages: number }> {
    const keys: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page = await store.list(prefix, after, limit);
      pages++;
      keys.push(...page.blobs.map((b) => b.key));
      expect(page.blobs.length).toBeLessThanOrEqual(limit);
      after = page.next;
    } while (after !== null && pages < 50);
    return { keys, pages };
  }

  it('lists only the prefix keys, in key order, across pages', async () => {
    expect(await all('inbound/', 3)).toEqual({ keys: inbound, pages: 3 });
    expect(await all('inbound/', 100)).toEqual({ keys: inbound, pages: 1 });
    // Across org directories, resuming in the middle of one.
    expect(await all('export/', 2)).toEqual({ keys: exports, pages: 3 });
    expect(await all('export/', 6)).toEqual({ keys: exports, pages: 1 });
  });

  it('reports each blob with its modification time', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    await utimes(join(root, inbound[0] as string), old, old);
    const page = await store.list('inbound/', null, 1);
    expect(page.blobs).toEqual([{ key: inbound[0], lastModified: old }]);
    expect(page.next).toBe(inbound[0]);
  });

  it('refuses a bad prefix, cursor or limit', async () => {
    await expect(store.list('org/' as 'inbound/', null, 10)).rejects.toThrow(/invalid list prefix/);
    await expect(store.list('inbound/', 'export/x', 10)).rejects.toThrow(/invalid list cursor/);
    await expect(store.list('inbound/', null, 0)).rejects.toThrow(/invalid list limit/);
  });

  it('lists nothing on a store without those directories', async () => {
    const empty = new LocalDiskStore(join(root, 'nothing-here'));
    expect(await empty.list('inbound/', null, 10)).toEqual({ blobs: [], next: null });
    expect(await empty.list('export/', null, 10)).toEqual({ blobs: [], next: null });
  });
});

describe('S3BlobStore.list', () => {
  const when = new Date('2026-10-01T00:00:00Z');
  function fake(pages: Array<{ keys: Array<string | undefined>; next?: string }>) {
    const sent: ListObjectsV2Command[] = [];
    const client = {
      send: async (command: ListObjectsV2Command) => {
        sent.push(command);
        const page = pages.shift() ?? { keys: [] };
        return {
          Contents: page.keys.map((Key) => ({ Key, LastModified: when })),
          IsTruncated: page.next !== undefined,
          ...(page.next ? { NextContinuationToken: page.next } : {}),
        };
      },
    } as unknown as S3Sender;
    return { store: new S3BlobStore(client, 'crove-files'), sent };
  }

  it('lists page by page from the cursor and skips keys outside the pattern', async () => {
    const [a, b, c] = [inboundKey(newInboundBlobId()), inboundKey(newInboundBlobId()), inboundKey(newInboundBlobId())].sort();
    const { store, sent } = fake([{ keys: [a, 'inbound/not-a-blob', undefined], next: 't1' }, { keys: [b, c] }]);
    expect(await store.list('inbound/', null, 100)).toEqual({
      blobs: [a, b, c].map((key) => ({ key, lastModified: when })),
      next: null,
    });
    expect(sent.map((command) => command.input)).toEqual([
      { Bucket: 'crove-files', Prefix: 'inbound/', MaxKeys: 100 },
      { Bucket: 'crove-files', Prefix: 'inbound/', MaxKeys: 97, ContinuationToken: 't1' },
    ]);
  });

  it('stops at the limit and hands back the last key it looked at as the cursor', async () => {
    const keys = Array.from({ length: 3 }, () => exportKey(randomUUID(), sha256Hex(randomUUID()))).sort();
    const { store, sent } = fake([{ keys: [...keys, 'export/x'], next: 'more' }]);
    const page = await store.list('export/', keys[0] as string, 4);
    expect(page).toEqual({ blobs: keys.map((key) => ({ key, lastModified: when })), next: 'export/x' });
    expect(sent[0]?.input).toEqual({ Bucket: 'crove-files', Prefix: 'export/', MaxKeys: 4, StartAfter: keys[0] });
  });

  it('never lists staging or org keys, whatever the server returns', async () => {
    const { store } = fake([{ keys: [newStagingKey(), fileKey(randomUUID(), sha256Hex('x'))] }]);
    expect(await store.list('inbound/', null, 10)).toEqual({ blobs: [], next: null });
  });

  it('stops on an empty page that still claims more', async () => {
    const { store, sent } = fake([{ keys: [], next: 'again' }]);
    expect(await store.list('inbound/', 'inbound/x', 10)).toEqual({ blobs: [], next: 'inbound/x' });
    expect(sent).toHaveLength(1);
  });
});
