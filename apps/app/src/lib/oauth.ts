// Connecting a channel through a provider's OAuth dialog (Social plan S6). The provider sends the browser back to one
// fixed address for every org, /channels/oauth/:provider/callback, so the screen that starts an attempt remembers
// which org it was for under the attempt's state. The state is not a secret from this browser: the server keeps only
// its hash and finishes the attempt only for the member who started it.
const PREFIX = 'crove.oauth.';
const MAX_AGE_MS = 15 * 60 * 1000;

interface Pending {
  slug: string;
  at: number;
}

export function rememberOAuthAttempt(state: string, slug: string): void {
  try {
    sessionStorage.setItem(PREFIX + state, JSON.stringify({ slug, at: Date.now() } satisfies Pending));
  } catch {
    // Storage off (private mode): the callback screen then asks to start again.
  }
}

// The org slug of the attempt, once: the entry is removed as it is read, and an entry older than the attempt's
// lifetime is ignored.
export function takeOAuthAttempt(state: string): string | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + state);
    sessionStorage.removeItem(PREFIX + state);
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<Pending>;
    if (typeof pending.slug !== 'string' || typeof pending.at !== 'number' || Date.now() - pending.at > MAX_AGE_MS) return null;
    return pending.slug;
  } catch {
    return null;
  }
}
