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
import { DomainError, fileKey, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { buildJournalWorkbook, type JournalEntryView } from '@crove/mod-finance';
import type { Authenticate, AuthUser } from './auth.ts';
import { publicAuthUrl, type Config } from './config.ts';
import { MAX_EMAIL_BYTES, handleInboundEmail, secretMatches } from './inbound.ts';
import { createRpcHandler, resolveOrg } from './rpc.ts';

export interface HttpDeps {
  config: Config;
  runtime: Runtime;
  store: BlobStore;
  authenticate: Authenticate;
  pool: pg.Pool;
  aiEnabled: boolean;
}

function problem(c: Context, error: unknown) {
  const domain = error instanceof DomainError ? error : new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
  if (domain.status === 500) console.error('[http]', error);
  return c.json({ code: domain.code, message: domain.message }, domain.status);
}

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

export function createHttpApp(deps: HttpDeps) {
  const { config, runtime, store, authenticate } = deps;
  const app = new Hono<{ Variables: { user: AuthUser } }>();
  const rpc = createRpcHandler(runtime);

  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const client = await deps.pool.connect().catch(() => null);
    if (!client) return c.json({ ready: false, reason: 'database' }, 503);
    try {
      const missing = await schemaMissing(client, config.MIGRATIONS_DIR);
      return missing.length === 0 ? c.json({ ready: true }) : c.json({ ready: false, missing }, 503);
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
    }),
  );

  // Self-hosted Supabase Auth behind the same origin.
  if (config.AUTH_UPSTREAM_URL) {
    const upstream = config.AUTH_UPSTREAM_URL.replace(/\/$/, '');
    app.all('/auth/v1/*', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
      const url = new URL(c.req.url);
      const target = `${upstream}${url.pathname.replace(/^\/auth\/v1/, '')}${url.search}`;
      const headers = new Headers();
      c.req.raw.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
      });
      const method = c.req.method;
      const response = await fetch(target, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? null : await c.req.arrayBuffer(),
        redirect: 'manual',
      });
      const out = new Headers();
      response.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'content-encoding') out.set(key, value);
      });
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
        const result = await handleInboundEmail({ runtime, store, domain }, raw, c.req.header('x-crove-recipient') ?? null);
        return c.json(result);
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

  app.all('/api/rpc/*', async (c) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: '/api/rpc',
      context: { user: c.get('user'), orgSlug: c.req.header(ORG_HEADER) ?? null },
    });
    return matched ? response : c.json({ code: 'NOT_FOUND' }, 404);
  });

  app.post('/api/files', bodyLimit({ maxSize: MAX_UPLOAD_BYTES * 10 + 1024 * 1024 }), async (c) => {
    try {
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, c.req.header(ORG_HEADER) ?? null);
      const body = await c.req.parseBody({ all: true });
      const files = ([] as unknown[]).concat(body.file ?? []).filter((f): f is File => f instanceof File).slice(0, 10);
      if (files.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp');
      const results = [];
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) throw new DomainError('TOO_LARGE', 413, `${file.name} vượt quá 25 MB`);
        const lower = file.name.toLowerCase();
        const type = ACCEPTED_UPLOAD_TYPES.includes(file.type)
          ? file.type
          : lower.endsWith('.xml')
            ? 'application/xml'
            : lower.endsWith('.pdf')
              ? 'application/pdf'
              : null;
        if (!type) throw new DomainError('UNSUPPORTED_TYPE', 415, `${file.name}: chỉ nhận XML, PDF, JPG, PNG, WEBP`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sha256 = sha256Hex(bytes);
        const storageKey = fileKey(orgId, sha256);
        await store.put(storageKey, bytes, type);
        results.push(
          await runtime.execute<{ fileId: string; duplicate: boolean }>(
            'kernel.file.ingest',
            { filename: file.name.slice(0, 255), contentType: type, sizeBytes: bytes.byteLength, sha256, storageKey, source: 'upload' },
            { actor: { type: 'user', userId: user.userId }, orgId },
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
        { actor: { type: 'user', userId: user.userId }, orgId },
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
      const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined };
      const entries = await runtime.query<JournalEntryView[]>('finance.journal.list', range, {
        actor: { type: 'user', userId: user.userId },
        orgId,
      });
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
    app.get('*', async (c) => c.html(await readFile(indexPath, 'utf8')));
  } else {
    app.get('/', (c) => c.text('Crove API is running. Build apps/app to serve the web UI from this port.'));
  }
  return app;
}
