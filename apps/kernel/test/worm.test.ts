// The WORM archive stores (issue #891) without a bucket: what the S3 store sends (create-only, Object Lock retention,
// a checksum), how it reads its answers, and the batch and chain hashes. The database side is
// test/invariant/worm-archive.db.test.ts; MinIO with Object Lock runs in the split-stack job (tools/e2e/split-stack.mjs).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, GetObjectLockConfigurationCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type QueryResult } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Db } from '@crove/db';
import {
  ArchiveObjectExistsError,
  GENESIS_SHA256,
  LocalArchiveStore,
  S3ArchiveStore,
  archiveKey,
  batchSha256,
  chainSha256,
  verifyArchive,
  writeArchive,
  type ArchiveBatch,
  type ArchiveS3Sender,
  type ArchiveStore,
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

// A database whose every query `answer` answers from memory.
function fakeDb(answer: (query: CompiledQuery) => unknown[]): Db {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery) => ({ rows: answer(query) }) as QueryResult<R>,
    streamQuery: () => {
      throw new Error('not used');
    },
  };
  return new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }) as unknown as Db;
}

// A database that answers the archive definers from memory: batches are due up to `due`, and archive_record refuses a
// sequence that does not follow the head, as the real one does (40001).
function fakeArchiveDb(due: number) {
  const state = { head: 0, chain: GENESIS_SHA256 };
  const start = Date.parse('2026-10-21T00:00:00.000Z');
  const windowStart = (seq: number) => new Date(start + seq * 5 * 60_000);
  const answer = (query: CompiledQuery): unknown[] => {
    if (query.sql.includes('archive_head()')) {
      return state.head ? [{ seq: String(state.head), window_to: windowStart(state.head), chain_sha256: state.chain }] : [];
    }
    if (query.sql.includes('archive_next_window')) {
      return [{ window_from: windowStart(state.head), horizon: windowStart(due + 1), first_row_at: state.head < due ? windowStart(state.head) : null }];
    }
    if (query.sql.includes('archive_record')) {
      const [seq, , , , , chain] = query.parameters as [number, string, string, number, string, string];
      if (Number(seq) !== state.head + 1) throw Object.assign(new Error('ARCHIVE_OUT_OF_ORDER'), { code: '40001' });
      [state.head, state.chain] = [Number(seq), chain];
      return [];
    }
    return [];
  };
  const db = fakeDb(answer);
  // Another run writing and recording a batch first, as the winner of a race does.
  const recordFirst = (batch: ArchiveBatch) => {
    [state.head, state.chain] = [batch.seq, batch.chainSha256];
  };
  return { db, state, recordFirst };
}

function memoryStore(beforePut: (key: string, body: Uint8Array, objects: Map<string, Uint8Array>) => void): ArchiveStore & { puts: number } {
  const objects = new Map<string, Uint8Array>();
  return {
    puts: 0,
    async put(key, body) {
      this.puts++;
      beforePut(key, body, objects);
      if (objects.has(key)) throw new ArchiveObjectExistsError(key);
      objects.set(key, body);
    },
    get: async (key) => objects.get(key) ?? null,
    list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    describe: () => 'memory',
  };
}

describe('archive writer races (#1004)', () => {
  it('lets a run that loses the race on batch after batch go on and finish', async () => {
    const { db, state, recordFirst } = fakeArchiveDb(6);
    let races = 5;
    // The other run writes and records each of the first five batches just before this run's write.
    const store = memoryStore((key, body, objects) => {
      if (races-- <= 0) return;
      objects.set(key, body);
      recordFirst(JSON.parse(new TextDecoder().decode(body)) as ArchiveBatch);
    });
    await expect(writeArchive(db, store, { lagSeconds: 600 })).resolves.toBe(1);
    expect(state.head).toBe(6);
    expect(store.puts).toBe(6);
  });

  it('lets a run whose record loses on batch after batch go on and finish', async () => {
    const { db, state, recordFirst } = fakeArchiveDb(6);
    let races = 5;
    // This run's write succeeds, but the other run records each of the first five sequences first: archive_record
    // refuses this run's record with 40001, as in the failure that #1004 reports.
    const store = memoryStore((_key, body) => {
      if (races-- <= 0) return;
      recordFirst(JSON.parse(new TextDecoder().decode(body)) as ArchiveBatch);
    });
    await expect(writeArchive(db, store, { lagSeconds: 600 })).resolves.toBe(1);
    expect(state.head).toBe(6);
    expect(store.puts).toBe(6);
  });

  it('still stops a run that keeps losing on one sequence', async () => {
    const { db, state } = fakeArchiveDb(2);
    // The key is taken, yet nothing records it and the object is never readable: the head never moves.
    const store = memoryStore(() => {
      throw new ArchiveObjectExistsError('taken');
    });
    await expect(writeArchive(db, store, { lagSeconds: 600 })).rejects.toBeInstanceOf(ArchiveObjectExistsError);
    expect(store.puts).toBe(4);
    expect(state.head).toBe(0);
  });
});

// The verifier over batches of every version (#1624, #1623), with a fake row-hash source: each archive_*_hashes
// function gives the rows `rowsOf` returns for its name and range, and the database records every batch in the store.
describe('archive verifier across batch versions (#1624, #1623)', () => {
  const EPOCH = new Date(0).toISOString();
  const at = (minutes: number) => new Date(Date.parse('2026-10-21T00:00:00.000Z') + minutes * 60_000).toISOString();
  type Rows = Array<[string, string]>;
  type Range = { fn: string; from: string; to: string };
  type Spec = Partial<ArchiveBatch> & { version: ArchiveBatch['version'] };

  // An allocation and a series made before the switch: anchored only by a batch that takes its rows from the epoch.
  const early: Record<string, Rows> = {
    archive_allocation_hashes: [['number:o:1', 'a'.repeat(64)]],
    archive_series_hashes: [['number_series:o:1', 'b'.repeat(64)]],
  };
  const rowsOf = ({ fn, from }: Range): Rows => (from === EPOCH ? (early[fn] ?? []) : []);

  // Batch `seq` covers [at(seq - 1), at(seq)), the first from the epoch. A spec sets its version and its *From fields;
  // its rows are what rowsOf gives for them, as the writer computes them.
  function chain(specs: Spec[]): ArchiveBatch[] {
    const batches: ArchiveBatch[] = [];
    let prev = GENESIS_SHA256;
    specs.forEach((spec, i) => {
      const seq = i + 1;
      const window = { from: seq === 1 ? EPOCH : at(seq - 1), to: at(seq) };
      const ranges: Array<[number, string, string | undefined]> = [
        [4, 'archive_allocation_hashes', spec.allocationsFrom],
        [5, 'archive_series_hashes', spec.seriesFrom],
      ];
      const rows = ranges
        .filter(([version]) => spec.version >= version)
        .flatMap(([, fn, from]) => rowsOf({ fn, from: from ?? window.from, to: window.to }))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const batchHash = batchSha256(rows);
      const batch: ArchiveBatch = {
        format: 'crove-archive',
        ...spec,
        seq,
        window,
        prevChainSha256: prev,
        rows,
        batchSha256: batchHash,
        chainSha256: chainSha256(prev, seq, window.from, window.to, batchHash),
      };
      batches.push(batch);
      prev = batch.chainSha256;
    });
    return batches;
  }

  // Verifies the batches as stored objects (a batch may lack a field), every one recorded in the database; `misfits` are
  // the series archive_series_misfits() names.
  async function verify(batches: Array<Omit<ArchiveBatch, 'allocationsFrom' | 'seriesFrom'> & Partial<ArchiveBatch>>, misfits: string[] = []) {
    const objects = new Map(batches.map((b) => [archiveKey(b.seq), new TextEncoder().encode(JSON.stringify(b))]));
    const store: ArchiveStore = {
      put: async () => {},
      get: async (key) => objects.get(key) ?? null,
      list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
      describe: () => 'memory',
    };
    const ranges: Range[] = [];
    const db = fakeDb((query) => {
      if (query.sql.includes('archive_batches()')) {
        return batches.map((b) => ({
          seq: String(b.seq),
          window_from: new Date(b.window.from),
          window_to: new Date(b.window.to),
          chain_sha256: b.chainSha256,
          object_key: archiveKey(b.seq),
        }));
      }
      if (query.sql.includes('archive_series_misfits()')) return misfits.map((ref) => ({ ref }));
      const fn =/crove_kernel\.(archive_\w+_hashes)\(/.exec(query.sql)?.[1];
      if (fn) {
        const [from, to] = query.parameters as [string, string];
        ranges.push({ fn, from, to });
        return rowsOf({ fn, from, to }).map(([ref, row_sha256]) => ({ ref, row_sha256 }));
      }
      return [];
    });
    return { result: await verifyArchive(db, store), ranges };
  }

  const v3: Spec = { version: 3, numbersFrom: EPOCH, entitiesFrom: EPOCH };
  // The numbers and entities of batch `seq`, after the first version 3 batch.
  const later = (seq: number) => ({ numbersFrom: at(seq - 1), entitiesFrom: at(seq - 1) });

  it('verifies version 3, 4 and 5 batches, each read back with its own version and range', async () => {
    const batches = chain([
      v3,
      { version: 4, ...later(2), allocationsFrom: EPOCH },
      { version: 4, ...later(3), allocationsFrom: at(2) },
      { version: 5, ...later(4), allocationsFrom: at(3), seriesFrom: EPOCH },
      { version: 5, ...later(5), allocationsFrom: at(4), seriesFrom: at(4) },
    ]);
    const { result, ranges } = await verify(batches);
    expect(result).toMatchObject({ ok: true, batches: 5, problems: [] });
    // The rows made before each switch are anchored once, by the first batch of the version that adds them.
    expect(batches.map((b) => b.rows.map(([ref]) => ref))).toEqual([[], ['number:o:1'], [], ['number_series:o:1'], []]);
    expect(ranges.filter((r) => r.fn === 'archive_allocation_hashes').map((r) => r.from)).toEqual([EPOCH, at(2), at(3), at(4)]);
    expect(ranges.filter((r) => r.fn === 'archive_series_hashes').map((r) => r.from)).toEqual([EPOCH, at(4)]);
  });

  it('reports a version 4 batch without allocationsFrom, or a version 5 one without seriesFrom, as unreadable', async () => {
    const [first, second] = chain([v3, { version: 4, ...later(2), allocationsFrom: EPOCH }]) as [ArchiveBatch, ArchiveBatch];
    const { allocationsFrom: _allocations, ...noAllocations } = second;
    expect((await verify([first, noAllocations])).result.problems).toEqual([{ code: 'object_unreadable', seq: 2 }]);

    const [head, v5] = chain([v3, { version: 5, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH }]) as [ArchiveBatch, ArchiveBatch];
    const { seriesFrom: _series, ...noSeries } = v5;
    expect((await verify([head, noSeries])).result.problems).toEqual([{ code: 'object_unreadable', seq: 2 }]);
  });

  it('reports allocations_gap when the first version 4 batch after a version 3 one does not take its allocations from the epoch', async () => {
    // A writer that skipped the allocations made before the switch: the batch holds no row for them, and the rows
    // recomputed over its own range agree, so only the gap shows.
    const batches = chain([v3, { version: 4, ...later(2), allocationsFrom: at(1) }]);
    expect(batches[1]?.rows).toEqual([]);
    expect((await verify(batches)).result.problems).toEqual([{ code: 'allocations_gap', seq: 2 }]);
  });

  it("reports allocations_gap when a later version 4 batch does not take its allocations from its window's start", async () => {
    const batches = chain([v3, { version: 4, ...later(2), allocationsFrom: EPOCH }, { version: 4, ...later(3), allocationsFrom: at(1) }]);
    expect((await verify(batches)).result.problems).toEqual([{ code: 'allocations_gap', seq: 3 }]);
  });

  it("reports series_gap when the first version 5 batch does not take its series from the epoch, or a later one not from its window's start", async () => {
    const skipped = chain([v3, { version: 5, ...later(2), allocationsFrom: EPOCH, seriesFrom: at(1) }]);
    expect((await verify(skipped)).result.problems).toEqual([{ code: 'series_gap', seq: 2 }]);
    const shifted = chain([
      v3,
      { version: 5, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH },
      { version: 5, ...later(3), allocationsFrom: at(2), seriesFrom: at(1) },
    ]);
    expect((await verify(shifted)).result.problems).toEqual([{ code: 'series_gap', seq: 3 }]);
  });

  it('reports a version 4 batch after a version 5 one as a regression', async () => {
    const batches = chain([
      v3,
      { version: 5, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH },
      { version: 4, ...later(3), allocationsFrom: at(2) },
    ]);
    expect((await verify(batches)).result.problems).toEqual([{ code: 'version_regressed', seq: 3 }]);
  });

  it('reports an anchored series whose period key does not fit its reset under the batch that anchored it (#1820)', async () => {
    const batches = chain([
      v3,
      { version: 4, ...later(2), allocationsFrom: EPOCH },
      { version: 5, ...later(3), allocationsFrom: at(2), seriesFrom: EPOCH },
    ]);
    // number_series:o:1 is anchored by batch 3; number_series:o:9 is not anchored yet and waits for its batch.
    expect((await verify(batches, ['number_series:o:1', 'number_series:o:9'])).result.problems).toEqual([
      { code: 'series_period_mismatch', seq: 3, ref: 'number_series:o:1' },
    ]);
    // Before version 5 nothing anchors a series, so the check does not run.
    expect((await verify(batches.slice(0, 2), ['number_series:o:1'])).result.problems).toEqual([]);
  });
});
