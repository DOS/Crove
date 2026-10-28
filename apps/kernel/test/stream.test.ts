// The invalidation stream's fan-out and re-check logic (issue #69), without a database: hints reach only the streams
// of their org, a hint about a row of one legal entity only the streams whose scope includes it (#1692), and a hint
// about a member's own notification only that member's streams (#1702); a failed re-check closes the stream with its
// reason, hints wait while a check runs, and a stream ends when its token expires, its client stops reading, or the
// process loses its LISTEN connection.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import { Semaphore } from '../src/concurrency.ts';
import {
  LISTEN_STABLE_MS,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  createPgNotificationSource,
  isProbePayload,
  sseEvent,
  ALL_ENTITIES,
  PENDING_HINT_LIMIT,
  RECHECK_EVERY_HINTS,
  StreamConnection,
  StreamHub,
  closeReason,
  forRecipient,
  inScope,
  newTicket,
  parseHint,
  streamScopeOf,
  ticketHash,
  wellFormedTicket,
  type HubSubscriber,
  type NotificationSource,
  type StreamScope,
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

function recorder(orgId: string): HubSubscriber & { hints: unknown[]; entities: unknown[]; recipients: unknown[]; shared: unknown[]; closed: string[] } {
  const hints: unknown[] = [];
  const entities: unknown[] = [];
  const recipients: unknown[] = [];
  const shared: unknown[] = [];
  const closed: string[] = [];
  return {
    orgId,
    hints,
    entities,
    recipients,
    shared,
    closed,
    hint: (h, legalEntityId, userId, isShared) => {
      hints.push(h);
      entities.push(legalEntityId);
      recipients.push(userId);
      shared.push(isShared);
    },
    close: (r) => void closed.push(r),
  };
}

const ENTITY_A = randomUUID();
const ENTITY_B = randomUUID();
const only = (...entities: string[]): StreamScope => ({ all: false, entities: new Set(entities) });
// The user every StreamConnection below is opened for, and another member of the org.
const USER_A = randomUUID();
const USER_B = randomUUID();
// The scope of an owner, admin or member with the whole org: it reads the org's shared notes (#1753).
const READS_SHARED: StreamScope = { all: true, sharedNotes: true };

describe('parseHint', () => {
  const id = randomUUID();
  it('reads exactly `<org> <type> <id>` of a known type', () => {
    expect(parseHint(`${ORG_A} proposal ${id}`)).toEqual({ orgId: ORG_A, hint: { type: 'proposal', id } });
    expect(parseHint(`${ORG_A} journal_entry ${id}`)).toEqual({ orgId: ORG_A, hint: { type: 'journal_entry', id } });
    expect(parseHint(`${ORG_A} proposal ${id}`)).not.toHaveProperty('legalEntityId');
  });

  it('reads the legal entity of an entity-scoped row as a fourth field (#1692)', () => {
    expect(parseHint(`${ORG_A} journal_entry ${id} ${ENTITY_A}`)).toEqual({ orgId: ORG_A, hint: { type: 'journal_entry', id }, legalEntityId: ENTITY_A });
    expect(parseHint(`${ORG_A} document ${id} ${ENTITY_B}`)).toEqual({ orgId: ORG_A, hint: { type: 'document', id }, legalEntityId: ENTITY_B });
    for (const payload of [
      `${ORG_A} journal_entry ${id} ${ENTITY_A} ${ENTITY_B}`,
      `${ORG_A} journal_entry ${id}  ${ENTITY_A}`,
      `${ORG_A} journal_entry ${id} ${ENTITY_A.toUpperCase()}`,
      `${ORG_A} journal_entry ${id} *`,
      `${ORG_A} journal_entry ${id} `,
      `${ORG_A} secret ${id} ${ENTITY_A}`,
    ]) {
      expect(parseHint(payload)).toBeNull();
    }
  });

  it("reads the recipient of a member's own row last, and drops a notification hint that names none (#1702)", () => {
    expect(parseHint(`${ORG_A} notification ${id} ${ENTITY_A} @${USER_A}`)).toEqual({
      orgId: ORG_A,
      hint: { type: 'notification', id },
      legalEntityId: ENTITY_A,
      userId: USER_A,
    });
    expect(parseHint(`${ORG_A} notification ${id} @${USER_A}`)).toEqual({ orgId: ORG_A, hint: { type: 'notification', id }, userId: USER_A });
    expect(parseHint(`${ORG_A} journal_entry ${id} ${ENTITY_A}`)).not.toHaveProperty('userId');
    for (const payload of [
      // Fail closed: a notification for nobody in particular reaches nobody.
      `${ORG_A} notification ${id}`,
      `${ORG_A} notification ${id} ${ENTITY_A}`,
      `${ORG_A} notification ${id} ${ENTITY_A} ${USER_A}`,
      `${ORG_A} notification ${id} @${USER_A} ${ENTITY_A}`,
      `${ORG_A} notification ${id} ${ENTITY_A} @${USER_A} @${USER_B}`,
      `${ORG_A} notification ${id} ${ENTITY_A} @${USER_A.toUpperCase()}`,
      `${ORG_A} notification ${id} ${ENTITY_A} @*`,
      `${ORG_A} notification ${id} ${ENTITY_A} @`,
      `${ORG_A} notification ${id} ${ENTITY_A}  @${USER_A}`,
    ]) {
      expect(parseHint(payload)).toBeNull();
    }
  });

  it('reads the owner of a to-do and the author of a note, and `+shared` on a shared note only (#1753)', () => {
    expect(parseHint(`${ORG_A} todo ${id} @${USER_A}`)).toEqual({ orgId: ORG_A, hint: { type: 'todo', id }, userId: USER_A });
    expect(parseHint(`${ORG_A} note ${id} @${USER_A}`)).toEqual({ orgId: ORG_A, hint: { type: 'note', id }, userId: USER_A });
    expect(parseHint(`${ORG_A} note ${id} @${USER_A}+shared`)).toEqual({ orgId: ORG_A, hint: { type: 'note', id }, userId: USER_A, shared: true });
    expect(parseHint(`${ORG_A} note ${id} @${USER_A}`)).not.toHaveProperty('shared');
    for (const payload of [
      // A to-do or a note for nobody in particular reaches nobody.
      `${ORG_A} todo ${id}`,
      `${ORG_A} note ${id}`,
      // `+shared` belongs to a note's recipient, and to a note only.
      `${ORG_A} note ${id} +shared`,
      `${ORG_A} note ${id}+shared`,
      `${ORG_A} note ${id} @${USER_A} +shared`,
      `${ORG_A} note ${id} @${USER_A}+shared+shared`,
      `${ORG_A} note ${id} @${USER_A}+org`,
      `${ORG_A} note ${id} @${USER_A}+SHARED`,
      `${ORG_A} todo ${id} @${USER_A}+shared`,
      `${ORG_A} notification ${id} ${ENTITY_A} @${USER_A}+shared`,
      `${ORG_A} file ${id} @${USER_A}+shared`,
    ]) {
      expect(parseHint(payload)).toBeNull();
    }
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

  it("passes a hint's legal entity on, for each stream to filter by its own scope (#1692)", () => {
    const source = fakeSource();
    const hub = new StreamHub(source);
    hub.start();
    source.ready();
    const a = recorder(ORG_A);
    hub.subscribe(a);
    const id = randomUUID();
    source.emit(`${ORG_A} journal_entry ${id} ${ENTITY_A}`);
    source.emit(`${ORG_A} file ${id}`);
    expect(a.hints).toEqual([
      { type: 'journal_entry', id },
      { type: 'file', id },
    ]);
    expect(a.entities).toEqual([ENTITY_A, undefined]);
  });

  it("passes a hint's recipient on, for each stream to drop another member's notification (#1702)", () => {
    const source = fakeSource();
    const hub = new StreamHub(source);
    hub.start();
    source.ready();
    const a = recorder(ORG_A);
    hub.subscribe(a);
    const id = randomUUID();
    source.emit(`${ORG_A} notification ${id} ${ENTITY_A} @${USER_B}`);
    source.emit(`${ORG_A} notification ${id} ${ENTITY_A}`);
    source.emit(`${ORG_A} file ${id}`);
    expect(a.hints).toEqual([
      { type: 'notification', id },
      { type: 'file', id },
    ]);
    expect(a.recipients).toEqual([USER_B, undefined]);
  });

  it('passes on whether a note is shared, for each stream to apply its own access (#1753)', () => {
    const source = fakeSource();
    const hub = new StreamHub(source);
    hub.start();
    source.ready();
    const a = recorder(ORG_A);
    hub.subscribe(a);
    const id = randomUUID();
    source.emit(`${ORG_A} note ${id} @${USER_B}+shared`);
    source.emit(`${ORG_A} note ${id} @${USER_B}`);
    source.emit(`${ORG_A} todo ${id} @${USER_B}`);
    source.emit(`${ORG_A} todo ${id}`);
    expect(a.hints).toEqual([
      { type: 'note', id },
      { type: 'note', id },
      { type: 'todo', id },
    ]);
    expect(a.recipients).toEqual([USER_B, USER_B, USER_B]);
    expect(a.shared).toEqual([true, false, false]);
  });

  it('is ready only while the source listens; a lost connection closes every stream', async () => {
    const source = fakeSource();
    const hub = new StreamHub(source);
    hub.start();
    expect(hub.ready).toBe(false);
    // Not listening yet: a stream is closed at once and never subscribed.
    const early = recorder(ORG_A);
    hub.subscribe(early);
    expect(early.closed).toEqual(['unavailable']);
    expect(hub.size).toBe(0);
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

describe('legal-entity scope (#1692)', () => {
  it('reads the scope of a kernel.stream.check result, and refuses anything else', () => {
    expect(streamScopeOf({ role: 'owner', legalEntities: '*', sharedNotes: true })).toEqual({ all: true, sharedNotes: true });
    expect(streamScopeOf({ role: 'viewer', legalEntities: '*', sharedNotes: false })).toEqual({ all: true, sharedNotes: false });
    expect(streamScopeOf({ role: 'member', legalEntities: [ENTITY_A], sharedNotes: false })).toEqual({ ...only(ENTITY_A), sharedNotes: false });
    expect(streamScopeOf({ role: 'member', legalEntities: [], sharedNotes: false })).toEqual({ ...only(), sharedNotes: false });
    for (const bad of [
      undefined,
      null,
      {},
      { role: 'owner' },
      { legalEntities: ['*'], sharedNotes: false },
      { legalEntities: 'all', sharedNotes: false },
      { legalEntities: [ENTITY_A, 1], sharedNotes: false },
      { legalEntities: ['x'], sharedNotes: false },
      // Shared-note access must be stated (#1753): a missing or malformed one never widens the stream.
      { legalEntities: '*' },
      { legalEntities: '*', sharedNotes: 'true' },
      { legalEntities: [ENTITY_A], sharedNotes: 1 },
    ]) {
      expect(() => streamScopeOf(bad)).toThrow();
    }
  });

  it('lets an org-wide hint through every scope, and an entity hint only through a scope that names it', () => {
    expect(inScope(ALL_ENTITIES, undefined)).toBe(true);
    expect(inScope(only(), undefined)).toBe(true);
    expect(inScope(ALL_ENTITIES, ENTITY_B)).toBe(true);
    expect(inScope(only(ENTITY_A), ENTITY_A)).toBe(true);
    expect(inScope(only(ENTITY_A), ENTITY_B)).toBe(false);
    expect(inScope(only(), ENTITY_A)).toBe(false);
  });
});

describe('recipient (#1702)', () => {
  it("lets a member's own hint through only that member's stream, and one that names nobody through none", () => {
    for (const type of ['notification', 'todo', 'note'] as const) {
      expect(forRecipient(ALL_ENTITIES, USER_A, type, USER_A)).toBe(true);
      expect(forRecipient(ALL_ENTITIES, USER_A, type, USER_B)).toBe(false);
      expect(forRecipient(ALL_ENTITIES, USER_A, type, undefined)).toBe(false);
      // Reading shared notes opens no other member's own row that is not shared.
      expect(forRecipient(READS_SHARED, USER_A, type, USER_B)).toBe(false);
    }
    expect(forRecipient(ALL_ENTITIES, USER_A, 'file', undefined)).toBe(true);
    // A recipient narrows any hint to that member.
    expect(forRecipient(ALL_ENTITIES, USER_A, 'file', USER_B)).toBe(false);
  });

  it("lets another member's shared note through only a stream that reads shared notes (#1753)", () => {
    expect(forRecipient(READS_SHARED, USER_A, 'note', USER_B, true)).toBe(true);
    expect(forRecipient({ ...only(), sharedNotes: true }, USER_A, 'note', USER_B, true)).toBe(true);
    expect(forRecipient({ all: true, sharedNotes: false }, USER_A, 'note', USER_B, true)).toBe(false);
    // Absent access is no access.
    expect(forRecipient(ALL_ENTITIES, USER_A, 'note', USER_B, true)).toBe(false);
    // Only a note can be shared, whatever the caller passes.
    expect(forRecipient(READS_SHARED, USER_A, 'todo', USER_B, true)).toBe(false);
    expect(forRecipient(READS_SHARED, USER_A, 'notification', USER_B, true)).toBe(false);
    // Its author always hears of it.
    expect(forRecipient({ all: true, sharedNotes: false }, USER_A, 'note', USER_A, true)).toBe(true);
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

  function connection(options: { check?: () => Promise<StreamScope>; scope?: StreamScope; endsInMs?: number; writable?: () => boolean } = {}) {
    const chunks: string[] = [];
    const state = { ended: 0, closed: 0 };
    const check = vi.fn(options.check ?? (async () => ALL_ENTITIES));
    const conn = new StreamConnection({
      orgId: ORG_A,
      userId: USER_A,
      scope: options.scope ?? ALL_ENTITIES,
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
        return ALL_ENTITIES;
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
        new Promise<StreamScope>((resolve, reject) => {
          answer = () => (fail ? reject(new DomainError('UNAUTHENTICATED', 401, 'revoked')) : resolve(ALL_ENTITIES));
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
    const { conn, events } = connection({ check: () => new Promise<StreamScope>((resolve) => (answer = () => resolve(ALL_ENTITIES))) });
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

  it('drops hints about rows of entities outside its scope, never counting them, and sends org-wide ones (#1692)', async () => {
    const { conn, events } = connection({ scope: only(ENTITY_A), check: async () => only(ENTITY_A) });
    const inA = randomUUID();
    const inB = randomUUID();
    const file = randomUUID();
    conn.hint({ type: 'journal_entry', id: inB }, ENTITY_B);
    conn.hint({ type: 'journal_entry', id: inA }, ENTITY_A);
    conn.hint({ type: 'file', id: file });
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([
      { event: 'invalidate', data: { type: 'journal_entry', id: inA } },
      { event: 'invalidate', data: { type: 'file', id: file } },
    ]);
    // Out-of-scope hints never fill the backlog: no resync however many arrive.
    for (let i = 0; i < PENDING_HINT_LIMIT * 2; i++) conn.hint({ type: 'document', id: randomUUID() }, ENTITY_B);
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toHaveLength(2);
    conn.finish();
  });

  it("drops another member's notification at once, never counting it, and sends its own user's (#1702)", async () => {
    const { conn, events } = connection();
    const mine = randomUUID();
    const theirs = randomUUID();
    conn.hint({ type: 'notification', id: theirs }, ENTITY_A, USER_B);
    conn.hint({ type: 'notification', id: randomUUID() }, ENTITY_A);
    conn.hint({ type: 'notification', id: mine }, ENTITY_A, USER_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([{ event: 'invalidate', data: { type: 'notification', id: mine } }]);
    // Another member's hints never fill the backlog: no resync however many arrive.
    for (let i = 0; i < PENDING_HINT_LIMIT * 2; i++) conn.hint({ type: 'notification', id: randomUUID() }, ENTITY_A, USER_B);
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toHaveLength(1);
    conn.finish();
  });

  it("sends another member's shared note only while the stream reads shared notes, never their to-do or private note (#1753)", async () => {
    let scope: StreamScope = READS_SHARED;
    let answer: (() => void) | null = null;
    const { conn, events } = connection({
      scope: READS_SHARED,
      check: () => new Promise<StreamScope>((resolve) => (answer = () => resolve(scope))),
    });
    const shared = randomUUID();
    const privateNote = randomUUID();
    const todo = randomUUID();
    const own = randomUUID();
    conn.hint({ type: 'note', id: privateNote }, undefined, USER_B, false);
    conn.hint({ type: 'todo', id: todo }, undefined, USER_B, false);
    conn.hint({ type: 'note', id: shared }, undefined, USER_B, true);
    conn.hint({ type: 'todo', id: own }, undefined, USER_A, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([
      { event: 'invalidate', data: { type: 'note', id: shared } },
      { event: 'invalidate', data: { type: 'todo', id: own } },
    ]);
    // The member became a viewer: a shared note held while the check ran is dropped once it answers.
    void conn.recheck();
    const held = randomUUID();
    conn.hint({ type: 'note', id: held }, undefined, USER_B, true);
    scope = { all: true, sharedNotes: false };
    (answer as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toHaveLength(2);
    // And later ones are dropped at once; their own shared note still reaches them.
    const mine = randomUUID();
    conn.hint({ type: 'note', id: randomUUID() }, undefined, USER_B, true);
    conn.hint({ type: 'note', id: mine }, undefined, USER_A, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(events().slice(2)).toEqual([{ event: 'invalidate', data: { type: 'note', id: mine } }]);
    conn.finish();
  });

  it('sends nothing of any entity under an empty scope', async () => {
    const { conn, events } = connection({ scope: only(), check: async () => only() });
    conn.hint({ type: 'notification', id: randomUUID() }, ENTITY_A, USER_A);
    const proposal = randomUUID();
    conn.hint({ type: 'proposal', id: proposal });
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([{ event: 'invalidate', data: { type: 'proposal', id: proposal } }]);
    conn.finish();
  });

  it('applies the scope each re-check returns, to the hints held while it ran as well', async () => {
    let scope = ALL_ENTITIES;
    let answer: (() => void) | null = null;
    const { conn, events } = connection({
      check: () => new Promise<StreamScope>((resolve) => (answer = () => resolve(scope))),
    });
    const before = randomUUID();
    conn.hint({ type: 'journal_entry', id: before }, ENTITY_B);
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toEqual([{ event: 'invalidate', data: { type: 'journal_entry', id: before } }]);
    // The member's assignments narrowed: held hints of entity B are dropped once the check answers.
    void conn.recheck();
    const held = randomUUID();
    const keptA = randomUUID();
    conn.hint({ type: 'journal_entry', id: held }, ENTITY_B);
    conn.hint({ type: 'journal_entry', id: keptA }, ENTITY_A);
    scope = only(ENTITY_A);
    (answer as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(events().slice(1)).toEqual([{ event: 'invalidate', data: { type: 'journal_entry', id: keptA } }]);
    conn.hint({ type: 'document', id: randomUUID() }, ENTITY_B);
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toHaveLength(2);
    // And widened again.
    scope = ALL_ENTITIES;
    void conn.recheck();
    (answer as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    const after = randomUUID();
    conn.hint({ type: 'document', id: after }, ENTITY_B);
    await vi.advanceTimersByTimeAsync(0);
    expect(events().at(-1)).toEqual({ event: 'invalidate', data: { type: 'document', id: after } });
    conn.finish();
  });
});

describe('re-checks share a bounded gate (issue #281)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs at most the gate limit at once, delays the rest with their hints, and skips a stream that closed meanwhile', async () => {
    const gate = new Semaphore(2);
    const answers: Array<() => void> = [];
    const checks: number[] = [];
    const sent: string[][] = [[], [], [], []];
    const streams = [0, 1, 2, 3].map(
      (i) =>
        new StreamConnection({
          orgId: ORG_A,
          userId: USER_A,
          scope: ALL_ENTITIES,
          check: () =>
            new Promise<StreamScope>((resolve) => {
              checks.push(i);
              answers.push(() => resolve(ALL_ENTITIES));
            }),
          gate,
          recheckMs: 3_600_000,
          endsAt: Date.now() + 3_600_000,
          write: (chunk) => {
            sent[i]?.push(chunk);
            return true;
          },
          end: () => {},
        }),
    );
    for (const stream of streams) void stream.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks).toEqual([0, 1]);
    // A hint for a waiting stream is held until its check has answered.
    const id = randomUUID();
    streams[2]?.hint({ type: 'file', id });
    // The fourth stream leaves while it waits: its check never runs.
    streams[3]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[2]).toEqual([]);
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks).toEqual([0, 1, 2]);
    expect(sent[2]).toEqual([]);
    answers.shift()?.();
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks).toEqual([0, 1, 2]);
    expect(sent[2]).toEqual([sseEvent('invalidate', { type: 'file', id })]);
    expect([gate.running, gate.queued]).toEqual([0, 0]);
    for (const stream of streams) stream.finish();
  });
});

describe('a re-check that never answers (issue #281)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('closes its stream as unavailable after the deadline and frees the gate for the others', async () => {
    const gate = new Semaphore(1);
    const closes: string[] = [];
    const make = (check: () => Promise<StreamScope>) =>
      new StreamConnection({
        orgId: ORG_A,
        userId: USER_A,
        scope: ALL_ENTITIES,
        check,
        gate,
        checkTimeoutMs: 5_000,
        recheckMs: 3_600_000,
        endsAt: Date.now() + 3_600_000,
        write: (chunk) => {
          if (chunk.startsWith('event: close')) closes.push(chunk);
          return true;
        },
        end: () => {},
      });
    const stuck = make(() => new Promise<StreamScope>(() => {}));
    const healthyCheck = vi.fn(async () => ALL_ENTITIES);
    const healthy = make(healthyCheck);
    void stuck.recheck();
    void healthy.recheck();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(healthyCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stuck.isClosed).toBe(true);
    expect(closes).toEqual([sseEvent('close', { reason: 'unavailable' })]);
    expect(healthyCheck).toHaveBeenCalledTimes(1);
    expect(healthy.isClosed).toBe(false);
    healthy.finish();
  });
});

// A stand-in for pg.Client: `answer` decides whether the self-probe NOTIFY comes back, `failConnect` whether connect()
// fails.
class FakeListenClient extends EventEmitter {
  answer = true;
  failConnect = false;
  ended = false;
  readonly queries: string[] = [];

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error('connection refused');
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push(text);
    if (text.includes('pg_notify') && this.answer) {
      const [channel, payload] = values as [string, string];
      queueMicrotask(() => this.emit('notification', { channel, payload }));
    }
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  // A NOTIFY from another session.
  deliver(payload: string): void {
    this.emit('notification', { channel: 'crove_stream', payload });
  }
}

describe('the LISTEN connection (issue #281)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No jitter: every backoff delay is its full value.
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Every client the source creates is kept, newest last, with the time it was created.
  function harness(setup: (client: FakeListenClient, index: number) => void = () => {}) {
    const clients: FakeListenClient[] = [];
    const createdAt: number[] = [];
    const events: string[] = [];
    const notified: string[] = [];
    const source = createPgNotificationSource({
      connectionString: 'postgres://listen.test/db',
      minDelayMs: 1_000,
      maxDelayMs: 64_000,
      log: () => {},
      createClient: () => {
        const client = new FakeListenClient();
        setup(client, clients.length);
        clients.push(client);
        createdAt.push(Date.now());
        return client as unknown as pg.Client;
      },
    });
    source.start({
      notify: (payload) => void notified.push(payload),
      ready: () => void events.push('ready'),
      lost: () => void events.push('lost'),
    });
    return { source, clients, createdAt, events, notified };
  }

  it('is ready only after its first self-probe came back, and hands no probe on', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(['ready']);
    expect(h.clients[0]?.queries).toEqual(['LISTEN crove_stream', 'SELECT pg_catalog.pg_notify($1, $2)']);
    const hint = `${ORG_A} file ${randomUUID()}`;
    h.clients[0]?.deliver(hint);
    // Another instance's probe is dropped too; it would not parse as a hint either.
    h.clients[0]?.deliver('probe someone-else');
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);
    expect(h.events).toEqual(['ready']);
    expect(h.notified).toEqual([hint]);
    expect(isProbePayload('probe someone-else')).toBe(true);
    expect(parseHint('probe someone-else')).toBeNull();
    expect(h.clients[0]?.queries.filter((q) => q.includes('pg_notify'))).toHaveLength(4);
    await h.source.stop();
  });

  it('never becomes ready on a connection that does not deliver notifications, such as a transaction pooler', async () => {
    const h = harness((client) => (client.answer = false));
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(h.events).toEqual(['lost']);
    expect(h.clients[0]?.ended).toBe(true);
    // It keeps trying, with backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.clients).toHaveLength(2);
    await h.source.stop();
  });

  it('drops a connection whose probe stops coming back, so the streams close, and reconnects', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(['ready']);
    const first = h.clients[0] as FakeListenClient;
    first.answer = false;
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS + PROBE_TIMEOUT_MS);
    expect(h.events).toEqual(['ready', 'lost']);
    expect(first.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.clients).toHaveLength(2);
    expect(h.events).toEqual(['ready', 'lost', 'ready']);
    // The dropped client's late notifications go nowhere.
    first.deliver(`${ORG_A} file ${randomUUID()}`);
    expect(h.notified).toEqual([]);
    await h.source.stop();
  });

  it('resets the reconnect backoff only after a connection stayed up for a while', async () => {
    // Clients 0 to 2 fail to connect; 3 comes up and drops after 10 s; 4 comes up and drops after the stable period.
    const h = harness((client, index) => {
      if (index < 3) client.failConnect = true;
    });
    const gaps = () => h.createdAt.slice(1).map((at, i) => at - (h.createdAt[i] as number));
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(gaps()).toEqual([1_000, 2_000, 4_000]);
    expect(h.events).toEqual(['lost', 'lost', 'lost', 'ready']);
    await vi.advanceTimersByTimeAsync(10_000);
    h.clients[3]?.emit('end');
    // Up for 10 s only: the backoff goes on doubling.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.clients).toHaveLength(5);
    expect((h.createdAt[4] as number) - (h.createdAt[3] as number)).toBe(10_000 + 8_000);
    await vi.advanceTimersByTimeAsync(LISTEN_STABLE_MS);
    h.clients[4]?.emit('error', new Error('server closed the connection'));
    // Up for the stable period: back to the shortest delay.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.clients).toHaveLength(6);
    expect((h.createdAt[5] as number) - (h.createdAt[4] as number)).toBe(LISTEN_STABLE_MS + 1_000);
    await h.source.stop();
  });
});
