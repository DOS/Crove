// Browser push in the SPA (#1238): the one Trusted Types policy passes only the service worker's own URL, the policy is
// created once and only when push is turned on, and the service worker shows a push and opens only a Crove path of
// its own origin, with no fetch handler and no imported script.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SW_POLICY, SW_SCOPE, SW_URL, deviceOf, keyBytes, swScriptUrl } from '../src/lib/push.ts';

const SW_SOURCE = readFileSync(new URL('../public/assets/sw.js', import.meta.url), 'utf8');

describe('the crove-sw Trusted Types policy', () => {
  it('passes the service worker URL exactly and refuses anything else', () => {
    expect(SW_URL).toBe('/assets/sw.js');
    expect(SW_SCOPE).toBe('/assets/');
    expect(SW_POLICY).toBe('crove-sw');
    expect(swScriptUrl('/assets/sw.js')).toBe('/assets/sw.js');
    for (const url of ['/assets/sw.js?x', '/assets/sw.js#x', '//evil/sw.js', 'https://evil.example/assets/sw.js', 'javascript:alert(1)', 'data:text/javascript,1', '/assets/../sw.js', '/assets/SW.js', ' /assets/sw.js', '']) {
      expect(() => swScriptUrl(url), url).toThrow(TypeError);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('is created once, lazily, by turning push on, with createScriptURL as its only rule', async () => {
    const created: { name: string; rules: Record<string, unknown> }[] = [];
    vi.stubGlobal('trustedTypes', {
      createPolicy: (name: string, rules: Record<string, unknown>) => {
        if (created.some((c) => c.name === name)) throw new TypeError('duplicate policy');
        created.push({ name, rules });
        return { createScriptURL: (u: string) => (rules.createScriptURL as (s: string) => string)(u) };
      },
    });
    const registered: unknown[] = [];
    const sub = { endpoint: 'https://push.example/1', options: { applicationServerKey: null }, toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => true };
    const reg = { active: {}, pushManager: { getSubscription: async () => null, subscribe: async () => sub } };
    vi.stubGlobal('Notification', { requestPermission: async () => 'granted', permission: 'default' });
    vi.stubGlobal('navigator', { serviceWorker: { register: async (url: unknown) => (registered.push(url), reg), getRegistration: async () => reg } });
    const push = await import('../src/lib/push.ts');
    // Importing the module creates nothing.
    expect(created).toEqual([]);
    await push.enablePush('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    await push.enablePush('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    expect(created.map((c) => c.name)).toEqual(['crove-sw']);
    expect(Object.keys(created[0]?.rules ?? {})).toEqual(['createScriptURL']);
    expect(registered).toEqual(['/assets/sw.js', '/assets/sw.js']);
  });
});

describe('forgetting this device on sign-out', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function withSubscription(endpoint: string | null) {
    let unsubscribed = 0;
    const sub = endpoint ? { endpoint, unsubscribe: async () => (unsubscribed++, true) } : null;
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('window', { isSecureContext: true, PushManager: class {}, Notification: {} });
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) } });
    const push = await import('../src/lib/push.ts');
    return { push, unsubscribed: () => unsubscribed };
  }

  it("removes this device's row, then ends the browser's subscription, even when the row cannot be removed", async () => {
    const ok = await withSubscription('https://push.example/1');
    const removed: string[] = [];
    await ok.push.forgetPushDevice(async (e) => removed.push(e));
    expect(removed).toEqual(['https://push.example/1']);
    expect(ok.unsubscribed()).toBe(1);
    vi.resetModules();
    const failing = await withSubscription('https://push.example/2');
    await failing.push.forgetPushDevice(() => Promise.reject(new Error('offline')));
    expect(failing.unsubscribed()).toBe(1);
    vi.resetModules();
    const slow = await withSubscription('https://push.example/3');
    await slow.push.forgetPushDevice(() => new Promise(() => undefined), 10);
    expect(slow.unsubscribed()).toBe(1);
  });

  it('does nothing without a subscription', async () => {
    const none = await withSubscription(null);
    const removed: string[] = [];
    await none.push.forgetPushDevice(async (e) => removed.push(e));
    expect(removed).toEqual([]);
  });
});

describe('push helpers', () => {
  it('names the browser and the system of a user agent', () => {
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')).toEqual({ browser: 'Chrome', os: 'Windows' });
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toEqual({ browser: 'Edge', os: 'Windows' });
    expect(deviceOf('Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0')).toEqual({ browser: 'Firefox', os: 'Linux' });
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Safari', os: 'iOS' });
    expect(deviceOf('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')).toEqual({ browser: 'Chrome', os: 'Android' });
    expect(deviceOf('curl/8')).toEqual({ browser: null, os: null });
  });

  it('reads a base64url key into bytes', () => {
    expect([...keyBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });
});

// The service worker run in a sandbox with a fake ServiceWorkerGlobalScope.
function loadWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://crove.example' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined, openWindow: async (url: string) => (opened.push(url), null) },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => (shown.push({ title, options }), undefined) },
  };
  runInNewContext(SW_SOURCE, { self, URL });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { listeners, shown, opened, fire };
}

describe('the service worker', () => {
  const POST = '/o/acme/social/0193b3a0-1c2d-7e4f-8a9b-0c1d2e3f4a5b';

  it('handles push and notification clicks only: no fetch handler, no imported script', () => {
    const w = loadWorker();
    expect([...w.listeners.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
    // The code, without its comments (which name what it does not do).
    const code = SW_SOURCE.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/importScripts|addEventListener\(\s*['"]fetch|caches\b|\bfetch\s*\(|\beval\b|new Function/);
  });

  it('shows the push and opens a Crove path of its own origin', async () => {
    const w = loadWorker();
    await w.fire('push', { data: { json: () => ({ title: 'Crove', body: 'Có bài đang chờ bạn duyệt', url: POST, tag: 'review_requested:x' }) } });
    expect(w.shown).toEqual([{ title: 'Crove', options: { body: 'Có bài đang chờ bạn duyệt', tag: 'review_requested:x', icon: '/assets/icon-192.png', data: { path: POST } } }]);
    let closed = false;
    await w.fire('notificationclick', { notification: { data: w.shown[0]?.options.data, close: () => (closed = true) } });
    expect(closed).toBe(true);
    expect(w.opened).toEqual([`https://crove.example${POST}`]);
  });

  it('opens the posts assigned to the reader (#1359)', async () => {
    const w = loadWorker();
    await w.fire('push', { data: { json: () => ({ title: 'Crove', body: 'Bạn được giao 3 bài mới', url: '/o/acme/social?assignee=me', tag: 'assigned:x' }) } });
    await w.fire('notificationclick', { notification: { data: w.shown[0]?.options.data, close: () => undefined } });
    expect(w.opened).toEqual(['https://crove.example/o/acme/social?assignee=me']);
  });

  it('opens nothing for a link that is not a Crove notification path', async () => {
    const w = loadWorker();
    for (const url of ['https://evil.example/o/acme/social/channels', '//evil.example/o/acme/social/channels', 'javascript:alert(1)', '/o/acme/settings', '/o/acme/social/channels?x=1', `${POST}#x`, '/o/acme/social/new?channel=x', '/o/acme/social?assignee=other', '/o/acme/social?assignee=me&x=1', '/o/acme/social']) {
      await w.fire('push', { data: { json: () => ({ title: 'Crove', body: 'x', url }) } });
      await w.fire('notificationclick', { notification: { data: w.shown.at(-1)?.options.data, close: () => undefined } });
    }
    expect(w.shown.every((s) => (s.options.data as { path: unknown }).path === null)).toBe(true);
    expect(w.opened).toEqual([]);
    // A push that is not JSON still shows, with no link.
    await w.fire('push', { data: { json: () => JSON.parse('not json') } });
    expect(w.shown.at(-1)).toMatchObject({ title: 'Crove', options: { body: '', data: { path: null } } });
  });
});
