// Verifies Supabase Auth (GoTrue) access tokens and maps them to Crove user accounts.
// Self-host signs with HS256 (shared secret); hosted Supabase publishes asymmetric keys via JWKS.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Db } from '@crove/db';
import { upsertIdentity } from '@crove/kernel';
import { DomainError, type Aal, type UserActor } from '@crove/kernel-runtime';
import type { Config } from './config.ts';

export interface AuthUser {
  userId: string;
  email: string;
  name: string | null;
  // From the token of this request: aal2 only when the session passed MFA.
  aal: Aal;
}

interface SupabaseClaims extends JWTPayload {
  email?: string;
  role?: string;
  aal?: string;
  user_metadata?: { full_name?: string; name?: string };
}

export function actorOf(user: AuthUser): UserActor {
  return { type: 'user', userId: user.userId, aal: user.aal };
}

export function createAuthenticator(config: Config, db: Db) {
  const jwks = config.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)) : null;
  const secret = config.AUTH_JWT_SECRET ? new TextEncoder().encode(config.AUTH_JWT_SECRET) : null;
  // Caches only the identity mapping; the assurance level is read from every token.
  const cache = new Map<string, { user: Omit<AuthUser, 'aal'>; expires: number }>();

  async function verify(token: string): Promise<SupabaseClaims> {
    const options = {
      audience: config.AUTH_AUDIENCE,
      ...(config.AUTH_ISSUER ? { issuer: config.AUTH_ISSUER } : {}),
    };
    try {
      if (jwks) return (await jwtVerify(token, jwks, { ...options, algorithms: ['ES256', 'RS256'] })).payload as SupabaseClaims;
      return (await jwtVerify(token, secret as Uint8Array, { ...options, algorithms: ['HS256'] })).payload as SupabaseClaims;
    } catch {
      throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
    }
  }

  return async function authenticate(header: string | undefined): Promise<AuthUser> {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw new DomainError('UNAUTHENTICATED', 401, 'Bạn cần đăng nhập');
    const claims = await verify(token);
    if (!claims.sub || !claims.email || claims.role !== 'authenticated') {
      throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ');
    }
    // A missing or unknown aal claim counts as the lowest level.
    const aal: Aal = claims.aal === 'aal2' ? 'aal2' : 'aal1';
    const issuer = claims.iss ?? 'supabase-auth';
    const key = `${issuer}|${claims.sub}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return { ...hit.user, aal };
    const name = claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? null;
    const userId = await upsertIdentity(db, { issuer, subject: claims.sub, email: claims.email, name });
    const user = { userId, email: claims.email, name };
    cache.set(key, { user, expires: Date.now() + 5 * 60_000 });
    if (cache.size > 10_000) cache.clear();
    return { ...user, aal };
  };
}

export type Authenticate = ReturnType<typeof createAuthenticator>;
