// The multi-client home screen (issue #318): every org the user belongs to, with what waits in it and when its next VAT
// return is due, and the tax calendar of every client (#921): what is due in the next 30 days or overdue, which a member
// marks done here; one click opens the org. Each org's figures are read in that org on the server (me.clients), with
// the Social figures of each client when Social is on (#1261); an org whose figures could not be read is one row that
// says so, with a retry (#495).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { cn } from '@crove/ui/lib/utils';
import { ClientSocialFigures } from '../components/client-social.tsx';
import { SupportLink } from '../components/support-link.tsx';
import { DueWhen, TONE_CLASS, usePeriodLabel } from '../components/tax-due.tsx';
import { DataTable, Empty, ErrorText, Logo, OrgLeftNotice, PageHeader, Spinner, TableSkeleton } from '../components/ui.tsx';
import { LocaleSwitcher, useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { clientForOrg, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { deadlineTone, periodParts, sortClients, type ClientDeadline } from '../lib/clients.ts';
import { signOut } from '../lib/session-actions.ts';
import { canMarkTaxDone, dueAcrossClients, type TaxDueRow } from '../lib/tax-calendar.ts';

function Deadline({ deadline, slug, canChoose }: { deadline: ClientDeadline | null; slug: string; canChoose: boolean }) {
  const t = useTranslations('clients');
  const f = useFormat();
  if (!deadline) {
    return (
      <span className="text-subtle-foreground">
        {t('noFilingPeriod')}
        {canChoose && (
          <>
            {' · '}
            <Link to="/o/$slug/settings" params={{ slug }} className="text-link hover:underline">
              {t('chooseFilingPeriod')}
            </Link>
          </>
        )}
      </span>
    );
  }
  const parts = periodParts(deadline.period);
  const period = parts
    ? parts.kind === 'month'
      ? t('periodMonth', { month: String(parts.index), year: String(parts.year) })
      : t('periodQuarter', { quarter: String(parts.index), year: String(parts.year) })
    : deadline.period;
  return (
    <span className="block">
      <span className={cn('font-medium tabular-nums', TONE_CLASS[deadlineTone(deadline.daysLeft)])}>{f.date(deadline.dueDate)}</span>
      <span className="block text-xs text-subtle-foreground">
        {period} · {t('daysLeft', { days: deadline.daysLeft })}
      </span>
    </span>
  );
}

// One row of the tax calendar, with its own "done" request: marking one obligation does not hold the other rows, and a
// refusal shows next to the row it concerns.
function TaxCalendarRow({ row, periodLabel }: { row: TaxDueRow; periodLabel: (period: string) => string }) {
  const tt = useTranslations('taxCalendar');
  const done = useMutation({
    mutationFn: () => clientForOrg(row.slug).org.markTaxObligation({ obligation: row.obligation, period: row.period, done: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.me.clients.key() });
    },
  });
  return (
    <TableRow>
      <TableCell className="px-4 py-3">
        <DueWhen due={row} />
      </TableCell>
      <TableCell className="px-4 py-3">
        <Link to="/o/$slug/inbox" params={{ slug: row.slug }} className="font-medium text-foreground hover:text-link hover:underline">
          {row.name}
        </Link>
      </TableCell>
      <TableCell className="px-4 py-3" title={row.legalBasis}>
        {tt(`obligations.${row.obligation}`)}
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">{periodLabel(row.period)}</TableCell>
      <TableCell className="px-4 py-3 text-right">
        {canMarkTaxDone(row.role) && (
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

// Every client's tax obligations due in the next 30 days or overdue, by due date. Marking one done (owners, admins and
// members of that client) runs in the client's own org and removes it from the list.
function TaxCalendar({ rows }: { rows: TaxDueRow[] }) {
  const tt = useTranslations('taxCalendar');
  const periodLabel = usePeriodLabel();
  return (
    <section className="mt-8" aria-label={tt('title')}>
      <h2 className="text-sm font-semibold">{tt('title')}</h2>
      <p className="mt-1 mb-3 text-xs text-subtle-foreground">{tt('subtitle')}</p>
      {rows.length === 0 ? (
        <Empty title={tt('empty')} hint={tt('emptyHint')} />
      ) : (
        <div className="overflow-x-auto">
          <DataTable head={[tt('columns.due'), tt('columns.company'), tt('columns.obligation'), tt('columns.period'), '']}>
            {rows.map((r) => (
              <TaxCalendarRow key={`${r.orgId}:${r.obligation}:${r.period}`} row={r} periodLabel={periodLabel} />
            ))}
          </DataTable>
        </div>
      )}
      <p className="mt-3 text-xs text-subtle-foreground">{tt('unconfirmed')}</p>
    </section>
  );
}

export function ClientsPage() {
  const t = useTranslations('clients');
  const tc = useTranslations('common');
  const root = useTranslations();
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const me = useQuery(orpc.me.get.queryOptions());
  // Each load reads every org on the server, one screen per user at a time (#495): refetched after a minute, not every
  // ten seconds, and a failed refetch keeps the list already shown.
  const clients = useQuery({ ...orpc.me.clients.queryOptions(), staleTime: 60_000 });
  const finance = getConfig().modules.includes('finance');
  const social = getConfig().modules.includes('social');
  const rows = clients.data ? sortClients(clients.data.clients, locale) : [];
  const head = [
    t('columns.company'),
    ...(social ? [t('columns.social')] : []),
    t('columns.pending'),
    t('columns.failed'),
    t('columns.lastActivity'),
    ...(finance ? [t('columns.vatDeadline'), t('columns.nextObligation')] : []),
  ];
  const dues = clients.data ? dueAcrossClients(clients.data.clients, locale) : [];
  const periodLabel = usePeriodLabel();
  const tt = useTranslations('taxCalendar');

  return (
    <div className="min-h-full bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-sidebar px-4 py-3 md:px-8">
        <Logo />
        <div className="flex flex-wrap items-center gap-3 text-xs text-subtle-foreground">
          <SupportLink className="text-link" />
          <span className="hidden truncate sm:inline">{me.data?.email}</span>
          <button className="hover:text-muted-foreground" onClick={() => void signOut()}>
            {tc('signOut')}
          </button>
          <LocaleSwitcher />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
        <OrgLeftNotice />
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        {clients.isLoading ? (
          <TableSkeleton columns={5} />
        ) : clients.error && !clients.data ? (
          <ErrorText>{errorMessage(clients.error)}</ErrorText>
        ) : rows.length === 0 ? (
          <Empty
            title={t('empty')}
            hint={t('emptyHint')}
            action={
              <Link to="/onboarding" className={buttonVariants({ size: 'lg' })}>
                {t('create')}
              </Link>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable head={head}>
                {rows.map((c) => {
                  const company = (
                    <TableCell className="px-4 py-3">
                      <Link to="/o/$slug/inbox" params={{ slug: c.slug }} className="font-medium text-foreground hover:text-link hover:underline">
                        {c.name}
                      </Link>
                      <Badge variant={c.role === 'owner' ? 'brand' : 'secondary'} className="ml-2 align-middle">
                        {root(`roles.${c.role}`)}
                      </Badge>
                    </TableCell>
                  );
                  if (!c.overview) {
                    return (
                      <TableRow key={c.orgId}>
                        {company}
                        <TableCell colSpan={head.length - 1} className="px-4 py-3">
                          <span className="text-destructive">{t('loadError')}</span>{' '}
                          <Button size="sm" variant="link" className="h-auto p-0" onClick={() => void clients.refetch()} disabled={clients.isFetching}>
                            {t('retry')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  }
                  const socialFigures = c.overview.modules.social;
                  return (
                    <TableRow key={c.orgId}>
                      {company}
                      {social && (
                        <TableCell className="px-4 py-3 align-top">
                          {socialFigures ? <ClientSocialFigures slug={c.slug} figures={socialFigures} /> : <span className="text-subtle-foreground">-</span>}
                        </TableCell>
                      )}
                      <TableCell className="px-4 py-3 tabular-nums">
                        {c.overview.pendingProposals > 0 ? (
                          <Link to="/o/$slug/inbox" params={{ slug: c.slug }} className="font-medium text-link hover:underline">
                            {f.number(c.overview.pendingProposals)}
                          </Link>
                        ) : (
                          <span className="text-subtle-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="px-4 py-3 tabular-nums">
                        {c.overview.failedFiles > 0 ? (
                          <Badge variant="destructive">{f.number(c.overview.failedFiles)}</Badge>
                        ) : (
                          <span className="text-subtle-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-muted-foreground">
                        {c.overview.lastActivityAt ? f.dateTime(c.overview.lastActivityAt) : <span className="text-subtle-foreground">{t('noActivity')}</span>}
                      </TableCell>
                      {finance && (
                        <TableCell className="px-4 py-3">
                          <Deadline deadline={c.overview.vatDeadline} slug={c.slug} canChoose={c.role === 'owner' || c.role === 'admin'} />
                        </TableCell>
                      )}
                      {finance && (
                        <TableCell className="px-4 py-3">
                          {c.overview.taxDues[0] ? (
                            <span className="block">
                              <span className="block">{tt(`obligations.${c.overview.taxDues[0].obligation}`)}</span>
                              <span className="block text-xs text-subtle-foreground">{periodLabel(c.overview.taxDues[0].period)}</span>
                              <DueWhen due={c.overview.taxDues[0]} />
                            </span>
                          ) : (
                            <span className="text-subtle-foreground">{tt('nothingDue')}</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </DataTable>
            </div>
            {clients.data && clients.data.total > clients.data.clients.length && (
              <p className="mt-3 text-xs text-muted-foreground">{t('truncated', { shown: f.number(clients.data.clients.length), total: f.number(clients.data.total) })}</p>
            )}
            {finance && <p className="mt-3 text-xs text-subtle-foreground">{t('deadlineNote')}</p>}
            {finance && <TaxCalendar rows={dues} />}
          </>
        )}
      </main>
    </div>
  );
}
