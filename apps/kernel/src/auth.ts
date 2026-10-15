// Verifies Supabase Auth (GoTrue) access tokens and maps them to Crove user accounts (ADR-0028 section 1).
// Self-host signs with HS256 (shared secret); hosted Supabase publishes asymmetric keys via JWKS. Verification is
// local; the session status check runs later, in the request transaction (Runtime + SessionStatusSource).
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Db } from '@crove/db';
import { resolveIdentity } from '@crove/kernel';
import { DomainError, toDomainError, type Aal, type UserActor } from '@crove/kernel-runtime';
import type { Config } from './config.ts';

export interface AuthUser {
  userId: string;
  email: string;
  name: string | null;
  // From the token of this request: aal2 only when the session passed MFA.
  aal: Aal;
  // Supabase Auth session id (`session_id`); a refresh keeps it.
  sessionId: string;
  // Unix seconds of the newest second-factor `amr` entry, or null.
  mfaAt: number | null;
}

export interface VerifiedToken {
  issuer: string;
  subject: string;
  email: string;
  name: string | null;
  aal: Aal;
  sessionId: string;
  mfaAt: number | null;
}

interface SupabaseClaims extends JWTPayload {
  email?: unknown;
  role?: unknown;
  aal?: unknown;
  session_id?: unknown;
  is_anonymous?: unknown;
  amr?: unknown;
  user_metadata?: { full_name?: unknown; name?: unknown };
}

// `amr` methods that prove a second factor: TOTP, phone (SMS or voice) and WebAuthn, in the spellings Supabase
// Auth uses. `otp`, `password`, `magiclink` and `oauth` are first factors.
const SECOND_FACTORS = new Set(['totp', 'mfa/totp', 'phone', 'mfa/phone', 'webauthn', 'mfa/webauthn']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK_TOLERANCE_S = 30;

export function actorOf(user: AuthUser): UserActor {
  return { type: 'user', userId: user.userId, aal: user.aal, sessionId: user.sessionId, mfaAt: user.mfaAt };
}

// Newest timestamp of a second-factor `amr` entry (entries are { method, timestamp }).
export function mfaTimestamp(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let newest: number | null = null;
  for (const entry of amr) {
    if (!entry || typeof entry !== 'object') continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== 'string' || !SECOND_FACTORS.has(method)) continue;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    if (newest === null || timestamp > newest) newest = timestamp;
  }
  return newest;
}

const invalid = () => new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');

// Signature, algorithm family, issuer, audience and expiry, then the claims Crove relies on. Every failure is 401.
export function createTokenVerifier(config: Config, keys: { jwks?: JWTVerifyGetKey } = {}) {
  const jwks = keys.jwks ?? (config.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(config.AUTH_JWKS_URL), { cacheMaxAge: 10 * 60_000 }) : null);
  const secret = config.AUTH_JWT_SECRET ? new TextEncoder().encode(config.AUTH_JWT_SECRET) : null;
  const options = {
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    requiredClaims: ['iss', 'aud', 'exp', 'sub', 'session_id'],
    clockTolerance: CLOCK_TOLERANCE_S,
  };

  return async function verify(token: string): Promise<VerifiedToken> {
    let claims: SupabaseClaims;
    try {
      // One family per deployment: JWKS (ES256/RS256) when configured, otherwise HS256 with the shared secret.
      if (jwks) claims = (await jwtVerify(token, jwks, { ...options, algorithms: ['ES256', 'RS256'] })).payload as SupabaseClaims;
      else if (secret) claims = (await jwtVerify(token, secret, { ...options, algorithms: ['HS256'] })).payload as SupabaseClaims;
      else throw invalid();
    } catch {
      throw invalid();
    }
    const { sub, iss, email, role, session_id: sessionId } = claims;
    if (typeof sub !== 'string' || sub === '' || typeof iss !== 'string') throw invalid();
    if (role !== 'authenticated' || claims.is_anonymous === true) throw invalid();
    // Crove identifies and adds members by email, so phone-only accounts are refused until a later ADR.
    if (typeof email !== 'string' || email.trim() === '') throw invalid();
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw invalid();
    const meta = claims.user_metadata;
    const name = typeof meta?.full_name === 'string' ? meta.full_name : typeof meta?.name === 'string' ? meta.name : null;
    return {
      issuer: iss,
      subject: sub,
      email,
      name,
      // A missing or unknown aal claim counts as the lowest level.
      aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
      sessionId: sessionId.toLowerCase(),
      mfaAt: mfaTimestamp(claims.amr),
    };
  };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;

// Database errors from the identity checks map to 401, 403 or 503 like the per-request check.
async function withDomainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toDomainError(error);
  }
}

export function createAuthenticator(config: Config, db: Db, verify: TokenVerifier = createTokenVerifier(config)) {
  // Caches only the identity mapping; no authorization decision. Assurance and session come from every token.
  const cache = new Map<string, { user: Pick<AuthUser, 'userId' | 'email' | 'name'>; expires: number }>();

  return async function authenticate(header: string | undefined): Promise<AuthUser> {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw new DomainError('UNAUTHENTICATED', 401, 'Bạn cần đăng nhập');
    const verified = await verify(token);
    // Same fail-closed answer as the events adapter, before anything is written.
    if (config.AUTH_SESSION_CHECK === 'events') {
      throw new DomainError('AUTH_STATUS_STALE', 503, 'Chưa kiểm tra được trạng thái phiên đăng nhập (AUTH_SESSION_CHECK=events chưa được hỗ trợ)');
    }
    const perToken = { aal: verified.aal, sessionId: verified.sessionId, mfaAt: verified.mfaAt };
    const key = `${verified.issuer}|${verified.subject}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now() && hit.user.email === verified.email) return { ...hit.user, ...perToken };
    // Checked first: a revoked, signed-out or disabled session never updates the account's email or name.
    const userId = await withDomainErrors(() =>
      resolveIdentity(db, {
        issuer: verified.issuer,
        subject: verified.subject,
        email: verified.email,
        name: verified.name,
        sessionId: verified.sessionId,
        upstream: config.AUTH_SESSION_CHECK === 'db',
      }),
    );
    const user = { userId, email: verified.email, name: verified.name };
    cache.set(key, { user, expires: Date.now() + 5 * 60_000 });
    if (cache.size > 10_000) cache.clear();
    return { ...user, ...perToken };
  };
}

export type Authenticate = ReturnType<typeof createAuthenticator>;
