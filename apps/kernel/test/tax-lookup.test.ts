// Onboarding by tax code (issue #324), unit part: the public tax registry lookup against a fake provider, its
// configuration, and the flag the app reads from /api/config. The address command and the RPC on a real database are
// in onboarding.db.test.ts.
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createTaxCodeLookup, type TaxCodeLookup } from '../src/tax-lookup.ts';

const URL_TEMPLATE = 'https://registry.example.test/v2/business/{taxCode}?key=provider-secret-789';

interface Call {
  url: string;
  init: RequestInit;
}

// A provider that answers `body` (an object is sent as JSON) with `status`, and records each request.
function provider(body: unknown = { code: '00', desc: 'Success', data: { id: '0101234564', name: 'CÔNG TY TNHH ABC', address: 'Số 1 Phố Huế, Hà Nội' } }, status = 200) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return `${(error as { status?: number }).status} ${(error as { code?: string }).code}`;
  }
};

afterEach(() => vi.restoreAllMocks());

describe('tax registry lookup', () => {
  it('asks the provider with the normalized tax code and answers its name and address on one line', async () => {
    const registry = provider({ code: '00', data: { name: '  CÔNG TY\nTNHH   ABC ', address: 'Số 1\tPhố Huế,\r\nHà Nội\u0007' } });
    const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch });
    expect(await lookup.lookup(' 0101.234.564 ', 'user-1')).toEqual({ taxCode: '0101234564', name: 'CÔNG TY TNHH ABC', address: 'Số 1 Phố Huế, Hà Nội' });
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0]?.url).toBe('https://registry.example.test/v2/business/0101234564?key=provider-secret-789');
    expect(registry.calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error', headers: { accept: 'application/json' } });
    expect(registry.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('looks up a dependent unit by its 13-character code, and answers a missing address as null', async () => {
    const registry = provider({ code: '00', data: { name: 'Chi nhánh ABC', address: null } });
    const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch });
    expect(await lookup.lookup('0101234564001', 'user-1')).toEqual({ taxCode: '0101234564-001', name: 'Chi nhánh ABC', address: null });
    expect(registry.calls[0]?.url).toContain('/business/0101234564-001?');
  });

  it('cuts a name longer than an org name may be, and an address longer than 500 characters', async () => {
    const registry = provider({ code: '00', data: { name: 'N'.repeat(300), address: 'A'.repeat(800) } });
    const entry = await createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch }).lookup('0101234564', 'user-1');
    expect(entry.name).toHaveLength(200);
    expect(entry.address).toHaveLength(500);
  });

  it('refuses a value that is not a tax code without asking the provider', async () => {
    const registry = provider();
    const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch });
    for (const bad of ['12345', '0101234564/../x', '01012345640011', '']) expect(await codeOf(lookup.lookup(bad, 'user-1')), bad).toBe('422 INVALID_TAX_CODE');
    expect(registry.calls).toEqual([]);
  });

  it('answers TAX_CODE_NOT_FOUND for any code but 00 or an entry without a name, and remembers it', async () => {
    for (const body of [{ code: '51', desc: 'Not found', data: null }, { code: '00', data: null }, { code: '00', data: { name: '   ' } }]) {
      const registry = provider(body);
      const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch });
      expect(await codeOf(lookup.lookup('0101234564', 'user-1')), JSON.stringify(body)).toBe('404 TAX_CODE_NOT_FOUND');
      expect(await codeOf(lookup.lookup('0101234564', 'user-1'))).toBe('404 TAX_CODE_NOT_FOUND');
      expect(registry.calls).toHaveLength(1);
    }
  });

  it('answers TAX_LOOKUP_UNAVAILABLE when the provider fails, logs only its host, and does not remember the failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [body, status] of [
      ['{}', 500],
      ['{}', 429],
      ['not json', 200],
      [{ unexpected: true }, 200],
      ['x'.repeat(70 * 1024), 200],
    ] as const) {
      const registry = provider(body, status);
      const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch });
      expect(await codeOf(lookup.lookup('0101234564', 'user-1')), `${status} ${String(body).slice(0, 20)}`).toBe('503 TAX_LOOKUP_UNAVAILABLE');
      expect(await codeOf(lookup.lookup('0101234564', 'user-1'))).toBe('503 TAX_LOOKUP_UNAVAILABLE');
      expect(registry.calls).toHaveLength(2);
    }
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    expect(await codeOf(createTaxCodeLookup(URL_TEMPLATE, { fetch: offline }).lookup('0101234564', 'user-1'))).toBe('503 TAX_LOOKUP_UNAVAILABLE');
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('[tax-lookup] registry.example.test failed: fetch failed');
    expect(logged).toContain('[tax-lookup] registry.example.test failed: HTTP 500');
    expect(logged).not.toContain('provider-secret-789');
  });

  it('serves a found entry from the cache for a day, then asks again', async () => {
    let now = 1_000_000;
    const registry = provider();
    const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch, now: () => now });
    await lookup.lookup('0101234564', 'user-1');
    now += 23 * 60 * 60 * 1000;
    await lookup.lookup('0101234564', 'user-1');
    expect(registry.calls).toHaveLength(1);
    now += 2 * 60 * 60 * 1000;
    await lookup.lookup('0101234564', 'user-1');
    expect(registry.calls).toHaveLength(2);
  });

  it('keeps at most cacheSize codes, dropping the oldest, and shares one request between concurrent lookups', async () => {
    const registry = provider();
    const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch, cacheSize: 2 });
    await Promise.all([lookup.lookup('0101234564', 'user-1'), lookup.lookup('0101234564', 'user-1'), lookup.lookup('0101.234.564', 'user-1')]);
    expect(registry.calls).toHaveLength(1);
    await lookup.lookup('0309876546', 'user-1');
    await lookup.lookup('0312345678', 'user-1');
    await lookup.lookup('0312345678', 'user-1');
    expect(registry.calls).toHaveLength(3);
    await lookup.lookup('0101234564', 'user-1');
    expect(registry.calls).toHaveLength(4);
  });
});

describe('tax registry lookup limits', () => {
  it('limits provider requests per user and per process, and never counts an answer from the cache', async () => {
    let now = 1_000_000;
    const registry = provider();
    const lookup = createTaxCodeLookup(URL_TEMPLATE, { fetch: registry.fetch, perUserPerMinute: 2, perMinute: 3, now: () => now });
    await lookup.lookup('0101234564', 'user-1');
    await lookup.lookup('0309876546', 'user-1');
    // Cached: no provider request, so no limit spent.
    for (let i = 0; i < 5; i++) await lookup.lookup('0101234564', 'user-1');
    expect(await codeOf(lookup.lookup('0312345678', 'user-1'))).toBe('429 RATE_LIMITED');
    // Another user still has their own budget, until the process-wide one runs out.
    await lookup.lookup('0312345678', 'user-2');
    expect(await codeOf(lookup.lookup('0311111112', 'user-3'))).toBe('429 RATE_LIMITED');
    expect(registry.calls).toHaveLength(3);
    now += 60_000;
    await lookup.lookup('0311111112', 'user-1');
    expect(registry.calls).toHaveLength(4);
  });
});

describe('tax registry lookup configuration', () => {
  const base = { DATABASE_URL: 'postgres://crove_app:pw@localhost:5432/crove', AUTH_JWT_SECRET: 'x'.repeat(40), AUTH_ISSUER: 'crove-auth' };

  it('is off when TAX_CODE_LOOKUP_URL is unset, and takes an https template with {taxCode}', () => {
    expect(loadConfig(base).TAX_CODE_LOOKUP_URL).toBeUndefined();
    expect(loadConfig({ ...base, TAX_CODE_LOOKUP_URL: ' ' }).TAX_CODE_LOOKUP_URL).toBeUndefined();
    expect(loadConfig({ ...base, TAX_CODE_LOOKUP_URL: 'https://api.vietqr.io/v2/business/{taxCode}' }).TAX_CODE_LOOKUP_URL).toBe('https://api.vietqr.io/v2/business/{taxCode}');
    for (const url of ['http://api.vietqr.io/v2/business/{taxCode}', 'https://api.vietqr.io/v2/business/', 'file:///etc/{taxCode}', 'not a url {taxCode}']) {
      expect(() => loadConfig({ ...base, TAX_CODE_LOOKUP_URL: url }), url).toThrow(/TAX_CODE_LOOKUP_URL/);
    }
  });

  it('tells the app through /api/config whether the lookup is on', async () => {
    const flag = async (taxLookup?: TaxCodeLookup) => {
      const app = createHttpApp({
        config: loadConfig({ ...base, WEB_DIST: '/nonexistent' }),
        runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
        store: {} as BlobStore,
        authenticate: async () => {
          throw new Error('not used');
        },
        pool: {} as pg.Pool,
        aiEnabled: false,
        ...(taxLookup ? { taxLookup } : {}),
      });
      return ((await (await app.request('/api/config')).json()) as { taxCodeLookup: unknown }).taxCodeLookup;
    };
    expect(await flag()).toBe(false);
    expect(await flag(createTaxCodeLookup(URL_TEMPLATE, { fetch: provider().fetch }))).toBe(true);
  });
});
