// Realtime invalidation over SSE (issue #69, plan §2 Realtime, §4.11 and §9).
//
// Writes to the records the SPA shows send `NOTIFY crove_stream, '<org_id> <type> <id>'` from a trigger
// (20261018140000_crove_kernel_stream_invalidation.sql), and rows that belong to one legal entity add it:
// `<org_id> <type> <id> <legal_entity_id>` (20261103080000 and 20261103090000 *_stream_legal_entity.sql, #1692), and a
// member's own row (a notification, a to-do, a note) names its recipient last, `... @<user_id>`, and a shared note adds
// `+shared` to it (20261103220000_crove_kernel_stream_recipient.sql, #1702; 20261104000000_crove_kernel_stream_notes_
// audience.sql, #1753). Each API process LISTENs on one dedicated connection (StreamHub with a NotificationSource) and
// hands a hint only to the open streams of that org, a hint with an entity only to the streams whose legal-entity scope
// includes it, and a hint with a recipient only to the streams of that user, or for a shared note also to the streams
// that read the org's shared notes. A stream sends ids, never row data, the entity or the recipient: the SPA re-fetches
// through the normal authorized queries, so a hint can never show a record its reader may not see, a member limited to
// some entities does not even learn that a record of another entity changed, and no member learns when another's
// notification, to-do or private note changed. A stream also re-runs the session check, membership, legal-entity scope
// and shared-note access of its org every STREAM_RECHECK_SECONDS and after every RECHECK_EVERY_HINTS hints, holding
// further hints back while it does, closes with a reason when the check fails, and applies the scope it returns to
// every hint it sends afterwards. It ends when the access token it was opened with expires.
//
// EventSource cannot send the Authorization header, so a stream opens with a one-time ticket from an authenticated
// POST (stream_ticket_issue, stored as its SHA-256), valid for seconds, bound to the user, org, session and assurance,
// and redeemed once on any instance (stream_ticket_redeem). The redeem runs before any user is known, so it is capped
// per client address (failed redeems per minute) and per process (redeems in flight) in http.ts (issue #281).
//
// Multi-instance: every instance LISTENs once and filters by org; Postgres delivers each notification to all of them.
// LISTEN needs a session connection, so DATABASE_LISTEN_URL must not go through a transaction-mode pooler. When the
// listener connection drops, or its periodic self-probe does not come back, every open stream of that process closes
// with `unavailable` (the app polls meanwhile), new streams answer 503 until it is back, and the listener reconnects
// with backoff. Background re-checks of all streams of a process share a small semaphore (STREAM_RECHECK_CONCURRENCY),
// so a burst of hints for a busy org never takes more than that many connections of the API pool.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { STREAM_HINT_TYPES, type StreamCloseReason, type StreamHint, type StreamHintType } from '@crove/kernel-contract';
import { DomainError, type Aal, type UserActor } from '@crove/kernel-runtime';

export const STREAM_CHANNEL = 'crove_stream';
// The query every check runs (packages/kernel/src/queries.ts).
export const STREAM_CHECK_QUERY = 'kernel.stream.check';
// A ticket is redeemed within seconds of being issued; the SPA opens the stream right away.
export const STREAM_TICKET_TTL_SECONDS = 30;
// Unexpired tickets one user may hold at once (all orgs, all instances).
export const STREAM_TICKETS_PER_USER = 10;
export const HEARTBEAT_MS = 25_000;
export const RECHECK_EVERY_HINTS = 50;
// A background re-check that takes longer closes its stream with `unavailable` (issue #281).
export const RECHECK_TIMEOUT_MS = 20_000;
// A stream never outlives this, whatever the token's exp says.
export const MAX_STREAM_LIFETIME_MS = 60 * 60_000;
// Distinct hints held for one stream (while a check runs or the client reads slowly); past it they collapse into one
// `resync`, which tells the app to refresh everything of the org.
export const PENDING_HINT_LIMIT = 200;
// Bytes a client may leave unread before its stream is dropped (it reconnects and resyncs).
export const MAX_BUFFERED_BYTES = 256 * 1024;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAYLOAD = new RegExp(`^(${UUID}) ([a-z_]{1,32}) (${UUID})(?: (${UUID}))?(?: @(${UUID})(\\+shared)?)?$`);
const UUID_ONLY = new RegExp(`^${UUID}$`);
const TYPES: ReadonlySet<string> = new Set(STREAM_HINT_TYPES);
const TICKET = /^[A-Za-z0-9_-]{43}$/;

// The hints about one member's own rows, which only that member may read (own_notification, todo_read, note_read): each
// names its recipient and reaches only the streams of that user. crove_kernel.stream_notify names the same types
// (20261104000000_crove_kernel_stream_notes_audience.sql).
export const RECIPIENT_HINT_TYPES: ReadonlySet<StreamHintType> = new Set<StreamHintType>(['notification', 'todo', 'note']);
// The hints that may add `+shared`: a shared note, which the members who read the org's shared notes may hear too.
const SHARED_HINT_TYPES: ReadonlySet<StreamHintType> = new Set<StreamHintType>(['note']);
// The hints about rows of tables under the RESTRICTIVE le_scope policy, whose trigger names the row's legal entity
// (#1692): a hint of one of these types without an entity reaches no stream, rather than every stream of the org
// (#1703). stream-legal-entity.db.test.ts checks this list against the catalog, so a table that becomes entity-scoped
// fails it until its type is added here.
export const ENTITY_HINT_TYPES: ReadonlySet<StreamHintType> = new Set<StreamHintType>(['journal_entry', 'document', 'extraction', 'notification']);

// Whether a hint of this type may go on with this entity (undefined: none named): a type of ENTITY_HINT_TYPES needs one.
export function entityNamed(type: StreamHintType, legalEntityId: string | undefined): boolean {
  return legalEntityId !== undefined || !ENTITY_HINT_TYPES.has(type);
}

export interface ParsedHint {
  orgId: string;
  hint: StreamHint;
  // The legal entity of the row the hint is about; absent for an org-wide row.
  legalEntityId?: string;
  // The one user whose streams may get the hint; absent for a row every member (of its entity) may hear about.
  userId?: string;
  // A shared note: the streams that read the org's shared notes may get it too.
  shared?: true;
}

// A notification payload, or null for anything that is not exactly `<org_id> <known type> <id>`, optionally followed
// by ` <legal_entity_id>`, then by ` @<user_id>`, which a shared note follows with `+shared`. A hint of an
// ENTITY_HINT_TYPES type that names no entity is null too, as is one of a RECIPIENT_HINT_TYPES type that names no
// recipient, and `+shared` on any other type than a note: fail closed, it reaches no stream.
export function parseHint(payload: string): ParsedHint | null {
  const match = PAYLOAD.exec(payload);
  if (!match) return null;
  const [, orgId, type, id, legalEntityId, userId, shared] = match as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
    string | undefined,
    string | undefined,
  ];
  if (!TYPES.has(type)) return null;
  const hint = { type: type as StreamHintType, id };
  if (!entityNamed(hint.type, legalEntityId)) return null;
  if (userId === undefined && RECIPIENT_HINT_TYPES.has(hint.type)) return null;
  if (shared !== undefined && !SHARED_HINT_TYPES.has(hint.type)) return null;
  return {
    orgId,
    hint,
    ...(legalEntityId === undefined ? {} : { legalEntityId }),
    ...(userId === undefined ? {} : { userId }),
    ...(shared === undefined ? {} : { shared: true as const }),
  };
}

// The legal entities a stream may hear about: every entity of the org, or exactly these (none for an empty set); and
// whether it may hear about other members' shared notes (absent: it may not).
export type StreamScope = ({ all: true } | { all: false; entities: ReadonlySet<string> }) & { sharedNotes?: boolean };
export const ALL_ENTITIES: StreamScope = { all: true };

// The scope a kernel.stream.check result grants (packages/kernel/src/queries.ts: `legalEntities` is '*' or a list of
// entity ids, `sharedNotes` a boolean). Anything else throws, so a malformed answer ends the stream as `unavailable`
// instead of widening it.
export function streamScopeOf(result: unknown): StreamScope {
  const answer = result as { legalEntities?: unknown; sharedNotes?: unknown } | null;
  const legalEntities = answer?.legalEntities;
  const sharedNotes = answer?.sharedNotes;
  if (typeof sharedNotes !== 'boolean') throw new Error('kernel.stream.check returned no shared-note access');
  if (legalEntities === '*') return { all: true, sharedNotes };
  if (Array.isArray(legalEntities) && legalEntities.every((id): id is string => typeof id === 'string' && UUID_ONLY.test(id))) {
    return { all: false, entities: new Set(legalEntities), sharedNotes };
  }
  throw new Error('kernel.stream.check returned no legal-entity scope');
}

// Whether a stream with this scope may get a hint about a row of this entity (undefined: an org-wide row).
export function inScope(scope: StreamScope, legalEntityId: string | undefined): boolean {
  return legalEntityId === undefined || scope.all || scope.entities.has(legalEntityId);
}

// Whether the stream of streamUserId, with this scope, may get a hint of this type for this recipient (undefined: none
// named): the recipient's own stream, and for a shared hint also a stream that reads shared notes. A hint of a
// RECIPIENT_HINT_TYPES type that names nobody reaches no stream.
export function forRecipient(
  scope: StreamScope,
  streamUserId: string,
  type: StreamHintType,
  recipientUserId: string | undefined,
  shared = false,
): boolean {
  if (recipientUserId !== undefined) {
    return recipientUserId === streamUserId || (shared && SHARED_HINT_TYPES.has(type) && scope.sharedNotes === true);
  }
  return !RECIPIENT_HINT_TYPES.has(type);
}

// Maps a failed check to the reason the stream closes with. 401s end the session (the app re-authenticates), 403s
// the membership; anything else (the database, Supabase Auth not ready) is unavailable and the app reconnects later.
export function closeReason(error: unknown): StreamCloseReason {
  if (!(error instanceof DomainError)) return 'unavailable';
  if (error.code === 'MFA_REQUIRED') return 'mfa';
  if (error.code === 'SESSION_REVOKED_IN_ORG') return 'session_revoked_in_org';
  if (error.status === 401 || error.code === 'USER_DISABLED') return 'session';
  if (error.status === 403) return 'membership';
  return 'unavailable';
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export interface HubSubscriber {
  readonly orgId: string;
  // legalEntityId: the entity of the row, for the subscriber to drop the hint when it is outside its scope; absent for
  // an org-wide row. userId: the recipient of a member's own row, for the subscriber to drop the hint when its stream
  // is another user's; absent for a row every member may hear about. shared: a shared note, which a stream that reads
  // the org's shared notes may get too.
  hint(hint: StreamHint, legalEntityId?: string, userId?: string, shared?: boolean): void;
  // The process can no longer see changes (listener lost, shutdown): the stream must end.
  close(reason: StreamCloseReason): void;
}

// Delivers raw notification payloads of STREAM_CHANNEL. `lost` is called when deliveries stopped (the connection
// dropped) and `ready` when they flow (again).
export interface NotificationSource {
  start(handlers: { notify(payload: string): void; ready(): void; lost(): void }): void;
  stop(): Promise<void>;
}

export class StreamHub {
  private readonly byOrg = new Map<string, Set<HubSubscriber>>();
  private listening = false;
  private started = false;
  private stopped = false;
  private count = 0;
  // Not a parameter property: Node runs this file with type stripping, which refuses them.
  private readonly source: NotificationSource;

  constructor(source: NotificationSource) {
    this.source = source;
  }

  // Starts listening; streams are refused until the source reports ready.
  start(): void {
    if (this.started) return;
    this.started = true;
    this.source.start({
      notify: (payload) => this.dispatch(payload),
      ready: () => {
        this.listening = !this.stopped;
      },
      lost: () => {
        this.listening = false;
        this.closeAll('unavailable');
      },
    });
  }

  get ready(): boolean {
    return this.listening && !this.stopped;
  }

  get size(): number {
    return this.count;
  }

  subscribe(subscriber: HubSubscriber): () => void {
    // A process that cannot see changes (listener down, stopping) feeds no stream.
    if (!this.ready) {
      subscriber.close('unavailable');
      return () => {};
    }
    let set = this.byOrg.get(subscriber.orgId);
    if (!set) {
      set = new Set();
      this.byOrg.set(subscriber.orgId, set);
    }
    if (!set.has(subscriber)) {
      set.add(subscriber);
      this.count++;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const current = this.byOrg.get(subscriber.orgId);
      if (current?.delete(subscriber)) this.count--;
      if (current && current.size === 0) this.byOrg.delete(subscriber.orgId);
    };
  }

  // Only the streams of the payload's org get the hint, with its legal entity and recipient for each to filter by its
  // own scope and user; a payload that does not parse is dropped.
  dispatch(payload: string): void {
    const parsed = parseHint(payload);
    if (!parsed) return;
    const set = this.byOrg.get(parsed.orgId);
    if (!set) return;
    for (const subscriber of set) subscriber.hint(parsed.hint, parsed.legalEntityId, parsed.userId, parsed.shared === true);
  }

  // Deleting from a Set or Map while iterating it is safe: a closed stream unsubscribes itself here.
  private closeAll(reason: StreamCloseReason): void {
    for (const set of this.byOrg.values()) for (const subscriber of set) subscriber.close(reason);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.listening = false;
    this.closeAll('shutdown');
    await this.source.stop();
  }
}

// The listener's self-probe (issue #281): every PROBE_INTERVAL_MS it sends a NOTIFY on STREAM_CHANNEL from its own
// connection and expects it back within PROBE_TIMEOUT_MS. The other instances receive it too and drop it; it would
// not parse as a hint either (parseHint).
export const PROBE_INTERVAL_MS = 30_000;
export const PROBE_TIMEOUT_MS = 10_000;
// A connection that stayed up this long resets the reconnect backoff; one that keeps dropping sooner backs off.
export const LISTEN_STABLE_MS = 60_000;
const PROBE_PREFIX = 'probe ';

export function isProbePayload(payload: string): boolean {
  return payload.startsWith(PROBE_PREFIX);
}

export interface PgSourceOptions {
  connectionString: string;
  // Backoff between reconnects: from minDelayMs, doubled up to maxDelayMs, with jitter.
  minDelayMs?: number;
  maxDelayMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  stableMs?: number;
  now?: () => number;
  // Builds the listen client (tests replace it).
  createClient?: (config: pg.ClientConfig) => pg.Client;
  log?: (message: string) => void;
}

// One dedicated pg client per process that LISTENs on STREAM_CHANNEL and reconnects with backoff. A connection that
// fails (error, end, a failed connect) or whose self-probe does not come back in time is dropped: the hub closes
// every open stream with `unavailable`, and the source reconnects. The probe catches what keepAlive cannot: a
// connection that is up but no longer delivers notifications, such as a DATABASE_LISTEN_URL that goes through a
// transaction-mode pooler, or a backend that hangs.
export function createPgNotificationSource(options: PgSourceOptions): NotificationSource {
  const minDelay = options.minDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const probeInterval = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const probeTimeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const stableMs = options.stableMs ?? LISTEN_STABLE_MS;
  const now = options.now ?? Date.now;
  const createClient = options.createClient ?? ((config: pg.ClientConfig) => new pg.Client(config));
  const log = options.log ?? ((message: string) => console.error(`[stream] ${message}`));
  let client: pg.Client | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | null = null;
  let handlers: Parameters<NotificationSource['start']>[0] | null = null;
  // Of the current connection: when it began to listen, its probe interval and the probe in flight.
  let readyAt: number | null = null;
  let probeTimer: NodeJS.Timeout | null = null;
  let probe: { payload: string; deadline: NodeJS.Timeout; settle: (answered: boolean) => void } | null = null;

  const stopProbes = () => {
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
    const pending = probe;
    probe = null;
    if (pending) {
      clearTimeout(pending.deadline);
      pending.settle(false);
    }
  };

  // settle(true) when the probe came back, settle(false) when the connection was dropped first.
  const sendProbe = (current: pg.Client, settle: (answered: boolean) => void = () => {}) => {
    if (client !== current) {
      settle(false);
      return;
    }
    // A probe still out has its own deadline.
    if (probe) return;
    const payload = `${PROBE_PREFIX}${randomBytes(12).toString('base64url')}`;
    const deadline = setTimeout(
      () =>
        drop(
          current,
          `liveness probe not answered within ${probeTimeout} ms; DATABASE_LISTEN_URL must be a direct or session-mode connection`,
        ),
      probeTimeout,
    );
    deadline.unref?.();
    probe = { payload, deadline, settle };
    current.query('SELECT pg_catalog.pg_notify($1, $2)', [STREAM_CHANNEL, payload]).catch((error: unknown) => {
      drop(current, `liveness probe failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const schedule = () => {
    if (stopped || timer) return;
    const delay = Math.min(maxDelay, minDelay * 2 ** Math.min(attempt, 10));
    attempt++;
    timer = setTimeout(
      () => {
        timer = null;
        void connect();
      },
      Math.round(delay * (0.5 + Math.random() / 2)),
    );
  };

  const drop = (current: pg.Client, why: string) => {
    if (client !== current) return;
    client = null;
    stopProbes();
    // The backoff starts over only after a connection that stayed up for stableMs.
    if (readyAt !== null && now() - readyAt >= stableMs) attempt = 0;
    readyAt = null;
    current.removeAllListeners('notification');
    current.end().catch(() => {});
    if (stopped) return;
    log(`listen connection lost (${why}); open streams closed, reconnecting`);
    handlers?.lost();
    schedule();
  };

  const connect = async () => {
    if (stopped) return;
    // keepAlive: a half-open TCP connection (NAT timeout, failover) is noticed instead of listening to nothing.
    const current = createClient({ connectionString: options.connectionString, application_name: 'crove-stream-listen', keepAlive: true });
    client = current;
    current.on('error', (error) => drop(current, error.message));
    current.on('end', () => drop(current, 'ended'));
    current.on('notification', (message) => {
      if (message.channel !== STREAM_CHANNEL) return;
      const payload = message.payload ?? '';
      // Probes, ours or another instance's, never reach the hub.
      if (isProbePayload(payload)) {
        if (client === current && probe && payload === probe.payload) {
          const answered = probe;
          probe = null;
          clearTimeout(answered.deadline);
          answered.settle(true);
        }
        return;
      }
      handlers?.notify(payload);
    });
    try {
      await current.connect();
      await current.query(`LISTEN ${STREAM_CHANNEL}`);
      if (stopped || client !== current) return;
      // Ready only once a first probe came back: a connection that cannot deliver notifications never opens a stream.
      const answered = await new Promise<boolean>((resolve) => sendProbe(current, resolve));
      if (!answered || stopped || client !== current) return;
      readyAt = now();
      probeTimer = setInterval(() => sendProbe(current), probeInterval);
      probeTimer.unref?.();
      handlers?.ready();
    } catch (error) {
      drop(current, error instanceof Error ? error.message : 'connect failed');
    }
  };

  return {
    start(h) {
      handlers = h;
      void connect();
    },
    async stop() {
      stopped = true;
      stopProbes();
      if (timer) clearTimeout(timer);
      timer = null;
      const current = client;
      client = null;
      await current?.end().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// One open stream
// ---------------------------------------------------------------------------

export interface StreamConnectionOptions {
  orgId: string;
  // The user the stream was opened for (its ticket's); hints about another member's own rows are dropped.
  userId: string;
  // The legal-entity scope of the check that admitted the stream; hints about rows of other entities are dropped.
  scope: StreamScope;
  // The session check and membership of the org; throws a DomainError when the stream must end, else returns the
  // legal-entity scope now in force, which replaces the previous one.
  check: () => Promise<StreamScope>;
  // Bounds the background re-checks of every stream of the process (a Semaphore, issue #281): a re-check waits for
  // a slot, and hints wait with it. Unset: re-checks run at once.
  gate?: { run<T>(fn: () => Promise<T>): Promise<T> };
  // How long a re-check may take (default RECHECK_TIMEOUT_MS).
  checkTimeoutMs?: number;
  // Writes a chunk; returns false when the client has left more than MAX_BUFFERED_BYTES unread.
  write: (chunk: string) => boolean;
  // Ends the response (after the close event, if any).
  end: () => void;
  recheckMs: number;
  heartbeatMs?: number;
  recheckEveryHints?: number;
  // When the stream must end (ms since the epoch): the token's exp, capped at MAX_STREAM_LIFETIME_MS.
  endsAt: number;
  now?: () => number;
  // Called once when the stream is over, for whatever reason.
  onClosed?: () => void;
}

interface HeldHint {
  hint: StreamHint;
  legalEntityId: string | undefined;
  userId: string | undefined;
  shared: boolean;
}

export class StreamConnection implements HubSubscriber {
  readonly orgId: string;
  private readonly userId: string;
  private readonly pending = new Map<string, HeldHint>();
  private scope: StreamScope;
  private resyncPending = false;
  private sinceCheck = 0;
  private checking = false;
  private closed = false;
  private flushQueued = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly options: StreamConnectionOptions;
  private readonly recheckEvery: number;

  constructor(options: StreamConnectionOptions) {
    this.options = options;
    this.orgId = options.orgId;
    this.userId = options.userId;
    this.scope = options.scope;
    this.recheckEvery = options.recheckEveryHints ?? RECHECK_EVERY_HINTS;
    const now = options.now ?? Date.now;
    const heartbeat = options.heartbeatMs ?? HEARTBEAT_MS;
    // A random phase, so streams opened together (after a deploy) do not re-check together; the first check still
    // comes within recheckMs.
    const phase = 1 + Math.floor(Math.random() * Math.max(1, options.recheckMs - 1));
    this.timers.push(
      setTimeout(() => {
        void this.recheck();
        const interval = setInterval(() => void this.recheck(), options.recheckMs);
        interval.unref?.();
        this.timers.push(interval);
      }, phase),
    );
    this.timers.push(setInterval(() => this.send(': ping\n\n'), heartbeat));
    this.timers.push(setTimeout(() => this.close('expired'), Math.max(0, options.endsAt - now())));
    for (const timer of this.timers) timer.unref?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // Sent once, right after the stream opened.
  open(recheckSeconds: number): void {
    this.send(sseEvent('ready', { recheckSeconds }));
  }

  // A hint outside the scope, about another member's own row that this stream may not read, or of an entity-scoped type
  // without its entity, is dropped at once, so it neither waits nor counts toward PENDING_HINT_LIMIT; one that waits is
  // checked again, when it is sent, against the scope then in force (a re-check may have narrowed it, or taken away
  // shared notes). A hint that arrives while a re-check that will widen the scope runs is dropped too: fail closed, the
  // app's poll covers it.
  hint(hint: StreamHint, legalEntityId?: string, userId?: string, shared = false): void {
    if (this.closed) return;
    if (!forRecipient(this.scope, this.userId, hint.type, userId, shared)) return;
    if (!entityNamed(hint.type, legalEntityId)) return;
    if (!inScope(this.scope, legalEntityId)) return;
    if (!this.resyncPending) {
      // Keyed by the entity too: an extraction hint carries its file's id, and two readings of one file may belong to
      // different entities, so a narrowing re-check must not drop the in-scope one with the other.
      this.pending.set(`${hint.type}:${hint.id}:${legalEntityId ?? ''}`, {
        hint: { type: hint.type, id: hint.id },
        legalEntityId,
        userId,
        shared,
      });
      if (this.pending.size > PENDING_HINT_LIMIT) {
        this.pending.clear();
        this.resyncPending = true;
      }
    }
    this.queueFlush();
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    while (!this.closed && !this.checking && (this.resyncPending || this.pending.size > 0)) {
      if (this.sinceCheck >= this.recheckEvery) {
        void this.recheck();
        return;
      }
      if (this.resyncPending) {
        this.resyncPending = false;
        this.sinceCheck++;
        this.send(sseEvent('resync', {}));
        continue;
      }
      const [key, held] = this.pending.entries().next().value as [string, HeldHint];
      this.pending.delete(key);
      if (!inScope(this.scope, held.legalEntityId)) continue;
      if (!forRecipient(this.scope, this.userId, held.hint.type, held.userId, held.shared)) continue;
      this.sinceCheck++;
      this.send(sseEvent('invalidate', held.hint));
    }
  }

  // Re-runs the session check, membership and legal-entity scope; hints wait until it answers and are then sent under
  // the scope it returned. At most one per stream runs or waits for the gate at a time, so the gate's queue never holds
  // more than the open streams.
  async recheck(): Promise<void> {
    if (this.closed || this.checking) return;
    this.checking = true;
    const { check, gate } = this.options;
    const timeoutMs = this.options.checkTimeoutMs ?? RECHECK_TIMEOUT_MS;
    // A check that does not answer in time (the pool exhausted, the database hanging) ends the stream as unavailable
    // and frees its slot of the gate, so it cannot hold back the re-checks of every other stream.
    const bounded = (): Promise<StreamScope | null> => {
      if (this.closed) return Promise.resolve(null);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('stream re-check timed out')), timeoutMs);
      });
      return Promise.race([check(), deadline]).finally(() => clearTimeout(timer));
    };
    let scope: StreamScope | null;
    try {
      // A stream that closed while it waited for a slot skips its check.
      scope = gate ? await gate.run(bounded) : await bounded();
    } catch (error) {
      this.checking = false;
      this.close(closeReason(error));
      return;
    }
    if (scope) this.scope = scope;
    this.checking = false;
    this.sinceCheck = 0;
    this.flush();
  }

  private send(chunk: string): void {
    if (this.closed) return;
    // A client that stopped reading is dropped; it reconnects and refreshes.
    if (!this.options.write(chunk)) this.finish();
  }

  // Tells the client why, then ends the response.
  close(reason: StreamCloseReason): void {
    if (this.closed) return;
    this.options.write(sseEvent('close', { reason }));
    this.finish();
  }

  // Ends without a close event (the client left, or stopped reading).
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.pending.clear();
    try {
      this.options.end();
    } finally {
      this.options.onClosed?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export interface TicketBinding {
  userId: string;
  orgId: string;
  sessionId: string;
  aal: Aal;
  mfaAt: number | null;
  // Unix seconds.
  tokenExp: number;
}

// issued: stored. expired: the token's exp has passed (by the database's clock), 401. limit: the user holds
// STREAM_TICKETS_PER_USER unexpired tickets already, 429.
export type TicketIssue = 'issued' | 'expired' | 'limit';

export interface TicketStore {
  issue(ticketHash: string, binding: TicketBinding): Promise<TicketIssue>;
  // The binding of an unexpired ticket, which is gone afterwards; null for an unknown, used or expired one.
  redeem(ticketHash: string): Promise<TicketBinding | null>;
}

export function newTicket(): { ticket: string; hash: string } {
  const ticket = randomBytes(32).toString('base64url');
  return { ticket, hash: ticketHash(ticket) };
}

export function ticketHash(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

// A ticket as the SPA sends it; anything else is refused before the database is asked.
export function wellFormedTicket(value: string | undefined | null): value is string {
  return typeof value === 'string' && TICKET.test(value);
}

export function createDbTicketStore(pool: pg.Pool, options: { ttlSeconds?: number; perUser?: number } = {}): TicketStore {
  const ttl = options.ttlSeconds ?? STREAM_TICKET_TTL_SECONDS;
  const perUser = options.perUser ?? STREAM_TICKETS_PER_USER;
  return {
    async issue(hash, b) {
      // stream_ticket_issue answers false both for an expired token and for the per-user limit. `expired` repeats its
      // token test in the same statement: now() is the transaction's start in both, so the two always agree.
      const { rows } = await pool.query<{ ok: boolean; expired: boolean }>(
        `SELECT crove_kernel.stream_ticket_issue($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, pg_catalog.to_timestamp($7::double precision), $8::integer, $9::integer) AS ok,
                pg_catalog.to_timestamp($7::double precision) <= pg_catalog.now() AS expired`,
        [hash, b.userId, b.orgId, b.sessionId, b.aal, b.mfaAt, b.tokenExp, ttl, perUser],
      );
      const row = rows[0];
      if (row?.ok === true) return 'issued';
      return row?.expired === true ? 'expired' : 'limit';
    },
    async redeem(hash) {
      const { rows } = await pool.query<{
        user_id: string;
        org_id: string;
        session_id: string;
        aal: string;
        mfa_at: string | null;
        token_exp: string;
      }>(
        `SELECT user_id, org_id, session_id, aal, mfa_at::text AS mfa_at, pg_catalog.date_part('epoch', token_expires_at)::text AS token_exp
         FROM crove_kernel.stream_ticket_redeem($1)`,
        [hash],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        orgId: row.org_id,
        sessionId: row.session_id,
        aal: row.aal === 'aal2' ? 'aal2' : 'aal1',
        mfaAt: row.mfa_at === null ? null : Number(row.mfa_at),
        tokenExp: Math.floor(Number(row.token_exp)),
      };
    },
  };
}

export function ticketActor(binding: TicketBinding): UserActor {
  return { type: 'user', userId: binding.userId, aal: binding.aal, sessionId: binding.sessionId, mfaAt: binding.mfaAt };
}
