// Token verification and session adapters (ADR-0028 acceptance tests, unit part).
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasFreshMfa, toDomainError } from '@crove/kernel-runtime';
import { createTokenVerifier, mfaTimestamp } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createLiveCheck, createSessionStatusSource, createSupabaseLiveCheck, createSupabaseSessionRevoker } from '../src/sessions.ts';
import { runSignOut } from '../src/worker.ts';

const SECRET = 'unit-test-jwt-secret-0123456789abcdef';
const KEY = new TextEncoder().encode(SECRET);
const ISSUER = 'crove-auth';
const SESSION = '2d0c6f1e-5b7a-4c3d-9e8f-1a2b3c4d5e6f';
const SUBJECT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER });
const verify = createTokenVerifier(config);

interface TokenParts {
  claims?: Record<string, unknown>;
  omit?: string[];
  exp?: number | null;
}

// A token as the bundled Supabase Auth issues it, with claims replaced or removed per case.
async function token({ claims = {}, omit = [], exp }: TokenParts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: ISSUER,
    aud: 'authenticated',
    sub: SUBJECT,
    iat: now,
    exp: exp === undefined ? now + 900 : exp,
    role: 'authenticated',
    email: 'user@example.com',
    session_id: SESSION,
    aal: 'aal1',
    is_anonymous: false,
    ...claims,
  };
  for (const key of omit) delete payload[key];
  if (exp === null) delete payload.exp;
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(KEY);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('access token verification', () => {
  it('accepts a complete Supabase Auth token', async () => {
    await expect(verify(await token())).resolves.toEqual({
      issuer: ISSUER,
      subject: SUBJECT,
      email: 'user@example.com',
      name: null,
      aal: 'aal1',
      sessionId: SESSION,
      mfaAt: null,
    });
  });

  const refused: Array<[string, TokenParts]> = [
    ['no iss', { omit: ['iss'] }],
    ['a wrong iss', { claims: { iss: 'someone-else' } }],
    ['no aud', { omit: ['aud'] }],
    ['a wrong aud', { claims: { aud: 'anon' } }],
    ['no exp', { exp: null }],
    ['an expired exp', { exp: Math.floor(Date.now() / 1000) - 120 }],
    ['no sub', { omit: ['sub'] }],
    ['no session_id', { omit: ['session_id'] }],
    ['a session_id that is not a uuid', { claims: { session_id: 'abc' } }],
    ['role anon', { claims: { role: 'anon' } }],
    ['role service_role', { claims: { role: 'service_role' } }],
    ['is_anonymous = true', { claims: { is_anonymous: true } }],
    ['an empty email (phone-only user)', { claims: { email: '' } }],
    ['no email', { omit: ['email'] }],
  ];
  for (const [label, parts] of refused) {
    it(`refuses a token with ${label}`, async () => {
      await expect(verify(await token(parts))).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    });
  }

  it('tolerates at most 30 seconds of clock skew', async () => {
    await expect(verify(await token({ exp: Math.floor(Date.now() / 1000) - 10 }))).resolves.toBeTruthy();
    await expect(verify(await token({ exp: Math.floor(Date.now() / 1000) - 45 }))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses an unsigned token (alg: none) and a token signed with another secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, aud: 'authenticated', sub: SUBJECT, exp: now + 60, role: 'authenticated', email: 'a@b.c', session_id: SESSION };
    await expect(verify(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`)).rejects.toMatchObject({ status: 401 });
    const forged = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('x'.repeat(40)));
    await expect(verify(forged)).rejects.toMatchObject({ status: 401 });
  });

  it('accepts only the asymmetric family when JWKS is configured', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
    const jwksConfig = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWKS_URL: 'https://auth.example.com/jwks', AUTH_ISSUER: ISSUER });
    const jwksVerify = createTokenVerifier(jwksConfig, { jwks: createLocalJWKSet({ keys: [jwk] }) });
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, aud: 'authenticated', sub: SUBJECT, exp: now + 60, role: 'authenticated', email: 'a@b.c', session_id: SESSION };
    const es256 = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(privateKey);
    await expect(jwksVerify(es256)).resolves.toMatchObject({ subject: SUBJECT });
    // An HS256 token signed with a value an attacker may know (for example the public key bytes) is refused.
    await expect(jwksVerify(await token())).rejects.toMatchObject({ status: 401 });
  });

  it('reads the newest second factor from amr, ignoring first factors', () => {
    expect(mfaTimestamp([{ method: 'password', timestamp: 100 }])).toBeNull();
    expect(mfaTimestamp([{ method: 'otp', timestamp: 100 }])).toBeNull();
    expect(mfaTimestamp([{ method: 'totp', timestamp: 200 }, { method: 'password', timestamp: 100 }])).toBe(200);
    expect(mfaTimestamp([{ method: 'mfa/phone', timestamp: 300 }, { method: 'totp', timestamp: 200 }])).toBe(300);
    expect(mfaTimestamp([{ method: 'totp', timestamp: '200' }])).toBeNull();
    expect(mfaTimestamp('totp')).toBeNull();
    expect(mfaTimestamp(undefined)).toBeNull();
  });
});

describe('MFA step-up freshness (policy P11)', () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const actor = (aal: 'aal1' | 'aal2', ageS: number | null) => ({
    type: 'user' as const,
    userId: SUBJECT,
    aal,
    mfaAt: ageS === null ? null : now / 1000 - ageS,
  });

  it('needs aal2 and a second factor within the last 5 minutes', () => {
    expect(hasFreshMfa(actor('aal2', 0), now)).toBe(true);
    expect(hasFreshMfa(actor('aal2', 300), now)).toBe(true);
    expect(hasFreshMfa(actor('aal2', 301), now)).toBe(false);
    expect(hasFreshMfa(actor('aal2', null), now)).toBe(false);
    expect(hasFreshMfa(actor('aal1', 0), now)).toBe(false);
    // An MFA time from the future beyond the clock tolerance is not trusted.
    expect(hasFreshMfa(actor('aal2', -20), now)).toBe(true);
    expect(hasFreshMfa(actor('aal2', -120), now)).toBe(false);
  });
});

describe('session status adapters', () => {
  it('maps each mode to its source; only jwt needs the live check for R3', () => {
    expect(createSessionStatusSource('jwt')).toMatchObject({ mode: 'jwt', liveCheckForR3: true });
    // db reads Supabase Auth's own tables on every request; off never consults Auth (local URLs only).
    expect(createSessionStatusSource('db')).toMatchObject({ mode: 'db', liveCheckForR3: false });
    expect(createSessionStatusSource('off')).toMatchObject({ mode: 'off', liveCheckForR3: false });
  });

  it('builds the live check for jwt with an Auth URL only', () => {
    const jwt = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER };
    expect(createLiveCheck(loadConfig({ ...jwt, PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' }))).toBeTypeOf('function');
    expect(createLiveCheck(loadConfig(jwt))).toBeNull();
    expect(createLiveCheck(loadConfig({ ...jwt, AUTH_UPSTREAM_URL: 'http://auth:9999' }))).toBeNull();
    expect(createLiveCheck(loadConfig({ ...jwt, AUTH_UPSTREAM_URL: 'http://auth:9999', AUTH_SESSION_CHECK: 'jwt' }))).toBeTypeOf('function');
  });
});

describe('live check with Supabase Auth for R3 (GET /user)', () => {
  let upstream: Server;
  let url = '';
  let answer: { status: number; body: string } | 'drop' | 'hang' = { status: 200, body: '{}' };
  let seen: { method: string; path: string; headers: IncomingHttpHeaders } | null = null;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers };
      if (answer === 'drop') {
        req.socket.destroy();
        return;
      }
      if (answer === 'hang') return;
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/auth/v1/`;
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const confirm = (options: { apiKey?: string } = {}) => createSupabaseLiveCheck({ authUrl: url, timeoutMs: 300, ...options })('the-token', SUBJECT);
  const user = (id: unknown) => ({ status: 200, body: JSON.stringify({ id, aud: 'authenticated' }) });

  it('passes a 200 for the same user and sends the token and the publishable key', async () => {
    answer = user(SUBJECT);
    await expect(confirm({ apiKey: 'anon' })).resolves.toBeUndefined();
    expect(seen).toMatchObject({ method: 'GET', path: '/auth/v1/user' });
    expect(seen?.headers.authorization).toBe('Bearer the-token');
    expect(seen?.headers.apikey).toBe('anon');
    await confirm();
    expect(seen?.headers.apikey).toBeUndefined();
  });

  it('answers 401 for any other 4xx and for a 200 that names someone else', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      answer = { status, body: '{"error_code":"session_not_found"}' };
      await expect(confirm()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    }
    for (const id of ['9a8b7c6d-0000-4a3b-8c2d-1e0f9a8b7c6d', undefined, 42]) {
      answer = user(id);
      await expect(confirm()).rejects.toMatchObject({ status: 401 });
    }
  });

  it('answers 503 for 429, 5xx, an unreadable answer, a dropped connection and a timeout', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      answer = { status, body: '{}' };
      await expect(confirm()).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
    }
    answer = { status: 200, body: 'not json' };
    await expect(confirm()).rejects.toMatchObject({ status: 503 });
    answer = 'drop';
    await expect(confirm()).rejects.toMatchObject({ status: 503 });
    answer = 'hang';
    await expect(confirm()).rejects.toMatchObject({ status: 503 });
  });

  // Issue #126: the SPA sends MFA_REQUIRED to the MFA challenge; #247: SESSION_REVOKED_IN_ORG leaves that org only;
  // every other 28000 signs the user out.
  it('maps the session check answers to 401 MFA_REQUIRED, SESSION_REVOKED_IN_ORG and UNAUTHENTICATED', () => {
    expect(toDomainError({ code: '28000', message: 'MFA_REQUIRED' })).toMatchObject({ code: 'MFA_REQUIRED', status: 401 });
    expect(toDomainError({ code: '28000', message: 'SESSION_REVOKED_IN_ORG' })).toMatchObject({ code: 'SESSION_REVOKED_IN_ORG', status: 401 });
    for (const message of ['SESSION_INVALID', 'SESSION_REVOKED', 'SESSION_REVOKED_IN_ORG_SOMETHING', 'MFA_REQUIRED_SOMETHING']) {
      expect(toDomainError({ code: '28000', message })).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    }
  });
});

describe('Supabase Auth sign-out after a revoke (self-host)', () => {
  let upstream: Server;
  let url = '';
  let status = 204;
  // Supabase Auth's error body carries an error_code; null sends no body.
  let errorCode: string | null = null;
  let seen: { method: string; path: string; headers: IncomingHttpHeaders } | null = null;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers };
      res.statusCode = status;
      if (errorCode === null) {
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: status, error_code: errorCode, msg: 'from the fake server' }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    status = 204;
    errorCode = null;
  });

  const revoker = () => createSupabaseSessionRevoker({ upstreamUrl: url, secret: SECRET, issuer: ISSUER, audience: 'authenticated' });

  it('signs that one session out with a short-lived token for it', async () => {
    status = 204;
    await revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope: 'local' });
    expect(seen?.method).toBe('POST');
    expect(seen?.path).toBe('/logout?scope=local');
    const bearer = String(seen?.headers.authorization ?? '').replace(/^Bearer /, '');
    const { payload } = await jwtVerify(bearer, KEY, { issuer: ISSUER, audience: 'authenticated' });
    expect(payload).toMatchObject({ sub: SUBJECT, session_id: SESSION, role: 'authenticated' });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
    // The user's own "revoke all" signs out every session of the subject.
    await revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope: 'global' });
    expect(seen?.path).toBe('/logout?scope=global');
  });

  // Status codes and error codes as Supabase Auth v2.197.0 (the compose pin) answers /logout, checked live (#92).
  it('treats an already removed session or user as done for a local sign-out', async () => {
    status = 403;
    for (const gone of ['session_not_found', 'user_not_found']) {
      errorCode = gone;
      await expect(revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope: 'local' })).resolves.toBeUndefined();
    }
  });

  it('does not count a missing session as done for a global sign-out: the other sessions are still alive', async () => {
    status = 403;
    errorCode = 'session_not_found';
    await expect(revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope: 'global' })).rejects.toThrow(
      /global sign-out answered 403 session_not_found/,
    );
    // A deleted user has no session left in any scope.
    errorCode = 'user_not_found';
    await expect(revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope: 'global' })).resolves.toBeUndefined();
  });

  it('retries a rejected token, an unknown answer and an outage in either scope', async () => {
    const cases: [number, string | null][] = [[403, 'bad_jwt'], [403, null], [401, null], [404, null], [429, null], [503, null]];
    for (const [answer, code] of cases) {
      status = answer;
      errorCode = code;
      for (const scope of ['local', 'global'] as const) {
        await expect(revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope })).rejects.toThrow(new RegExp(`answered ${answer}`));
      }
    }
  });
});

describe('Supabase Auth sign-out job', () => {
  const target = { subject: SUBJECT, sessionId: SESSION, scope: 'global' } as const;
  const failing = { signOut: async () => Promise.reject(new Error('Supabase Auth global sign-out answered 403 session_not_found')) };

  it('rethrows a failed global sign-out so it is retried, then raises an ALERT after the last attempt', async () => {
    const alerts = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runSignOut(failing, target, 0)).rejects.toThrow(/session_not_found/);
      await expect(runSignOut(failing, target, 4)).rejects.toThrow(/session_not_found/);
      expect(alerts).not.toHaveBeenCalled();
      await expect(runSignOut(failing, target, 5)).resolves.toBeUndefined();
      expect(alerts).toHaveBeenCalledTimes(1);
      expect(String(alerts.mock.calls[0]?.[0])).toMatch(/^\[signout\] ALERT global sign-out of session 2d0c6f1e: .*after 6 attempts/);
    } finally {
      alerts.mockRestore();
    }
  });

  it('finishes without a retry when the sign-out succeeds or no revoker is configured', async () => {
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined)];
    try {
      const calls: unknown[] = [];
      await expect(runSignOut({ signOut: async (t) => void calls.push(t) }, target, 0)).resolves.toBeUndefined();
      expect(calls).toEqual([target]);
      await expect(runSignOut(null, target, 0)).resolves.toBeUndefined();
      expect(String(quiet[1]?.mock.calls[0]?.[0])).toMatch(/no Supabase Auth sign-out configured; revoked in Crove only/);
    } finally {
      for (const spy of quiet) spy.mockRestore();
    }
  });
});
