// The retention job's blob sweeps (issue #212) on a fake store: leftover raw inbound mail and expired exports. The
// references to inbound blobs come from the database (blob-sweep.db.test.ts); here the listing, the age cutoff, the
// page budget and the ALERT lines.
import { describe, expect, it } from 'vitest';
import type { Db } from '@crove/db';
import { exportKey, inboundKey, newInboundBlobId, type BlobListing, type BlobStore, type ListPrefix } from '@crove/kernel-runtime';
import { BLOB_SWEEP_PAGE, expireExports, sweepInboundBlobs } from '../src/retention.ts';

const DAY = 86_400_000;
const now = new Date('2026-12-01T02:30:00Z');

function fakeStore(blobs: Record<string, Date>) {
  const deleted: string[] = [];
  const lists: Array<{ prefix: ListPrefix; after: string | null; limit: number }> = [];
  const store: BlobStore = {
    put: async () => 'content:x',
    get: async () => new Uint8Array(),
    delete: async (key) => {
      deleted.push(key);
      delete blobs[key];
    },
    list: async (prefix, after, limit): Promise<BlobListing> => {
      lists.push({ prefix, after, limit });
      const keys = Object.keys(blobs)
        .filter((k) => k.startsWith(prefix) && (after === null || k > after))
        .sort();
      const page = keys.slice(0, limit);
      return { blobs: page.map((key) => ({ key, lastModified: blobs[key] as Date })), next: keys.length > limit ? (page.at(-1) ?? null) : null };
    },
  };
  return { store, deleted, lists };
}

function recorder() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: { log: (m: string) => lines.push(m), error: (m: string) => errors.push(m) } };
}

// A database answering the reference queries: the pending definer first, then the job table.
function fakeDb(pending: string[], live: string[]) {
  const calls: string[] = [];
  const db = {
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: (node: unknown) => ({ sql: JSON.stringify(node), parameters: [], query: node }),
      executeQuery: async (compiled: { sql: string }) => {
        const isPending = compiled.sql.includes('inbound_pending_blobs');
        calls.push(isPending ? 'pending' : 'jobs');
        return { rows: (isPending ? pending : live).map((blob_id) => ({ blob_id })) };
      },
      withPlugins: () => db.getExecutor(),
    }),
  };
  return { db: db as unknown as Db, calls };
}

describe('sweepInboundBlobs', () => {
  it('deletes old blobs nothing waits for, and keeps young and referenced ones', async () => {
    const [oldFree, oldPending, oldLive, young] = [newInboundBlobId(), newInboundBlobId(), newInboundBlobId(), newInboundBlobId()];
    const { store, deleted } = fakeStore({
      [inboundKey(oldFree)]: new Date(now.getTime() - 31 * DAY),
      [inboundKey(oldPending)]: new Date(now.getTime() - 40 * DAY),
      [inboundKey(oldLive)]: new Date(now.getTime() - 31 * DAY),
      [inboundKey(young)]: new Date(now.getTime() - 29 * DAY),
      [exportKey('00000000-0000-4000-8000-000000000001', 'a'.repeat(64))]: new Date(0),
    });
    const { db, calls } = fakeDb([oldPending], [oldLive]);
    const r = recorder();
    expect(await sweepInboundBlobs(store, db, now, r.log)).toEqual({ deleted: 1, kept: 2, more: false });
    expect(deleted).toEqual([inboundKey(oldFree)]);
    expect(calls).toEqual(['pending', 'jobs']);
    expect(r.lines).toEqual(['[retention] inbound blobs deleted=1 kept=2']);
    expect(r.errors).toEqual([]);
  });

  it('asks the database nothing for a page with no old blob', async () => {
    const { store, deleted } = fakeStore({ [inboundKey(newInboundBlobId())]: now });
    const { db, calls } = fakeDb([], []);
    expect(await sweepInboundBlobs(store, db, now, recorder().log)).toEqual({ deleted: 0, kept: 0, more: false });
    expect(deleted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('stops at its page budget with an ALERT, and the next run continues', async () => {
    const blobs: Record<string, Date> = {};
    for (let i = 0; i < 7; i++) blobs[inboundKey(newInboundBlobId())] = new Date(0);
    const { store, deleted, lists } = fakeStore(blobs);
    const r = recorder();
    expect(await sweepInboundBlobs(store, fakeDb([], []).db, now, r.log, { pageSize: 2, maxPages: 2 })).toEqual({ deleted: 4, kept: 0, more: true });
    expect(lists.map((l) => l.limit)).toEqual([2, 2]);
    expect(r.errors).toEqual([expect.stringContaining('[retention] ALERT inbound blobs: blobs remain after 2 pages')]);
    expect(await sweepInboundBlobs(store, fakeDb([], []).db, now, recorder().log, { pageSize: 2, maxPages: 2 })).toEqual({ deleted: 3, kept: 0, more: false });
    expect(deleted).toHaveLength(7);
  });

  it('never deletes when the reference check fails, and logs an ALERT', async () => {
    const { store, deleted } = fakeStore({ [inboundKey(newInboundBlobId())]: new Date(0) });
    const broken = { getExecutor: () => { throw new Error('db down'); } } as unknown as Db;
    const r = recorder();
    expect(await sweepInboundBlobs(store, broken, now, r.log)).toBeNull();
    expect(deleted).toEqual([]);
    expect(r.errors).toEqual(['[retention] ALERT inbound blobs sweep failed after deleting 0']);
  });

  it('skips a store that cannot list', async () => {
    const { store } = fakeStore({});
    delete store.list;
    const r = recorder();
    expect(await sweepInboundBlobs(store, fakeDb([], []).db, now, r.log)).toBeNull();
    expect(r.lines).toEqual(['[retention] inbound blobs: the blob store cannot list; not swept']);
  });

  it('uses pages of BLOB_SWEEP_PAGE keys by default', async () => {
    const { store, lists } = fakeStore({});
    await sweepInboundBlobs(store, fakeDb([], []).db, now, recorder().log);
    expect(lists).toEqual([{ prefix: 'inbound/', after: null, limit: BLOB_SWEEP_PAGE }]);
  });
});

describe('expireExports', () => {
  const org = '00000000-0000-4000-8000-000000000002';
  const gone = '00000000-0000-4000-8000-000000000003';
  // Org records answer the live keys; the other org's records cannot be read (closed or deleted).
  function runtimeWith(live: Record<string, string[]>) {
    const asked: string[] = [];
    const runtime = {
      query: async (name: string, _input: unknown, options: { orgId: string }) => {
        expect(name).toBe('kernel.org.export.live_keys');
        asked.push(options.orgId);
        const keys = live[options.orgId];
        if (!keys) throw Object.assign(new Error('forbidden'), { status: 403 });
        return keys;
      },
    } as unknown as Parameters<typeof expireExports>[1];
    return { runtime, asked };
  }

  it('keeps blobs a live record lists and deletes the rest once two days old', async () => {
    const recorded = exportKey(org, 'a'.repeat(64));
    const unrecorded = exportKey(org, 'b'.repeat(64));
    const writing = exportKey(org, 'c'.repeat(64));
    const mail = inboundKey(newInboundBlobId());
    const { store, deleted } = fakeStore({
      // Older than any retention, but its record (say EXPORT_RETENTION_DAYS was 90 then) has not expired.
      [recorded]: new Date(now.getTime() - 80 * DAY),
      // A failed attempt, or an expired export.
      [unrecorded]: new Date(now.getTime() - 3 * DAY),
      // Being written right now: not recorded yet.
      [writing]: new Date(now.getTime() - 3_600_000),
      [mail]: new Date(0),
    });
    const { runtime, asked } = runtimeWith({ [org]: [recorded] });
    expect(await expireExports(store, runtime, 35, now, recorder().log)).toEqual({ deleted: 1, kept: 1, more: false });
    expect(deleted).toEqual([unrecorded]);
    expect(asked).toEqual([org]);
  });

  it('falls back to the age of the blob when the records cannot be read', async () => {
    const expired = exportKey(gone, 'a'.repeat(64));
    const young = exportKey(gone, 'b'.repeat(64));
    const { store, deleted } = fakeStore({
      [expired]: new Date(now.getTime() - 37 * DAY),
      [young]: new Date(now.getTime() - 20 * DAY),
    });
    const r = recorder();
    expect(await expireExports(store, runtimeWith({}).runtime, 35, now, r.log)).toEqual({ deleted: 1, kept: 1, more: false });
    expect(deleted).toEqual([expired]);
    expect(r.errors).toEqual([`[retention] export records of org ${gone} unreadable; its export blobs expire by age`]);
  });
});
