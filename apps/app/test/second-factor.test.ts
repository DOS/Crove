// /mfa decides from the server when the session says no second factor is due (#345): a factor enabled on another device
// is missing from the cached session until the token refreshes, and the cached answer alone loops between /mfa and the
// app (the kernel refuses with MFA_REQUIRED, which opens /mfa again).
import { describe, expect, it } from 'vitest';
import { needsSecondFactorNow } from '../src/lib/auth.ts';

type Level = { currentLevel: string | null; nextLevel: string | null } | null;
type Factor = { id: string; status: 'verified' | 'unverified' };

function fakeClient(level: Level | Error, factors: Factor[] | null) {
  let listed = 0;
  const client = {
    mfa: {
      getAuthenticatorAssuranceLevel: async () => (level instanceof Error ? { data: null, error: level } : { data: level, error: null }),
      listFactors: async () => {
        listed += 1;
        return factors === null ? { data: null, error: new Error('network') } : { data: { all: factors, totp: factors.filter((f) => f.status === 'verified') }, error: null };
      },
    },
  };
  return { client: client as unknown as Parameters<typeof needsSecondFactorNow>[0], listed: () => listed };
}

describe('needsSecondFactorNow', () => {
  it('trusts the session when it already says a second factor is due, or that the session has one', async () => {
    const due = fakeClient({ currentLevel: 'aal1', nextLevel: 'aal2' }, []);
    expect(await needsSecondFactorNow(due.client)).toBe(true);
    expect(due.listed()).toBe(0);
    const done = fakeClient({ currentLevel: 'aal2', nextLevel: 'aal2' }, [{ id: 'f1', status: 'verified' }]);
    expect(await needsSecondFactorNow(done.client)).toBe(false);
    expect(done.listed()).toBe(0);
  });

  it('asks the server when the session lists no factor, and finds one enabled on another device', async () => {
    const stale = fakeClient({ currentLevel: 'aal1', nextLevel: 'aal1' }, [{ id: 'f1', status: 'verified' }]);
    expect(await needsSecondFactorNow(stale.client)).toBe(true);
    expect(stale.listed()).toBe(1);
  });

  it('needs none when the server has no verified factor either', async () => {
    expect(await needsSecondFactorNow(fakeClient({ currentLevel: 'aal1', nextLevel: 'aal1' }, [{ id: 'f1', status: 'unverified' }]).client)).toBe(false);
    expect(await needsSecondFactorNow(fakeClient({ currentLevel: 'aal1', nextLevel: 'aal1' }, []).client)).toBe(false);
    expect(await needsSecondFactorNow(fakeClient(null, [{ id: 'f1', status: 'verified' }]).client)).toBe(false);
  });

  // A failed answer counted as "no factor" would send the user back to the app, whose next request the kernel refuses
  // with MFA_REQUIRED, and round again; thrown, it reaches the router's error page.
  it('throws when Supabase Auth cannot answer', async () => {
    await expect(needsSecondFactorNow(fakeClient({ currentLevel: 'aal1', nextLevel: 'aal1' }, null).client)).rejects.toThrow('network');
    await expect(needsSecondFactorNow(fakeClient(new Error('no session'), []).client)).rejects.toThrow('no session');
  });
});
