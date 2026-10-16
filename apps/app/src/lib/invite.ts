// The invite token from an accept link (/-/invite#<token>). It is kept in this browser only while the invitee
// signs in or signs up, so the invite page can pick it up again, and dropped once the invite is answered, when the
// user signs out, or after PENDING_INVITE_TTL_MS (#134): a shared browser must not keep it for the next person. The
// link itself stays valid until the invite expires, so opening it again starts over.
const KEY = 'crove-pending-invite';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Long enough to sign in, or to sign up and confirm the email; much shorter than the invite (7 days).
export const PENDING_INVITE_TTL_MS = 60 * 60 * 1000;

interface Stored {
  token: string;
  savedAt: number;
}

export function isInviteToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

export function rememberInvite(token: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, savedAt: now } satisfies Stored));
  } catch {
    // Storage may be unavailable (private mode); the link still works when opened again after signing in.
  }
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored> | null;
    if (!value || !isInviteToken(value.token) || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null;
    return { token: value.token, savedAt: value.savedAt };
  } catch {
    return null;
  }
}

// The stored token while it is fresh. Anything else (expired, saved in the future, malformed, or the bare token an
// older version stored) is removed.
export function pendingInvite(now: number = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const stored = parse(raw);
    if (stored && stored.savedAt <= now && now - stored.savedAt < PENDING_INVITE_TTL_MS) return stored.token;
    localStorage.removeItem(KEY);
    return null;
  } catch {
    return null;
  }
}

export function forgetInvite(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

// Takes the token out of the address bar, so it is not kept in history or shared by copying the URL.
export function takeTokenFromHash(): string | null {
  const token = window.location.hash.replace(/^#/, '');
  if (!isInviteToken(token)) return null;
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  return token;
}
