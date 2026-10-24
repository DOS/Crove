// Cloudflare Turnstile on the public booking form (#1353): both keys or neither; with them the site key reaches the app,
// the SPA's CSP lets Turnstile's script and frame in, and a booking request is refused unless its token checks out with
// Cloudflare. Without them nothing changes. Polls of a request are never checked.
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { contentSecurityPolicy, createHttpApp } from '../src/http.ts';
import { TURNSTILE_VERIFY_URL, createTurnstileVerifier, type TurnstileVerifier } from '../src/turnstile.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
const KEYS = { TURNSTILE_SITE_KEY: '0x4AAAAAAAtest', TURNSTILE_SECRET: '0x4AAAAAAAsecret' };
const REQUEST = { startsAt: '2026-11-02T02:00:00.000Z', name: 'Nguyễn Văn Khách', email: 'khach@example.test', timeZone: 'Asia/Ho_Chi_Minh' };

function app(env: Record<string, string>, turnstile?: TurnstileVerifier | null) {
  const orgless = vi.fn(async () => 'booking-id');
  const http = createHttpApp({
    config: loadConfig({ ...base, ...env }),
    runtime: { installed: () => true, modules: () => ['kernel', 'crm'], orgless } as unknown as Runtime,
    store: {} as BlobStore,
    authenticate: async () => {
      throw new Error('not used');
    },
    pool: {} as pg.Pool,
    aiEnabled: false,
    ...(turnstile !== undefined ? { turnstile } : {}),
  });
  const post = (body: unknown) => http.request('/api/booking/cong-ty/tu-van', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { http, orgless, post };
}

describe('Turnstile on the booking form (#1353)', () => {
  it('takes both keys or neither', () => {
    expect(loadConfig(base).TURNSTILE_SITE_KEY).toBeUndefined();
    expect(loadConfig({ ...base, ...KEYS }).TURNSTILE_SITE_KEY).toBe(KEYS.TURNSTILE_SITE_KEY);
    expect(() => loadConfig({ ...base, TURNSTILE_SITE_KEY: KEYS.TURNSTILE_SITE_KEY })).toThrow(/both TURNSTILE_SITE_KEY and TURNSTILE_SECRET/);
    expect(() => loadConfig({ ...base, TURNSTILE_SECRET: KEYS.TURNSTILE_SECRET })).toThrow(/both TURNSTILE_SITE_KEY and TURNSTILE_SECRET/);
    expect(() => loadConfig({ ...base, ...KEYS, TURNSTILE_SITE_KEY: 'not a key<' })).toThrow(/TURNSTILE_SITE_KEY/);
    // Cloudflare's test keys pass any token: fine locally, refused on a public URL.
    const TEST = { TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' };
    expect(loadConfig({ ...base, ...TEST }).TURNSTILE_SECRET).toBe(TEST.TURNSTILE_SECRET);
    const pub = { ...base, PUBLIC_URL: 'https://crove.example.com' };
    expect(() => loadConfig({ ...pub, ...TEST })).toThrow(/Cloudflare's test keys/);
    expect(() => loadConfig({ ...pub, ...KEYS, TURNSTILE_SECRET: '2x0000000000000000000000000000000AA' })).toThrow(/Cloudflare's test keys/);
    expect(() => loadConfig({ ...pub, ...KEYS, TURNSTILE_SITE_KEY: '3x00000000000000000000FF' })).toThrow(/Cloudflare's test keys/);
  });

  it('hands the site key to the app, or null', async () => {
    const key = async (env: Record<string, string>) => ((await (await app(env).http.request('/api/config')).json()) as { turnstileSiteKey: unknown }).turnstileSiteKey;
    expect(await key({})).toBeNull();
    expect(await key(KEYS)).toBe(KEYS.TURNSTILE_SITE_KEY);
  });

  it("lets Turnstile's script, frame and Trusted Types policy into the CSP only when the keys are set", () => {
    const off = contentSecurityPolicy('/auth/v1', null);
    expect(off).not.toContain('challenges.cloudflare.com');
    expect(off.endsWith('trusted-types crove-sw')).toBe(true);
    const on = new Map(
      contentSecurityPolicy('/auth/v1', null, true)
        .split('; ')
        .map((d) => [d.slice(0, d.indexOf(' ')), d.slice(d.indexOf(' ') + 1)]),
    );
    expect(on.get('script-src')).toBe("'self' https://challenges.cloudflare.com");
    expect(on.get('frame-src')).toBe('https://challenges.cloudflare.com');
    expect(on.get('trusted-types')).toBe('crove-sw crove-turnstile');
    expect(on.get('require-trusted-types-for')).toBe("'script'");
  });

  it('records requests as before when the deployment sets no keys', async () => {
    const { post, orgless } = app({});
    const res = await post(REQUEST);
    expect(res.status).toBe(202);
    expect(orgless).toHaveBeenCalledTimes(1);
  });

  it('refuses a request without a good token before recording anything, and records one with a good token', async () => {
    const verify = vi.fn<TurnstileVerifier>(async (token) => token === 'good');
    const { post, orgless } = app(KEYS, verify);
    for (const body of [REQUEST, { ...REQUEST, turnstile: 'bad' }, { ...REQUEST, turnstile: 7 }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'BOOKING_CHECK_FAILED' });
    }
    expect(orgless).not.toHaveBeenCalled();
    const ok = await post({ ...REQUEST, turnstile: 'good' });
    expect(ok.status).toBe(202);
    expect(orgless).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenLastCalledWith('good', null);
    // A poll of a request carries the request token only and is not checked.
    verify.mockClear();
    await post({ token: 'A'.repeat(43) });
    expect(verify).not.toHaveBeenCalled();
  });

  it('asks siteverify with the secret, the token and the address, and takes only success: true', async () => {
    const calls: { url: string; body: string }[] = [];
    const answer = (reply: () => Promise<Response>) =>
      createTurnstileVerifier('the-secret', (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return reply();
      }) as typeof fetch);
    expect(await answer(async () => Response.json({ success: true }))('tok', '203.0.113.7')).toBe(true);
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({ secret: 'the-secret', response: 'tok', remoteip: '203.0.113.7' });
    expect(await answer(async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }))('tok', null)).toBe(false);
    expect(await answer(async () => Response.json({ success: 'true' }))('tok', null)).toBe(false);
    expect(await answer(async () => new Response('nope', { status: 500 }))('tok', null)).toBe(false);
    expect(await answer(async () => Promise.reject(new TypeError('fetch failed')))('tok', null)).toBe(false);
    // No call for an empty or oversized token.
    calls.length = 0;
    expect(await answer(async () => Response.json({ success: true }))('', null)).toBe(false);
    expect(await answer(async () => Response.json({ success: true }))('x'.repeat(3000), null)).toBe(false);
    expect(calls).toEqual([]);
  });
});
