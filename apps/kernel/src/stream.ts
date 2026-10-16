// Realtime invalidation over SSE (issue #69, plan §2 Realtime, §4.11 and §9).
//
// Writes to the records the SPA shows send `NOTIFY crove_stream, '<org_id> <type> <id>'` from a trigger
// (20261018140000_crove_kernel_stream_invalidation.sql). Each API process LISTENs on one dedicated connection
// (StreamHub with a NotificationSource) and hands a hint only to the open streams of that org. A stream sends ids,
// never row data: the SPA re-fetches through the normal authorized queries, so a hint can never show a record its
// reader may not see. A stream also re-runs the session check and membership of its org every STREAM_RECHECK_SECONDS
// and after every RECHECK_EVERY_HINTS hints, holding further hints back while it does, and closes with a reason when
// either fails. It ends when the access token it was opened with expires.
//
// EventSource cannot send the Authorization header, so a stream opens with a one-time ticket from an authenticated
// POST (stream_ticket_issue, stored as its SHA-256), valid for seconds, bound to the user, org, session and assurance,
// and redeemed once on any instance (stream_ticket_redeem).
//
// Multi-instance: every instance LISTENs once and filters by org; Postgres delivers each notification to all of them.
// LISTEN needs a session connection, so DATABASE_LISTEN_URL must not go through a transaction-mode pooler. When the
// listener connection drops, every open stream of that process closes with `unavailable` (the app polls meanwhile),
// new streams answer 503 until it is back, and the listener reconnects with backoff.
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
// A stream never outlives this, whatever the token's exp says.
export const MAX_STREAM_LIFETIME_MS = 60 * 60_000;
// Distinct hints held for one stream (while a check runs or the client reads slowly); past it they collapse into one
// `resync`, which tells the app to refresh everything of the org.
export const PENDING_HINT_LIMIT = 200;
// Bytes a client may leave unread before its stream is dropped (it reconnects and resyncs).
export const MAX_BUFFERED_BYTES = 256 * 1024;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAYLOAD = new RegExp(`^(${UUID}) ([a-z_]{1,32}) (${UUID})$`);
const TYPES: ReadonlySet<string> = new Set(STREAM_HINT_TYPES);
const TICKET = /^[A-Za-z0-9_-]{43}$/;

// A notification payload, or null for anything that is not exactly `<org_id> <known type> <id>`.
export function parseHint(payload: string): { orgId: string; hint: StreamHint } | null {
  const match = PAYLOAD.exec(payload);
  if (!match) return null;
  const [, orgId, type, id] = match as unknown as [string, string, string, string];
  if (!TYPES.has(type)) return null;
  return { orgId, hint: { type: type as StreamHintType, id } };
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
  hint(hint: StreamHint): void;
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

  // Only the streams of the payload's org get the hint; a payload that does not parse is dropped.
  dispatch(payload: string): void {
    const parsed = parseHint(payload);
    if (!parsed) return;
    const set = this.byOrg.get(parsed.orgId);
    if (!set) return;
    for (const subscriber of set) subscriber.hint(parsed.hint);
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

export interface PgSourceOptions {
  connectionString: string;
  // Backoff between reconnects: from minDelayMs, doubled up to maxDelayMs, with jitter.
  minDelayMs?: number;
  maxDelayMs?: number;
  log?: (message: string) => void;
}

// One dedicated pg client per process that LISTENs on STREAM_CHANNEL and reconnects with backoff.
export function createPgNotificationSource(options: PgSourceOptions): NotificationSource {
  const minDelay = options.minDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const log = options.log ?? ((message: string) => console.error(`[stream] ${message}`));
  let client: pg.Client | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | null = null;
  let handlers: Parameters<NotificationSource['start']>[0] | null = null;

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
    const current = new pg.Client({ connectionString: options.connectionString, application_name: 'crove-stream-listen', keepAlive: true });
    client = current;
    current.on('error', (error) => drop(current, error.message));
    current.on('end', () => drop(current, 'ended'));
    current.on('notification', (message) => {
      if (message.channel === STREAM_CHANNEL) handlers?.notify(message.payload ?? '');
    });
    try {
      await current.connect();
      await current.query(`LISTEN ${STREAM_CHANNEL}`);
      if (stopped || client !== current) return;
      attempt = 0;
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
  // The session check and membership of the org; throws a DomainError when the stream must end.
  check: () => Promise<void>;
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

export class StreamConnection implements HubSubscriber {
  readonly orgId: string;
  private readonly pending = new Map<string, StreamHint>();
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

  hint(hint: StreamHint): void {
    if (this.closed) return;
    if (!this.resyncPending) {
      this.pending.set(`${hint.type}:${hint.id}`, hint);
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
      const [key, hint] = this.pending.entries().next().value as [string, StreamHint];
      this.pending.delete(key);
      this.sinceCheck++;
      this.send(sseEvent('invalidate', hint));
    }
  }

  // Re-runs the session check and membership; hints wait until it answers.
  async recheck(): Promise<void> {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      await this.options.check();
    } catch (error) {
      this.checking = false;
      this.close(closeReason(error));
      return;
    }
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

export interface TicketStore {
  // false: the user holds STREAM_TICKETS_PER_USER unexpired tickets already, or the token has expired.
  issue(ticketHash: string, binding: TicketBinding): Promise<boolean>;
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
      const { rows } = await pool.query<{ ok: boolean }>(
        `SELECT crove_kernel.stream_ticket_issue($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, pg_catalog.to_timestamp($7::double precision), $8::integer, $9::integer) AS ok`,
        [hash, b.userId, b.orgId, b.sessionId, b.aal, b.mfaAt, b.tokenExp, ttl, perUser],
      );
      return rows[0]?.ok === true;
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
