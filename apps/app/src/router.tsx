import { Outlet, createRootRoute, createRoute, createRouter, redirect, type ErrorComponentProps } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from './components/ui.tsx';
import { getCurrentOrg, isUnauthenticated, orpc, queryClient, setCurrentOrg } from './lib/api.ts';
import { accessToken, auth, getConfig } from './lib/auth.ts';
import { signOut } from './lib/session-actions.ts';
import { pendingInvite, rememberInvite, takeTokenFromHash } from './lib/invite.ts';
import { AuthPage } from './routes/auth.tsx';
import { DocumentsPage } from './routes/documents.tsx';
import { InboxDetailPage } from './routes/inbox-detail.tsx';
import { InboxPage } from './routes/inbox.tsx';
import { InvitePage } from './routes/invite.tsx';
import { JournalPage } from './routes/journal.tsx';
import { OnboardingPage } from './routes/onboarding.tsx';
import { OrgLayout } from './routes/org-layout.tsx';
import { SettingsPage } from './routes/settings.tsx';
import { VendorsPage } from './routes/vendors.tsx';

async function requireAuth() {
  if (!(await accessToken())) throw redirect({ to: '/login' });
}

function ErrorPage({ error }: ErrorComponentProps) {
  const t = useTranslations('common');
  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-fg">{t('error')}</h1>
        <p className="mt-2 text-sm text-fg-2">{error instanceof Error ? error.message : t('unknownError')}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => window.location.reload()}>{t('reload')}</Button>
          <Button variant="ghost" onClick={() => void signOut().then(() => window.location.assign('/login'))}>
            {t('signOut')}
          </Button>
        </div>
      </div>
    </main>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet />, errorComponent: ErrorPage });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    await requireAuth();
    // An invite opened before signing in (or signing up) is answered first.
    if (pendingInvite()) throw redirect({ to: '/-/invite' });
    const me = await queryClient.fetchQuery(orpc.me.get.queryOptions()).catch(async (error: unknown) => {
      if (!isUnauthenticated(error)) throw error;
      await auth().signOut({ scope: 'local' });
      throw redirect({ to: '/login' });
    });
    const first = me.orgs[0];
    if (first) throw redirect({ to: '/o/$slug/inbox', params: { slug: first.slug } });
    throw redirect({ to: '/onboarding' });
  },
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: AuthPage });

// Accept links are /-/invite#<token>. The token is moved from the address bar to storage before the sign-in
// check, so it survives the detour through /login (and email confirmation after signing up).
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/invite',
  beforeLoad: async () => {
    const token = takeTokenFromHash();
    if (token) rememberInvite(token);
    await requireAuth();
  },
  component: InvitePage,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  beforeLoad: requireAuth,
  component: OnboardingPage,
});

export const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$slug',
  beforeLoad: async ({ params }) => {
    await requireAuth();
    if (getCurrentOrg() !== params.slug) {
      // Cached data belongs to one org; never show it under another.
      queryClient.clear();
      setCurrentOrg(params.slug);
    }
  },
  component: OrgLayout,
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/o/$slug/inbox', params: { slug: params.slug } });
  },
});

export const inboxRoute = createRoute({ getParentRoute: () => orgRoute, path: 'inbox', component: InboxPage });
export const inboxDetailRoute = createRoute({ getParentRoute: () => orgRoute, path: 'inbox/$id', component: InboxDetailPage });
// Screens of the finance module; a deployment without it (CROVE_MODULES) sends them to the inbox.
const requireFinance = ({ params }: { params: { slug: string } }) => {
  if (!getConfig().modules.includes('finance')) throw redirect({ to: '/o/$slug/inbox', params: { slug: params.slug } });
};
const documentsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'documents', beforeLoad: requireFinance, component: DocumentsPage });
const vendorsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'vendors', beforeLoad: requireFinance, component: VendorsPage });
const journalRoute = createRoute({ getParentRoute: () => orgRoute, path: 'journal', beforeLoad: requireFinance, component: JournalPage });
const settingsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  inviteRoute,
  onboardingRoute,
  orgRoute.addChildren([orgIndexRoute, inboxRoute, inboxDetailRoute, documentsRoute, vendorsRoute, journalRoute, settingsRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
