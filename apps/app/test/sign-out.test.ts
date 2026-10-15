// The sign-out helper (issue #150): the revoke is best effort, the sign-out always happens.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signOutWithRevoke } from '../src/lib/sign-out.ts';

const session = { userId: 'u1', sessionId: 's1' };

afterEach(() => vi.useRealTimers());

describe('signOutWithRevoke', () => {
  it('revokes the current session before signing out', async () => {
    const order: string[] = [];
    await signOutWithRevoke({
      currentSession: async () => session,
      revoke: async (input) => void order.push(`revoke:${input.userId}:${input.sessionId}`),
      signOut: async () => void order.push('signOut'),
    });
    expect(order).toEqual(['revoke:u1:s1', 'signOut']);
  });

  it('signs out when the revoke fails', async () => {
    const signOut = vi.fn(async () => undefined);
    await signOutWithRevoke({ currentSession: async () => session, revoke: async () => Promise.reject(new Error('boom')), signOut });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('signs out after the timeout when the revoke hangs, and aborts it', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const signOut = vi.fn(async () => undefined);
    const done = signOutWithRevoke({
      currentSession: async () => session,
      revoke: (_input, signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise(() => undefined);
      },
      signOut,
      timeoutMs: 3000,
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(signOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(signOut).toHaveBeenCalledOnce();
    expect(aborted).toBe(true);
  });

  it('skips the revoke when there is no session and still signs out', async () => {
    const revoke = vi.fn(async () => undefined);
    const signOut = vi.fn(async () => undefined);
    await signOutWithRevoke({ currentSession: async () => null, revoke, signOut });
    expect(revoke).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('signs out when reading the session throws', async () => {
    const signOut = vi.fn(async () => undefined);
    await signOutWithRevoke({ currentSession: async () => Promise.reject(new Error('storage')), revoke: async () => undefined, signOut });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('signs out at the timeout when reading the session hangs', async () => {
    vi.useFakeTimers();
    const signOut = vi.fn(async () => undefined);
    const done = signOutWithRevoke({ currentSession: () => new Promise(() => undefined), revoke: async () => undefined, signOut, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(signOut).toHaveBeenCalledOnce();
  });
});
