// Pure helpers for the device sessions screens (ADR-0028 section 4). No browser or API imports, so they are unit tested.

export interface SessionRow {
  sessionId: string;
  status: 'active' | 'revoked';
  firstSeenAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

// The Supabase Auth session id carried by an access token (`session_id` claim). Reading the claim is display only:
// the server verifies every token and decides what may be revoked.
export function sessionIdFromToken(token: string | null | undefined): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const claims = JSON.parse(json) as { session_id?: unknown };
    return typeof claims.session_id === 'string' && claims.session_id ? claims.session_id : null;
  } catch {
    return null;
  }
}

// The current session first, then active sessions by last activity, then revoked ones by revocation time.
export function sortSessions<T extends SessionRow>(sessions: readonly T[], currentId: string | null): T[] {
  const rank = (s: T) => (s.sessionId === currentId ? 0 : s.status === 'active' ? 1 : 2);
  const time = (s: T) => Date.parse(s.status === 'revoked' ? (s.revokedAt ?? s.lastSeenAt) : s.lastSeenAt) || 0;
  return [...sessions].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}

export function otherActiveSessionIds(sessions: readonly SessionRow[], currentId: string | null): string[] {
  return sessions.filter((s) => s.status === 'active' && s.sessionId !== currentId).map((s) => s.sessionId);
}

// A short, stable label for a session the API knows only by id.
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(-6).toUpperCase();
}

// "Chrome trên Windows" for this browser. The API does not record user agents, so only the current device gets one.
export function describeUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\/|Opera/.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(userAgent)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} trên ${os}`;
  return browser ?? os;
}

export type SessionScope = 'self' | 'member';

// Clear messages for the answers this screen can get. STEP_UP_REQUIRED is the R3 answer (ADR-0028 section 5); a
// session revoke is R1 today, but a deployment may tighten it, so the screen explains it instead of a raw code.
export function sessionErrorMessage(error: unknown, scope: SessionScope): string {
  const e = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  if (e.code === 'STEP_UP_REQUIRED') {
    return 'Thao tác này cần xác thực hai lớp trong 5 phút gần nhất. Hãy xác minh lại mã hai lớp rồi thử lại.';
  }
  if (e.code === 'NOT_A_MEMBER' || e.code === 'USER_DISABLED') {
    return typeof e.message === 'string' && e.message ? e.message : 'Không có quyền thực hiện';
  }
  if (e.status === 403 || e.code === 'FORBIDDEN') {
    return scope === 'member'
      ? 'Chỉ chủ sở hữu tổ chức mới xem và thu hồi được phiên đăng nhập của thành viên. Quản trị viên không có quyền này.'
      : 'Bạn không có quyền xem hoặc thu hồi các phiên đăng nhập này.';
  }
  if (typeof e.message === 'string' && e.message) return e.message;
  return 'Đã có lỗi xảy ra';
}
