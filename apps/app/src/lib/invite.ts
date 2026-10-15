// The invite token from an accept link (/-/invite#<token>). It is kept in this browser only while the invitee
// signs in or signs up, so the invite page can pick it up again, and dropped once the invite is answered.
const KEY = 'crove-pending-invite';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isInviteToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

export function rememberInvite(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage may be unavailable (private mode); the link still works when opened again after signing in.
  }
}

export function pendingInvite(): string | null {
  try {
    const token = localStorage.getItem(KEY);
    return isInviteToken(token) ? token : null;
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
