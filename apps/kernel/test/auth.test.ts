// Token verification and session adapters (ADR-0028 acceptance tests, unit part).
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasFreshMfa } from '@crove/kernel-runtime';
import { createTokenVerifier, mfaTimestamp } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createSessionStatusSource, createSupabaseSessionRevoker } from '../src/sessions.ts';

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
  it('fails closed with 503 on the events adapter until the Cloud consumer exists', async () => {
    const source = createSessionStatusSource('events');
    expect(source.mode).toBe('events');
    await expect(source.check({} as never, { type: 'user', userId: SUBJECT, aal: 'aal1', sessionId: SESSION }, null)).rejects.toMatchObject({
      code: 'AUTH_STATUS_STALE',
      status: 503,
    });
  });
});

describe('Supabase Auth sign-out after a revoke (self-host)', () => {
  let upstream: Server;
  let url = '';
  let status = 204;
  let seen: { method: string; path: string; headers: IncomingHttpHeaders } | null = null;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers };
      res.statusCode = status;
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
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

  it('treats an already removed session as done and retries anything else', async () => {
    for (const gone of [401, 403, 404]) {
      status = gone;
      await expect(revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope: 'local' })).resolves.toBeUndefined();
    }
    status = 503;
    await expect(revoker().signOut({ subject: SUBJECT, sessionId: SESSION, scope: 'local' })).rejects.toThrow(/503/);
  });
});
