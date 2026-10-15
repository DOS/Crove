// Binds the sign-out helper to the app's API and auth clients. Every "Đăng xuất" control goes through signOut().
import { client } from './api.ts';
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
    currentSession: async () => {
      const { data } = await auth().getSession();
      const sessionId = sessionIdFromToken(data.session?.access_token);
      return data.session && sessionId ? { userId: data.session.user.id, sessionId } : null;
    },
    revoke: (input, signal) => client.sessions.revoke(input, { signal }),
    signOut: () => auth().signOut({ scope: 'local' }),
  });
}
