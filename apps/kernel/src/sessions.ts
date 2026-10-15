// Session status and revocation adapters (ADR-0028 sections 3 and 4). One interface per concern, one adapter per
// deployment: self-host reads the shared database and signs sessions out through the bundled Supabase Auth;
// Crove Cloud consumes DOS ID lifecycle events (not implemented yet: it fails closed).
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import { DomainError, type SessionStatusSource } from '@crove/kernel-runtime';
import type { Config, SessionCheckMode } from './config.ts';

// Self-host (AUTH_SESSION_CHECK=db): the Crove record, the user's Crove state and the Supabase Auth session and
// user rows, in one definer call inside the request transaction. Before `auth-grants` has run it raises 55000,
// answered with 503.
function sqlSource(mode: 'db' | 'off'): SessionStatusSource {
  const upstream = mode === 'db';
  return {
    mode,
    async check(trx, actor, orgId) {
      await sql`SELECT crove_kernel.session_check(${actor.userId}::uuid, ${actor.sessionId}::uuid, ${upstream}, ${orgId}::uuid)`.execute(trx);
    },
  };
}

// Crove Cloud (AUTH_SESSION_CHECK=events): session and user lifecycle events from DOS ID with checkpoints and a
// 60 s evidence limit, plus a first-seen getUser check. The DOS-side producer (DOS-28) does not exist yet, so
// this adapter refuses every request rather than trust a session it cannot vouch for.
function eventsSource(): SessionStatusSource {
  return {
    mode: 'events',
    async check() {
      throw new DomainError(
        'AUTH_STATUS_STALE',
        503,
        'Chưa kiểm tra được trạng thái phiên đăng nhập (AUTH_SESSION_CHECK=events chưa được hỗ trợ)',
      );
    },
  };
}

export function createSessionStatusSource(mode: SessionCheckMode): SessionStatusSource {
  return mode === 'events' ? eventsSource() : sqlSource(mode);
}

export interface SignOutTarget {
  // Supabase Auth user id (the token's `sub`).
  subject: string;
  // A session of that subject; Crove checked it belongs to the subject before asking for the sign-out.
  sessionId: string;
  // local: that session; global: every session of the subject (the user's own "revoke all").
  scope: 'local' | 'global';
}

// Asks Supabase Auth to sign a session out, which destroys its refresh tokens. Best effort: the revoked Crove
// record already blocks the session, so a failure here is retried and logged, never trusted.
export interface SessionRevoker {
  signOut(target: SignOutTarget): Promise<void>;
}

export interface SupabaseRevokerOptions {
  upstreamUrl: string;
  secret: string;
  issuer: string;
  audience: string;
  fetch?: typeof fetch;
}

// Self-host: the admin sign-out takes the target session's access token, not an id, so the kernel signs a
// 60-second token for that subject and session with the deployment's JWT secret and calls /logout with the scope.
// Only the user's own revocations reach it: an org owner's revoke stays inside that org.
export function createSupabaseSessionRevoker(options: SupabaseRevokerOptions): SessionRevoker {
  const key = new TextEncoder().encode(options.secret);
  const doFetch = options.fetch ?? fetch;
  const base = options.upstreamUrl.replace(/\/$/, '');
  return {
    async signOut({ subject, sessionId, scope }) {
      const token = await new SignJWT({ role: 'authenticated', session_id: sessionId, aal: 'aal1' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(subject)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime('60s')
        .sign(key);
      const response = await doFetch(`${base}/logout?scope=${scope === 'global' ? 'global' : 'local'}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      // 204: signed out. 401, 403 and 404: the session or user is already gone, which is the goal.
      if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) return;
      throw new Error(`Supabase Auth sign-out answered ${response.status}`);
    },
  };
}

// The self-host revoker needs the bundled Supabase Auth and the shared HS256 secret. Without them (asymmetric keys,
// or Crove Cloud, where DOS ID runs the sign-out as part of DOS-28) revocation stays Crove-side only.
export function createSessionRevoker(config: Config): SessionRevoker | null {
  if (!config.AUTH_UPSTREAM_URL || !config.AUTH_JWT_SECRET || config.AUTH_JWKS_URL) return null;
  return createSupabaseSessionRevoker({
    upstreamUrl: config.AUTH_UPSTREAM_URL,
    secret: config.AUTH_JWT_SECRET,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
  });
}
