// Limits on guessing passwords and codes through the /auth/v1 proxy (#221): which requests count and under which
// account, the token buckets, the guarantee that one address cannot lock an account out, the configuration guard,
// and the proxy's answers in front of a fake Supabase Auth.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import type { EmailLimiter } from '../src/auth-email-limit.ts';
import { TokenBuckets, createGuessLimiter, guessRequest, type Guess, type GuessLimiter } from '../src/auth-guess-limit.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const SECRET = 'x'.repeat(32);
const MINUTE = 60_000;
const text = (value: string) => new TextEncoder().encode(value);
const json = (value: unknown) => text(JSON.stringify(value));
const query = (search: string) => new URLSearchParams(search);
const LIMITS = { perClient: 30, perAccountClient: 10, perAccount: 50 };

describe('guessRequest', () => {
  const signIn = json({ email: '  Alice@Example.COM ', password: 'guess' });

  it('counts password sign-in, keyed by the email or phone in the body', () => {
    expect(guessRequest('POST', '/token', query('grant_type=password'), 'application/json', signIn)).toEqual({ kind: 'password', account: 'email:alice@example.com' });
    expect(guessRequest('POST', '/token', query('grant_type=password'), null, json({ phone: '+84 90-123 4567', password: 'x' }))).toEqual({
      kind: 'password',
      account: 'phone:84901234567',
    });
    // Keys in any case, as Supabase Auth's Go decoder reads them; conflicting or unreadable ones share one bucket.
    expect(guessRequest('POST', '/token', query('grant_type=password'), null, json({ EMAIL: 'a@b.co', password: 'x' }))?.account).toBe('email:a@b.co');
    expect(guessRequest('POST', '/token', query('grant_type=password'), null, text('{"email":"a@b.co","Email":"c@b.co"}'))?.account).toBeNull();
    expect(guessRequest('POST', '/token', query('grant_type=password'), null, text('not json'))).toEqual({ kind: 'password', account: null });
    expect(guessRequest('POST', '/token', query('grant_type=password'), null, null)).toEqual({ kind: 'password', account: null });
  });

  it('leaves refresh, PKCE and ID token grants alone, and counts every other grant', () => {
    for (const grant of ['refresh_token', 'pkce', 'id_token']) {
      expect(guessRequest('POST', '/token', query(`grant_type=${grant}`), 'application/json', json({ refresh_token: 'r' }))).toBeNull();
    }
    for (const search of ['', 'grant_type=web3', 'grant_type=PKCE', 'grant_type=refresh_token;grant_type=password']) {
      expect(guessRequest('POST', '/token', query(search), 'application/json', signIn)?.kind).toBe('password');
    }
  });

  // Supabase Auth reads the grant with Go's FormValue, which prefers a form-encoded body's grant_type to the query's.
  it('counts a refresh grant whose body names another grant', () => {
    expect(guessRequest('POST', '/token', query('grant_type=refresh_token'), 'application/x-www-form-urlencoded', text('grant_type=password'))?.kind).toBe('password');
    expect(guessRequest('POST', '/token', query('grant_type=refresh_token&grant_type=password'), null, null)?.kind).toBe('password');
    // A JSON body that also reads as a form with grant_type=password: counted, whatever the Content-Type says.
    const both = json({ email: 'victim@example.com', password: 'guess', x: '&grant_type=password&' });
    expect(guessRequest('POST', '/token', query('grant_type=refresh_token'), 'application/json', both)).toEqual({ kind: 'password', account: 'email:victim@example.com' });
    expect(guessRequest('POST', '/token', query('grant_type=refresh_token'), 'multipart/form-data; boundary=x', null)?.kind).toBe('password');
  });

  it('counts a one-time code checked against an email or phone, not a link token hash', () => {
    expect(guessRequest('POST', '/verify', query(''), null, json({ type: 'email', email: 'A@b.co', token: '123456' }))).toEqual({ kind: 'code', account: 'email:a@b.co' });
    expect(guessRequest('POST', '/verify', query(''), null, json({ type: 'sms', phone: '+84 901', token: '123456' }))).toEqual({ kind: 'code', account: 'phone:84901' });
    expect(guessRequest('POST', '/verify', query(''), null, json({ type: 'recovery', token_hash: 'a'.repeat(56) }))).toBeNull();
    expect(guessRequest('POST', '/verify', query(''), null, json({ type: 'email', email: '', token: '1' }))).toEqual({ kind: 'code', account: null });
    expect(guessRequest('POST', '/verify', query(''), null, text('{"email":'))).toEqual({ kind: 'code', account: null });
    expect(guessRequest('GET', '/verify', query('token=abc&type=signup'), null, null)).toBeNull();
  });

  it('counts an MFA code per factor, whatever form the factor id takes', () => {
    const id = '6BA7B810-9DAD-11D1-80B4-00C04FD430C8';
    expect(guessRequest('POST', `/factors/${id}/verify`, query(''), null, json({ code: '123456' }))).toEqual({ kind: 'mfa', account: 'factor:6ba7b8109dad11d180b400c04fd430c8' });
    expect(guessRequest('POST', `/factors/${id.replace(/-/g, '')}/verify`, query(''), null, null)?.account).toBe('factor:6ba7b8109dad11d180b400c04fd430c8');
    expect(guessRequest('POST', `/factors/${id}/challenge`, query(''), null, null)).toBeNull();
    expect(guessRequest('POST', '/factors', query(''), null, json({ factor_type: 'totp' }))).toBeNull();
  });

  it('ignores everything else', () => {
    for (const path of ['/signup', '/recover', '/otp', '/resend', '/user', '/logout', '/settings', '/reauthenticate']) {
      expect(guessRequest('POST', path, query(''), null, signIn)).toBeNull();
    }
    expect(guessRequest('GET', '/token', query('grant_type=password'), null, null)).toBeNull();
    expect(guessRequest('PUT', '/user', query(''), null, json({ password: 'new-password' }))).toBeNull();
  });
});

describe('TokenBuckets', () => {
  it('spends the capacity, refills it evenly over the window, and says when to retry', () => {
    let now = 0;
    const buckets = new TokenBuckets({ capacity: 3, windowMs: 15 * MINUTE, now: () => now });
    for (let i = 0; i < 3; i += 1) expect(buckets.take('k').allowed).toBe(true);
    expect(buckets.take('k')).toEqual({ allowed: false, retryAfterSeconds: 300 });
    now += 5 * MINUTE;
    expect(buckets.take('k').allowed).toBe(true);
    expect(buckets.take('k').allowed).toBe(false);
    // Other keys have their own bucket.
    expect(buckets.take('other').allowed).toBe(true);
  });

  it('gives a token back, never above capacity, and drops buckets that are full again', () => {
    const buckets = new TokenBuckets({ capacity: 2, windowMs: MINUTE, now: () => 0 });
    buckets.take('k');
    expect(buckets.size).toBe(1);
    buckets.refund('k');
    expect(buckets.size).toBe(0);
    buckets.refund('k');
    expect(buckets.size).toBe(0);
    expect(buckets.take('k').allowed).toBe(true);
    expect(buckets.take('k').allowed).toBe(true);
    expect(buckets.take('k').allowed).toBe(false);
  });

  it('keeps at most maxKeys: full buckets go first, then the one touched longest ago', () => {
    let now = 0;
    const buckets = new TokenBuckets({ capacity: 2, windowMs: MINUTE, maxKeys: 3, now: () => now });
    for (const key of ['a', 'b', 'c']) buckets.take(key);
    buckets.take('a');
    // 'b' and 'c' are full again after 30 s; 'a' is not.
    now += 30_000;
    buckets.take('d');
    expect(buckets.size).toBe(2);
    // Nothing is full: the oldest ('a' was touched before 'd' and 'e') goes.
    buckets.take('e');
    buckets.take('e');
    buckets.take('f');
    expect(buckets.size).toBe(3);
    expect(buckets.take('a').allowed).toBe(true);
    expect(buckets.size).toBe(3);
  });

  it('sweeps a full map at most once a second, dropping the oldest bucket in between', () => {
    let now = 0;
    const buckets = new TokenBuckets({ capacity: 1, windowMs: 500, maxKeys: 2, now: () => now });
    buckets.take('a');
    buckets.take('b');
    now = 600;
    // 'a' and 'b' are full again: the sweep drops both.
    buckets.take('c');
    buckets.take('d');
    expect(buckets.size).toBe(2);
    now = 1200;
    // 'c' and 'd' are full again, but the last sweep was under a second ago: only the oldest goes.
    buckets.take('e');
    expect(buckets.size).toBe(2);
    now = 1700;
    buckets.take('f');
    expect(buckets.size).toBe(1);
  });

  it('refuses a malformed capacity', () => {
    expect(() => new TokenBuckets({ capacity: 0, windowMs: MINUTE })).toThrow(/capacity/);
  });
});

describe('createGuessLimiter', () => {
  const guess = (account: string, kind: Guess['kind'] = 'password'): Guess => ({ kind, account });
  let now = 0;
  let limiter: GuessLimiter;
  const attempts = (client: string, g: Guess, n: number) => Array.from({ length: n }, () => limiter.reserve(client, g).allowed);

  beforeEach(() => {
    now = 0;
    limiter = createGuessLimiter(LIMITS, { now: () => now });
  });

  it('allows 10 failed attempts at one account from one address in 15 minutes', () => {
    expect(attempts('v4:198.51.100.1', guess('email:a@b.co'), 11)).toEqual([...Array<boolean>(10).fill(true), false]);
    const refused = limiter.reserve('v4:198.51.100.1', guess('email:a@b.co'));
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 90 });
    // The same account from another address, and another account from the same address, still get through.
    expect(limiter.reserve('v4:198.51.100.2', guess('email:a@b.co')).allowed).toBe(true);
    expect(limiter.reserve('v4:198.51.100.1', guess('email:other@b.co')).allowed).toBe(true);
    // Codes and MFA count apart from passwords.
    expect(limiter.reserve('v4:198.51.100.1', guess('email:a@b.co', 'code')).allowed).toBe(true);
    now += 15 * MINUTE;
    expect(attempts('v4:198.51.100.1', guess('email:a@b.co'), 10).every(Boolean)).toBe(true);
  });

  it('allows 30 failed attempts from one address in 15 minutes, all accounts together', () => {
    const results = Array.from({ length: 31 }, (_, i) => limiter.reserve('v4:198.51.100.1', guess(`email:u${i}@b.co`)).allowed);
    expect(results).toEqual([...Array<boolean>(30).fill(true), false]);
    expect(limiter.reserve('v4:198.51.100.2', guess('email:u0@b.co')).allowed).toBe(true);
  });

  it('allows 50 failed attempts at one account in an hour from every address together', () => {
    for (let n = 1; n <= 5; n += 1) expect(attempts(`v4:203.0.113.${n}`, guess('email:target@b.co'), 10).every(Boolean)).toBe(true);
    const refused = limiter.reserve('v4:203.0.113.6', guess('email:target@b.co'));
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 72 });
    // A refusal spends nothing: the sixth address still has its own budgets for other accounts.
    expect(attempts('v4:203.0.113.6', guess('email:someone@b.co'), 10).every(Boolean)).toBe(true);
  });

  it('never lets one address lock an account out', () => {
    const attacker = 'v4:198.51.100.66';
    for (let minute = 0; minute < 6 * 60; minute += 1) {
      now = minute * MINUTE;
      // More than the address may spend: every attempt it is allowed fails and keeps its slot.
      for (let i = 0; i < 5; i += 1) limiter.reserve(attacker, guess('email:victim@b.co'));
      // The owner, from another address, still gets through, signs in and gives the slots back.
      const owner = limiter.reserve('v4:203.0.113.10', guess('email:victim@b.co'));
      expect(owner.allowed, `minute ${minute}`).toBe(true);
      if (owner.allowed) owner.release();
    }
  });

  it('gives the slots back for accepted attempts, once', () => {
    for (let i = 0; i < 40; i += 1) {
      const verdict = limiter.reserve('v4:198.51.100.1', guess('email:a@b.co'));
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) {
        verdict.release();
        verdict.release();
      }
    }
    expect(attempts('v4:198.51.100.1', guess('email:a@b.co'), 11)).toEqual([...Array<boolean>(10).fill(true), false]);
  });

  it('counts requests without a clear account in one shared bucket per kind', () => {
    expect(attempts('v4:198.51.100.1', { kind: 'password', account: null }, 10).every(Boolean)).toBe(true);
    expect(limiter.reserve('v4:198.51.100.1', { kind: 'password', account: null }).allowed).toBe(false);
    expect(limiter.reserve('v4:198.51.100.1', { kind: 'code', account: null }).allowed).toBe(true);
  });
});

describe('guess limit configuration', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth' };

  it('defaults to 30 per address and 10 per account from one address in 15 minutes, 50 per account an hour', () => {
    const config = loadConfig(base);
    expect([config.AUTH_GUESS_LIMIT_PER_CLIENT, config.AUTH_GUESS_LIMIT_PER_ACCOUNT_CLIENT, config.AUTH_GUESS_LIMIT_PER_ACCOUNT]).toEqual([30, 10, 50]);
  });

  it('refuses limits that let one address lock an account out', () => {
    expect(() => loadConfig({ ...base, AUTH_GUESS_LIMIT_PER_ACCOUNT: '39' })).toThrow(/AUTH_GUESS_LIMIT_PER_ACCOUNT=39 lets one client address lock an account out.*at least 40/);
    expect(loadConfig({ ...base, AUTH_GUESS_LIMIT_PER_ACCOUNT: '40' }).AUTH_GUESS_LIMIT_PER_ACCOUNT).toBe(40);
    expect(loadConfig({ ...base, AUTH_GUESS_LIMIT_PER_ACCOUNT_CLIENT: '5', AUTH_GUESS_LIMIT_PER_ACCOUNT: '20' }).AUTH_GUESS_LIMIT_PER_ACCOUNT).toBe(20);
    expect(() => loadConfig({ ...base, AUTH_GUESS_LIMIT_PER_CLIENT: '5' })).toThrow(/AUTH_GUESS_LIMIT_PER_ACCOUNT_CLIENT must not exceed/);
  });

  it('refuses malformed limits', () => {
    expect(() => loadConfig({ ...base, AUTH_GUESS_LIMIT_PER_CLIENT: '0' })).toThrow(/AUTH_GUESS_LIMIT_PER_CLIENT/);
    expect(() => loadConfig({ ...base, AUTH_GUESS_LIMIT_PER_ACCOUNT: 'many' })).toThrow(/AUTH_GUESS_LIMIT_PER_ACCOUNT/);
  });
});

describe('auth proxy guess limits', () => {
  let upstream: Server;
  let forwarded: string[] = [];
  let upstreamStatus = 400;
  let port = 0;
  let now = 0;

  const noEmails: EmailLimiter = {
    reserve: async () => ({ allowed: true, reservation: '1' }),
    release: async () => {},
  };

  const appWith = (env: Record<string, string> = {}, upstreamUrl?: string) =>
    createHttpApp({
      config: loadConfig({
        DATABASE_URL: 'postgres://localhost/x',
        AUTH_JWT_SECRET: SECRET,
        AUTH_ISSUER: 'crove-auth',
        AUTH_UPSTREAM_URL: upstreamUrl ?? `http://127.0.0.1:${port}`,
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
      emailLimiter: noEmails,
      guessLimiter: createGuessLimiter(LIMITS, { now: () => now }),
    });

  const post = (app: ReturnType<typeof appWith>, path: string, body: unknown, socket: string, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`http://localhost/auth/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      { incoming: { socket: { remoteAddress: socket } } },
    );

  const signIn = (app: ReturnType<typeof appWith>, email: string, socket: string, headers: Record<string, string> = {}) =>
    post(app, '/token?grant_type=password', { email, password: 'guess' }, socket, headers);

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      forwarded.push(req.url ?? '');
      res.statusCode = upstreamStatus;
      res.setHeader('content-type', 'application/json');
      res.end(upstreamStatus === 400 ? '{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}' : '{}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    port = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    forwarded = [];
    upstreamStatus = 400;
    now = 0;
  });

  it('refuses the 11th wrong password for one account from one address with 429 RATE_LIMITED, without forwarding', async () => {
    const app = appWith();
    for (let i = 0; i < 10; i += 1) expect((await signIn(app, 'a@example.com', '198.51.100.1')).status).toBe(400);
    const refused = await signIn(app, 'A@Example.com', '198.51.100.1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('90');
    // RATE_LIMITED for Crove clients; error_code is what auth-js reads.
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED', error_code: 'over_request_rate_limit', retryAfterSeconds: 90 });
    expect(forwarded).toHaveLength(10);
    // The account from another address, and another account from this one, still reach Supabase Auth.
    expect((await signIn(app, 'a@example.com', '198.51.100.2')).status).toBe(400);
    expect((await signIn(app, 'b@example.com', '198.51.100.1')).status).toBe(400);
    now += 15 * 60_000;
    expect((await signIn(app, 'a@example.com', '198.51.100.1')).status).toBe(400);
  });

  it('does not count sign-ins Supabase Auth accepts, or refuses with its own limit', async () => {
    const app = appWith();
    upstreamStatus = 200;
    for (let i = 0; i < 40; i += 1) expect((await signIn(app, 'a@example.com', '198.51.100.3')).status).toBe(200);
    upstreamStatus = 429;
    for (let i = 0; i < 40; i += 1) expect((await signIn(app, 'a@example.com', '198.51.100.3')).status).toBe(429);
    expect(forwarded).toHaveLength(80);
    upstreamStatus = 400;
    for (let i = 0; i < 10; i += 1) expect((await signIn(app, 'a@example.com', '198.51.100.3')).status).toBe(400);
    expect((await signIn(app, 'a@example.com', '198.51.100.3')).status).toBe(429);
  });

  it('ignores client-supplied forwarding headers unless proxies are trusted', async () => {
    const app = appWith();
    for (let i = 0; i < 10; i += 1) await signIn(app, 'a@example.com', '198.51.100.4', { 'x-forwarded-for': `10.0.0.${i}`, 'x-real-ip': `10.0.1.${i}` });
    expect((await signIn(app, 'a@example.com', '198.51.100.4', { 'x-forwarded-for': '10.9.9.9' })).status).toBe(429);
    // One trusted proxy: the entry it appended is the client.
    const proxied = appWith({ TRUSTED_PROXY_HOPS: '1' });
    for (let i = 0; i < 10; i += 1) await signIn(proxied, 'a@example.com', '10.0.0.1', { 'x-forwarded-for': `6.6.6.6, 203.0.113.${i}` });
    expect((await signIn(proxied, 'a@example.com', '10.0.0.1', { 'x-forwarded-for': '203.0.113.99' })).status).toBe(400);
  });

  it('limits one-time codes per email and MFA codes per factor', async () => {
    const app = appWith();
    upstreamStatus = 403;
    for (let i = 0; i < 10; i += 1) expect((await post(app, '/verify', { type: 'email', email: 'c@example.com', token: '000000' }, '198.51.100.5')).status).toBe(403);
    expect((await post(app, '/verify', { type: 'email', email: 'c@example.com', token: '000000' }, '198.51.100.5')).status).toBe(429);
    // A link's token hash is not a guess.
    expect((await post(app, '/verify', { type: 'recovery', token_hash: 'a'.repeat(56) }, '198.51.100.5')).status).toBe(403);
    upstreamStatus = 422;
    const factor = '/factors/6ba7b810-9dad-11d1-80b4-00c04fd430c8/verify';
    for (let i = 0; i < 10; i += 1) expect((await post(app, factor, { challenge_id: 'x', code: '000000' }, '198.51.100.6')).status).toBe(422);
    expect((await post(app, factor, { challenge_id: 'x', code: '000000' }, '198.51.100.6')).status).toBe(429);
  });

  it('leaves refresh tokens and every other path alone', async () => {
    const app = appWith();
    upstreamStatus = 400;
    for (let i = 0; i < 40; i += 1) expect((await post(app, '/token?grant_type=refresh_token', { refresh_token: 'r' }, '198.51.100.7')).status).toBe(400);
    for (let i = 0; i < 40; i += 1) expect((await post(app, '/recover', { email: 'r@example.com' }, '198.51.100.7')).status).toBe(400);
    expect(forwarded).toHaveLength(80);
  });

  it('keeps the slot when Supabase Auth does not answer (it may have checked the password)', async () => {
    // Nothing listens on port 1.
    const app = appWith({}, 'http://127.0.0.1:1');
    for (let i = 0; i < 10; i += 1) expect((await signIn(app, 'k@example.com', '198.51.100.8')).status).toBe(503);
    expect((await signIn(app, 'k@example.com', '198.51.100.8')).status).toBe(429);
  });
});
