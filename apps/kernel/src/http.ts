import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type pg from 'pg';
import { schemaMissing } from '@crove/db/migrate';
import { ACCEPTED_ARCHIVE_TYPES, ACCEPTED_UPLOAD_TYPES, MAX_SOCIAL_VIDEO_BYTES, MAX_SOCIAL_VIDEO_MS, MAX_UPLOAD_BYTES, ORG_HEADER, SOCIAL_IMAGE_TYPES, type UploadPurpose } from '@crove/kernel-contract';
import {
  BlobConflictError,
  BlobIntegrityError,
  BlobNotFoundError,
  BlobTooLargeError,
  DomainError,
  fileKey,
  putFile,
  readVerified,
  sha256Hex,
  type BlobStore,
  type Runtime,
} from '@crove/kernel-runtime';
import type { OrgExportView } from '@crove/kernel';
import {
  JOURNAL_EXPORT_LIMIT,
  MISA_SME_PURCHASE_SERVICE,
  MISA_SME_SALES,
  buildJournalWorkbook,
  buildLedgerWorkbook,
  buildMisaWorkbook,
  buildVatWorkbook,
  purchaseRows,
  salesRows,
  type JournalEntryView,
  type LedgerBook,
  type PurchaseVoucher,
  type SalesVoucher,
  type VatReport,
} from '@crove/mod-finance';
import { clientBucket, createDbEmailLimiter, emailSendRequest, type EmailLimiter } from './auth-email-limit.ts';
import { actorOf, bearerIssuedToOAuthClient, oauthClientRefused, type Authenticate, type AuthUser } from './auth.ts';
import { ConcurrencyLimiter, type Semaphore } from './concurrency.ts';
import { publicAuthUrl, type Config } from './config.ts';
import { exportAad, exportSealer } from './export-seal.ts';
import { MAX_EMAIL_BYTES, acceptInboundEmail, secretMatches } from './inbound.ts';
import { createInviteMailSender } from './invite-mail.ts';
import { pgBossSchemaVersion } from './jobs-schema.ts';
import type { Mailer } from './mail.ts';
import { RateLimiter } from './rate-limit.ts';
import { createRpcHandler, resolveMembership, resolveOrg, type RpcChannels, type SocialDrafter } from './rpc.ts';
import { hasVideoTrack, sniffVideo, videoDurationMs } from './media-probe.ts';
import { safeFilename, sniffType } from './sniff.ts';
import { directTransferOrigin } from './storage.ts';
import {
  MAX_BUFFERED_BYTES,
  MAX_STREAM_LIFETIME_MS,
  STREAM_CHECK_QUERY,
  STREAM_TICKET_TTL_SECONDS,
  StreamConnection,
  newTicket,
  ticketActor,
  ticketHash,
  wellFormedTicket,
  type StreamHub,
  type TicketBinding,
  type TicketStore,
} from './stream.ts';

export interface HttpDeps {
  config: Config;
  runtime: Runtime;
  store: BlobStore;
  authenticate: Authenticate;
  pool: pg.Pool;
  aiEnabled: boolean;
  // Outbound mail for invites (issue #129). Unset: off, and the inviter passes the one-time link on.
  mailer?: Mailer;
  // Per-client budget for Supabase Auth's emails (#190). Unset: the database limiter on `pool`.
  emailLimiter?: EmailLimiter;
  // Per-user request limit on /api (issue #162). Default: built from API_RATE_LIMIT_PER_MINUTE; null turns it off.
  rateLimiter?: RateLimiter | null;
  // Staged upload completions running at once in this process (issue #223). Default: UPLOAD_COMPLETE_CONCURRENCY.
  uploadCompletes?: ConcurrencyLimiter;
  // Uploads that may be larger than MAX_UPLOAD_BYTES (Social videos, #409) running at once. Default: 2 per process.
  largeUploads?: ConcurrencyLimiter;
  // Channel connections (ADR-0025): the broker that seals tokens, and whether the sandbox channel is on. Unset: no
  // channel can be connected through the API.
  channels?: RpcChannels;
  // Drafts Social posts with the deployment's model (Social plan S7); unset: AI drafting answers 503.
  socialWriter?: SocialDrafter;
  // Realtime invalidation (issue #69). Unset: /api/stream answers 404 and the app keeps polling.
  stream?: StreamDeps;
}

export interface StreamDeps {
  hub: StreamHub;
  tickets: TicketStore;
  // Open streams in this process, and per user (STREAM_MAX_CONNECTIONS, STREAM_MAX_PER_USER).
  slots: ConcurrencyLimiter;
  recheckSeconds: number;
  // Background re-checks running at once in this process (STREAM_RECHECK_CONCURRENCY). Unset: unbounded.
  rechecks?: Semaphore;
  // Failed ticket redeems per client address (issue #281). Default: STREAM_REDEEM_FAILURES_PER_MINUTE.
  redeemFailures?: RateLimiter;
  // Ticket redeems in flight in this process. Default: STREAM_REDEEMS_IN_FLIGHT.
  redeems?: ConcurrencyLimiter;
}

// What a refused stream tells the client to wait before it tries again (it polls meanwhile).
export const STREAM_RETRY_SECONDS = 15;
// GET /api/stream redeems its ticket before any user is known, so the redeem is capped by client address instead
// (issue #281). Only failures count: the SPA redeems each fresh ticket once, so a client that keeps presenting unknown,
// spent or expired tickets is probing, and is refused (429) before the database is asked. Per process, like the
// request rate limit; with TRUSTED_PROXY_HOPS unset behind a reverse proxy every client shares the proxy's address and
// so this budget. The budget is peeked before and spent after the redeem, so one burst of concurrent failures may pass
// it by up to the per-address in-flight cap. The in-flight cap bounds the database work of many addresses at once (503 STREAM_BUSY past it), and
// one address may hold only a quarter of it.
export const STREAM_REDEEM_FAILURES_PER_MINUTE = 20;
export const STREAM_REDEEMS_IN_FLIGHT = 32;
export const STREAM_REDEEMS_IN_FLIGHT_PER_CLIENT = 8;

// Store errors that are not server faults. A blob missing behind a file row, or a key holding other bytes, is
// still logged: either one means storage and database disagree. Other store errors (access, I/O) stay 500.
function storeProblem(error: unknown): DomainError | null {
  if (error instanceof BlobNotFoundError) return new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
  if (error instanceof BlobConflictError) return new DomainError('CONFLICT', 409, 'Tệp đã tồn tại với nội dung khác');
  if (error instanceof BlobTooLargeError) return new DomainError('TOO_LARGE', 413, 'Tệp vượt quá 25 MB');
  // The stored object is not the one the file row recorded (red-team S25). Never served; an operator investigates.
  if (error instanceof BlobIntegrityError) return new DomainError('BLOB_INTEGRITY', 500, 'Tệp lưu trữ không khớp với bản đã ghi nhận; đã chặn tải về');
  return null;
}

function problem(c: Context, error: unknown) {
  const store = storeProblem(error);
  const domain = error instanceof DomainError ? error : (store ?? new DomainError('INTERNAL', 500, 'Lỗi hệ thống'));
  if (error instanceof BlobIntegrityError) console.error('[http] ALERT evidence integrity:', error.message);
  else if (domain.status === 500 || store) console.error('[http]', error);
  return c.json({ code: domain.code, message: domain.message }, domain.status);
}

// The bytes as a one-chunk stream that calls release once the chunk is taken or the stream is cancelled, and after five
// minutes at the latest, so a connection that neither reads nor closes cannot keep a slot for good.
function held(bytes: Uint8Array, release: () => void): ReadableStream<Uint8Array> {
  setTimeout(release, 5 * 60_000).unref();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes);
      controller.close();
      release();
    },
    cancel() {
      release();
    },
  });
}

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// The shape Supabase Auth uses for its own email limit, so the SPA (auth-js) reads the same error code.
function emailRateLimited(retryAfterSeconds: number): Response {
  const error = { code: 429, error_code: 'over_email_send_rate_limit', msg: 'Đã gửi quá nhiều email; vui lòng thử lại sau' };
  return new Response(JSON.stringify(error), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
  });
}

// A token Supabase Auth issued to an OAuth client, refused before it reaches Supabase Auth (issue #277). Same code as
// the kernel's verifier, in Supabase Auth's error shape like `emailRateLimited`, so auth-js reads it as `error.code`.
function oauthClientTokenRefused(): Response {
  const refused = oauthClientRefused();
  const error = { code: refused.status, error_code: refused.code, msg: refused.message };
  return new Response(JSON.stringify(error), { status: refused.status, headers: { 'content-type': 'application/json' } });
}

// With TRUSTED_PROXY_HOPS=0 behind a reverse proxy, every client shares the proxy's address and so one email budget
// and one budget of failed stream ticket redeems.
let proxyWarned = false;
function warnIfUntrustedProxy(c: Context, trustedHops: number): void {
  if (proxyWarned || trustedHops > 0 || !c.req.header('x-forwarded-for')) return;
  proxyWarned = true;
  console.warn(
    '[http] requests carry X-Forwarded-For but TRUSTED_PROXY_HOPS=0: behind a reverse proxy every client shares its address, and so one email budget and one budget of failed stream ticket redeems; set TRUSTED_PROXY_HOPS',
  );
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
]);

// Copies headers except hop-by-hop ones, including any the Connection header names.
function forwardable(source: Headers, extraDrop: ReadonlySet<string> = new Set()): Headers {
  const named = new Set(
    (source.get('connection') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Headers();
  source.forEach((value, key) => {
    const name = key.toLowerCase();
    if (!HOP_BY_HOP.has(name) && !named.has(name) && !extraDrop.has(name)) out.set(key, value);
  });
  return out;
}
// Client-supplied forwarding headers are dropped; the proxy sets X-Real-IP from the socket instead.
const SPOOFABLE = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-client-ip']);
// Public Supabase Auth endpoints the web app needs. Everything else (notably /admin) is not reachable.
const AUTH_PUBLIC_PATHS =
  /^\/(?:token|signup|verify|recover|user|logout|otp|resend|settings|health|authorize|callback|reauthenticate|factors(?:\/[\w-]+(?:\/(?:challenge|verify))?)?|\.well-known\/jwks\.json)$/;
const MAX_FILES_PER_UPLOAD = 5;
// A Social video (#409) is one file of up to 100 MB; a batch of documents stays under 60 MB.
const UPLOAD_BODY_LIMIT = MAX_SOCIAL_VIDEO_BYTES + 2 * 1024 * 1024;
// What a completion refused for lack of a slot tells the client to wait; the grant stays unused for 5 minutes.
export const UPLOAD_BUSY_RETRY_SECONDS = 3;
function contentSecurityPolicy(authUrl: string, storageOrigin: string | null): string {
  // Hosted Supabase Auth lives on another origin; the bundled one is proxied under /auth/v1. With presigned
  // transfers the app also posts uploads to, and fetches downloads from, the bucket's origin.
  const authOrigin = new URL(authUrl, 'http://localhost').origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src 'self' ${authOrigin}${storageOrigin ? ` ${storageOrigin}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The socket address, or with trusted reverse proxies the X-Forwarded-For entry they appended.
function clientIp(c: Context, trustedHops: number): string | null {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const socket = incoming?.socket?.remoteAddress ?? null;
  if (trustedHops === 0) return socket;
  const chain = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return chain[chain.length - trustedHops] ?? socket;
}

export function createHttpApp(deps: HttpDeps) {
  const { config, runtime, store, authenticate } = deps;
  const app = new Hono<{ Variables: { user: AuthUser } }>();
  const rpc = createRpcHandler(runtime, deps.mailer ? createInviteMailSender(deps.mailer, config.PUBLIC_URL) : undefined, deps.channels, deps.socialWriter);
  const perMinute = config.API_RATE_LIMIT_PER_MINUTE;
  const limiter = deps.rateLimiter !== undefined ? deps.rateLimiter : perMinute > 0 ? new RateLimiter({ perMinute }) : null;

  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const client = await deps.pool.connect().catch(() => null);
    if (!client) return c.json({ ready: false, reason: 'database' }, 503);
    try {
      const missing = await schemaMissing(client, config.MIGRATIONS_DIR);
      if (missing.length > 0) return c.json({ ready: false, reason: 'schema' }, 503);
      // The vendored crove_jobs schema must be the version this pg-boss release expects (External-tenant gate T6).
      const jobs = await client.query<{ version: number | null }>('SELECT crove_kernel.jobs_schema_version() AS version');
      if (jobs.rows[0]?.version !== pgBossSchemaVersion()) return c.json({ ready: false, reason: 'jobs_schema' }, 503);
      // The session check fails closed until it can read Supabase Auth's tables (ADR-0028).
      if (config.AUTH_SESSION_CHECK === 'db') {
        const { rows } = await client.query<{ ok: boolean }>('SELECT crove_kernel.auth_grants_ready() AS ok');
        if (!rows[0]?.ok) return c.json({ ready: false, reason: 'auth_grants' }, 503);
      }
      return c.json({ ready: true });
    } catch {
      return c.json({ ready: false, reason: 'database' }, 503);
    } finally {
      client.release();
    }
  });

  app.get('/api/config', (c) =>
    c.json({
      authUrl: publicAuthUrl(config),
      authAnonKey: config.PUBLIC_AUTH_ANON_KEY ?? null,
      aiEnabled: deps.aiEnabled,
      // presigned: the app uploads to a staging key and downloads from the bucket (plan §7.6); direct: through the kernel.
      uploads: store.direct ? 'presigned' : 'direct',
      inboundEnabled: Boolean(config.INBOUND_DOMAIN && config.INBOUND_SECRET),
      mailEnabled: deps.mailer?.enabled ?? false,
      // The shell's feedback and support link (SUPPORT_URL, issue #310); null hides it.
      supportUrl: config.SUPPORT_URL ?? null,
      // The SPA shows the menus of these modules only (plan Decision 12).
      modules: runtime.modules(),
      // The app subscribes to /api/stream and polls only while it is down (issue #69).
      stream: Boolean(deps.stream),
      // Channels the app may offer to connect without a platform account (ADR-0025).
      // OAuth providers only with a credential key: their tokens could not be sealed otherwise.
      channels: { sandbox: Boolean(deps.channels?.sandbox), bluesky: Boolean(deps.channels?.bluesky), oauth: deps.channels && deps.channels.broker.id !== 'none' ? Object.keys(deps.channels.connectors ?? {}).sort() : [] },
    }),
  );

  // Self-hosted Supabase Auth behind the same origin.
  if (config.AUTH_UPSTREAM_URL) {
    const upstream = config.AUTH_UPSTREAM_URL.replace(/\/$/, '');
    const emailLimiter =
      deps.emailLimiter ??
      createDbEmailLimiter(deps.pool, {
        perClientPerHour: config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR,
        addressIntervalSeconds: config.AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS,
      });
    const autoconfirm = config.AUTH_AUTOCONFIRM === 'true';
    app.all('/auth/v1/*', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
      const url = new URL(c.req.url);
      const path = url.pathname.replace(/^\/auth\/v1/, '');
      if (!AUTH_PUBLIC_PATHS.test(path)) return c.json({ code: 'NOT_FOUND' }, 404);
      const headers = forwardable(c.req.raw.headers, SPOOFABLE);
      // Supabase Auth accepts the access tokens its OAuth server issues to third-party clients wherever it accepts a
      // browser's (ADR-0028 fact 11). Of the paths above, it authenticates /user, /logout, /reauthenticate and every
      // /factors path with that token (`requireAuthentication`, v2.197.0), so an OAuth client could change the
      // user's email or password, enroll or remove factors, or sign every session out. A browser never holds such a
      // token, so it is refused on every forwarded path, before the email budget and without reaching Supabase Auth.
      // The header checked is the one forwarded; the token is decoded, never verified (Supabase Auth does that).
      if (bearerIssuedToOAuthClient(headers.get('authorization'))) return oauthClientTokenRefused();
      const ip = clientIp(c, config.TRUSTED_PROXY_HOPS);
      if (ip) headers.set('x-real-ip', ip);
      const method = c.req.method;
      const payload = method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await c.req.arrayBuffer());
      // A request that makes Supabase Auth send an email takes a slot of its client's budget first (#190).
      const sends = emailSendRequest(method, path, payload, autoconfirm);
      const client = clientBucket(ip);
      let reservation: string | null = null;
      if (sends) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        const verdict = await emailLimiter.reserve({ client, target: sends.target }).catch((error: unknown) => {
          console.error('[auth-proxy] email limiter unavailable:', error instanceof Error ? error.message : error);
          return null;
        });
        if (!verdict) return c.json({ code: 'AUTH_UNAVAILABLE', message: 'Dịch vụ đăng nhập không phản hồi' }, 503);
        if (!verdict.allowed) return emailRateLimited(verdict.retryAfterSeconds);
        reservation = verdict.reservation;
      }
      const response = await fetch(`${upstream}${path}${url.search}`, {
        method,
        headers,
        body: payload ? body(payload) : null,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      // A refused request sent no email, so it gives its slot back. One left unanswered (timeout, dropped connection)
      // keeps it: Supabase Auth may still have sent the email.
      if (reservation && response && response.status >= 400) {
        await emailLimiter.release(reservation, client).catch((error: unknown) => {
          console.error('[auth-proxy] email reservation not released:', error instanceof Error ? error.message : error);
        });
      }
      if (!response) return c.json({ code: 'AUTH_UNAVAILABLE', message: 'Dịch vụ đăng nhập không phản hồi' }, 503);
      // fetch() already decoded the body, so the upstream content-encoding no longer applies.
      const out = forwardable(response.headers, new Set(['content-encoding']));
      return new Response(response.body, { status: response.status, headers: out });
    });
  }

  if (config.INBOUND_DOMAIN && config.INBOUND_SECRET) {
    const domain = config.INBOUND_DOMAIN;
    const secret = config.INBOUND_SECRET;
    app.post('/api/inbound/email', bodyLimit({ maxSize: MAX_EMAIL_BYTES }), async (c) => {
      if (!secretMatches(c.req.header('authorization'), secret)) return c.json({ code: 'UNAUTHENTICATED' }, 401);
      try {
        const raw = new Uint8Array(await c.req.arrayBuffer());
        // Stored and queued only; the worker parses it and files the attachments (External-tenant gate T5).
        const result = await acceptInboundEmail({ runtime, store, domain }, raw, c.req.header('x-crove-recipient') ?? null);
        return c.json(result, 202);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The invalidation stream (issue #69). EventSource sends no Authorization header, so this route runs before the
  // bearer middleware below and authenticates with a one-time ticket instead (POST /api/stream/tickets, which does go
  // through it): the ticket is redeemed once (capped per client address and per process, issue #281), then come the
  // same per-user request limit, a connection slot, and the session check and membership of the ticket's org, all
  // before the stream opens.
  const stream = deps.stream;
  if (stream) {
    const redeemFailures = stream.redeemFailures ?? new RateLimiter({ perMinute: STREAM_REDEEM_FAILURES_PER_MINUTE });
    const redeems = stream.redeems ?? new ConcurrencyLimiter({ total: STREAM_REDEEMS_IN_FLIGHT, perKey: STREAM_REDEEMS_IN_FLIGHT_PER_CLIENT });
    const unavailable = (c: Context) => {
      c.header('retry-after', String(STREAM_RETRY_SECONDS));
      return c.json({ code: 'STREAM_UNAVAILABLE', message: 'Kênh cập nhật tạm thời không hoạt động' }, 503);
    };
    const rateLimited = (c: Context, retryAfterSeconds: number) => {
      c.header('retry-after', String(retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds }, 429);
    };
    app.get('/api/stream', async (c) => {
      // Hono answers HEAD with this route and drops the body: a stream nobody reads would hold a slot.
      if (c.req.method !== 'GET') return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      const ticket = c.req.query('ticket');
      const refused = () => c.json({ code: 'STREAM_TICKET_INVALID', message: 'Vé kết nối không hợp lệ hoặc đã hết hạn' }, 401);
      if (!wellFormedTicket(ticket)) return refused();
      // Checked before the redeem: a stream this process cannot feed is refused without using the ticket.
      if (!stream.hub.ready) return unavailable(c);
      // The address the email budget uses too (the socket, or the entry the trusted proxies appended; IPv6 by /64).
      const client = clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS));
      const budget = redeemFailures.peek(client);
      if (!budget.allowed) return rateLimited(c, budget.retryAfterSeconds);
      const inFlight = redeems.tryAcquire(client);
      if (!inFlight) {
        c.header('retry-after', String(STREAM_RETRY_SECONDS));
        return c.json({ code: 'STREAM_BUSY', message: 'Quá nhiều kết nối cập nhật đang mở' }, 503);
      }
      let binding: TicketBinding | null;
      try {
        binding = await stream.tickets.redeem(ticketHash(ticket));
      } catch (error) {
        console.error('[stream] ticket not redeemed:', error instanceof Error ? error.message : error);
        return unavailable(c);
      } finally {
        inFlight();
      }
      if (!binding) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        redeemFailures.take(client);
        return refused();
      }
      const decision = limiter?.take(binding.userId);
      if (decision && !decision.allowed) return rateLimited(c, decision.retryAfterSeconds);
      const release = stream.slots.tryAcquire(binding.userId);
      if (!release) {
        c.header('retry-after', String(STREAM_RETRY_SECONDS));
        return c.json({ code: 'STREAM_BUSY', message: 'Quá nhiều kết nối cập nhật đang mở' }, 503);
      }
      const actor = ticketActor(binding);
      const orgId = binding.orgId;
      const check = () => runtime.query(STREAM_CHECK_QUERY, {}, { actor, orgId }).then(() => undefined);
      try {
        await check();
      } catch (error) {
        release();
        return problem(c, error);
      }
      // The listener may have dropped, or the process begun to stop, while the checks ran.
      if (!stream.hub.ready) {
        release();
        return unavailable(c);
      }
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let unsubscribe = () => {};
      const connection = new StreamConnection({
        orgId,
        check,
        ...(stream.rechecks ? { gate: stream.rechecks } : {}),
        recheckMs: stream.recheckSeconds * 1000,
        endsAt: Math.min(binding.tokenExp * 1000, Date.now() + MAX_STREAM_LIFETIME_MS),
        write: (chunk) => {
          if (!controller) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            return false;
          }
          // Negative once more than the queue's high-water mark (0) is unread.
          return (controller.desiredSize ?? 0) > -MAX_BUFFERED_BYTES;
        },
        end: () => {
          try {
            controller?.close();
          } catch {
            // Already closed, or cancelled by the client.
          }
        },
        onClosed: () => {
          unsubscribe();
          release();
        },
      });
      const body = new ReadableStream<Uint8Array>(
        {
          start(ctrl) {
            controller = ctrl;
          },
          // The client went away.
          cancel() {
            connection.finish();
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
      );
      c.req.raw.signal.addEventListener('abort', () => connection.finish(), { once: true });
      unsubscribe = stream.hub.subscribe(connection);
      connection.open(stream.recheckSeconds);
      // A client that left during the checks above never fires abort again, and its body is never cancelled.
      if (c.req.raw.signal.aborted) connection.finish();
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
        },
      });
    });
  }

  // Everything below requires a signed-in user, and is limited per user (plan §4.4 step 0) before any command or
  // query runs. The token is verified first, so the key is a user the token proves; authenticate() writes to the
  // database only when its identity cache misses (once per user and process every few minutes), never per request.
  app.use('/api/*', async (c, next) => {
    let user: AuthUser;
    try {
      user = await authenticate(c.req.header('authorization'));
    } catch (error) {
      return problem(c, error);
    }
    const decision = limiter?.take(user.userId);
    if (decision && !decision.allowed) {
      c.header('retry-after', String(decision.retryAfterSeconds));
      return c.json(
        { code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds },
        429,
      );
    }
    c.set('user', user);
    await next();
  });

  // A one-time ticket for GET /api/stream (issue #69), bound to this token's user, session, assurance and expiry and to
  // the org of the request, issued after that org's session check and membership. No body is read.
  if (stream) {
    app.post('/api/stream/tickets', bodyLimit({ maxSize: 1024 }), async (c) => {
      try {
        const user = c.get('user');
        // Fail closed: without the token's exp a stream could outlive the token (jwt mode trusts it until then).
        const tokenExp = user.tokenExp;
        if (tokenExp === undefined) throw new DomainError('STREAM_UNAVAILABLE', 503, 'Kênh cập nhật tạm thời không hoạt động');
        const orgId = await resolveOrg(runtime, user, c.req.header(ORG_HEADER) ?? null);
        await runtime.query(STREAM_CHECK_QUERY, {}, { actor: actorOf(user), orgId });
        const { ticket, hash } = newTicket();
        const issued = await stream.tickets.issue(hash, {
          userId: user.userId,
          orgId,
          sessionId: user.sessionId,
          aal: user.aal,
          mfaAt: user.mfaAt,
          tokenExp,
        });
        // The token expired between its check above and the database's: sign in again (401), not wait (429).
        if (issued === 'expired') throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
        if (issued === 'limit') {
          c.header('retry-after', String(STREAM_TICKET_TTL_SECONDS));
          throw new DomainError('RATE_LIMITED', 429, 'Quá nhiều yêu cầu mở kênh cập nhật, hãy thử lại sau');
        }
        c.header('cache-control', 'no-store');
        return c.json({ ticket, expiresInSeconds: STREAM_TICKET_TTL_SECONDS });
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  app.all('/api/rpc/*', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: '/api/rpc',
      context: { user: c.get('user'), orgSlug: c.req.header(ORG_HEADER) ?? null },
    });
    return matched ? response : c.json({ code: 'NOT_FOUND' }, 404);
  });

  // Files are written and recorded the same way on every path: the server computes the sha256 of the bytes it
  // holds, writes them create-only to org/<org_id>/<sha256> and records the triple with the generation the store
  // returned (plan §7.6, ADR-0013).
  // purpose social: an image or a video for a Social post (#372, #409), recorded with source 'social' so it never goes
  // to extraction. A video's duration is read from the file and recorded with it.
  async function ingest(user: AuthUser, orgId: string, name: string, bytes: Uint8Array, sha256 = sha256Hex(bytes), purpose: UploadPurpose = 'document') {
    // The content decides the type; the browser's MIME type and the extension are only hints.
    const video = purpose === 'social' ? sniffVideo(bytes) : null;
    const type = video ?? sniffType(bytes);
    let durationMs: number | undefined;
    if (video) {
      if (bytes.byteLength > MAX_SOCIAL_VIDEO_BYTES) throw new DomainError('TOO_LARGE', 413, `${name} vượt quá 100 MB`);
      const ms = videoDurationMs(bytes);
      if (ms === null || ms === 0) throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: không đọc được thời lượng video`);
      if (!hasVideoTrack(bytes)) throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: tệp không có hình, chỉ có âm thanh`);
      if (ms > MAX_SOCIAL_VIDEO_MS) throw new DomainError('VIDEO_TOO_LONG', 422, `${name}: video dài quá 3 giờ`);
      durationMs = ms;
    } else {
      if (purpose === 'social' && (!type || !SOCIAL_IMAGE_TYPES.includes(type))) {
        throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: bài đăng chỉ nhận ảnh JPG, PNG, WEBP và video MP4, MOV`);
      }
      // A ZIP of documents (#314) is stored like one; the worker opens it in the sandbox and files every entry.
      if (!type || !(ACCEPTED_UPLOAD_TYPES.includes(type) || ACCEPTED_ARCHIVE_TYPES.includes(type))) {
        throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: chỉ nhận XML, PDF, JPG, PNG, WEBP hoặc ZIP`);
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new DomainError('TOO_LARGE', 413, `${name} vượt quá 25 MB`);
    }
    if (!type) throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: không nhận dạng được tệp`);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(store, storageKey, bytes, type, sha256);
    return runtime.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      {
        filename: safeFilename(name, type),
        contentType: type,
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey,
        generation,
        source: purpose === 'social' ? 'social' : 'upload',
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      { actor: actorOf(user), orgId },
    );
  }

  // A body larger than a document may be (a Social video) is held whole in memory while it is hashed and stored, so
  // this process takes at most two of them at once, one per user (#409).
  const large = deps.largeUploads ?? new ConcurrencyLimiter({ total: 2, perKey: 1 });
  const busy = (c: Context) => {
    c.header('retry-after', String(UPLOAD_BUSY_RETRY_SECONDS));
    return new DomainError('UPLOAD_BUSY', 503, 'Máy chủ đang xử lý nhiều tệp; hãy thử lại sau vài giây');
  };

  // What an upload is for: a document (the default) or an image for a Social post. Anything else is refused.
  function uploadPurpose(value: unknown): UploadPurpose {
    if (value === undefined || value === null || value === '' || value === 'document') return 'document';
    if (value === 'social') return 'social';
    throw new DomainError('INVALID', 400, 'Mục đích tải lên không hợp lệ');
  }

  async function uploader(c: Context<{ Variables: { user: AuthUser } }>) {
    const user = c.get('user');
    const membership = await resolveMembership(runtime, user, c.req.header(ORG_HEADER) ?? null);
    if (membership.role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không tải được chứng từ');
    return { user, orgId: membership.orgId };
  }

  // Bytes through the kernel: always on local disk, and still accepted with S3 (the server hashes them either way).
  app.post('/api/files', bodyLimit({ maxSize: UPLOAD_BODY_LIMIT }), async (c) => {
    let release: (() => void) | null = null;
    try {
      const { user, orgId } = await uploader(c);
      // A body that may be larger than a batch of documents (no length, or more than 25 MB) waits for a large slot.
      const length = Number(c.req.header('content-length'));
      if (!Number.isFinite(length) || length > MAX_UPLOAD_BYTES + 1024 * 1024) {
        release = large.tryAcquire(user.userId);
        if (!release) throw busy(c);
      }
      const body = await c.req.parseBody({ all: true });
      const files = ([] as unknown[]).concat(body.file ?? []).filter((f): f is File => f instanceof File);
      const purpose = uploadPurpose(body.purpose);
      if (files.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp');
      if (files.length > MAX_FILES_PER_UPLOAD) throw new DomainError('TOO_MANY_FILES', 413, `Tối đa ${MAX_FILES_PER_UPLOAD} tệp mỗi lần`);
      const results = [];
      for (const file of files) {
        // A Social video may be up to 100 MB; ingest checks the size against the type it reads from the bytes.
        if (file.size > (purpose === 'social' ? MAX_SOCIAL_VIDEO_BYTES : MAX_UPLOAD_BYTES)) throw new DomainError('TOO_LARGE', 413, `${file.name} vượt quá ${purpose === 'social' ? 100 : 25} MB`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        results.push(await ingest(user, orgId, file.name, bytes, sha256Hex(bytes), purpose));
      }
      return c.json({ files: results });
    } catch (error) {
      return problem(c, error);
    } finally {
      release?.();
    }
  });

  // Staged presigned uploads (plan §7.6 steps 1 to 3), when the store supports them (STORAGE=s3).
  const direct = store.direct;
  const noDirect = () => new DomainError('NOT_FOUND', 404, 'Máy chủ nhận tệp trực tiếp; hãy dùng POST /api/files');
  // Each completion buffers the staged object (up to 25 MB) while it hashes and writes it, so this process runs at
  // most UPLOAD_COMPLETE_CONCURRENCY of them at once, and one user at most half of them (issue #223).
  const completes = deps.uploadCompletes ?? new ConcurrencyLimiter({ total: config.UPLOAD_COMPLETE_CONCURRENCY });

  // Step 1: a single-use grant and a presigned POST form for a random staging key, 5 minutes, 1 byte to 25 MB.
  app.post('/api/files/uploads', bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    try {
      if (!direct) throw noDirect();
      const { user, orgId } = await uploader(c);
      const input = (await c.req.json().catch(() => null)) as { purpose?: unknown } | null;
      const grant = await runtime.execute<{ uploadId: string; stagingKey: string; maxBytes: number }>('kernel.file.upload.begin', { purpose: uploadPurpose(input?.purpose) }, {
        actor: actorOf(user),
        orgId,
      });
      const form = await direct.presignUpload(grant.stagingKey, grant.maxBytes);
      c.header('cache-control', 'private, no-store');
      return c.json({ uploadId: grant.uploadId, url: form.url, fields: form.fields, expiresAt: form.expiresAt.toISOString(), maxBytes: form.maxBytes });
    } catch (error) {
      return problem(c, error);
    }
  });

  // Steps 2 and 3: claim the grant (once), stream the staged object through sha256 with the size cap, write those
  // exact bytes create-only to the org key, record the triple, and delete the staging object. The staging object is
  // never itself a file, and a write to the staging key after the claim is never read.
  //
  // The slot is taken after the (4 KB) body is read, so a slow body holds none, and before the claim: a completion
  // refused with 503 UPLOAD_BUSY leaves its grant unused, so the client retries the same upload after Retry-After.
  app.post('/api/files/uploads/:id/complete', bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    try {
      if (!direct) throw noDirect();
      const { user, orgId } = await uploader(c);
      const input = (await c.req.json().catch(() => null)) as { filename?: unknown; purpose?: unknown } | null;
      const purpose = uploadPurpose(input?.purpose);
      const filename = typeof input?.filename === 'string' && input.filename.trim() ? input.filename.slice(0, 255) : 'chung-tu';
      const release = completes.tryAcquire(user.userId);
      if (!release) {
        c.header('retry-after', String(UPLOAD_BUSY_RETRY_SECONDS));
        throw new DomainError('UPLOAD_BUSY', 503, 'Máy chủ đang xử lý nhiều tệp; hãy thử lại sau vài giây');
      }
      // A Social upload may be a video of up to 100 MB: it also takes a large slot, before the grant is used.
      const releaseLarge = purpose === 'social' ? large.tryAcquire(user.userId) : () => undefined;
      if (!releaseLarge) {
        release();
        throw busy(c);
      }
      try {
        const claim = await runtime.execute<{ stagingKey: string; maxBytes: number }>(
          'kernel.file.upload.claim',
          { uploadId: c.req.param('id') },
          { actor: actorOf(user), orgId },
        );
        try {
          // A document is read up to 25 MB whatever its grant allowed.
          const staged = await direct.readStaged(claim.stagingKey, Math.min(claim.maxBytes, purpose === 'social' ? MAX_SOCIAL_VIDEO_BYTES : MAX_UPLOAD_BYTES)).catch((error: unknown) => {
            if (error instanceof BlobNotFoundError) throw new DomainError('UPLOAD_MISSING', 409, 'Chưa nhận được tệp cho lượt tải lên này');
            throw error;
          });
          if (staged.bytes.byteLength === 0) throw new DomainError('NO_FILE', 400, 'Tệp rỗng');
          return c.json(await ingest(user, orgId, filename, staged.bytes, staged.sha256, purpose));
        } finally {
          await store.delete(claim.stagingKey).catch((error: unknown) => console.error('[http] staging object not deleted', error));
        }
      } finally {
        releaseLarge();
        release();
      }
    } catch (error) {
      return problem(c, error);
    }
  });

  app.get('/api/files/:id', async (c) => {
    try {
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, c.req.header(ORG_HEADER) ?? null);
      const file = await runtime.query<{ filename: string; content_type: string; storage_key: string; generation: string | null; sha256: string; size_bytes: string }>(
        'kernel.file.get',
        { id: c.req.param('id') },
        { actor: actorOf(user), orgId },
      );
      const ref = { key: file.storage_key, generation: file.generation, sha256: file.sha256 };
      // With S3, a presigned GET of the exact version the row recorded (60 seconds, as an attachment), after the
      // same authorization as a streamed download. A generation that cannot be pinned streams, checked by sha256.
      const presigned = direct ? await direct.presignDownload(ref, { filename: file.filename, contentType: file.content_type }) : null;
      // ?link=1 answers with the URL instead of a redirect, so the app can fetch it without its Authorization and
      // org headers (a redirect would carry the custom header to the bucket and need a CORS preflight there).
      // url null: stream from this endpoint.
      if (c.req.query('link') === '1') {
        c.header('cache-control', 'private, no-store');
        return c.json({ url: presigned });
      }
      if (presigned) {
        return new Response(null, { status: 302, headers: { location: presigned, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
      }
      // A file larger than a document (a Social video) is read whole to check its hash: it takes a large slot.
      let releaseLarge: (() => void) | null = null;
      if (Number(file.size_bytes) > MAX_UPLOAD_BYTES) {
        releaseLarge = large.tryAcquire(user.userId);
        if (!releaseLarge) throw busy(c);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readVerified(store, ref);
      } catch (error) {
        releaseLarge?.();
        throw error;
      }
      // A large body keeps its slot until it is handed to the connection (or the client goes away).
      const payload = releaseLarge ? held(bytes, releaseLarge) : body(bytes);
      return new Response(payload, {
        headers: {
          'content-type': file.content_type,
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
      });
    } catch (error) {
      return problem(c, error);
    }
  });

  // Finance routes exist only when the finance module is installed (CROVE_MODULES); otherwise they are 404 below.
  if (runtime.installed('finance')) {
    app.get('/api/export/journal.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = c.req.header(ORG_HEADER) ?? null;
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT };
        const entries = await runtime.query<JournalEntryView[]>('finance.journal.list', range, {
          actor: actorOf(user),
          orgId,
        });
        if (entries.length >= JOURNAL_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều bút toán để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
        }
        const bytes = await buildJournalWorkbook([...entries].reverse(), orgSlug ?? '');
        // The export's audit row (counts only), for the weekly usage report (issue #311). No row, no download.
        await runtime.execute('finance.journal.export', { from: range.from, to: range.to, entries: entries.length }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="crove-but-toan-${orgSlug}.xlsx"`,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Purchase vouchers in the MISA SME import template (issue #317), same roles, range and audit as the journal
    // export above.
    app.get('/api/export/misa/purchases.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = c.req.header(ORG_HEADER) ?? null;
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT };
        const vouchers = await runtime.query<PurchaseVoucher[]>('finance.vouchers.purchases', range, { actor: actorOf(user), orgId });
        if (vouchers.length >= JOURNAL_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều chứng từ để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
        }
        const bytes = await buildMisaWorkbook(MISA_SME_PURCHASE_SERVICE, vouchers.flatMap(purchaseRows));
        await runtime.execute(
          'finance.journal.export',
          { from: range.from, to: range.to, entries: vouchers.length, format: 'misa_sme_purchases' },
          { actor: actorOf(user), orgId },
        );
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="crove-misa-mua-dich-vu-${orgSlug}.xlsx"`,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Sales vouchers in the MISA SME import template (issue #313), same roles, range and audit as the purchase export.
    app.get('/api/export/misa/sales.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = c.req.header(ORG_HEADER) ?? null;
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT };
        const vouchers = await runtime.query<SalesVoucher[]>('finance.vouchers.sales', range, { actor: actorOf(user), orgId });
        if (vouchers.length >= JOURNAL_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều chứng từ để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
        }
        const bytes = await buildMisaWorkbook(MISA_SME_SALES, vouchers.flatMap(salesRows));
        await runtime.execute(
          'finance.journal.export',
          { from: range.from, to: range.to, entries: vouchers.length, format: 'misa_sme_sales' },
          { actor: actorOf(user), orgId },
        );
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="crove-misa-ban-hang-${orgSlug}.xlsx"`,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // VAT working of one month or quarter (issue #316), ?period=2026-09 or ?period=2026-Q3. The query checks the
    // period (422 otherwise) and the roles, so the file name below only ever holds a valid period.
    app.get('/api/export/vat.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = c.req.header(ORG_HEADER) ?? null;
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const period = c.req.query('period') ?? '';
        const report = await runtime.query<VatReport>('finance.vat.period', { period }, { actor: actorOf(user), orgId });
        const bytes = await buildVatWorkbook(report, orgSlug ?? '');
        // The export's audit row (period and invoice count only). No row, no download.
        const documents = report.input.documents.length + report.output.documents.length;
        await runtime.execute('finance.vat.export', { period: report.period.period, documents }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="crove-gtgt-${report.period.period}-${orgSlug}.xlsx"`,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Ledger reports of one month, quarter or year (issue #321), ?period=2026-09, 2026-Q3 or 2026. The query checks
    // the period (422 otherwise) and the roles, so the file name below only ever holds a valid period.
    app.get('/api/export/ledger.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = c.req.header(ORG_HEADER) ?? null;
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const period = c.req.query('period') ?? '';
        const book = await runtime.query<LedgerBook>('finance.ledger.book', { period }, { actor: actorOf(user), orgId });
        const bytes = await buildLedgerWorkbook(book, orgSlug ?? '');
        // The export's audit row (period and journal line count only). No row, no download.
        await runtime.execute('finance.ledger.export', { period: book.period.period, lines: book.lines }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="crove-so-sach-${book.period.period}-${orgSlug}.xlsx"`,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The org export (issue #38, streamed since #212), owners only: GET /api/org-export/manifest (JSON) or
  // /api/org-export/<table> (NDJSON, one row per line), from the newest export kernel.org.export.get reports. Every key,
  // version and sha256 comes from that export's audit row, never from the request; each blob is read at its recorded
  // version, checked against its sha256 and opened with the export key. A table streams chunk by chunk, so the kernel
  // holds one chunk at a time.
  const sealer = exportSealer(config);
  app.get('/api/org-export/:part', async (c) => {
    try {
      const user = c.get('user');
      const orgSlug = c.req.header(ORG_HEADER) ?? null;
      const orgId = await resolveOrg(runtime, user, orgSlug);
      const view = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: actorOf(user), orgId });
      const part = c.req.param('part');
      const exported = view.export;
      const missing = () => new DomainError('NOT_FOUND', 404, 'Chưa có bản xuất dữ liệu này');
      if (!exported) throw missing();
      if (exported.expired) throw new DomainError('EXPORT_EXPIRED', 404, 'Bản xuất dữ liệu đã hết hạn; hãy yêu cầu xuất lại');
      const read = async (ref: { key: string; generation: string; sha256: string }, aad: Buffer) => {
        // Under this org's export prefix whatever wrote the audit row (kernel.org.export.record checks it too).
        if (!ref.key.startsWith(`export/${orgId}/`)) throw missing();
        return sealer.open(await readVerified(store, ref), aad, exported.encryption);
      };
      const headers = (type: string, extension: string, length: number) => ({
        'content-type': type,
        'content-length': String(length),
        'content-disposition': `attachment; filename="crove-${orgSlug}-${part}.${extension}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      });
      if (part === 'manifest') {
        const ref = { key: exported.manifestKey, generation: exported.manifestGeneration, sha256: exported.manifestSha256 };
        const bytes = await read(ref, exportAad(orgId, 'manifest'));
        return new Response(body(bytes), { headers: headers('application/json; charset=utf-8', 'json', bytes.byteLength) });
      }
      const chunks = exported.parts.filter((p) => p.table === part).sort((a, b) => a.chunk - b.chunk);
      if (chunks.length === 0) throw missing();
      const readChunk = (p: (typeof chunks)[number]) => read(p, exportAad(orgId, { table: p.table, chunk: p.chunk }));
      // The first chunk is read before the response starts, so a missing or altered blob answers with an error status.
      const first = await readChunk(chunks[0] as (typeof chunks)[number]);
      let next = 1;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(first);
          },
          async pull(controller) {
            const chunk = chunks[next++];
            if (!chunk) return controller.close();
            try {
              controller.enqueue(await readChunk(chunk));
            } catch (error) {
              // The status is already sent; the client sees a cut download (content-length tells it so).
              console.error(`[org-export] download of ${part} chunk ${chunk.chunk} failed`, error);
              controller.error(error);
            }
          },
        },
        { highWaterMark: 0 },
      );
      const length = chunks.reduce((n, p) => n + p.bytes, 0);
      return new Response(stream, { headers: headers('application/x-ndjson; charset=utf-8', 'ndjson', length) });
    } catch (error) {
      return problem(c, error);
    }
  });

  app.all('/api/*', (c) => c.json({ code: 'NOT_FOUND' }, 404));

  // The SPA, served on the same origin.
  if (existsSync(config.WEB_DIST)) {
    const root = relative(process.cwd(), config.WEB_DIST) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.use('/favicon.svg', serveStatic({ root }));
    const indexPath = join(config.WEB_DIST, 'index.html');
    const csp = contentSecurityPolicy(publicAuthUrl(config), store.direct ? directTransferOrigin(config) : null);
    let indexHtml: string | null = null;
    app.get('*', async (c) => {
      c.header('content-security-policy', csp);
      indexHtml ??= await readFile(indexPath, 'utf8');
      return c.html(indexHtml);
    });
  } else {
    app.get('/', (c) => c.text('Crove API is running. Build apps/app to serve the web UI from this port.'));
  }
  return app;
}
