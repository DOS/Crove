import { Outlet, createRootRoute, createRoute, createRouter, redirect, type ErrorComponentProps } from '@tanstack/react-router';
import { Button } from './components/ui.tsx';
import { getCurrentOrg, isUnauthenticated, orpc, queryClient, setCurrentOrg } from './lib/api.ts';
import { accessToken, auth } from './lib/auth.ts';
import { AuthPage } from './routes/auth.tsx';
import { DocumentsPage } from './routes/documents.tsx';
import { InboxDetailPage } from './routes/inbox-detail.tsx';
import { InboxPage } from './routes/inbox.tsx';
import { InvitesPage } from './routes/invites.tsx';
import { JournalPage } from './routes/journal.tsx';
import { OnboardingPage } from './routes/onboarding.tsx';
import { OrgLayout } from './routes/org-layout.tsx';
import { SettingsPage } from './routes/settings.tsx';
import { VendorsPage } from './routes/vendors.tsx';

async function requireAuth() {
  if (!(await accessToken())) throw redirect({ to: '/login' });
}

function ErrorPage({ error }: ErrorComponentProps) {
  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-fg">Đã có lỗi xảy ra</h1>
        <p className="mt-2 text-sm text-fg-2">{error instanceof Error ? error.message : 'Lỗi không xác định'}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Tải lại</Button>
          <Button variant="ghost" onClick={() => void auth().signOut({ scope: 'local' }).then(() => window.location.assign('/login'))}>
            Đăng xuất
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

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  beforeLoad: requireAuth,
  component: OnboardingPage,
});

// The signed-in user's pending invites, outside any org: the invitee is not a member yet.
const invitesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invites',
  beforeLoad: requireAuth,
  component: InvitesPage,
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
const documentsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'documents', component: DocumentsPage });
const vendorsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'vendors', component: VendorsPage });
const journalRoute = createRoute({ getParentRoute: () => orgRoute, path: 'journal', component: JournalPage });
const settingsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  onboardingRoute,
  invitesRoute,
  orgRoute.addChildren([orgIndexRoute, inboxRoute, inboxDetailRoute, documentsRoute, vendorsRoute, journalRoute, settingsRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
