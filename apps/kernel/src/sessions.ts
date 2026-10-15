// Session status and revocation adapters (ADR-0028 sections 3 to 5). One interface per concern, one adapter per
// deployment: self-host reads the shared database and signs sessions out through the bundled Supabase Auth; Crove
// Cloud (jwt) keeps Supabase Auth's default token lifetime, Crove's own revocation records and a live Auth check
// for R3.
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import { DomainError, type SessionStatusSource } from '@crove/kernel-runtime';
import { liveAuthUrl, type Config, type SessionCheckMode } from './config.ts';

// One definer call inside the request transaction: the Crove session records (global and for the org in context)
// and the user's Crove state, plus, for db, the Supabase Auth session and user rows in the shared database. Before
// `auth-grants` has run, db raises 55000, answered with 503.
//   db:  self-host with the bundled Supabase Auth. Its own tables are read on every request, so R3 needs no extra
//        call: the per-request check already sees a sign-out, ban or deletion.
//   jwt: a remote Supabase Auth Crove cannot read (Crove Cloud). A verified token is trusted until its exp, as
//        Supabase Auth does by default; a sign-out elsewhere destroys the refresh tokens at once, so access ends at
//        the token's expiry. Crove's own revocation is immediate, and every R3 command is confirmed live.
//   off: Crove's records only, no Auth at all (local URLs only).
function sqlSource(mode: SessionCheckMode): SessionStatusSource {
  const upstream = mode === 'db';
  return {
    mode,
    liveCheckForR3: mode === 'jwt',
    async check(trx, actor, orgId) {
      await sql`SELECT crove_kernel.session_check(${actor.userId}::uuid, ${actor.sessionId}::uuid, ${upstream}, ${orgId}::uuid)`.execute(trx);
    },
  };
}

export function createSessionStatusSource(mode: SessionCheckMode): SessionStatusSource {
  return sqlSource(mode);
}

export interface LiveCheckOptions {
  // Supabase Auth base URL: the GoTrue root (bundled) or `https://<project>.supabase.co/auth/v1` (hosted).
  authUrl: string;
  // Hosted Supabase answers only requests that carry the project's publishable (anon) key.
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// Confirms an access token with Supabase Auth: GET /user loads the user from `sub` and the session from
// `session_id` and refuses a signed-out session, a banned user or a deleted one (ADR-0028, Supabase Auth fact 5).
// Only a 200 whose `id` equals the token's subject passes; any other 4xx or a 200 for someone else is 401; a
// network error, timeout, 429 or 5xx is 503. No cache: R3 is rare and must see the current state.
export type LiveCheck = (token: string, subject: string) => Promise<void>;

export function createSupabaseLiveCheck(options: LiveCheckOptions): LiveCheck {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.authUrl.replace(/\/$/, '')}/user`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const unavailable = () =>
    new DomainError('AUTH_UNAVAILABLE', 503, 'Chưa kiểm tra được phiên đăng nhập với máy chủ xác thực, hãy thử lại sau');
  const invalid = () => new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập đã hết hiệu lực, hãy đăng nhập lại');
  return async function confirm(token, subject) {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, ...(options.apiKey ? { apikey: options.apiKey } : {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable();
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw invalid();
      throw unavailable();
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unavailable();
    }
    const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || id !== subject) throw invalid();
  };
}

// The live check the deployment uses for R3, or null when its session check does not need one (db reads Supabase
// Auth's tables on every request; off never consults Auth) or no Auth URL is configured (R3 then fails closed).
export function createLiveCheck(config: Config): LiveCheck | null {
  const authUrl = liveAuthUrl(config);
  if (config.AUTH_SESSION_CHECK !== 'jwt' || !authUrl) return null;
  return createSupabaseLiveCheck({ authUrl, ...(config.PUBLIC_AUTH_ANON_KEY ? { apiKey: config.PUBLIC_AUTH_ANON_KEY } : {}) });
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
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      // Supabase Auth answers 403 both when the target is already gone and when it rejects the token itself
      // (`bad_jwt`, a wrong secret or issuer), so only the error code tells them apart. A deleted user has no
      // sessions left in any scope. A missing session is the goal only for a local sign-out: for a global one it
      // means the token's session was already gone, so the user's other sessions are still alive upstream.
      let code: unknown;
      try {
        code = ((await response.json()) as { error_code?: unknown } | null)?.error_code;
      } catch {
        code = undefined;
      }
      if (response.status === 403 && (code === 'user_not_found' || (code === 'session_not_found' && scope === 'local'))) return;
      throw new Error(`Supabase Auth ${scope} sign-out answered ${response.status}${typeof code === 'string' ? ` ${code}` : ''}`);
    },
  };
}

// The self-host revoker needs the bundled Supabase Auth and the shared HS256 secret. Without them (asymmetric keys,
// or Crove Cloud, which has no admin access to DOS's Supabase Auth) revocation stays Crove-side only: the revoked
// record blocks the session in Crove at once, and the session's tokens expire at their exp.
export function createSessionRevoker(config: Config): SessionRevoker | null {
  if (!config.AUTH_UPSTREAM_URL || !config.AUTH_JWT_SECRET || config.AUTH_JWKS_URL) return null;
  return createSupabaseSessionRevoker({
    upstreamUrl: config.AUTH_UPSTREAM_URL,
    secret: config.AUTH_JWT_SECRET,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
  });
}
