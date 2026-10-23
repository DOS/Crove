// The org's overview (issue #1249): what waits for the user in this org today, each with its count and a link to the
// screen that clears it, then the tax obligations due in the next 30 days or overdue, which a member marks done here
// as on the multi-client home screen (#921). The org's figures are the ones /clients reads for it (org.overview).
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
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { OPEN_TASK_STATUSES } from '../lib/agents.ts';
import { getConfig } from '../lib/auth.ts';
import { deadlineTone, periodParts } from '../lib/clients.ts';
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
  const bank = useQuery({ ...orpc.bank.openLines.queryOptions(), enabled: financeOn, refetchInterval: every });

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
  const vatParts = vat ? periodParts(vat.period) : null;
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
                    <span className="w-10 shrink-0 text-right font-mono text-base font-semibold tabular-nums text-foreground">{count}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-foreground">{t(`waiting.${key}.label`, { count })}</span>
                      <span className="block text-xs text-subtle-foreground">{t(`waiting.${key}.hint`)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-link">{t(`waiting.${key}.open`)}</span>
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

      <section className="mt-8" aria-labelledby="overview-tax">
        <h2 id="overview-tax" className="text-sm font-semibold">
          {tt('title')}
        </h2>
        <p className="mt-1 mb-3 text-xs text-subtle-foreground">{t('taxSubtitle')}</p>
        {vat && !vatListed && (
          <p className="mb-3 text-sm">
            {t('vatNext', {
              period: vatParts
                ? vatParts.kind === 'month'
                  ? tcl('periodMonth', { month: String(vatParts.index), year: String(vatParts.year) })
                  : tcl('periodQuarter', { quarter: String(vatParts.index), year: String(vatParts.year) })
                : vat.period,
            })}{' '}
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
                  <DueRow key={`${d.obligation}:${d.period}`} due={d} canMark={canMarkTaxDone(role)} />
                ))}
              </DataTable>
            </div>
          ))}
        <p className="mt-3 text-xs text-subtle-foreground">{tt('unconfirmed')}</p>
      </section>
    </div>
  );
}
