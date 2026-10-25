// Cloudflare Turnstile on the public booking form (#1353, plan docs/plan/calendar.md §3.4, decision CAL-2): when the
// deployment sets TURNSTILE_SITE_KEY and TURNSTILE_SECRET, the page shows the widget and sends its token with the
// request, and the kernel asks Cloudflare's siteverify whether the token is good before recording anything. Any
// doubt (no token, a refusal, an error, a timeout) refuses: the visitor can try again, a bot cannot slip through.

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;
// What Cloudflare accepts as a token; anything longer is not one.
const MAX_TOKEN = 2048;

/** Whether a Turnstile token is good, for the visitor's address when the kernel knows it. */
export type TurnstileVerifier = (token: string, remoteIp: string | null) => Promise<boolean>;

export function createTurnstileVerifier(secret: string, fetchImpl: typeof fetch = fetch): TurnstileVerifier {
  return async (token, remoteIp) => {
    if (!token || token.length > MAX_TOKEN) return false;
    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp) form.set('remoteip', remoteIp);
    try {
      const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return false;
      const body = (await res.json()) as { success?: unknown };
      return body.success === true;
    } catch {
      return false;
    }
  };
}
