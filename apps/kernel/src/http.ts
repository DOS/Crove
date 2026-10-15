import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type pg from 'pg';
import { schemaMissing } from '@crove/db/migrate';
import { ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, ORG_HEADER } from '@crove/kernel-contract';
import { BlobConflictError, BlobNotFoundError, DomainError, fileKey, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { JOURNAL_EXPORT_LIMIT, buildJournalWorkbook, type JournalEntryView } from '@crove/mod-finance';
import { actorOf, type Authenticate, type AuthUser } from './auth.ts';
import { publicAuthUrl, type Config } from './config.ts';
import { MAX_EMAIL_BYTES, acceptInboundEmail, secretMatches } from './inbound.ts';
import type { SendInviteMail } from './invite-mail.ts';
import { createRpcHandler, resolveMembership, resolveOrg } from './rpc.ts';
import { safeFilename, sniffType } from './sniff.ts';

export interface HttpDeps {
  config: Config;
  runtime: Runtime;
  store: BlobStore;
  authenticate: Authenticate;
  pool: pg.Pool;
  aiEnabled: boolean;
  // Invite mail (issue #129). Unset: off, and the inviter passes the one-time link on.
  sendInviteMail?: SendInviteMail;
}

// Store errors that are not server faults. A blob missing behind a file row, or a key holding other bytes, is
// still logged: either one means storage and database disagree. Other store errors (access, I/O) stay 500.
function storeProblem(error: unknown): DomainError | null {
  if (error instanceof BlobNotFoundError) return new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
  if (error instanceof BlobConflictError) return new DomainError('CONFLICT', 409, 'Tệp đã tồn tại với nội dung khác');
  return null;
}

function problem(c: Context, error: unknown) {
  const store = storeProblem(error);
  const domain = error instanceof DomainError ? error : (store ?? new DomainError('INTERNAL', 500, 'Lỗi hệ thống'));
  if (domain.status === 500 || store) console.error('[http]', error);
  return c.json({ code: domain.code, message: domain.message }, domain.status);
}

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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
const UPLOAD_BODY_LIMIT = 60 * 1024 * 1024;
function contentSecurityPolicy(authUrl: string): string {
  // Hosted Supabase Auth lives on another origin; the bundled one is proxied under /auth/v1.
  const authOrigin = new URL(authUrl, 'http://localhost').origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src 'self' ${authOrigin}`,
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
  const rpc = createRpcHandler(runtime, deps.sendInviteMail);

  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const client = await deps.pool.connect().catch(() => null);
    if (!client) return c.json({ ready: false, reason: 'database' }, 503);
    try {
      const missing = await schemaMissing(client, config.MIGRATIONS_DIR);
      if (missing.length > 0) return c.json({ ready: false, reason: 'schema' }, 503);
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
      inboundEnabled: Boolean(config.INBOUND_DOMAIN && config.INBOUND_SECRET),
      mailEnabled: Boolean(config.SMTP_HOST && deps.sendInviteMail),
    }),
  );

  // Self-hosted Supabase Auth behind the same origin.
  if (config.AUTH_UPSTREAM_URL) {
    const upstream = config.AUTH_UPSTREAM_URL.replace(/\/$/, '');
    app.all('/auth/v1/*', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
      const url = new URL(c.req.url);
      const path = url.pathname.replace(/^\/auth\/v1/, '');
      if (!AUTH_PUBLIC_PATHS.test(path)) return c.json({ code: 'NOT_FOUND' }, 404);
      const headers = forwardable(c.req.raw.headers, SPOOFABLE);
      const ip = clientIp(c, config.TRUSTED_PROXY_HOPS);
      if (ip) headers.set('x-real-ip', ip);
      const method = c.req.method;
      const response = await fetch(`${upstream}${path}${url.search}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? null : await c.req.arrayBuffer(),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
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

  // Everything below requires a signed-in user.
  app.use('/api/*', async (c, next) => {
    try {
      c.set('user', await authenticate(c.req.header('authorization')));
    } catch (error) {
      return problem(c, error);
    }
    await next();
  });

  app.all('/api/rpc/*', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: '/api/rpc',
      context: { user: c.get('user'), orgSlug: c.req.header(ORG_HEADER) ?? null },
    });
    return matched ? response : c.json({ code: 'NOT_FOUND' }, 404);
  });

  app.post('/api/files', bodyLimit({ maxSize: UPLOAD_BODY_LIMIT }), async (c) => {
    try {
      const user = c.get('user');
      const membership = await resolveMembership(runtime, user, c.req.header(ORG_HEADER) ?? null);
      if (membership.role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không tải được chứng từ');
      const orgId = membership.orgId;
      const body = await c.req.parseBody({ all: true });
      const files = ([] as unknown[]).concat(body.file ?? []).filter((f): f is File => f instanceof File);
      if (files.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp');
      if (files.length > MAX_FILES_PER_UPLOAD) throw new DomainError('TOO_MANY_FILES', 413, `Tối đa ${MAX_FILES_PER_UPLOAD} tệp mỗi lần`);
      const results = [];
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) throw new DomainError('TOO_LARGE', 413, `${file.name} vượt quá 25 MB`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        // The content decides the type; the browser's MIME type and the extension are only hints.
        const type = sniffType(bytes);
        if (!type || !ACCEPTED_UPLOAD_TYPES.includes(type)) {
          throw new DomainError('UNSUPPORTED_TYPE', 415, `${file.name}: chỉ nhận XML, PDF, JPG, PNG, WEBP`);
        }
        const sha256 = sha256Hex(bytes);
        const storageKey = fileKey(orgId, sha256);
        await store.put(storageKey, bytes, type);
        results.push(
          await runtime.execute<{ fileId: string; duplicate: boolean }>(
            'kernel.file.ingest',
            { filename: safeFilename(file.name, type), contentType: type, sizeBytes: bytes.byteLength, sha256, storageKey, source: 'upload' },
            { actor: actorOf(user), orgId },
          ),
        );
      }
      return c.json({ files: results });
    } catch (error) {
      return problem(c, error);
    }
  });

  app.get('/api/files/:id', async (c) => {
    try {
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, c.req.header(ORG_HEADER) ?? null);
      const file = await runtime.query<{ filename: string; content_type: string; storage_key: string }>(
        'kernel.file.get',
        { id: c.req.param('id') },
        { actor: actorOf(user), orgId },
      );
      const bytes = await store.get(file.storage_key);
      return new Response(body(bytes), {
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

  app.all('/api/*', (c) => c.json({ code: 'NOT_FOUND' }, 404));

  // The SPA, served on the same origin.
  if (existsSync(config.WEB_DIST)) {
    const root = relative(process.cwd(), config.WEB_DIST) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.use('/favicon.svg', serveStatic({ root }));
    const indexPath = join(config.WEB_DIST, 'index.html');
    const csp = contentSecurityPolicy(publicAuthUrl(config));
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
