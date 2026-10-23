// Browser push on this device (#1238): the service worker, the browser's push subscription, and the one Trusted Types
// policy the SPA may create. The kernel's CSP enforces Trusted Types and names a single policy, crove-sw, once
// (apps/kernel/src/http.ts); navigator.serviceWorker.register() is a script-URL sink, so the worker's URL goes through
// that policy, created only when a member turns push on. Its createScriptURL hands back the worker's fixed URL and
// throws for anything else; it has no createHTML or createScript, so every HTML and script sink still refuses strings.
//
// The worker lives under /assets (the only static path the kernel serves) with the scope /assets/: it controls no page
// and intercepts no request, which push does not need; it only shows a push and opens its link.

export const SW_URL = '/assets/sw.js';
export const SW_SCOPE = '/assets/';
export const SW_POLICY = 'crove-sw';

// The policy's only rule: the service worker's own URL, exactly.
export function swScriptUrl(input: string): string {
  if (input !== SW_URL) throw new TypeError('crove-sw only allows the service worker script');
  return input;
}

interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}
interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL: (input: string) => string }): ScriptUrlPolicy;
}

let policy: ScriptUrlPolicy | null = null;
// The worker's URL as register() takes it: through crove-sw where the browser has Trusted Types, created on first use.
function workerUrl(): string {
  const tt = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (!tt) return SW_URL;
  policy ??= tt.createPolicy(SW_POLICY, { createScriptURL: swScriptUrl });
  // A TrustedScriptURL; register() accepts it where it accepts the string.
  return policy.createScriptURL(SW_URL) as string;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission(): NotificationPermission | null {
  return pushSupported() ? Notification.permission : null;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration(SW_SCOPE);
}

// The push service's endpoint of this browser's subscription, or null when it has none.
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

// A registration's worker once it is active: subscribe() needs one, and navigator.serviceWorker.ready never settles for
// a worker whose scope holds no page.
function active(reg: ServiceWorkerRegistration): Promise<void> {
  const worker = reg.installing ?? reg.waiting;
  if (reg.active || !worker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
      else if (worker.state === 'redundant') reject(new Error('service worker not installed'));
    });
  });
}

export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => a !== null && a.byteLength === b.length && new Uint8Array(a).every((v, i) => v === b[i]);

export class PushDenied extends Error {
  constructor() {
    super('notifications not allowed');
    this.name = 'PushDenied';
  }
}

// Asks for permission, registers the worker and subscribes with the deployment's key (again when the key changed).
export async function enablePush(publicKey: string): Promise<{ endpoint: string; p256dh: string; auth: string }> {
  if ((await Notification.requestPermission()) !== 'granted') throw new PushDenied();
  const reg = await navigator.serviceWorker.register(workerUrl(), { scope: SW_SCOPE });
  await active(reg);
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new Error('push subscription without keys');
  return { endpoint: json.endpoint, p256dh, auth };
}

// Ends this browser's subscription; the server row is removed by the caller.
export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  await sub?.unsubscribe();
}

// The browser and system a user agent names, for the device list ("Chrome", "Windows"); null when unknown.
export function deviceOf(userAgent: string): { browser: string | null; os: string | null } {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /(Chrome|CriOS)\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent)
      ? 'iOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /CrOS/.test(userAgent)
            ? 'ChromeOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : null;
  return { browser, os };
}
