// Verifies Supabase Auth (GoTrue) access tokens and maps them to Crove user accounts.
// Self-host signs with HS256 (shared secret); hosted Supabase publishes asymmetric keys via JWKS.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Db } from '@crove/db';
import { upsertIdentity } from '@crove/kernel';
import { DomainError } from '@crove/kernel-runtime';
import type { Config } from './config.ts';

export interface AuthUser {
  userId: string;
  email: string;
  name: string | null;
}

interface SupabaseClaims extends JWTPayload {
  email?: string;
  role?: string;
  user_metadata?: { full_name?: string; name?: string };
}

export function createAuthenticator(config: Config, db: Db) {
  const jwks = config.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)) : null;
  const secret = config.AUTH_JWT_SECRET ? new TextEncoder().encode(config.AUTH_JWT_SECRET) : null;
  const cache = new Map<string, { user: AuthUser; expires: number }>();

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
    const issuer = claims.iss ?? 'supabase-auth';
    const key = `${issuer}|${claims.sub}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.user;
    const name = claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? null;
    const userId = await upsertIdentity(db, { issuer, subject: claims.sub, email: claims.email, name });
    const user = { userId, email: claims.email, name };
    cache.set(key, { user, expires: Date.now() + 5 * 60_000 });
    if (cache.size > 10_000) cache.clear();
    return user;
  };
}

export type Authenticate = ReturnType<typeof createAuthenticator>;
