// In-app notifications of the kernel and finance (#671): the viewer's own, newest first. Opening one marks it read and
// goes to what it is about; the settings turn kinds off for this member only. Social's have their own screen (#637).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { cn } from '@crove/ui/lib/utils';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { isKnownKind, kindKey, notificationKinds, notificationTarget, periodParts, type KnownNotificationKind } from '../lib/notifications.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

export type WorkNotification = Awaited<ReturnType<typeof client.notifications.list>>['items'][number];

// The viewer's notifications; between stream hints they are read again every minute.
export function useWorkNotifications(enabled = true) {
  const live = useStreamLive();
  return useQuery({ ...orpc.notifications.list.queryOptions({ input: {} }), enabled, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
}

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.notifications.list.key() });

function useLine() {
  const t = useTranslations('notifications');
  const period = (key: string | undefined) => {
    const parts = key ? periodParts(key) : null;
    if (!parts) return key ?? '';
    return t(parts.kind === 'month' ? 'month' : 'quarter', { label: parts.label });
  };
  const f = useFormat();
  return (n: WorkNotification): string => {
    switch (n.kind) {
      case 'kernel.approval_waiting':
        return t('text.approval_waiting', { title: n.detail.title ?? '' });
      case 'kernel.file_unreadable':
        return t('text.file_unreadable', { filename: n.detail.filename ?? '' });
      case 'finance.bank_attention':
        return t('text.bank_attention', { account: n.detail.bankAccount ?? '', lines: Number(n.detail.lines ?? 0) });
      case 'finance.portal_attention':
        return n.detail.failed === 'true'
          ? t('text.portal_failed', { period: period(n.detail.period) })
          : t('text.portal_attention', { period: period(n.detail.period), missing: Number(n.detail.missing ?? 0), mismatch: Number(n.detail.amountMismatch ?? 0) });
      case 'finance.period_closing':
        return t('text.period_closing', { period: period(n.detail.period), due: n.detail.dueDate ? f.date(n.detail.dueDate) : '' });
      default:
        return t('text.other');
    }
  };
}

function Settings({ muted }: { muted: readonly string[] }) {
  const t = useTranslations('notifications');
  const kinds = notificationKinds(getConfig().modules);
  const mute = useMutation({
    mutationFn: (v: { kind: KnownNotificationKind; muted: boolean }) => client.notifications.mute(v),
    onSettled: refresh,
  });
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('settings')}</h2>
        <p className="text-xs text-subtle-foreground">{t('settingsHint')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {kinds.map((kind) => {
          const on = mute.isPending && mute.variables?.kind === kind ? !mute.variables.muted : !muted.includes(kind);
          return (
            <label key={kind} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={on} disabled={mute.isPending} onCheckedChange={(checked) => mute.mutate({ kind, muted: checked !== true })} />
              {t(`kinds.${kindKey(kind)}`)}
            </label>
          );
        })}
      </div>
      {mute.error && <ErrorText>{errorMessage(mute.error)}</ErrorText>}
    </Card>
  );
}

export function NotificationsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('notifications');
  const f = useFormat();
  const navigate = useNavigate();
  const line = useLine();
  const list = useWorkNotifications();
  const read = useMutation({
    mutationFn: (input: { ids: string[] } | { all: true }) => client.notifications.read(input),
    onSettled: refresh,
  });
  const open = (n: WorkNotification) => {
    if (!n.read) read.mutate({ ids: [n.id] });
    const target = notificationTarget(n);
    if (target?.to === 'proposal') void navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: target.id } });
    else if (target?.to === 'inbox') void navigate({ to: '/o/$slug/inbox', params: { slug } });
    else if (target?.to === 'bank') void navigate({ to: '/o/$slug/bank', params: { slug }, search: target.account ? { account: target.account } : {} });
    else if (target?.to === 'portal') void navigate({ to: '/o/$slug/portal-invoices', params: { slug } });
    else if (target?.to === 'ledger') void navigate({ to: '/o/$slug/ledger', params: { slug } });
  };
  // A kind this version of the app does not know (a newer module) is left out rather than shown blank.
  const items = (list.data?.items ?? []).filter((n) => isKnownKind(n.kind));
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button variant="outline" size="sm" disabled={!list.data?.unread || read.isPending} onClick={() => read.mutate({ all: true })}>
            {t('readAll')}
          </Button>
        }
      />
      {list.isLoading ? (
        <ListSkeleton />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : items.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <Card className="block divide-y p-0">
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => open(n)}
              className={cn('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none', !n.read && 'bg-primary/5')}
            >
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-primary')} aria-hidden />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className={cn('block text-sm', n.read ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                  {line(n)}
                  {!n.read && <span className="sr-only"> ({t('unread')})</span>}
                </span>
                <span className="block text-xs text-subtle-foreground">{f.dateTime(n.createdAt)}</span>
              </span>
            </button>
          ))}
        </Card>
      )}
      {read.error && <ErrorText>{errorMessage(read.error)}</ErrorText>}
      {list.data && <Settings muted={list.data.muted} />}
    </div>
  );
}
