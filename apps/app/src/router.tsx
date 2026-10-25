import { Outlet, createRootRoute, createRoute, createRouter, redirect, type ErrorComponentProps } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { errorMessage, getCurrentOrg, isUnauthenticated, orpc, queryClient, setCurrentOrg } from './lib/api.ts';
import { accessToken, auth, getConfig, needsSecondFactor, needsSecondFactorNow } from './lib/auth.ts';
import { landingFor } from './lib/clients.ts';
import { pendingInvite, rememberInvite, takeTokenFromHash } from './lib/invite.ts';
import { signOut } from './lib/session-actions.ts';
import { AgentsPage } from './routes/agents.tsx';
import { AuditPage } from './routes/audit.tsx';
import { PersonalDataPage } from './routes/personal-data.tsx';
import { AuthPage } from './routes/auth.tsx';
import { ClientsPage } from './routes/clients.tsx';
import { DocumentsPage } from './routes/documents.tsx';
import { GuidePage } from './routes/guide.tsx';
import { InboxDetailPage } from './routes/inbox-detail.tsx';
import { InboxPage } from './routes/inbox.tsx';
import { OverviewPage } from './routes/overview.tsx';
import { InvitePage } from './routes/invite.tsx';
import { JournalPage } from './routes/journal.tsx';
import { NotificationsPage } from './routes/notifications.tsx';
import { LedgerPage } from './routes/ledger.tsx';
import { BankPage } from './routes/bank.tsx';
import { MfaPage } from './routes/mfa.tsx';
import { OnboardingPage } from './routes/onboarding.tsx';
import { OpeningBalancePage } from './routes/opening-balance.tsx';
import { OrgLayout } from './routes/org-layout.tsx';
import { ResetPasswordPage } from './routes/reset-password.tsx';
import { SettingsPage } from './routes/settings.tsx';
import { SocialPage } from './routes/social.tsx';
import { SocialImportPage } from './routes/social-import.tsx';
import { SocialSnippetsPage } from './routes/social-snippets.tsx';
import { SocialNotificationsPage } from './routes/social-notifications.tsx';
import { SocialLabelsPage } from './routes/social-labels.tsx';
import { SocialIdeasPage } from './routes/social-ideas.tsx';
import { SocialBioPage } from './routes/social-bio.tsx';
import { SocialFeedsPage } from './routes/social-feeds.tsx';
import { OCCASION_IDS } from './lib/social-occasions.ts';
import { SocialReviewPage } from './routes/social-review.tsx';
import { SocialReportPage } from './routes/social-report.tsx';
import { BookingPage } from './routes/booking-page.tsx';
import { SocialPlanPrintPage } from './routes/social-plan-print.tsx';
import { parsePlanSearch } from './lib/social-plan-export.ts';
import { parseSocialSearch } from './lib/social.ts';
import { parseJournalSearch, parseTextSearch } from './lib/search.ts';
import { SocialChannelsPage } from './routes/social-channels.tsx';
import { OAuthCallbackPage } from './routes/social-oauth.tsx';
import { SocialComposePage, SocialPostPage } from './routes/social-post.tsx';
import { SocialSharePage } from './routes/social-share.tsx';
import { SHARE_PATH, pendingShare, readShareFragment, readShareOrg, rememberShare } from './lib/social-share.ts';
import { TaskDetailPage, TasksPage } from './routes/tasks.tsx';
import { BookingsPage } from './routes/bookings.tsx';
import { VatPage } from './routes/vat.tsx';
import { PortalListPage } from './routes/portal-list.tsx';
import { VendorsPage } from './routes/vendors.tsx';
import { CustomersPage } from './routes/customers.tsx';
import { VouchersPage } from './routes/vouchers.tsx';
import { PublishHoldBanner } from './components/social-publish-hold.tsx';
import { FixedAssetsPage } from './routes/fixed-assets.tsx';

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
    // So is a page shared before signing in (#1235).
    if (pendingShare()) throw redirect({ to: SHARE_PATH });
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

// A client's review link (#589): /-/review#<token>, no account and no sign-in; the token is the only credential.
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/-/review', component: SocialReviewPage });
// A client's report link (#643): /-/report#<token>, the same way.
const reportRoute = createRoute({ getParentRoute: () => rootRoute, path: '/-/report', component: SocialReportPage });
// A booking page of the crm module (#1318): /-/b/<org>/<event type>, no account. The API answers 404 without crm.
const bookingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/b/$org/$type',
  component: function BookingRouteView() {
    const { org, type } = bookingRoute.useParams();
    return <BookingPage org={org} type={type} />;
  },
});

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

// A page shared into a new Social draft (#1235): the share target's query, already moved to the fragment by
// share-boot.ts, or the bookmarklet's fragment (#org=&link=&text=). The share is moved from the address bar to this
// tab's storage before the sign-in check, so it survives the detour through /login.
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SHARE_PATH,
  beforeLoad: async () => {
    const shared = readShareFragment(window.location.hash);
    if (shared) rememberShare({ ...shared, org: readShareOrg(window.location.hash) });
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname);
    await requireAuth();
  },
  component: SocialSharePage,
});

const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa',
  beforeLoad: async () => {
    await requireSession();
    if (!(await needsSecondFactorNow())) throw redirect({ to: '/' });
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

// Signed in, and the org in the address is the one API calls name.
async function enterOrg(slug: string) {
  await requireAuth();
  if (getCurrentOrg() !== slug) {
    // Cached data belongs to one org; never show it under another.
    queryClient.clear();
    setCurrentOrg(slug);
  }
}

export const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$slug',
  beforeLoad: ({ params }) => enterOrg(params.slug),
  component: OrgLayout,
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/o/$slug/inbox', params: { slug: params.slug } });
  },
});

// What waits for the user in this org today (#1249), first in the menu; opening an org still lands on its Inbox.
const overviewRoute = createRoute({ getParentRoute: () => orgRoute, path: 'overview', component: OverviewPage });
export const inboxRoute = createRoute({ getParentRoute: () => orgRoute, path: 'inbox', component: InboxPage });
export const inboxDetailRoute = createRoute({ getParentRoute: () => orgRoute, path: 'inbox/$id', component: InboxDetailPage });
// Screens of the finance module; a deployment without it (CROVE_MODULES) sends them to the inbox.
const requireFinance = ({ params }: { params: { slug: string } }) => {
  if (!getConfig().modules.includes('finance')) throw redirect({ to: '/o/$slug/inbox', params: { slug: params.slug } });
};
// ?q= starts the documents and vendors filters, and ?from=&to= sets the journal's range: where the command palette's
// search results go (#673).
const documentsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'documents', beforeLoad: requireFinance, validateSearch: parseTextSearch, component: DocumentsPage });
const vendorsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'vendors', beforeLoad: requireFinance, validateSearch: parseTextSearch, component: VendorsPage });
// Customers of sales invoices and receivables (issue #670); ?q= opens it on a search (a tax code or a name).
const customersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'customers',
  beforeLoad: requireFinance,
  validateSearch: parseTextSearch,
  component: CustomersPage,
});
const journalRoute = createRoute({ getParentRoute: () => orgRoute, path: 'journal', beforeLoad: requireFinance, validateSearch: parseJournalSearch, component: JournalPage });
// Cash and bank vouchers (issue #327).
const vouchersRoute = createRoute({ getParentRoute: () => orgRoute, path: 'vouchers', beforeLoad: requireFinance, component: VouchersPage });
// The register of fixed assets and prepaid costs (issue #919).
const fixedAssetsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'fixed-assets', beforeLoad: requireFinance, component: FixedAssetsPage });
// VAT working per month or quarter (issue #316).
const vatRoute = createRoute({ getParentRoute: () => orgRoute, path: 'vat', beforeLoad: requireFinance, component: VatPage });
// Reconciliation with the tax portal's purchase list (issue #465).
const portalListRoute = createRoute({ getParentRoute: () => orgRoute, path: 'portal-invoices', beforeLoad: requireFinance, component: PortalListPage });
// Ledger reports per month, quarter or year (issue #321).
const ledgerRoute = createRoute({ getParentRoute: () => orgRoute, path: 'ledger', beforeLoad: requireFinance, component: LedgerPage });
// Bank statements per bank account (issue #326). ?account=1121&month=2026-09 opens that account and month (the Inbox
// links its open lines here).
const bankRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'bank',
  beforeLoad: requireFinance,
  // The router reads a digits-only value (a hand-typed ?account=1121) as a number, so a whole number counts as its code.
  validateSearch: (search: Record<string, unknown>): { account?: string; month?: string } => {
    const account = typeof search.account === 'number' && Number.isSafeInteger(search.account) ? String(search.account) : search.account;
    return {
      ...(typeof account === 'string' && /^[0-9A-Za-z._-]{3,50}$/.test(account) ? { account } : {}),
      ...(typeof search.month === 'string' && /^\d{4}-\d{2}$/.test(search.month) ? { month: search.month } : {}),
    };
  },
  component: BankPage,
});
// Opening balances from Excel (#320), reached from the journal.
const openingBalanceRoute = createRoute({ getParentRoute: () => orgRoute, path: 'journal/opening-balances', beforeLoad: requireFinance, component: OpeningBalancePage });
// The Vietnamese quick guide (issue #310), linked from the empty Inbox; it walks through finance screens.
const guideRoute = createRoute({ getParentRoute: () => orgRoute, path: 'guide', beforeLoad: requireFinance, component: GuidePage });
// Screens of the social module; without it (CROVE_MODULES) they send you to the inbox.
const requireSocial = ({ params }: { params: { slug: string } }) => {
  if (!getConfig().modules.includes('social')) throw redirect({ to: '/o/$slug/inbox', params: { slug: params.slug } });
};
// Every Social page shows the org's publishing hold (#946) above it while one is on.
const socialRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'social',
  beforeLoad: requireSocial,
  component: () => (
    <>
      <PublishHoldBanner />
      <Outlet />
    </>
  ),
});
const socialIndexRoute = createRoute({ getParentRoute: () => socialRoute, path: '/', validateSearch: parseSocialSearch, component: SocialPage });
// ?at=<ISO time>: the calendar starts a post planned for that time (#580); ?idea=<id>: a draft made from an idea (#701);
// ?channel=<id>: a post for that channel, from the notice of its queue running low (#1079); ?photo=<file id>: an AI draft
// from that library photo (#1191).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const socialNewRoute = createRoute({
  getParentRoute: () => socialRoute,
  path: 'new',
  validateSearch: (search: Record<string, unknown>): { at?: string; idea?: string; occasion?: string; on?: string; channel?: string; photo?: string } => ({
    ...(typeof search.at === 'string' && !Number.isNaN(Date.parse(search.at)) ? { at: new Date(search.at).toISOString() } : {}),
    // ?occasion=<id>&on=<YYYY-MM-DD>: a post for an occasion of the calendar (#702).
    ...(typeof search.occasion === 'string' && OCCASION_IDS.has(search.occasion) && typeof search.on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.on) ? { occasion: search.occasion, on: search.on } : {}),
    ...(typeof search.idea === 'string' && UUID.test(search.idea) ? { idea: search.idea.toLowerCase() } : {}),
    ...(typeof search.channel === 'string' && UUID.test(search.channel) ? { channel: search.channel.toLowerCase() } : {}),
    ...(typeof search.photo === 'string' && UUID.test(search.photo) ? { photo: search.photo.toLowerCase() } : {}),
  }),
  component: SocialComposePage,
});
const socialChannelsRoute = createRoute({ getParentRoute: () => socialRoute, path: 'channels', component: SocialChannelsPage });
const socialImportRoute = createRoute({ getParentRoute: () => socialRoute, path: 'import', component: SocialImportPage });
const socialSnippetsRoute = createRoute({ getParentRoute: () => socialRoute, path: 'snippets', component: SocialSnippetsPage });
const socialNotificationsRoute = createRoute({ getParentRoute: () => socialRoute, path: 'notifications', component: SocialNotificationsPage });
const socialLabelsRoute = createRoute({ getParentRoute: () => socialRoute, path: 'labels', component: SocialLabelsPage });
const socialIdeasRoute = createRoute({ getParentRoute: () => socialRoute, path: 'ideas', component: SocialIdeasPage });
const socialBioRoute = createRoute({ getParentRoute: () => socialRoute, path: 'bio', component: SocialBioPage });
const socialFeedsRoute = createRoute({ getParentRoute: () => socialRoute, path: 'feeds', component: SocialFeedsPage });
const socialPostRoute = createRoute({ getParentRoute: () => socialRoute, path: '$id', component: SocialPostPage });
// The content plan to print (#978), outside the org's frame so only the plan reaches the paper.
const socialPlanPrintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$slug/print/social-plan',
  beforeLoad: async ({ params }) => {
    await enterOrg(params.slug);
    requireSocial({ params });
  },
  validateSearch: parsePlanSearch,
  component: SocialPlanPrintPage,
});
// ?invite=<email> fills the invite form: onboarding sends a firm here to invite the new client's contact (issue #324).
const settingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'settings',
  validateSearch: (search: Record<string, unknown>): { invite?: string } => (typeof search.invite === 'string' ? { invite: search.invite.slice(0, 320) } : {}),
  component: SettingsPage,
});
// The audit log (#672): owners and admins only, which the page checks and the server enforces.
const auditRoute = createRoute({ getParentRoute: () => orgRoute, path: 'audit', component: AuditPage });
const personalDataRoute = createRoute({ getParentRoute: () => orgRoute, path: 'personal-data', component: PersonalDataPage });
// AI agents and tasks (ADR-0029) belong to the kernel, so every deployment has them.
// In-app notifications of the kernel and finance (#671).
const notificationsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'notifications', component: NotificationsPage });
const agentsRoute = createRoute({ getParentRoute: () => orgRoute, path: 'agents', component: AgentsPage });
const tasksRoute = createRoute({ getParentRoute: () => orgRoute, path: 'tasks', component: TasksPage });
// The bookings of the public booking page (#1320), with the crm module; a deployment without it goes to the inbox.
const bookingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'bookings',
  beforeLoad: ({ params }) => {
    if (!getConfig().modules.includes('crm')) throw redirect({ to: '/o/$slug/inbox', params: { slug: params.slug } });
  },
  component: BookingsPage,
});
const taskDetailRoute = createRoute({ getParentRoute: () => orgRoute, path: 'tasks/$id', component: TaskDetailPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  reviewRoute,
  bookingRoute,
  reportRoute,
  shareRoute,
  socialPlanPrintRoute,
  inviteRoute,
  mfaRoute,
  resetPasswordRoute,
  onboardingRoute,
  clientsRoute,
  oauthCallbackRoute,
  orgRoute.addChildren([orgIndexRoute, overviewRoute, inboxRoute, inboxDetailRoute, documentsRoute, customersRoute, vendorsRoute, journalRoute, vouchersRoute, fixedAssetsRoute, vatRoute, portalListRoute, ledgerRoute, bankRoute, openingBalanceRoute, socialRoute.addChildren([socialIndexRoute, socialNewRoute, socialChannelsRoute, socialImportRoute, socialSnippetsRoute, socialLabelsRoute, socialIdeasRoute, socialFeedsRoute, socialBioRoute, socialNotificationsRoute, socialPostRoute]), notificationsRoute, agentsRoute, tasksRoute, taskDetailRoute, bookingsRoute, settingsRoute, auditRoute, personalDataRoute, guideRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
