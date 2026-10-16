// The email budget end to end through the kernel's /auth/v1 proxy (#190), on a real PostgreSQL 17, in front of a
// fake Supabase Auth that, like the real one, sends every email from one deployment-wide bucket. One client address
// signing up with many new addresses gets its own cap and leaves the bucket for everyone else. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// Supabase Auth's GOTRUE_RATE_LIMIT_EMAIL_SENT in the fake, and the kernel's per-client cap (10 x 2 <= 20).
const BUDGET = 20;
const PER_CLIENT = 2;

const suite = ADMIN ? describe : describe.skip;

suite('email budget through the /auth/v1 proxy (#190)', () => {
  const dbName = `crove_test_authemail_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool;
  let upstream: Server;
  let app: ReturnType<typeof createHttpApp>;
  // Emails the fake sent, by recipient.
  const sent: string[] = [];

  // Sign-up, recovery and OTP: 422 for a malformed address (nothing sent), 429 once the deployment budget is used.
  function fakeSupabaseAuth(body: string): { status: number; body: unknown } {
    const email = (JSON.parse(body) as { email?: string }).email ?? '';
    if (!email.includes('@')) return { status: 422, body: { code: 422, error_code: 'validation_failed' } };
    if (sent.length >= BUDGET) return { status: 429, body: { code: 429, error_code: 'over_email_send_rate_limit' } };
    sent.push(email);
    return { status: 200, body: {} };
  }

  const post = (path: string, body: unknown, client: string) =>
    app.fetch(
      new Request(`http://localhost/auth/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      { incoming: { socket: { remoteAddress: client } } },
    );

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    const adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });

    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const answer = fakeSupabaseAuth(raw || '{}');
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address() as AddressInfo;
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: 'x'.repeat(32),
      AUTH_ISSUER: 'crove-auth',
      AUTH_UPSTREAM_URL: `http://127.0.0.1:${port}`,
      AUTH_AUTOCONFIRM: 'false',
      AUTH_RATE_LIMIT_EMAIL_SENT: String(BUDGET),
      AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: String(PER_CLIENT),
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({
      config,
      runtime: {} as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool,
      aiEnabled: false,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    await pool?.end().catch(() => {});
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('caps one client signing up many new addresses, and another client still gets its confirmation email', async () => {
    const statuses: number[] = [];
    for (let n = 0; n < 30; n++) statuses.push((await post('/signup', { email: `spam${n}@example.com`, password: 'pw-123456' }, '198.51.100.10')).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(PER_CLIENT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30 - PER_CLIENT);
    expect(sent).toHaveLength(PER_CLIENT);

    const refused = await post('/recover', { email: 'spam0@example.com' }, '198.51.100.10');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(3500);
    expect(await refused.json()).toMatchObject({ code: 429, error_code: 'over_email_send_rate_limit' });

    // Client B: sign-up confirmation and password recovery both go out.
    expect((await post('/signup', { email: 'alice@example.com', password: 'pw-123456' }, '203.0.113.20')).status).toBe(200);
    expect((await post('/recover', { email: 'bob@example.com' }, '203.0.113.20')).status).toBe(200);
    expect(sent.slice(-2)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('counts a whole IPv6 /64 as one client, and a different /64 separately', async () => {
    const statuses: number[] = [];
    for (let n = 1; n <= 4; n++) statuses.push((await post('/otp', { email: `v6-${n}@example.com` }, `2001:db8:aa:1::${n}`)).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect((await post('/otp', { email: 'v6-5@example.com' }, '2001:db8:aa:2::1')).status).toBe(200);
  });

  it('allows one email per recipient a minute, whichever client asks', async () => {
    expect((await post('/recover', { email: 'carol@example.com' }, '203.0.113.30')).status).toBe(200);
    expect((await post('/recover', { email: 'Carol@Example.com' }, '203.0.113.31')).status).toBe(429);
  });

  it('gives the slot back when Supabase Auth sends nothing', async () => {
    for (let n = 0; n < 5; n++) expect((await post('/signup', { email: 'not-an-email', password: 'pw-123456' }, '203.0.113.40')).status).toBe(422);
    expect((await post('/signup', { email: 'dave@example.com', password: 'pw-123456' }, '203.0.113.40')).status).toBe(200);
  });

  // The control: the fake reproduces the issue when the proxy does not cap clients.
  it('without the per-client cap, one client uses up the budget and blocks everyone', async () => {
    sent.length = 0;
    const uncapped = createHttpApp({
      config: loadConfig({
        DATABASE_URL: 'postgres://localhost/x',
        AUTH_JWT_SECRET: 'x'.repeat(32),
        AUTH_ISSUER: 'crove-auth',
        AUTH_UPSTREAM_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        AUTH_AUTOCONFIRM: 'false',
        WEB_DIST: '/nonexistent',
      }),
      runtime: {} as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool,
      aiEnabled: false,
      emailLimiter: { reserve: async () => ({ allowed: true, reservation: '0' }), release: async () => {} },
    });
    const send = (email: string, client: string) =>
      uncapped.fetch(
        new Request('http://localhost/auth/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'pw-123456' }) }),
        { incoming: { socket: { remoteAddress: client } } },
      );
    for (let n = 0; n < BUDGET; n++) expect((await send(`flood${n}@example.com`, '198.51.100.99')).status).toBe(200);
    const victim = await send('erin@example.com', '203.0.113.50');
    expect(victim.status).toBe(429);
    expect(await victim.json()).toMatchObject({ error_code: 'over_email_send_rate_limit' });
  });
});
