// The org's overview (issue #1249): what waits for the user in this org today, each with its count and a link to the
// screen that clears it, then one card per installed app with its key figure (#1528; this screen opens the Home app),
// then the tax obligations due in the next 30 days or overdue, which a member marks done here as on the multi-client
// home screen (#921). The org's figures are the ones /clients reads for it (org.overview).
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TaxDueView } from '@crove/kernel-contract';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NavIcon, type NavIconName } from '@crove/ui/components/nav-icon';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { cn } from '@crove/ui/lib/utils';
import { DueWhen, TONE_CLASS, usePeriodLabel } from '../components/tax-due.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { OPEN_TASK_STATUSES } from '../lib/agents.ts';
import { installedApps, type AppId } from '../lib/apps.ts';
import { getConfig } from '../lib/auth.ts';
import { deadlineTone } from '../lib/clients.ts';
import { allCounted, waitingItems, type WaitingKey } from '../lib/overview.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { canMarkTaxDone } from '../lib/tax-calendar.ts';
import { useWorkNotifications } from './notifications.tsx';


const TARGET = {
  proposals: { to: '/o/$slug/inbox', icon: 'inbox' },
  socialReviews: { to: '/o/$slug/inbox', icon: 'social' },
  failedFiles: { to: '/o/$slug/inbox', icon: 'documents' },
  notifications: { to: '/o/$slug/notifications', icon: 'alerts' },
  tasks: { to: '/o/$slug/tasks', icon: 'tasks' },
  bankLines: { to: '/o/$slug/bank', icon: 'bank' },
} as const satisfies Record<WaitingKey, { to: string; icon: NavIconName }>;

const APP_CARD = {
  accounting: { to: '/o/$slug/vat', icon: 'appAccounting' },
  social: { to: '/o/$slug/social', icon: 'appSocial' },
  crm: { to: '/o/$slug/bookings', icon: 'appCrm' },
} as const satisfies Record<Exclude<AppId, 'home'>, { to: string; icon: NavIconName }>;

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
// The lists the cards count return at most this many rows; a full page reads as "200+", not as an exact figure.
const LIST_CAP = 200;
const counted = (n: number, page: number) => (page >= LIST_CAP ? `${n}+` : String(n));

// One card per installed app (#1528): its key figure and a way in. Home is this screen, so it has none.
function AppCards({ slug, vat, vatLoaded }: { slug: string; vat: { period: string; daysLeft: number } | null; vatLoaded: boolean }) {
  const t = useTranslations('overview.apps');
  const tn = useTranslations('nav');
  const periodLabel = usePeriodLabel();
  const apps = installedApps(getConfig().modules).filter((a) => a.id !== 'home');
  const has = (id: AppId) => apps.some((a) => a.id === id);
  // The next 7 days from the start of this hour: the query key holds within the hour and moves on with the clock, so a
  // tab left open does not count last week's posts.
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const week = { from: new Date(hour).toISOString(), to: new Date(hour + WEEK_MS).toISOString() };
  const posts = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { ...week, limit: LIST_CAP } }), enabled: has('social') });
  const bookings = useQuery({ ...orpc.crm.bookings.list.queryOptions({ input: { scope: 'mine', period: 'upcoming' } }), enabled: has('crm') });
  if (apps.length === 0) return null;

  type Figure = { value: string | null; label: string; retry?: () => void };
  const failed = (q: { refetch: () => unknown }): Figure => ({ value: '-', label: t('failed'), retry: () => void q.refetch() });
  const figure = (id: Exclude<AppId, 'home'>): Figure => {
    if (id === 'accounting') {
      if (!vatLoaded) return { value: null, label: '' };
      if (!vat) return { value: '-', label: t('accounting.noPeriod') };
      return vat.daysLeft >= 0
        ? { value: String(vat.daysLeft), label: t('accounting.vatDue', { days: vat.daysLeft, period: periodLabel(vat.period) }) }
        : { value: String(-vat.daysLeft), label: t('accounting.vatOverdue', { days: -vat.daysLeft, period: periodLabel(vat.period) }) };
    }
    if (id === 'social') {
      if (posts.isError) return failed(posts);
      if (!posts.data) return { value: null, label: '' };
      // The range holds every post with a time in it; only the scheduled ones are waiting to go out.
      const scheduled = posts.data.filter((p) => p.status === 'scheduled').length;
      return { value: counted(scheduled, posts.data.length), label: t('social.scheduled', { count: scheduled }) };
    }
    if (bookings.isError) return failed(bookings);
    if (!bookings.data) return { value: null, label: '' };
    const upcoming = bookings.data.filter((b) => b.status === 'pending' || b.status === 'confirmed').length;
    return { value: counted(upcoming, bookings.data.length), label: t('crm.upcoming', { count: upcoming }) };
  };

  return (
    <section className="mt-8" aria-labelledby="overview-apps">
      <h2 id="overview-apps" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {apps.map((app) => {
          const id = app.id as Exclude<AppId, 'home'>;
          const { value, label, retry } = figure(id);
          return (
            <li key={id}>
              <Card className="flex h-full flex-col gap-2 p-4">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <NavIcon name={APP_CARD[id].icon} className="text-muted-foreground" />
                  {tn(`appNames.${id}`)}
                </span>
                {value === null ? (
                  <Spinner />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    <span className="mr-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</span>
                    {label}
                    {retry && (
                      <button type="button" className="ml-2 text-xs text-link hover:underline" onClick={retry}>
                        {t('retry')}
                      </button>
                    )}
                  </p>
                )}
                <Link to={APP_CARD[id].to} params={{ slug }} className="mt-auto text-xs text-link hover:underline">
                  {t('open', { app: tn(`appNames.${id}`) })}
                </Link>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DueRow({ due, canMark }: { due: TaxDueView; canMark: boolean }) {
  const tt = useTranslations('taxCalendar');
  const periodLabel = usePeriodLabel();
  const done = useMutation({
    mutationFn: () => client.org.markTaxObligation({ obligation: due.obligation, period: due.period, done: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.org.overview.key() });
    },
  });
  return (
    <TableRow>
      <TableCell className="px-4 py-3">
        <DueWhen due={due} />
      </TableCell>
      <TableCell className="px-4 py-3" title={due.legalBasis}>
        {tt(`obligations.${due.obligation}`)}
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">{periodLabel(due.period)}</TableCell>
      <TableCell className="px-4 py-3 text-right">
        {canMark && (
          <Button size="sm" variant="outline" onClick={() => done.mutate()} disabled={done.isPending}>
            {done.isPending ? <Spinner className="text-current" /> : null}
            {tt('markDone')}
          </Button>
        )}
        {done.error && <ErrorText>{errorMessage(done.error)}</ErrorText>}
      </TableCell>
    </TableRow>
  );
}

export function OverviewPage() {
  const t = useTranslations('overview');
  const tt = useTranslations('taxCalendar');
  const tcl = useTranslations('clients');
  const f = useFormat();
  const periodLabel = usePeriodLabel();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const modules = getConfig().modules;
  const financeOn = modules.includes('finance');
  const socialOn = modules.includes('social');
  const live = useStreamLive();
  const every = pollEvery(live, 60_000, SAFETY_POLL_MS);

  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const overview = useQuery({ ...orpc.org.overview.queryOptions(), refetchInterval: every });
  const work = useWorkNotifications();
  const tasks = useQuery({ ...orpc.tasks.list.queryOptions({ input: { mine: true, status: [...OPEN_TASK_STATUSES] } }), refetchInterval: every });
  const reviews = useQuery({ ...orpc.social.reviewInbox.queryOptions({ input: {} }), enabled: socialOn, refetchInterval: every });
  // Open statement lines of the entity chosen in the shell (#1280), the books the bank screen opens on.
  const entity = useChosenEntity();
  const bank = useQuery({ ...orpc.bank.openLines.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: financeOn && entity.ready, refetchInterval: every });

  const counts = {
    proposals: overview.data?.pendingProposals,
    failedFiles: overview.data?.failedFiles,
    notifications: work.data?.unread,
    tasks: tasks.data?.length,
    ...(socialOn ? { socialReviews: reviews.data?.total } : {}),
    ...(financeOn ? { bankLines: bank.data?.accounts.reduce((sum, a) => sum + a.open, 0) } : {}),
  };
  const asked: WaitingKey[] = ['proposals', 'failedFiles', 'notifications', 'tasks', ...(socialOn ? (['socialReviews'] as const) : []), ...(financeOn ? (['bankLines'] as const) : [])];
  const waiting = waitingItems(counts);
  const failed = [overview, work, tasks, ...(socialOn ? [reviews] : []), ...(financeOn ? [bank] : [])].find((q) => q.isError);

  const vat = overview.data?.vatDeadline ?? null;
  const dues = overview.data?.taxDues ?? [];
  // The VAT return in the tax calendar already says when it is due; otherwise the next one is named on its own.
  const vatListed = vat !== null && dues.some((d) => d.obligation === 'vat_return' && d.period === vat.period);
  const canChooseVat = role === 'owner' || role === 'admin';
  const uploadAction = (
    <Link to="/o/$slug/inbox" params={{ slug }} className={buttonVariants()}>
      {t('upload')}
    </Link>
  );

  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={overview.data?.lastActivityAt ? t('lastActivity', { when: f.dateTime(overview.data.lastActivityAt) }) : t('subtitle')}
        actions={uploadAction}
      />

      <section aria-labelledby="overview-waiting">
        <h2 id="overview-waiting" className="text-sm font-semibold">
          {t('waiting.title')}
        </h2>
        {failed && <ErrorText>{errorMessage(failed.error)}</ErrorText>}
        {waiting.length > 0 ? (
          <Card className="mt-3 block overflow-hidden p-0">
            <ul className="divide-y">
              {waiting.map(({ key, count }) => (
                <li key={key}>
                  <Link
                    to={TARGET[key].to}
                    params={{ slug }}
                    // The count and what it counts, as one phrase ("3 đề xuất bút toán chờ duyệt"); the hint and the
                    // link text beside them are for the eye.
                    aria-label={`${count} ${t(`waiting.${key}.label`, { count })}`}
                    className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50 focus-visible:bg-muted/50"
                  >
                    <NavIcon name={TARGET[key].icon} className="text-muted-foreground" />
                    <span className="w-8 shrink-0 text-right font-mono text-base font-semibold tabular-nums text-foreground">{count}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-foreground">{t(`waiting.${key}.label`, { count })}</span>
                      <span className="block text-xs text-subtle-foreground">{t(`waiting.${key}.hint`)}</span>
                    </span>
                    {/* The whole row is the link; on a phone the words would only squeeze what it counts. */}
                    <span className="hidden shrink-0 text-xs text-link sm:inline">{t(`waiting.${key}.open`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : allCounted(counts, asked) && !failed ? (
          <div className="mt-3">
            <Empty title={t('waiting.empty')} hint={t('waiting.emptyHint')} action={uploadAction} />
          </div>
        ) : (
          !failed && (
            <p className="mt-3 flex items-center gap-2 text-sm text-subtle-foreground">
              <Spinner /> {t('loading')}
            </p>
          )
        )}
      </section>

      <AppCards slug={slug} vat={vat} vatLoaded={overview.isSuccess} />

      <section className="mt-8" aria-labelledby="overview-tax">
        <h2 id="overview-tax" className="text-sm font-semibold">
          {tt('title')}
        </h2>
        <p className="mt-1 mb-3 text-xs text-subtle-foreground">{t('taxSubtitle')}</p>
        {vat && !vatListed && (
          <p className="mb-3 text-sm">
            {t('vatNext', { period: periodLabel(vat.period) })}{' '}
            <span className={cn('font-medium tabular-nums', TONE_CLASS[deadlineTone(vat.daysLeft)])}>{f.date(vat.dueDate)}</span>{' '}
            <span className="text-subtle-foreground">({tt('daysLeft', { days: vat.daysLeft })})</span>
          </p>
        )}
        {overview.data && overview.data.vatFilingPeriod === null && (
          <p className="mb-3 text-sm text-subtle-foreground">
            {tcl('noFilingPeriod')}
            {canChooseVat && (
              <>
                {' · '}
                <Link to="/o/$slug/settings" params={{ slug }} className="text-link hover:underline">
                  {tcl('chooseFilingPeriod')}
                </Link>
              </>
            )}
          </p>
        )}
        {overview.data &&
          (dues.length === 0 ? (
            <Empty title={tt('empty')} hint={tt('emptyHint')} />
          ) : (
            <div className="overflow-x-auto">
              <DataTable head={[tt('columns.due'), tt('columns.obligation'), tt('columns.period'), '']}>
                {dues.map((d) => (
                  <DueRow key={`${d.obligation}:${d.period}`} due={d} canMark={canMarkTaxDone(role, d.obligation, financeOn)} />
                ))}
              </DataTable>
            </div>
          ))}
        <p className="mt-3 text-xs text-subtle-foreground">{tt('unconfirmed')}</p>
      </section>
    </div>
  );
}
