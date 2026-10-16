// Binds the sign-out helper to the app's API and auth clients. Every "Đăng xuất" control goes through signOut().
import { orglessClient, orpc, queryClient } from './api.ts';
import { auth } from './auth.ts';
import { forgetInvite } from './invite.ts';
import { sessionIdFromToken } from './sessions.ts';
import { signOutWithRevoke } from './sign-out.ts';

// Revokes this session in Crove, then signs this device out of Supabase Auth (auth-js tells the other tabs, and
// main.tsx sends every tab to /login). Scope is local: signing out everywhere is the sessions screen's job.
// A pending invite token is dropped too, so a shared browser does not keep it for the next person (#134); only the
// invite page's "use another email" keeps it (keepInvite), to come back to the invite after signing in again.
export function signOut(options: { keepInvite?: boolean } = {}): Promise<void> {
  if (!options.keepInvite) forgetInvite();
  return signOutWithRevoke({
    // The kernel's user id (me.get), not Supabase Auth's: a revoke names the Crove user (issue #184).
    currentSession: async () => {
      const { data } = await auth().getSession();
      const sessionId = sessionIdFromToken(data.session?.access_token);
      if (!data.session || !sessionId) return null;
      // Fresh, never cached: another tab may have signed in as someone else in the last few seconds (#196).
      const me = await queryClient.fetchQuery({ ...orpc.me.get.queryOptions(), staleTime: 0 });
      return { userId: me.userId, sessionId };
    },
    // Without the org header on every page: an org that refused this session cannot swallow its revoke (#247).
    revoke: (input, signal) => orglessClient.sessions.revoke(input, { signal }),
    signOut: () => auth().signOut({ scope: 'local' }),
  });
}
