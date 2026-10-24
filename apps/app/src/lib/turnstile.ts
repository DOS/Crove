// Cloudflare Turnstile on the public booking form (#1353), when the deployment sets TURNSTILE_SITE_KEY. The kernel's
// CSP then lets Turnstile's origin in and names a second Trusted Types policy, crove-turnstile (apps/kernel/src/http.ts):
// a script's src is a script-URL sink, so Turnstile's script URL goes through that policy, created on first use. Its
// createScriptURL hands back that one fixed URL and throws for anything else, like crove-sw (push.ts); it has no
// createHTML or createScript. The widget is rendered explicitly into the form and hands its token to a callback.

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TURNSTILE_POLICY = 'crove-turnstile';

// The policy's only rule: Turnstile's script URL, exactly.
export function turnstileScriptUrl(input: string): string {
  if (input !== TURNSTILE_SCRIPT) throw new TypeError('crove-turnstile only allows the Turnstile script');
  return input;
}

interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}
interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL: (input: string) => string }): ScriptUrlPolicy;
}
export interface TurnstileApi {
  render(container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

let policy: ScriptUrlPolicy | null = null;
let loading: Promise<TurnstileApi> | null = null;

/** Loads Turnstile's script once, through crove-turnstile where the browser has Trusted Types. */
export function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    const tt = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
    if (tt) policy ??= tt.createPolicy(TURNSTILE_POLICY, { createScriptURL: turnstileScriptUrl });
    // A TrustedScriptURL where the browser has Trusted Types; the src setter accepts it where it accepts the string.
    script.src = (policy ? policy.createScriptURL(TURNSTILE_SCRIPT) : TURNSTILE_SCRIPT) as string;
    script.async = true;
    script.onload = () => {
      const api = (window as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else reject(new Error('turnstile missing'));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}
