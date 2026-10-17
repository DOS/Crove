// Client side of the invalidation stream (issue #69): a hint marks stale exactly the cached queries that show that
// record (by id) or list its kind, events are parsed strictly, and the client reconnects with a fresh ticket.
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { contract } from '@crove/kernel-contract';
import {
  ACCESS_RETRY_MS,
  RECONNECT_MIN_MS,
  invalidateHint,
  parseCloseEvent,
  parseHintEvent,
  startStreamClient,
  type EventSourceLike,
} from '../src/lib/stream.ts';

const client: ContractRouterClient<typeof contract> = createORPCClient(new RPCLink({ url: 'http://localhost/api/rpc' }));
const orpc = createTanstackQueryUtils(client);

const P1 = '0190a000-0000-7000-8000-000000000001';
const P2 = '0190a000-0000-7000-8000-000000000002';
const FILE = '0190a000-0000-7000-8000-0000000000f1';
const ENTRY = '0190a000-0000-7000-8000-0000000000e1';
const DOC = '0190a000-0000-7000-8000-0000000000d1';

const SOCIAL = '0190a000-0000-7000-8000-0000000000c1';

function seeded() {
  const qc = new QueryClient();
  const keys = {
    inboxPending: orpc.inbox.list.queryKey({ input: { status: 'pending' } }),
    inboxDone: orpc.inbox.list.queryKey({ input: { status: 'executed' } }),
    detail1: orpc.inbox.get.queryKey({ input: { id: P1 } }),
    detail2: orpc.inbox.get.queryKey({ input: { id: P2 } }),
    files: orpc.files.recent.queryKey(),
    journal: orpc.journal.list.queryKey({ input: {} }),
    entry: orpc.journal.get.queryKey({ input: { id: ENTRY } }),
    documents: orpc.documents.list.queryKey({ input: {} }),
    parties: orpc.parties.list.queryKey({ input: {} }),
    ledger: orpc.ledger.period.queryKey({ input: { period: '2026-09' } }),
    ledgerAccount: orpc.ledger.account.queryKey({ input: { period: '2026-09', accountCode: '331' } }),
    me: orpc.me.get.queryKey(),
    org: orpc.org.get.queryKey(),
    socialList: orpc.social.posts.list.queryKey({ input: {} }),
    socialPost: orpc.social.posts.get.queryKey({ input: { postId: SOCIAL } }),
    socialOther: orpc.social.posts.get.queryKey({ input: { postId: '0190a000-0000-7000-8000-0000000000c2' } }),
    socialQueue: orpc.social.queues.get.queryKey({ input: { connectionId: '0190a000-0000-7000-8000-0000000000c3' } }),
  };
  // Partial records: invalidateHint reads only the ids, so the seeds skip the rest of each response's shape.
  const seed = (key: QueryKey, data: unknown) => qc.setQueryData(key, data);
  for (const key of Object.values(keys)) seed(key, {});
  seed(keys.detail1, { file: { id: FILE }, result: { documentId: DOC, journalEntryId: ENTRY } });
  seed(keys.detail2, { file: { id: '0190a000-0000-7000-8000-0000000000f2' }, result: null });
  const stale = () =>
    Object.entries(keys)
      .filter(([, key]) => qc.getQueryState(key)?.isInvalidated)
      .map(([name]) => name)
      .sort();
  return { qc, stale };
}

describe('invalidateHint', () => {
  it('proposal: the inbox lists, the files list and that proposal only', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'proposal', id: P1 });
    expect(stale()).toEqual(['detail1', 'files', 'inboxDone', 'inboxPending']);
  });

  it('file and extraction: the lists and the proposal that shows the file', async () => {
    for (const type of ['file', 'extraction'] as const) {
      const { qc, stale } = seeded();
      await invalidateHint(qc, { type, id: FILE });
      expect(stale()).toEqual(['detail1', 'files', 'inboxDone', 'inboxPending']);
    }
  });

  it('journal_entry: the journal, that entry, the documents, the ledger reports and the proposal that posted it', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'journal_entry', id: ENTRY });
    expect(stale()).toEqual(['detail1', 'documents', 'entry', 'journal', 'ledger', 'ledgerAccount']);
  });

  it('document: the documents, the vendors and the proposal that recorded it', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'document', id: DOC });
    expect(stale()).toEqual(['detail1', 'documents', 'parties']);
  });

  it('social_post: the calendar, that post and the queues', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'social_post', id: SOCIAL });
    expect(stale()).toEqual(['socialList', 'socialPost', 'socialQueue']);
  });

  it('never touches unrelated queries', async () => {
    const { qc, stale } = seeded();
    await invalidateHint(qc, { type: 'proposal', id: '0190a000-0000-7000-8000-0000000000aa' });
    expect(stale()).not.toContain('me');
    expect(stale()).not.toContain('org');
    expect(stale()).not.toContain('detail1');
  });
});

describe('event parsing', () => {
  it('accepts a known type with a uuid id only', () => {
    expect(parseHintEvent(JSON.stringify({ type: 'proposal', id: P1 }))).toEqual({ type: 'proposal', id: P1 });
    expect(parseHintEvent(JSON.stringify({ type: 'proposal', id: P1, extra: 1 }))).toEqual({ type: 'proposal', id: P1 });
    expect(parseHintEvent(JSON.stringify({ type: 'secret', id: P1 }))).toBeNull();
    expect(parseHintEvent(JSON.stringify({ type: 'proposal', id: 'x' }))).toBeNull();
    expect(parseHintEvent('not json')).toBeNull();
  });

  it('reads a close reason, unknown ones as unavailable', () => {
    expect(parseCloseEvent(JSON.stringify({ reason: 'membership' }))).toBe('membership');
    expect(parseCloseEvent(JSON.stringify({ reason: 'whatever' }))).toBe('unavailable');
    expect(parseCloseEvent('')).toBe('unavailable');
  });
});

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, (event: { data?: string }) => void>();
  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  fire(type: string, data: unknown = {}) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

function harness(ticket: () => Promise<string> = async () => `t${Math.random()}`) {
  const sources: FakeEventSource[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const calls = { hints: [] as unknown[], resyncs: 0, access: [] as string[], live: [] as boolean[] };
  let clock = 0;
  const stop = startStreamClient({
    ticket,
    open: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    hint: (h) => void calls.hints.push(h),
    resync: () => void calls.resyncs++,
    accessChanged: (r) => void calls.access.push(r),
    live: (l) => void calls.live.push(l),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    now: () => clock,
    random: () => 1,
  });
  const fireTimer = async () => {
    const timer = timers.shift();
    timer?.fn();
    await vi.waitFor(() => undefined);
    return timer?.ms;
  };
  return { sources, timers, calls, stop, fireTimer, advance: (ms: number) => (clock += ms) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startStreamClient', () => {
  it('opens with a ticket, passes hints on, and resyncs after a reconnect', async () => {
    const h = harness(async () => 'abc');
    await tick();
    expect(h.sources[0]?.url).toBe('/api/stream?ticket=abc');
    h.sources[0]?.fire('ready', { recheckSeconds: 30 });
    expect(h.calls.live).toEqual([true]);
    expect(h.calls.resyncs).toBe(0);
    h.sources[0]?.fire('invalidate', { type: 'file', id: FILE });
    h.sources[0]?.fire('invalidate', { type: 'bogus', id: FILE });
    expect(h.calls.hints).toEqual([{ type: 'file', id: FILE }]);

    // A dropped connection never reuses the spent ticket: it closes and reconnects with a new one.
    h.sources[0]?.onerror?.({});
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.calls.live).toEqual([true, false]);
    expect(h.timers[0]?.ms).toBe(RECONNECT_MIN_MS);
    await h.fireTimer();
    await tick();
    expect(h.sources).toHaveLength(2);
    h.sources[1]?.fire('ready');
    expect(h.calls.resyncs).toBe(1);
    h.stop();
    expect(h.sources[1]?.closed).toBe(true);
  });

  it('backs off while streams keep failing, and resets after a stable one', async () => {
    const h = harness();
    await tick();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.sources.at(-1)?.fire('ready');
      h.sources.at(-1)?.fire('close', { reason: 'unavailable' });
      delays.push((await h.fireTimer()) as number);
      await tick();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    h.sources.at(-1)?.fire('ready');
    h.advance(60_000);
    h.sources.at(-1)?.fire('close', { reason: 'expired' });
    expect(h.timers[0]?.ms).toBe(RECONNECT_MIN_MS);
    h.stop();
  });

  it('on an access reason, lets the app re-check and waits before reconnecting', async () => {
    const h = harness();
    await tick();
    h.sources[0]?.fire('ready');
    h.sources[0]?.fire('close', { reason: 'membership' });
    expect(h.calls.access).toEqual(['membership']);
    expect(h.timers[0]?.ms).toBe(ACCESS_RETRY_MS);
    // The error that follows the server's close is ignored.
    h.sources[0]?.onerror?.({});
    expect(h.timers).toHaveLength(1);
    h.stop();
  });

  it('keeps polling when the deployment has no stream, and retries later when refused', async () => {
    const off = harness(async () => Promise.reject(Object.assign(new Error('off'), { status: 404 })));
    await tick();
    expect(off.sources).toHaveLength(0);
    expect(off.timers).toHaveLength(0);
    const refused = harness(async () => Promise.reject(Object.assign(new Error('no'), { status: 403 })));
    await tick();
    expect(refused.timers[0]?.ms).toBe(ACCESS_RETRY_MS);
    refused.stop();
  });
});
