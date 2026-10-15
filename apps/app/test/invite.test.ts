// The pending invite token kept in this browser while the invitee signs in (issue #134: a time limit, and gone
// on sign-out).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_INVITE_TTL_MS, forgetInvite, pendingInvite, rememberInvite } from '../src/lib/invite.ts';

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
