// The pending invite token kept in this browser while the invitee signs in (issue #134: a time limit, and gone
// on sign-out).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITE_TOKEN_HEADER, PENDING_INVITE_TTL_MS, forgetInvite, pendingInvite, rememberInvite, withInviteToken } from '../src/lib/invite.ts';

const TOKEN = 'A'.repeat(43);
const KEY = 'crove-pending-invite';

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe('pending invite storage', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the token for the time limit only, then removes it', () => {
    const now = 1_800_000_000_000;
    rememberInvite(TOKEN, now);
    expect(pendingInvite(now)).toBe(TOKEN);
    expect(pendingInvite(now + PENDING_INVITE_TTL_MS - 1)).toBe(TOKEN);
    expect(pendingInvite(now + PENDING_INVITE_TTL_MS)).toBeNull();
    expect(storage.items.has(KEY)).toBe(false);
  });

  it('is much shorter than an invite (7 days)', () => {
    expect(PENDING_INVITE_TTL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('drops a token saved in the future, a malformed entry or the bare token of an older version', () => {
    const now = 1_800_000_000_000;
    for (const raw of [
      JSON.stringify({ token: TOKEN, savedAt: now + 60_000 }),
      JSON.stringify({ token: 'short', savedAt: now }),
      JSON.stringify({ token: TOKEN }),
      '{not json',
      TOKEN,
    ]) {
      storage.setItem(KEY, raw);
      expect(pendingInvite(now)).toBeNull();
      expect(storage.items.has(KEY)).toBe(false);
    }
  });

  it('is forgotten on request (an answered invite, or signing out)', () => {
    rememberInvite(TOKEN);
    forgetInvite();
    expect(pendingInvite()).toBeNull();
  });

  it('works without storage (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => rememberInvite(TOKEN)).not.toThrow();
    expect(pendingInvite()).toBeNull();
    expect(() => forgetInvite()).not.toThrow();
  });
});

// A sign-up from an accept link carries the token for the kernel's sign-up policy (#563): someone who only knows an
// invited address cannot create that account first with their own password.
describe('the invite token on a sign-up', () => {
  const ORIGIN = 'https://crove.example.test';
  let storage: MemoryStorage;
  let calls: { url: string; init: RequestInit | undefined }[];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('{}');
  }) as typeof fetch;
  const tokenOf = (init: RequestInit | undefined) => new Headers(init?.headers).get(INVITE_TOKEN_HEADER);
  beforeEach(() => {
    storage = new MemoryStorage();
    calls = [];
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds the pending token to a sign-up sent to this origin, keeping the other headers', async () => {
    rememberInvite(TOKEN);
    const send = withInviteToken(base, ORIGIN);
    await send(`${ORIGIN}/auth/v1/signup`, { method: 'POST', headers: { apikey: 'anon', 'content-type': 'application/json' }, body: '{}' });
    expect(tokenOf(calls[0]?.init)).toBe(TOKEN);
    expect(new Headers(calls[0]?.init?.headers).get('apikey')).toBe('anon');
    expect(calls[0]?.init?.body).toBe('{}');
  });

  it('adds nothing without a pending invite, to other requests, or to a Supabase Auth on another origin', async () => {
    const send = withInviteToken(base, ORIGIN);
    await send(`${ORIGIN}/auth/v1/signup`, { method: 'POST' });
    rememberInvite(TOKEN);
    await send(`${ORIGIN}/auth/v1/token?grant_type=password`, { method: 'POST' });
    await send(`${ORIGIN}/auth/v1/signup`, { method: 'GET' });
    await send('https://project.supabase.example.test/auth/v1/signup', { method: 'POST' });
    expect(calls.map((c) => tokenOf(c.init))).toEqual([null, null, null, null]);
  });
});
