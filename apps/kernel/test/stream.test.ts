// The invalidation stream's fan-out and re-check logic (issue #69), without a database: hints reach only the streams
// of their org, a failed re-check closes the stream with its reason, hints wait while a check runs, and a stream ends
// when its token expires, its client stops reading, or the process loses its LISTEN connection.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import {
  PENDING_HINT_LIMIT,
  RECHECK_EVERY_HINTS,
  StreamConnection,
  StreamHub,
  closeReason,
  newTicket,
  parseHint,
  ticketHash,
  wellFormedTicket,
  type HubSubscriber,
  type NotificationSource,
} from '../src/stream.ts';

const ORG_A = randomUUID();
const ORG_B = randomUUID();

function fakeSource() {
  let handlers: Parameters<NotificationSource['start']>[0] | null = null;
  const source: NotificationSource & { emit(payload: string): void; ready(): void; lose(): void; stopped: boolean } = {
    stopped: false,
    start(h) {
      handlers = h;
    },
    async stop() {
      source.stopped = true;
    },
    emit: (payload) => handlers?.notify(payload),
    ready: () => handlers?.ready(),
    lose: () => handlers?.lost(),
  };
  return source;
}

function recorder(orgId: string): HubSubscriber & { hints: unknown[]; closed: string[] } {
  const hints: unknown[] = [];
  const closed: string[] = [];
  return { orgId, hints, closed, hint: (h) => void hints.push(h), close: (r) => void closed.push(r) };
}

describe('parseHint', () => {
  const id = randomUUID();
  it('reads exactly `<org> <type> <id>` of a known type', () => {
    expect(parseHint(`${ORG_A} proposal ${id}`)).toEqual({ orgId: ORG_A, hint: { type: 'proposal', id } });
    expect(parseHint(`${ORG_A} journal_entry ${id}`)).toEqual({ orgId: ORG_A, hint: { type: 'journal_entry', id } });
  });

  it('drops anything else', () => {
    for (const payload of [
      '',
      `${ORG_A} secret ${id}`,
      `${ORG_A} proposal ${id} extra`,
      `${ORG_A}  proposal ${id}`,
      `${ORG_A} proposal ${id}\n`,
      `${ORG_A.toUpperCase()} proposal ${id}`,
      `not-an-org proposal ${id}`,
      `${ORG_A} proposal`,
      JSON.stringify({ org: ORG_A, type: 'proposal', id }),
    ]) {
      expect(parseHint(payload)).toBeNull();
    }
  });
});

describe('StreamHub', () => {
  it('hands a hint only to the streams of its org', () => {
    const source = fakeSource();
    const hub = new StreamHub(source);
    hub.start();
    source.ready();
    const a1 = recorder(ORG_A);
    const a2 = recorder(ORG_A);
    const b = recorder(ORG_B);
    hub.subscribe(a1);
    const offA2 = hub.subscribe(a2);
    hub.subscribe(b);
    expect(hub.size).toBe(3);

    const id = randomUUID();
    source.emit(`${ORG_A} file ${id}`);
    expect(a1.hints).toEqual([{ type: 'file', id }]);
    expect(a2.hints).toEqual([{ type: 'file', id }]);
    expect(b.hints).toEqual([]);

    offA2();
    offA2();
    expect(hub.size).toBe(2);
    source.emit(`${ORG_B} document ${id}`);
    source.emit(`${ORG_A} nonsense ${id}`);
    expect(a1.hints).toHaveLength(1);
    expect(a2.hints).toHaveLength(1);
    expect(b.hints).toEqual([{ type: 'document', id }]);
  });

  it('is ready only while the source listens; a lost connection closes every stream', async () => {
    const source = fakeSource();
    const hub = new StreamHub(source);
    hub.start();
    expect(hub.ready).toBe(false);
    source.ready();
    expect(hub.ready).toBe(true);
    const a = recorder(ORG_A);
    const b = recorder(ORG_B);
    hub.subscribe(a);
    hub.subscribe(b);
    source.lose();
    expect(hub.ready).toBe(false);
    expect(a.closed).toEqual(['unavailable']);
    expect(b.closed).toEqual(['unavailable']);
    source.ready();
    expect(hub.ready).toBe(true);
    await hub.stop();
    expect(hub.ready).toBe(false);
    expect(source.stopped).toBe(true);
    expect(a.closed).toEqual(['unavailable', 'shutdown']);
  });
});

describe('closeReason', () => {
  it('maps a failed check to the reason the app acts on', () => {
    expect(closeReason(new DomainError('UNAUTHENTICATED', 401, 'x'))).toBe('session');
    expect(closeReason(new DomainError('USER_DISABLED', 403, 'x'))).toBe('session');
    expect(closeReason(new DomainError('SESSION_REVOKED_IN_ORG', 401, 'x'))).toBe('session_revoked_in_org');
    expect(closeReason(new DomainError('MFA_REQUIRED', 401, 'x'))).toBe('mfa');
    expect(closeReason(new DomainError('NOT_A_MEMBER', 403, 'x'))).toBe('membership');
    expect(closeReason(new DomainError('FORBIDDEN', 403, 'x'))).toBe('membership');
    expect(closeReason(new DomainError('AUTH_NOT_READY', 503, 'x'))).toBe('unavailable');
    expect(closeReason(new Error('connection refused'))).toBe('unavailable');
  });
});

describe('tickets', () => {
  it('are 32 random bytes in base64url, stored as their SHA-256', () => {
    const { ticket, hash } = newTicket();
    expect(wellFormedTicket(ticket)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ticketHash(ticket)).toBe(hash);
    expect(newTicket().ticket).not.toBe(ticket);
    for (const bad of [undefined, null, '', `${ticket}x`, ticket.slice(1), `${ticket.slice(1)}=`, `${ticket.slice(1)}/`]) {
      expect(wellFormedTicket(bad)).toBe(false);
    }
  });
});

describe('StreamConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function connection(options: { check?: () => Promise<void>; endsInMs?: number; writable?: () => boolean } = {}) {
    const chunks: string[] = [];
    const state = { ended: 0, closed: 0 };
    const check = vi.fn(options.check ?? (async () => {}));
    const conn = new StreamConnection({
      orgId: ORG_A,
      check,
      recheckMs: 30_000,
      heartbeatMs: 25_000,
      endsAt: Date.now() + (options.endsInMs ?? 3_600_000),
      write: (chunk) => {
        chunks.push(chunk);
        return options.writable ? options.writable() : true;
      },
      end: () => void state.ended++,
      onClosed: () => void state.closed++,
    });
    const events = () =>
      chunks
        .filter((c) => c.startsWith('event:'))
        .map((c) => {
          const [event, data] = c.trim().split('\n') as [string, string];
          return { event: event.slice(7), data: JSON.parse(data.slice(6)) as unknown };
        });
    return { conn, chunks, state, check, events };
  }

  it('sends ready, hints as {type, id} only, and heartbeat comments', async () => {
    const { conn, chunks, events } = connection();
    conn.open(30);
    const id = randomUUID();
    conn.hint({ type: 'proposal', id });
    conn.hint({ type: 'proposal', id });
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([
      { event: 'ready', data: { recheckSeconds: 30 } },
      { event: 'invalidate', data: { type: 'proposal', id } },
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(chunks.at(-1)).toBe(': ping\n\n');
    conn.finish();
  });

  it('re-checks on the interval and closes with the reason when the member was removed', async () => {
    let member = true;
    const { conn, state, check, events } = connection({
      check: async () => {
        if (!member) throw new DomainError('NOT_A_MEMBER', 403, 'gone');
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(conn.isClosed).toBe(false);
    member = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(conn.isClosed).toBe(true);
    expect(events().at(-1)).toEqual({ event: 'close', data: { reason: 'membership' } });
    expect(state).toEqual({ ended: 1, closed: 1 });
    // Nothing runs on a closed stream.
    conn.hint({ type: 'file', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(state).toEqual({ ended: 1, closed: 1 });
  });

  it(`re-checks after every ${RECHECK_EVERY_HINTS} hints and holds the rest until the check answers`, async () => {
    let answer: (() => void) | null = null;
    let fail = false;
    const { conn, check, events } = connection({
      check: () =>
        new Promise<void>((resolve, reject) => {
          answer = () => (fail ? reject(new DomainError('UNAUTHENTICATED', 401, 'revoked')) : resolve());
        }),
    });
    for (let i = 0; i < RECHECK_EVERY_HINTS + 5; i++) conn.hint({ type: 'file', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(events().filter((e) => e.event === 'invalidate')).toHaveLength(RECHECK_EVERY_HINTS);
    expect(check).toHaveBeenCalledTimes(1);
    // Held while the check runs.
    conn.hint({ type: 'file', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(events().filter((e) => e.event === 'invalidate')).toHaveLength(RECHECK_EVERY_HINTS);
    (answer as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(events().filter((e) => e.event === 'invalidate')).toHaveLength(RECHECK_EVERY_HINTS + 6);

    // A check that fails while hints wait drops them: none reach a session that just ended.
    for (let i = 0; i < RECHECK_EVERY_HINTS + 3; i++) conn.hint({ type: 'proposal', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    const before = events().filter((e) => e.event === 'invalidate').length;
    (answer as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(events().filter((e) => e.event === 'invalidate')).toHaveLength(before);
    expect(events().at(-1)).toEqual({ event: 'close', data: { reason: 'session' } });
  });

  it('collapses an overflowing backlog into one resync', async () => {
    let answer: (() => void) | null = null;
    const { conn, events } = connection({ check: () => new Promise<void>((resolve) => (answer = resolve)) });
    void conn.recheck();
    for (let i = 0; i < PENDING_HINT_LIMIT + 1; i++) conn.hint({ type: 'file', id: randomUUID() });
    (answer as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([{ event: 'resync', data: {} }]);
    conn.finish();
  });

  it('ends when the token expires', async () => {
    const { conn, events, state } = connection({ endsInMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.isClosed).toBe(true);
    expect(events().at(-1)).toEqual({ event: 'close', data: { reason: 'expired' } });
    expect(state).toEqual({ ended: 1, closed: 1 });
  });

  it('drops a client that stopped reading, without a close event', async () => {
    let writable = true;
    const { conn, events, state } = connection({ writable: () => writable });
    conn.open(30);
    writable = false;
    conn.hint({ type: 'file', id: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.isClosed).toBe(true);
    expect(events().map((e) => e.event)).toEqual(['ready', 'invalidate']);
    expect(state).toEqual({ ended: 1, closed: 1 });
  });

  it('closes with unavailable when the check cannot answer', async () => {
    const { conn, events } = connection({ check: async () => Promise.reject(new Error('connection terminated')) });
    await conn.recheck();
    expect(conn.isClosed).toBe(true);
    expect(events().at(-1)).toEqual({ event: 'close', data: { reason: 'unavailable' } });
  });
});
