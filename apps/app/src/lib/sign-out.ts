// One sign-out path for the SPA (issue #150). A Supabase sign-out leaves the access token valid until it expires, so
// the current session is revoked in Crove first (an own revoke is immediate), then the Supabase session is ended.
// The revoke is best effort: it never blocks or prevents the sign-out. No browser or API imports, so it is unit tested.

export const REVOKE_TIMEOUT_MS = 3000;

export interface SignOutDeps {
  // The signed-in user and Supabase Auth session id, or null when nobody is signed in or the token has no session id.
  currentSession: () => Promise<{ userId: string; sessionId: string } | null>;
  revoke: (input: { userId: string; sessionId: string }, signal: AbortSignal) => Promise<unknown>;
  signOut: () => Promise<unknown>;
  timeoutMs?: number;
}

export async function signOutWithRevoke(deps: SignOutDeps): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, deps.timeoutMs ?? REVOKE_TIMEOUT_MS);
    });
    // The budget covers reading the session too: auth-js can retry a token refresh for a long time when offline.
    const revoke = (async () => {
      const session = await deps.currentSession();
      if (session) await deps.revoke(session, controller.signal);
    })();
    revoke.catch(() => undefined);
    await Promise.race([revoke, timeout]);
  } catch {
    // A failed revoke must not keep the user signed in; the token then lives until it expires, as before.
  } finally {
    clearTimeout(timer);
  }
  await deps.signOut();
}
