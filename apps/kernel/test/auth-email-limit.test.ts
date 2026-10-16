// Per-client email budget in front of Supabase Auth (#190): which proxied requests count, how client addresses map
// to buckets, the configuration guard, and the proxy's answers with an in-memory limiter. The database limiter is
// covered by test/invariant/auth-email-limit.db.test.ts and, end to end through the proxy, auth-email-proxy.db.test.ts.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { clientBucket, emailSendRequest, hashKey, type EmailLimiter, type EmailVerdict } from '../src/auth-email-limit.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const SECRET = 'x'.repeat(32);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('emailSendRequest', () => {
  it('counts the requests that make Supabase Auth send an email, keyed by the recipient', () => {
    const body = json({ email: '  Alice@Example.COM ', password: 'pw' });
    expect(emailSendRequest('POST', '/recover', body, false)).toEqual({ target: 'email:alice@example.com' });
    expect(emailSendRequest('POST', '/otp', body, true)).toEqual({ target: 'email:alice@example.com' });
    expect(emailSendRequest('POST', '/resend', json({ type: 'signup', email: 'a@b.co' }), false)).toEqual({ target: 'email:a@b.co' });
    expect(emailSendRequest('POST', '/otp', json({ phone: '+84 90-123 4567' }), false)).toEqual({ target: 'phone:84901234567' });
    expect(emailSendRequest('PUT', '/user', json({ email: 'new@example.com' }), false)).toEqual({ target: 'email:new@example.com' });
    expect(emailSendRequest('GET', '/reauthenticate', null, false)).toEqual({ target: null });
  });

  it('counts sign-up only while confirmations are on', () => {
    const body = json({ email: 'a@b.co', password: 'pw' });
    expect(emailSendRequest('POST', '/signup', body, false)).toEqual({ target: 'email:a@b.co' });
    expect(emailSendRequest('POST', '/signup', body, true)).toBeNull();
  });

  it('ignores requests that send nothing', () => {
    expect(emailSendRequest('POST', '/token', json({ email: 'a@b.co', password: 'pw' }), false)).toBeNull();
    expect(emailSendRequest('GET', '/user', null, false)).toBeNull();
    expect(emailSendRequest('PUT', '/user', json({ password: 'new-password' }), false)).toBeNull();
    expect(emailSendRequest('POST', '/verify', json({ email: 'a@b.co' }), false)).toBeNull();
    expect(emailSendRequest('GET', '/recover', null, false)).toBeNull();
  });

  // Supabase Auth's Go decoder matches keys ignoring case, so {"EMAIL": ...} sets the email there.
  it('reads keys the way Supabase Auth does: any case, conflicting values with no recipient', () => {
    expect(emailSendRequest('PUT', '/user', json({ Email: 'New@Example.com' }), false)).toEqual({ target: 'email:new@example.com' });
    expect(emailSendRequest('POST', '/recover', json({ EMAIL: 'a@b.co' }), false)).toEqual({ target: 'email:a@b.co' });
    expect(emailSendRequest('POST', '/otp', json({ PHONE: '+84 901' }), false)).toEqual({ target: 'phone:84901' });
    const conflicting = new TextEncoder().encode('{"email":"a@b.co","Email":"b@b.co","email":"c@b.co"}');
    expect(emailSendRequest('PUT', '/user', conflicting, false)).toEqual({ target: null });
    expect(emailSendRequest('POST', '/recover', conflicting, false)).toEqual({ target: null });
    expect(emailSendRequest('POST', '/recover', json({ email: 'A@b.co', EMAIL: 'a@B.co' }), false)).toEqual({ target: 'email:a@b.co' });
    // An email key Supabase Auth would reject still counts; an unparseable update counts with no recipient.
    expect(emailSendRequest('PUT', '/user', json({ eMaIl: 42 }), false)).toEqual({ target: null });
    expect(emailSendRequest('PUT', '/user', new TextEncoder().encode('{"email":'), false)).toEqual({ target: null });
  });

  it('does not count an anonymous sign-up, which sends nothing', () => {
    expect(emailSendRequest('POST', '/signup', json({ data: {} }), false)).toBeNull();
    expect(emailSendRequest('POST', '/signup', json({ phone: '+84901', password: 'pw' }), false)).toEqual({ target: 'phone:84901' });
  });

  it('still counts per client when the body has no recipient or is not JSON', () => {
    expect(emailSendRequest('POST', '/recover', new TextEncoder().encode('not json'), false)).toEqual({ target: null });
    expect(emailSendRequest('POST', '/recover', json(['a@b.co']), false)).toEqual({ target: null });
    expect(emailSendRequest('POST', '/recover', null, false)).toEqual({ target: null });
    expect(emailSendRequest('POST', '/recover', json({ email: 42 }), false)).toEqual({ target: null });
  });
});

describe('clientBucket', () => {
  it('keys IPv4 by address and IPv6 by its /64', () => {
    expect(clientBucket('203.0.113.9')).toBe('v4:203.0.113.9');
    expect(clientBucket('2001:db8:1:2:aaaa::1')).toBe('v6:2001:db8:1:2::/64');
    expect(clientBucket('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('v6:2001:db8:1:2::/64');
    expect(clientBucket('2001:0DB8:0001:0002::')).toBe('v6:2001:db8:1:2::/64');
    expect(clientBucket('2001:db8::1')).toBe('v6:2001:db8:0:0::/64');
    expect(clientBucket('::1')).toBe('v6:0:0:0:0::/64');
    expect(clientBucket('fe80::1%eth0')).toBe('v6:fe80:0:0:0::/64');
    expect(clientBucket('64:ff9b::192.0.2.1')).toBe('v6:64:ff9b:0:0::/64');
  });

  it('maps IPv4-mapped IPv6 (a dual-stack socket) to the IPv4 address', () => {
    expect(clientBucket('::ffff:127.0.0.1')).toBe('v4:127.0.0.1');
    expect(clientBucket('::ffff:7f00:1')).toBe('v4:127.0.0.1');
  });

  it('puts anything that is not an address in one shared bucket', () => {
    expect(clientBucket(null)).toBe('unknown');
    expect(clientBucket('')).toBe('unknown');
    expect(clientBucket('not-an-ip')).toBe('unknown');
    expect(clientBucket('1.2.3.4, 5.6.7.8')).toBe('unknown');
  });

  it('hashes keys to 64 hex characters', () => {
    expect(hashKey('v4:203.0.113.9')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey('a')).not.toBe(hashKey('b'));
  });
});

describe('email budget configuration', () => {
  const publicUrl = {
    DATABASE_URL: 'postgres://localhost/x',
    AUTH_JWT_SECRET: SECRET,
    AUTH_ISSUER: 'crove-auth',
    PUBLIC_URL: 'https://books.example.com',
    AUTH_UPSTREAM_URL: 'http://auth:9999',
  };

  it('defaults to 5 per client per hour and one per recipient a minute', () => {
    const config = loadConfig(publicUrl);
    expect(config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR).toBe(5);
    expect(config.AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS).toBe(60);
    expect(config.AUTH_RATE_LIMIT_EMAIL_SENT).toBeUndefined();
  });

  it('refuses a public deployment where fewer than 10 client addresses use up the budget', () => {
    expect(loadConfig({ ...publicUrl, AUTH_RATE_LIMIT_EMAIL_SENT: '100' }).AUTH_RATE_LIMIT_EMAIL_SENT).toBe(100);
    expect(() => loadConfig({ ...publicUrl, AUTH_RATE_LIMIT_EMAIL_SENT: '30' })).toThrow(/AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR=5 lets 6 client addresses.*at most 3/);
    expect(loadConfig({ ...publicUrl, AUTH_RATE_LIMIT_EMAIL_SENT: '30', AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: '3' }).AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR).toBe(3);
    // Localhost (tests, local runs) and deployments without the bundled Supabase Auth are not checked.
    expect(() => loadConfig({ ...publicUrl, PUBLIC_URL: 'http://localhost:8080', AUTH_RATE_LIMIT_EMAIL_SENT: '30' })).not.toThrow();
  });

  it('refuses malformed limits', () => {
    expect(() => loadConfig({ ...publicUrl, AUTH_RATE_LIMIT_EMAIL_SENT: 'many' })).toThrow(/AUTH_RATE_LIMIT_EMAIL_SENT/);
    expect(() => loadConfig({ ...publicUrl, AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: '0' })).toThrow(/AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR/);
    expect(() => loadConfig({ ...publicUrl, AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS: '7200' })).toThrow(/AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS/);
  });
});

// Counts per client bucket only; the database limiter adds the recipient interval and the lock.
class MemoryLimiter implements EmailLimiter {
  reserved = new Map<string, string>();
  calls: Array<{ client: string; target: string | null }> = [];
  released: string[] = [];
  fail = false;
  private next = 0;
  private readonly perClient: number;
  constructor(perClient: number) {
    this.perClient = perClient;
  }

  async reserve(request: { client: string; target: string | null }): Promise<EmailVerdict> {
    this.calls.push(request);
    if (this.fail) throw new Error('database down');
    const used = [...this.reserved.values()].filter((c) => c === request.client).length;
    if (used >= this.perClient) return { allowed: false, rule: 'auth_email_per_client', retryAfterSeconds: 1234 };
    const id = String(++this.next);
    this.reserved.set(id, request.client);
    return { allowed: true, reservation: id };
  }

  async release(reservation: string, client: string): Promise<void> {
    if (this.reserved.get(reservation) === client) this.reserved.delete(reservation);
    this.released.push(reservation);
  }
}

describe('auth proxy email budget', () => {
  let upstream: Server;
  let forwarded: string[] = [];
  let upstreamStatus = 200;
  let port = 0;
  let limiter: MemoryLimiter;

  const appWith = (env: Record<string, string> = {}) =>
    createHttpApp({
      config: loadConfig({
        DATABASE_URL: 'postgres://localhost/x',
        AUTH_JWT_SECRET: SECRET,
        AUTH_ISSUER: 'crove-auth',
        AUTH_UPSTREAM_URL: `http://127.0.0.1:${port}`,
        WEB_DIST: '/nonexistent',
        ...env,
      }),
      runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
      emailLimiter: limiter,
    });

  const send = (app: ReturnType<typeof appWith>, path: string, body: unknown, socket: string, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`http://localhost/auth/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      { incoming: { socket: { remoteAddress: socket } } },
    );

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      forwarded.push(req.url ?? '');
      res.statusCode = upstreamStatus;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    port = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    forwarded = [];
    upstreamStatus = 200;
    limiter = new MemoryLimiter(2);
  });

  it('refuses a client over its budget with 429 in Supabase Auth shape, without forwarding', async () => {
    const app = appWith();
    for (const n of [1, 2]) expect((await send(app, '/recover', { email: `u${n}@example.com` }, '198.51.100.1')).status).toBe(200);
    const refused = await send(app, '/recover', { email: 'u3@example.com' }, '198.51.100.1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1234');
    expect(await refused.json()).toMatchObject({ code: 429, error_code: 'over_email_send_rate_limit' });
    expect(forwarded).toEqual(['/recover', '/recover']);
    // Another client address still gets through.
    expect((await send(app, '/recover', { email: 'u3@example.com' }, '198.51.100.2')).status).toBe(200);
    expect(limiter.calls.map((c) => c.client)).toEqual(['v4:198.51.100.1', 'v4:198.51.100.1', 'v4:198.51.100.1', 'v4:198.51.100.2']);
    expect(limiter.calls[0]?.target).toBe('email:u1@example.com');
  });

  it('ignores client-supplied forwarding headers unless proxies are trusted', async () => {
    const app = appWith();
    for (const n of [1, 2, 3]) await send(app, '/recover', { email: 'v@example.com' }, '198.51.100.7', { 'x-forwarded-for': `10.0.0.${n}`, 'x-real-ip': `10.0.1.${n}` });
    expect(new Set(limiter.calls.map((c) => c.client))).toEqual(new Set(['v4:198.51.100.7']));
    // One trusted proxy: the entry it appended is the client.
    limiter = new MemoryLimiter(2);
    const proxied = appWith({ TRUSTED_PROXY_HOPS: '1' });
    await send(proxied, '/recover', { email: 'v@example.com' }, '10.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.50' });
    expect(limiter.calls[0]?.client).toBe('v4:203.0.113.50');
  });

  it('gives the slot back when Supabase Auth refuses the request', async () => {
    const app = appWith();
    upstreamStatus = 422;
    expect((await send(app, '/signup', { email: 'bad', password: 'pw' }, '198.51.100.3')).status).toBe(422);
    expect(limiter.released).toEqual(['1']);
    upstreamStatus = 200;
    for (const n of [1, 2]) expect((await send(app, '/signup', { email: `s${n}@example.com`, password: 'pw' }, '198.51.100.3')).status).toBe(200);
    expect(limiter.released).toEqual(['1']);
  });

  it('keeps the slot when Supabase Auth does not answer (it may still have sent the email)', async () => {
    const app = createHttpApp({
      config: loadConfig({
        DATABASE_URL: 'postgres://localhost/x',
        AUTH_JWT_SECRET: SECRET,
        AUTH_ISSUER: 'crove-auth',
        // Nothing listens on port 1.
        AUTH_UPSTREAM_URL: 'http://127.0.0.1:1',
        WEB_DIST: '/nonexistent',
      }),
      runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
      emailLimiter: limiter,
    });
    expect((await send(app, '/recover', { email: 'k@example.com' }, '198.51.100.6')).status).toBe(503);
    expect(limiter.released).toEqual([]);
    expect(limiter.reserved.size).toBe(1);
  });

  it('answers 503 when the limiter cannot decide, and leaves other paths alone', async () => {
    const app = appWith();
    limiter.fail = true;
    const response = await send(app, '/otp', { email: 'o@example.com' }, '198.51.100.4');
    expect(response.status).toBe(503);
    expect(forwarded).toEqual([]);
    expect((await send(app, '/token?grant_type=password', { email: 'o@example.com', password: 'pw' }, '198.51.100.4')).status).toBe(200);
    expect(limiter.calls).toHaveLength(1);
  });

  it('does not count sign-ups while confirmations are off', async () => {
    const app = appWith({ AUTH_AUTOCONFIRM: 'true' });
    for (const n of [1, 2, 3]) expect((await send(app, '/signup', { email: `a${n}@example.com`, password: 'pw' }, '198.51.100.5')).status).toBe(200);
    expect(limiter.calls).toEqual([]);
  });
});
