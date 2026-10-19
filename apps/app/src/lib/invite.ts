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

// The header the kernel's /auth/v1 proxy reads the invite token from on a sign-up (issue #563). While sign-up is
// restricted (invite_only, or an invited address under allowlist), Supabase Auth only gets a sign-up for an invited
// address that carries its token: whoever merely knows the address cannot create the account first with their own
// password. The proxy never forwards the header.
export const INVITE_TOKEN_HEADER = 'x-crove-invite';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// A fetch for the auth client that adds the pending invite token to a sign-up sent to this origin (the bundled
// Supabase Auth behind the kernel's proxy), and changes nothing else. A Supabase Auth on another origin never gets
// the token (and would refuse the unknown header in its CORS preflight).
export function withInviteToken(base: typeof fetch, origin: string): typeof fetch {
  return (input, init) => {
    const url = new URL(requestUrl(input), origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const token = method === 'POST' && url.origin === origin && url.pathname.endsWith('/signup') ? pendingInvite() : null;
    if (!token) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(INVITE_TOKEN_HEADER, token);
    return base(input, { ...init, headers });
  };
}
