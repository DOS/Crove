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
  highSha256,
  restoreReport,
  verifyArchive,
  writeArchive,
  type ArchiveBatch,
  type ArchiveHigh,
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
    archive_revision_hashes: [['revision:journal:o:1', 'd'.repeat(64)]],
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
        [6, 'archive_revision_hashes', spec.revisionsFrom],
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
  // the series archive_series_misfits() names, and the rows in `changed` hash differently now than when written.
  async function verify(batches: Array<Omit<ArchiveBatch, 'allocationsFrom' | 'seriesFrom' | 'revisionsFrom'> & Partial<ArchiveBatch>>, misfits: string[] = [], changed: string[] = []) {
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
      const fn = /crove_kernel\.(archive_\w+_hashes)\(/.exec(query.sql)?.[1];
      if (fn) {
        const [from, to] = query.parameters as [string, string];
        ranges.push({ fn, from, to });
        return rowsOf({ fn, from, to }).map(([ref, row_sha256]) => ({ ref, row_sha256: changed.includes(ref) ? 'c'.repeat(64) : row_sha256 }));
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

  it('verifies version 6 batches after version 5 ones, the first taking the source revisions from the epoch (#1337)', async () => {
    const batches = chain([
      v3,
      { version: 5, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH },
      { version: 6, ...later(3), allocationsFrom: at(2), seriesFrom: at(2), revisionsFrom: EPOCH },
      { version: 6, ...later(4), allocationsFrom: at(3), seriesFrom: at(3), revisionsFrom: at(3) },
    ]);
    const { result, ranges } = await verify(batches);
    expect(result).toMatchObject({ ok: true, batches: 4, problems: [] });
    // An entry made before the switch is anchored once, by the first version 6 batch.
    expect(batches.map((b) => b.rows.map(([ref]) => ref))).toEqual([[], ['number:o:1', 'number_series:o:1'], ['revision:journal:o:1'], []]);
    expect(ranges.filter((r) => r.fn === 'archive_revision_hashes').map((r) => r.from)).toEqual([EPOCH, at(3)]);
    // A changed revision or payload hash fails the batch that anchored it.
    expect((await verify(batches, [], ['revision:journal:o:1'])).result.problems).toEqual([{ code: 'row_changed', seq: 3, ref: 'revision:journal:o:1' }]);
  });

  it('reports a version 6 batch without revisionsFrom as unreadable, and revisions_gap when the revisions do not start where they must', async () => {
    const [head, v6] = chain([v3, { version: 6, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH, revisionsFrom: EPOCH }]) as [ArchiveBatch, ArchiveBatch];
    const { revisionsFrom: _revisions, ...noRevisions } = v6;
    expect((await verify([head, noRevisions])).result.problems).toEqual([{ code: 'object_unreadable', seq: 2 }]);

    const skipped = chain([v3, { version: 6, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH, revisionsFrom: at(1) }]);
    expect((await verify(skipped)).result.problems).toEqual([{ code: 'revisions_gap', seq: 2 }]);
    const shifted = chain([
      v3,
      { version: 6, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH, revisionsFrom: EPOCH },
      { version: 6, ...later(3), allocationsFrom: at(2), seriesFrom: at(2), revisionsFrom: at(1) },
    ]);
    expect((await verify(shifted)).result.problems).toEqual([{ code: 'revisions_gap', seq: 3 }]);
    // A version 5 batch after a version 6 one leaves revisions unanchored.
    const regressed = chain([
      v3,
      { version: 6, ...later(2), allocationsFrom: EPOCH, seriesFrom: EPOCH, revisionsFrom: EPOCH },
      { version: 5, ...later(3), allocationsFrom: at(2), seriesFrom: at(2) },
    ]);
    expect((await verify(regressed)).result.problems).toEqual([{ code: 'version_regressed', seq: 3 }]);
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
    // A series whose row changed is reported as that, once: its reset was switched after it was anchored.
    expect((await verify(batches, ['number_series:o:1'], ['number_series:o:1'])).result.problems).toEqual([
      { code: 'row_changed', seq: 3, ref: 'number_series:o:1' },
    ]);
    // Before version 5 nothing anchors a series, so the check does not run.
    expect((await verify(batches.slice(0, 2), ['number_series:o:1'])).result.problems).toEqual([]);
  });
});

// Version 7 batches and the restore report (#2007): each batch carries its series highs in the clear, checked against
// their row hashes; after a restore, the report names what the archive holds beyond the database and the series to
// raise. A fake database answers the archive definers from memory.
describe('series highs and the restore report (#2007)', () => {
  const EPOCH = new Date(0).toISOString();
  const at = (minutes: number) => new Date(Date.parse('2026-10-21T00:00:00.000Z') + minutes * 60_000).toISOString();
  const ORG = '0190f000-0000-7000-8000-00000000000a';
  const ENTITY = '0190f000-0000-7000-8000-0000000000e1';
  const SERIES = '0190f000-0000-7000-8000-0000000000f1';
  const highRef = `number_high:${ORG}:${SERIES}`;
  const high = (number: string): ArchiveHigh => [highRef, ENTITY, 'finance.journal_voucher', '2026', number];
  const highRow = (h: ArchiveHigh): [string, string] => [h[0], highSha256(...h)];
  const highAnswer = (h: ArchiveHigh) => {
    const [ref, row_sha256] = highRow(h);
    return { ref, row_sha256, legal_entity_id: h[1], doc_type: h[2], period_key: h[3], high: h[4] };
  };
  const hash = (c: string) => c.repeat(64);

  // Batch `seq` covers [at(seq - 1), at(seq)), the first from the epoch, with the given rows and highs.
  function chainOf(specs: Array<{ version: ArchiveBatch['version']; rows: Array<[string, string]>; highs?: ArchiveHigh[] }>): ArchiveBatch[] {
    let prev = GENESIS_SHA256;
    return specs.map((spec, i) => {
      const seq = i + 1;
      const window = { from: seq === 1 ? EPOCH : at(seq - 1), to: at(seq) };
      const from = (version: number) => (i === 0 || (specs[i - 1]?.version ?? 1) < version ? EPOCH : window.from);
      const rows = [...spec.rows, ...(spec.highs ?? []).map(highRow)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const batchHash = batchSha256(rows);
      const batch: ArchiveBatch = {
        format: 'crove-archive',
        version: spec.version,
        seq,
        window,
        numbersFrom: from(2),
        entitiesFrom: from(3),
        allocationsFrom: from(4),
        seriesFrom: from(5),
        revisionsFrom: from(6),
        ...(spec.version >= 7 ? { highsFrom: from(7), highs: spec.highs ?? [] } : {}),
        prevChainSha256: prev,
        rows,
        batchSha256: batchHash,
        chainSha256: chainSha256(prev, seq, window.from, window.to, batchHash),
      };
      prev = batch.chainSha256;
      return batch;
    });
  }

  function storeOf(batches: ArchiveBatch[]): ArchiveStore {
    const objects = new Map(batches.map((b) => [archiveKey(b.seq), new TextEncoder().encode(JSON.stringify(b))]));
    return {
      put: async () => {},
      get: async (key) => objects.get(key) ?? null,
      list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
      describe: () => 'memory',
    };
  }

  // The database: it recorded the first `recorded` batches, holds the version 1 rows `present` gives per range start,
  // its series highs per range start, and its series with their next numbers.
  function dbOf(opts: {
    batches: ArchiveBatch[];
    recorded: number;
    present: Record<string, Array<[string, string]>>;
    highs?: Record<string, ArchiveHigh[]>;
    series?: Array<{ series_id: string; next_number: string }>;
  }): Db {
    return fakeDb((query) => {
      if (query.sql.includes('archive_batches()')) {
        return opts.batches.slice(0, opts.recorded).map((b) => ({
          seq: String(b.seq),
          window_from: new Date(b.window.from),
          window_to: new Date(b.window.to),
          chain_sha256: b.chainSha256,
          object_key: archiveKey(b.seq),
        }));
      }
      if (query.sql.includes('archive_series_next()')) {
        return (opts.series ?? []).map((s) => ({ org_id: ORG, legal_entity_id: ENTITY, doc_type: 'finance.journal_voucher', period_key: '2026', ...s }));
      }
      const [from] = query.parameters as [string, string];
      if (query.sql.includes('archive_series_highs(')) return (opts.highs?.[from] ?? []).map(highAnswer);
      if (query.sql.includes('archive_row_hashes(')) return (opts.present[from] ?? []).map(([ref, row_sha256]) => ({ ref, row_sha256 }));
      return [];
    });
  }

  it('writes version 7 batches with the series highs in the clear, and the verifier checks each against its row', async () => {
    const state = { head: 0, chain: GENESIS_SHA256, window: EPOCH };
    const h = high('5');
    const db = fakeDb((query) => {
      if (query.sql.includes('archive_head()')) return state.head ? [{ seq: String(state.head), window_to: new Date(state.window), chain_sha256: state.chain }] : [];
      if (query.sql.includes('archive_next_window')) {
        return [{ window_from: new Date(state.window), horizon: new Date(at(10)), first_row_at: state.head === 0 ? new Date(at(0)) : null }];
      }
      if (query.sql.includes('archive_series_highs(')) return [highAnswer(h)];
      if (query.sql.includes('archive_record')) {
        const [seq, , to, , , chain] = query.parameters as [number, string, string, number, string, string];
        Object.assign(state, { head: Number(seq), window: to, chain });
      }
      return [];
    });
    const objects = new Map<string, Uint8Array>();
    const store: ArchiveStore = {
      put: async (key, body) => void objects.set(key, body),
      get: async (key) => objects.get(key) ?? null,
      list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
      describe: () => 'memory',
    };
    expect(await writeArchive(db, store, { lagSeconds: 600 })).toBe(1);
    const batch = JSON.parse(new TextDecoder().decode(objects.get(archiveKey(1)))) as ArchiveBatch;
    expect(batch).toMatchObject({ version: 7, highsFrom: EPOCH, highs: [h], rows: [highRow(h)] });

    // The verifier reads the store back; a clear value changed there fails as high_mismatch, though the rows and the
    // chain still hold.
    const recorded = fakeDb((query) => {
      if (query.sql.includes('archive_batches()')) {
        return [{ seq: '1', window_from: new Date(batch.window.from), window_to: new Date(batch.window.to), chain_sha256: batch.chainSha256, object_key: archiveKey(1) }];
      }
      if (query.sql.includes('archive_series_highs(')) return [highAnswer(h)];
      return [];
    });
    expect(await verifyArchive(recorded, storeOf([batch]))).toMatchObject({ ok: true, problems: [] });
    expect((await verifyArchive(recorded, storeOf([{ ...batch, highs: [high('50')] }]))).problems).toEqual([{ code: 'high_mismatch', seq: 1, ref: highRef }]);
    // A high row without its clear values fails the same way; a version 7 batch without highs is unreadable.
    expect((await verifyArchive(recorded, storeOf([{ ...batch, highs: [] }]))).problems).toEqual([{ code: 'high_mismatch', seq: 1, ref: highRef }]);
    const { highs: _highs, ...noHighs } = batch;
    expect((await verifyArchive(recorded, storeOf([noHighs as ArchiveBatch]))).problems).toEqual([{ code: 'object_unreadable', seq: 1 }]);
  });

  it('reports highs_gap when the first version 7 batch does not take its highs from the epoch', async () => {
    const [first, second] = chainOf([{ version: 6, rows: [] }, { version: 7, rows: [] }]) as [ArchiveBatch, ArchiveBatch];
    const skipped = { ...second, highsFrom: second.window.from };
    const db = dbOf({ batches: [first, skipped], recorded: 2, present: {} });
    expect((await verifyArchive(db, storeOf([first, skipped]))).problems).toEqual([{ code: 'highs_gap', seq: 2 }]);
  });

  it('names what the archive holds beyond the restored database, and the series to raise above it', async () => {
    const kept: Array<[string, string]> = [[`journal:${ORG}:e1`, hash('1')]];
    const lost: Array<[string, string]> = [
      ['audit:x2', hash('2')],
      [`journal:${ORG}:e2`, hash('3')],
      [`entity:journal:${ORG}:e2`, hash('4')],
      [`journal_voucher:${ORG}:v2`, hash('5')],
      [`voucher_number:journal_voucher:${ORG}:v2`, hash('6')],
      [`number:${ORG}:a2`, hash('7')],
    ];
    const batches = chainOf([
      { version: 7, rows: kept, highs: [high('5')] },
      { version: 7, rows: lost, highs: [high('6')] },
    ]);
    // The restored database recorded batch 1 and holds its rows; its series gives 6 next, a number the archive holds.
    const restored = (series?: Array<{ series_id: string; next_number: string }>) =>
      dbOf({ batches, recorded: 1, present: { [EPOCH]: kept }, highs: { [EPOCH]: [high('5')] }, ...(series ? { series } : {}) });
    expect(await restoreReport(restored([{ series_id: SERIES, next_number: '6' }]), storeOf(batches))).toEqual({
      ok: false,
      batches: 2,
      recorded: 1,
      beyond: [{ seq: 2, from: at(1), to: at(2) }],
      auditEvents: 1,
      orgs: [
        {
          orgId: ORG,
          journalEntries: ['e2'],
          cashVouchers: [],
          journalVouchers: ['v2'],
          documentVoids: [],
          allocations: ['a2'],
          numberVoids: [],
          series: [],
        },
      ],
      reseed: [{ orgId: ORG, seriesId: SERIES, legalEntityId: ENTITY, docType: 'finance.journal_voucher', periodKey: '2026', archivedHigh: '6', next: '6' }],
      uncovered: [],
      problems: [],
    });

    // A series the restore lost altogether is named with its archived id; one already above the archive is not.
    expect((await restoreReport(restored(), storeOf(batches))).reseed).toEqual([expect.objectContaining({ seriesId: SERIES, archivedHigh: '6', next: null })]);
    expect((await restoreReport(restored([{ series_id: SERIES, next_number: '7' }]), storeOf(batches))).reseed).toEqual([]);

    // Before version 7, the archive cannot say which series a lost allocation was in: the org needs a floor.
    const old = chainOf([
      { version: 6, rows: kept },
      { version: 6, rows: lost },
    ]);
    const legacy = await restoreReport(dbOf({ batches: old, recorded: 1, present: { [EPOCH]: kept }, series: [{ series_id: SERIES, next_number: '6' }] }), storeOf(old));
    expect(legacy).toMatchObject({ reseed: [], uncovered: [ORG] });
  });

  it('fails on a lower version after a version 7 batch: the numbers of its window have no highs', async () => {
    const kept: Array<[string, string]> = [[`journal:${ORG}:e1`, hash('1')]];
    const lost: Array<[string, string]> = [[`number:${ORG}:a2`, hash('7')]];
    const batches = chainOf([
      { version: 7, rows: kept, highs: [high('5')] },
      { version: 6, rows: lost },
    ]);
    const db = dbOf({ batches, recorded: 1, present: { [EPOCH]: kept }, highs: { [EPOCH]: [high('5')] }, series: [{ series_id: SERIES, next_number: '6' }] });
    const report = await restoreReport(db, storeOf(batches));
    expect(report.problems).toEqual([{ code: 'version_regressed', seq: 2 }]);
    expect(report.ok).toBe(false);
  });

  it('agrees when nothing was lost, and names a recorded batch the store lacks', async () => {
    const kept: Array<[string, string]> = [[`journal:${ORG}:e1`, hash('1')]];
    const batches = chainOf([{ version: 7, rows: kept, highs: [high('5')] }]);
    const db = dbOf({ batches, recorded: 1, present: { [EPOCH]: kept }, highs: { [EPOCH]: [high('5')] }, series: [{ series_id: SERIES, next_number: '6' }] });
    expect(await restoreReport(db, storeOf(batches))).toMatchObject({ ok: true, beyond: [], orgs: [], reseed: [], problems: [] });
    // An empty store, as on a server whose archive settings do not point at the surviving archive.
    expect((await restoreReport(db, storeOf([]))).problems).toEqual([{ code: 'object_missing', seq: 1 }]);
  });
});
