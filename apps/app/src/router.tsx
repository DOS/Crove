import { Outlet, createRootRoute, createRoute, createRouter, redirect, type ErrorComponentProps } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { errorMessage, getCurrentOrg, isUnauthenticated, orpc, queryClient, setCurrentOrg } from './lib/api.ts';
import { accessToken, auth, getConfig, needsSecondFactor } from './lib/auth.ts';
import { landingFor } from './lib/clients.ts';
import { pendingInvite, rememberInvite, takeTokenFromHash } from './lib/invite.ts';
import { signOut } from './lib/session-actions.ts';
import { AgentsPage } from './routes/agents.tsx';
import { AuthPage } from './routes/auth.tsx';
import { ClientsPage } from './routes/clients.tsx';
import { DocumentsPage } from './routes/documents.tsx';
import { GuidePage } from './routes/guide.tsx';
import { InboxDetailPage } from './routes/inbox-detail.tsx';
import { InboxPage } from './routes/inbox.tsx';
import { InvitePage } from './routes/invite.tsx';
import { JournalPage } from './routes/journal.tsx';
import { LedgerPage } from './routes/ledger.tsx';
import { BankPage } from './routes/bank.tsx';
import { MfaPage } from './routes/mfa.tsx';
import { OnboardingPage } from './routes/onboarding.tsx';
import { OpeningBalancePage } from './routes/opening-balance.tsx';
import { OrgLayout } from './routes/org-layout.tsx';
import { ResetPasswordPage } from './routes/reset-password.tsx';
import { SettingsPage } from './routes/settings.tsx';
import { SocialPage } from './routes/social.tsx';
import { SocialChannelsPage } from './routes/social-channels.tsx';
import { OAuthCallbackPage } from './routes/social-oauth.tsx';
import { SocialComposePage, SocialPostPage } from './routes/social-post.tsx';
import { TaskDetailPage, TasksPage } from './routes/tasks.tsx';
import { VatPage } from './routes/vat.tsx';
import { PortalListPage } from './routes/portal-list.tsx';
import { VendorsPage } from './routes/vendors.tsx';
import { VouchersPage } from './routes/vouchers.tsx';

async function requireSession() {
  if (!(await accessToken())) throw redirect({ to: '/login' });
}

// A user with a verified second factor finishes signing in on /mfa before seeing any data.
async function requireAuth() {
  await requireSession();
  if (await needsSecondFactor()) throw redirect({ to: '/mfa' });
}

function ErrorPage({ error }: ErrorComponentProps) {
  const t = useTranslations('common');
  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-foreground">{t('error')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error instanceof Error ? errorMessage(error) : t('unknownError')}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="outline" size="lg" onClick={() => window.location.reload()}>{t('reload')}</Button>
          <Button variant="ghost" size="lg" onClick={() => void signOut().then(() => window.location.assign('/login'))}>
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
    // Several orgs (an accountant's clients): the home screen (issue #318); one: its Inbox; none: onboarding.
    const landing = landingFor(me.orgs);
    if (landing.to === 'clients') throw redirect({ to: '/clients' });
    if (landing.to === 'inbox') throw redirect({ to: '/o/$slug/inbox', params: { slug: landing.slug } });
    throw redirect({ to: '/onboarding' });
  },
});

// Every org of the user with what waits in it and its next VAT deadline (issue #318); the landing page with several
// orgs, and linked from the sidebar then.
const clientsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/clients', beforeLoad: requireAuth, component: ClientsPage });

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

const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa',
  beforeLoad: async () => {
    await requireSession();
    if (!(await needsSecondFactor())) throw redirect({ to: '/' });
  },
  component: MfaPage,
});

// Reached from a recovery email link, which signs the user in for this one purpose.
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  beforeLoad: requireSession,
  component: ResetPasswordPage,
});

// Where a channel provider's OAuth dialog sends the browser back (Social plan S6). One address for every org: the
// attempt remembers its org (lib/oauth.ts).
const oauthCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/channels/oauth/$provider/callback',
  beforeLoad: requireAuth,
  component: OAuthCallbackPage,
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
// Cash and bank vouchers (issue #327).
const vouchersRoute = createRoute({ getParentRoute: () => orgRoute, path: 'vouchers', beforeLoad: requireFinance, component: VouchersPage });
// VAT working per month or quarter (issue #316).
const vatRoute = createRoute({ getParentRoute: () => orgRoute, path: 'vat', beforeLoad: requireFinance, component: VatPage });
// Reconciliation with the tax portal's purchase list (issue #465).
const portalListRoute = createRoute({ getParentRoute: () => orgRoute, path: 'portal-invoices', beforeLoad: requireFinance, component: PortalListPage });
// Ledger reports per month, quarter or year (issue #321).
const ledgerRoute = createRoute({ getParentRoute: () => orgRoute, path: 'ledger', beforeLoad: requireFinance, component: LedgerPage });
// Bank statements per bank account (issue #326).
const bankRoute = createRoute({ getParentRoute: () => orgRoute, path: 'bank', beforeLoad: requireFinance, component: BankPage });
// Opening balances from Excel (#320), reached from the journal.
const openingBalanceRoute = createRoute({ getParentRoute: () => orgRoute, path: 'journal/opening-balances', beforeLoad: requireFinance, component: OpeningBalancePage });
// The Vietnamese quick guide (issue #310), linked from the empty Inbox; it walks through finance screens.
const guideRoute = createRoute({ getParentRoute: () => orgRoute, path: 'guide', beforeLoad: requireFinance, component: GuidePage });
// Screens of the social module; without it (CROVE_MODULES) they send you to the inbox.
const requireSocial = ({ params }: { params: { slug: string } }) => {
  if (!getConfig().modules.includes('social')) throw redirect({ to: '/o/$slug/inbox', params: { slug: params.slug } });
};
const socialRoute = createRoute({ getParentRoute: () => orgRoute, path: 'social', beforeLoad: requireSocial, component: () => <Outlet /> });
const socialIndexRoute = createRoute({ getParentRoute: () => socialRoute, path: '/', component: SocialPage });
const socialNewRoute = createRoute({ getParentRoute: () => socialRoute, path: 'new', component: SocialComposePage });
const socialChannelsRoute = createRoute({ getParentRoute: () => socialRoute, path: 'channels', component: SocialChannelsPage });
const socialPostRoute = createRoute({ getParentRoute: () => socialRoute, path: '$id', component: SocialPostPage });
const settingsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'settings', component: SettingsPage });
// AI agents and tasks (ADR-0029) belong to the kernel, so every deployment has them.
const agentsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'agents', component: AgentsPage });
const tasksRoute = createRoute({ getParentRoute: () => orgRoute, path: 'tasks', component: TasksPage });
const taskDetailRoute = createRoute({ getParentRoute: () => orgRoute, path: 'tasks/$id', component: TaskDetailPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  inviteRoute,
  mfaRoute,
  resetPasswordRoute,
  onboardingRoute,
  clientsRoute,
  oauthCallbackRoute,
  orgRoute.addChildren([orgIndexRoute, inboxRoute, inboxDetailRoute, documentsRoute, vendorsRoute, journalRoute, vouchersRoute, vatRoute, portalListRoute, ledgerRoute, bankRoute, openingBalanceRoute, socialRoute.addChildren([socialIndexRoute, socialNewRoute, socialChannelsRoute, socialPostRoute]), agentsRoute, tasksRoute, taskDetailRoute, settingsRoute, guideRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
