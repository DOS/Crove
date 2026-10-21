// Invariant suite (Decision 7): route enumeration (ADR-0028, "Acceptance tests"; External-tenant gate T1; issue #693).
// Every route the HTTP app registers goes through authenticate(), the token and session check, unless it is on the
// public list below with its reason. The test builds the app with every optional part on (every module, the status
// page, the bundled Supabase Auth proxy, inbound email, provider mail webhooks, the event stream and the SPA), reads
// Hono's route table and sends each route a request without a token: a route off the list must answer 401 and must
// have called authenticate(). So a new export or download route that skips the check fails here, whatever its path.
// Keep this directory self-contained: no imports from outside test/invariant/ besides the app's own source.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { DomainError, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp, type HttpDeps } from '../../src/http.ts';

// Routes anyone may reach without a token, by Hono path pattern, each with its reason. A route listed here must
// exist (the list cannot go stale), and nothing else may skip authenticate().
const PUBLIC: Record<string, string> = {
  '/healthz': 'liveness probe: says only that the process serves',
  '/readyz': 'readiness probe: schema and Supabase Auth grants, no tenant data',
  '/version': 'the build id and the migrations missing from the ledger (#892); no tenant data',
  '/api/config': 'what the SPA needs before sign-in (auth URL, public links); no tenant data',
  '/status': 'the public status page (#678): one line per service, nothing about an org',
  '/auth/v1/*': 'the proxy to Supabase Auth, where sign-up and sign-in happen; it applies its own per-client limits',
  '/webhooks/mail/:provider': "the mail provider's delivery events, checked by the provider's signature",
  '/api/inbound/email': 'the inbound mail relay, checked by INBOUND_SECRET (constant-time)',
  '/api/stream': 'the event stream, opened with a one-time ticket that POST /api/stream/tickets issues after the session check',
  '/api/review/view': "Social's client review page (#589): a signed, expiring review link is the credential",
  '/api/review/media': 'the same review link, for the media of the post under review',
  '/api/review/file': 'the same review link, for one file of the post under review',
  '/api/review/answer': "the reviewer's answer, through the same review link",
  '/api/report/view': "Social's client report link (#643): a signed, expiring report link is the credential",
  '/cal/:file': 'the posting calendar feed (#862): an unguessable feed token in the file name is the credential',
  '/l/:code': 'short link redirects (#706): public by design, they only redirect to the stored target',
  '/b/:slug': 'link-in-bio pages (#707): public by design',
  '/b/:slug/go/:target': 'a link-in-bio link: public by design, redirects to the stored target',
  '/b/:slug/img/:file': 'a link-in-bio image: public by design',
  '/assets/*': "the SPA's static files",
  '/favicon.svg': "the SPA's icon",
  '/*': 'the SPA shell (index.html) and the security headers on every response; no data',
};

const WEB_DIST = mkdtempSync(join(tmpdir(), 'crove-route-coverage-'));
writeFileSync(join(WEB_DIST, 'index.html'), '<!doctype html><title>Crove</title>');

function app(authenticate: HttpDeps['authenticate']) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/x',
    AUTH_JWT_SECRET: 'x'.repeat(32),
    AUTH_ISSUER: 'crove-auth',
    AUTH_UPSTREAM_URL: 'http://127.0.0.1:9',
    INBOUND_DOMAIN: 'inbound.example.com',
    INBOUND_SECRET: 'y'.repeat(32),
    STATUS_FILE: join(WEB_DIST, 'status.json'),
    WEB_DIST,
  });
  const runtime = { installed: () => true, modules: () => ['kernel', 'finance', 'social'] } as unknown as Runtime;
  const unused = {} as never;
  return createHttpApp({
    config,
    runtime,
    store: {} as BlobStore,
    authenticate,
    pool: {} as pg.Pool,
    aiEnabled: false,
    mailer: { name: 'test', enabled: true, sendRetrySafety: 'unsafe', send: unused, parseWebhook: () => [] } as unknown as NonNullable<HttpDeps['mailer']>,
    stream: { hub: { ready: false }, tickets: unused, slots: unused, recheckSeconds: 30 } as unknown as NonNullable<HttpDeps['stream']>,
  });
}

// What the probe needs of an app: its route table and a way to send it a request.
type App = Pick<Hono, 'routes' | 'request'>;

// One request per registered method and path: Hono lists each handler and middleware of a route, so duplicates fold.
function routesOf(target: App): Array<{ method: string; path: string }> {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of target.routes) seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
  return [...seen.values()];
}

// A concrete URL for a path pattern: each parameter and wildcard becomes a harmless value.
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, 'x').replace(/\*$/, 'x').replace(/^x$/, '/x');

// The routes that answered a request without a token without calling authenticate() and without a 401.
async function unprotected(target: App, calls: { count: number }): Promise<string[]> {
  const open: string[] = [];
  for (const { method, path } of routesOf(target)) {
    if (Object.hasOwn(PUBLIC, path)) continue;
    calls.count = 0;
    const verb = method === 'ALL' ? (path.startsWith('/api/rpc') ? 'POST' : 'GET') : method;
    const init: RequestInit = verb === 'GET' ? { method: verb } : { method: verb, headers: { 'content-type': 'application/json' }, body: '{}' };
    const response = await target.request(concrete(path), init);
    if (response.status !== 401 || calls.count === 0) open.push(`${method} ${path} (${response.status}, authenticate called ${calls.count} times)`);
  }
  return open;
}

function refusingAuthenticate(calls: { count: number }): HttpDeps['authenticate'] {
  return async () => {
    calls.count += 1;
    throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
  };
}

describe('route enumeration (ADR-0028, gate T1)', () => {
  it('sends every non-public route through authenticate(), and refuses it without a token', async () => {
    const calls = { count: 0 };
    const target = app(refusingAuthenticate(calls));
    // The app is built with every optional part on, so the table holds the export and download routes.
    const paths = routesOf(target).map((r) => r.path);
    for (const path of ['/api/rpc/*', '/api/files/:id', '/api/export/journal.xlsx', '/api/export/vat-01gtgt.xml', '/api/org-export/:part']) {
      expect(paths, path).toContain(path);
    }
    // Most of the table is behind the check: a probe that reached none of it would prove nothing.
    expect(routesOf(target).filter((r) => !Object.hasOwn(PUBLIC, r.path)).length).toBeGreaterThan(15);
    expect(await unprotected(target, calls)).toEqual([]);
  });

  it('lists only routes that exist, so the public list cannot grow stale', () => {
    const paths = new Set(routesOf(app(refusingAuthenticate({ count: 0 }))).map((r) => r.path));
    expect(Object.keys(PUBLIC).filter((path) => !paths.has(path))).toEqual([]);
  });

  it('catches a download route registered ahead of the check', async () => {
    // The mistake this test exists for: a route registered before app.use('/api/*', ...) runs without it, whatever its
    // path, as the public review routes do on purpose. Built the way createHttpApp builds its routes.
    const calls = { count: 0 };
    const authenticate = refusingAuthenticate(calls);
    const leaky = new Hono();
    leaky.get('/healthz', (c) => c.json({ ok: true }));
    leaky.get('/api/export/leak.xlsx', (c) => c.body('the books'));
    leaky.use('/api/*', async (c, next) => {
      try {
        await authenticate(c.req.header('authorization'));
      } catch {
        return c.json({ code: 'UNAUTHENTICATED' }, 401);
      }
      await next();
    });
    leaky.get('/api/export/journal.xlsx', (c) => c.body('checked'));
    expect(await unprotected(leaky, calls)).toEqual(['GET /api/export/leak.xlsx (200, authenticate called 0 times)']);
  });
});
