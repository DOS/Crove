// The WORM archive stores (issue #891) without a bucket: what the S3 store sends (create-only, Object Lock retention,
// a checksum), how it reads its answers, and the batch and chain hashes. The database side is
// test/invariant/worm-archive.db.test.ts; MinIO with Object Lock runs in the split-stack job (tools/e2e/split-stack.mjs).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, GetObjectLockConfigurationCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  ArchiveObjectExistsError,
  GENESIS_SHA256,
  LocalArchiveStore,
  S3ArchiveStore,
  archiveKey,
  batchSha256,
  chainSha256,
  type ArchiveS3Sender,
} from '../src/worm.ts';

type Sent = { name: string; input: Record<string, unknown> };

function fakeS3(answer: (command: Sent) => unknown): { client: ArchiveS3Sender; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const entry = { name: command.constructor.name, input: command.input };
      sent.push(entry);
      return answer(entry);
    },
  } as unknown as ArchiveS3Sender;
  return { client, sent };
}

const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { $metadata: { httpStatusCode: status } });
const NOW = new Date('2026-10-21T00:00:00.000Z');

describe('S3 archive store', () => {
  it('writes each batch once, locked until the retention ends, with its checksum', async () => {
    const { client, sent } = fakeS3(() => ({}));
    const store = new S3ArchiveStore({ client, bucket: 'crove-archive-prod', lockMode: 'COMPLIANCE', retentionDays: 3650, now: () => NOW });
    const body = new TextEncoder().encode('{"seq":1}');
    await store.put(archiveKey(1), body);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(PutObjectCommand.name);
    expect(sent[0]?.input).toMatchObject({
      Bucket: 'crove-archive-prod',
      Key: 'chain/v1/000000000001.json',
      IfNoneMatch: '*',
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date(NOW.getTime() + 3650 * 86_400_000),
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
    });
  });

  it('reports a key already taken, and passes other failures on', async () => {
    for (const status of [412, 409]) {
      const store = new S3ArchiveStore({ client: fakeS3(() => Promise.reject(failure(status))).client, bucket: 'b', lockMode: 'GOVERNANCE', retentionDays: 1 });
      await expect(store.put(archiveKey(2), new Uint8Array())).rejects.toBeInstanceOf(ArchiveObjectExistsError);
    }
    const denied = new S3ArchiveStore({ client: fakeS3(() => Promise.reject(failure(403))).client, bucket: 'b', lockMode: 'GOVERNANCE', retentionDays: 1 });
    await expect(denied.put(archiveKey(2), new Uint8Array())).rejects.toThrow('HTTP 403');
  });

  it('refuses a bucket without Object Lock', async () => {
    const off = new S3ArchiveStore({ client: fakeS3(() => ({ ObjectLockConfiguration: {} })).client, bucket: 'plain', lockMode: 'GOVERNANCE', retentionDays: 1 });
    await expect(off.assertObjectLock()).rejects.toThrow(/plain has no Object Lock/);
    const { client, sent } = fakeS3(() => ({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }));
    await new S3ArchiveStore({ client, bucket: 'locked', lockMode: 'GOVERNANCE', retentionDays: 1 }).assertObjectLock();
    expect(sent[0]).toMatchObject({ name: GetObjectLockConfigurationCommand.name, input: { Bucket: 'locked' } });
  });

  it('reads a batch, a missing one as null, and lists every page in key order', async () => {
    const pages = [
      { Contents: [{ Key: 'chain/v1/000000000002.json' }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Key: 'chain/v1/000000000001.json' }], IsTruncated: false },
    ];
    const { client, sent } = fakeS3((command) => {
      if (command.name === ListObjectsV2Command.name) return pages.shift();
      if (command.input.Key === archiveKey(9)) return Promise.reject(failure(404));
      return { Body: { transformToByteArray: async () => new Uint8Array([7]) } };
    });
    const store = new S3ArchiveStore({ client, bucket: 'b', lockMode: 'GOVERNANCE', retentionDays: 1 });
    expect(await store.list('chain/v1/')).toEqual([archiveKey(1), archiveKey(2)]);
    expect(sent.filter((s) => s.name === ListObjectsV2Command.name).map((s) => s.input.ContinuationToken)).toEqual([undefined, 't1']);
    expect(await store.get(archiveKey(1))).toEqual(new Uint8Array([7]));
    expect(sent.at(-1)).toMatchObject({ name: GetObjectCommand.name, input: { Key: archiveKey(1) } });
    expect(await store.get(archiveKey(9))).toBeNull();
  });
});

describe('local archive store', () => {
  it('writes read-only files once and lists them in key order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crove-worm-unit-'));
    try {
      const store = new LocalArchiveStore(dir);
      expect(await store.list('chain/v1/')).toEqual([]);
      await store.put(archiveKey(2), new Uint8Array([2]));
      await store.put(archiveKey(1), new Uint8Array([1]));
      await expect(store.put(archiveKey(1), new Uint8Array([9]))).rejects.toBeInstanceOf(ArchiveObjectExistsError);
      expect(await store.list('chain/v1/')).toEqual([archiveKey(1), archiveKey(2)]);
      expect(await store.get(archiveKey(1))).toEqual(Buffer.from([1]));
      expect(await store.get(archiveKey(3))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('batch and chain hashes', () => {
  it('hashes the rows in a fixed text form and folds each batch into the chain', () => {
    const rows: Array<[string, string]> = [
      ['audit:1', 'a'.repeat(64)],
      ['journal:o:2', 'b'.repeat(64)],
    ];
    const expected = createHash('sha256').update(`audit:1 ${'a'.repeat(64)}\njournal:o:2 ${'b'.repeat(64)}\n`).digest('hex');
    expect(batchSha256(rows)).toBe(expected);
    expect(GENESIS_SHA256).toBe(createHash('sha256').update('').digest('hex'));
    const first = chainSha256(GENESIS_SHA256, 1, '1970-01-01T00:00:00.000Z', '2026-10-21T00:05:00.000Z', expected);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Any field of the link changes it.
    expect(chainSha256(GENESIS_SHA256, 2, '1970-01-01T00:00:00.000Z', '2026-10-21T00:05:00.000Z', expected)).not.toBe(first);
    expect(chainSha256(first, 1, '1970-01-01T00:00:00.000Z', '2026-10-21T00:05:00.000Z', expected)).not.toBe(first);
    expect(chainSha256(GENESIS_SHA256, 1, '1970-01-01T00:00:00.000Z', '2026-10-21T00:05:00.001Z', expected)).not.toBe(first);
    expect(archiveKey(12)).toBe('chain/v1/000000000012.json');
  });
});
