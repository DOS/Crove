// The multi-client home screen (issue #318): every org the user belongs to, with what waits in it and when its next VAT
// return is due; one click opens the org. Each org's figures are read in that org on the server (me.clients).
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { buttonVariants } from '@crove/ui/components/button';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { cn } from '@crove/ui/lib/utils';
import { SupportLink } from '../components/support-link.tsx';
import { DataTable, Empty, ErrorText, Logo, OrgLeftNotice, PageHeader, Spinner } from '../components/ui.tsx';
import { LocaleSwitcher, useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { deadlineTone, periodParts, sortClients, type ClientDeadline } from '../lib/clients.ts';
import { signOut } from '../lib/session-actions.ts';

const TONE_CLASS = { urgent: 'text-destructive', soon: 'text-warning', later: 'text-foreground' } as const;

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
  const rows = clients.data ? sortClients(clients.data.clients, locale) : [];
  const head = [t('columns.company'), t('columns.pending'), t('columns.failed'), t('columns.lastActivity'), ...(finance ? [t('columns.vatDeadline')] : [])];

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
          <Spinner />
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
                {rows.map((c) => (
                  <TableRow key={c.orgId}>
                    <TableCell className="px-4 py-3">
                      <Link to="/o/$slug/inbox" params={{ slug: c.slug }} className="font-medium text-foreground hover:text-link hover:underline">
                        {c.name}
                      </Link>
                      <Badge variant={c.role === 'owner' ? 'brand' : 'secondary'} className="ml-2 align-middle">
                        {root(`roles.${c.role}`)}
                      </Badge>
                    </TableCell>
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
                  </TableRow>
                ))}
              </DataTable>
            </div>
            {clients.data && clients.data.total > clients.data.clients.length && (
              <p className="mt-3 text-xs text-muted-foreground">{t('truncated', { shown: f.number(clients.data.clients.length), total: f.number(clients.data.total) })}</p>
            )}
            {finance && <p className="mt-3 text-xs text-subtle-foreground">{t('deadlineNote')}</p>}
          </>
        )}
      </main>
    </div>
  );
}
