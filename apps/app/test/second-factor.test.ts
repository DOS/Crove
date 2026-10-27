// /mfa decides from the server when the session says no second factor is due (#345): a factor enabled on another device
// is missing from the cached session until the token refreshes, and the cached answer alone loops between /mfa and the
// app (the kernel refuses with MFA_REQUIRED, which opens /mfa again).
import { describe, expect, it, vi } from 'vitest';
import { MFA_WAIT_MS, needsSecondFactorNow, secondFactorStillOwed, verifySecondFactor } from '../src/lib/auth.ts';

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

// A request sent just before this tab verified a factor comes back MFA_REQUIRED (#1611): the answer waits for the
// verification, and the session it saved owes nothing, so the screen and its step-up are not dropped for /mfa.
describe('secondFactorStillOwed', () => {
  function verifyingClient() {
    let level = { currentLevel: 'aal1', nextLevel: 'aal2' };
    let finish = () => {};
    const client = {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: level, error: null }),
        listFactors: async () => ({ data: { all: [], totp: [] }, error: null }),
        challengeAndVerify: () =>
          new Promise((resolve) => {
            finish = () => {
              level = { currentLevel: 'aal2', nextLevel: 'aal2' };
              resolve({ data: {}, error: null });
            };
          }),
      },
    };
    return { client: client as unknown as Parameters<typeof secondFactorStillOwed>[0], finish: () => finish() };
  }

  it('waits for the verification in flight, then owes nothing', async () => {
    const { client, finish } = verifyingClient();
    const verified = verifySecondFactor({ factorId: 'f1', code: '123456' }, client);
    const owed = secondFactorStillOwed(client);
    finish();
    await verified;
    expect(await owed).toBe(false);
  });

  it('still owes the factor with no verification under way', async () => {
    expect(await secondFactorStillOwed(fakeClient({ currentLevel: 'aal1', nextLevel: 'aal2' }, []).client)).toBe(true);
  });

  it('still owes the factor when the code was refused', async () => {
    const { client } = verifyingClient();
    const refused = { mfa: { ...client?.mfa, challengeAndVerify: async () => ({ data: null, error: new Error('mfa_verification_failed') }) } };
    await verifySecondFactor({ factorId: 'f1', code: '000000' }, refused as unknown as typeof client);
    expect(await secondFactorStillOwed(refused as unknown as typeof client)).toBe(true);
  });

  it('decides from the session as it is when the verification never answers', async () => {
    vi.useFakeTimers();
    try {
      const { client, finish } = verifyingClient();
      const verified = verifySecondFactor({ factorId: 'f1', code: '123456' }, client);
      const owed = secondFactorStillOwed(client);
      await vi.advanceTimersByTimeAsync(MFA_WAIT_MS);
      expect(await owed).toBe(true);
      // Settled for the tests after this one, which share the module.
      finish();
      await verified;
    } finally {
      vi.useRealTimers();
    }
  });
});

// A check that never answers (Supabase Auth hangs) counts as owed (coordinator review of #1611): /mfa opens, and the
// tab is never left waiting with every later MFA_REQUIRED ignored.
describe('secondFactorStillOwed when Supabase Auth hangs', () => {
  it('counts a check that never answers as owed', async () => {
    vi.useFakeTimers();
    try {
      const hanging = {
        mfa: {
          getAuthenticatorAssuranceLevel: () => new Promise(() => {}),
          listFactors: () => new Promise(() => {}),
        },
      } as unknown as Parameters<typeof secondFactorStillOwed>[0];
      const owed = secondFactorStillOwed(hanging);
      await vi.advanceTimersByTimeAsync(MFA_WAIT_MS);
      expect(await owed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // openMfa counts a failed check as owed; the failure itself is not swallowed into an answer here.
  it('passes on a check that fails', async () => {
    await expect(secondFactorStillOwed(fakeClient(new Error('no session'), []).client)).rejects.toThrow('no session');
  });
});
