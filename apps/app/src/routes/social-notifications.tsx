// In-app notifications (#637): the viewer's own, newest first. Opening one marks it read and goes to its post (or to
// the channels page for an expired channel); the settings turn kinds off for this member only.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { cn } from '@crove/ui/lib/utils';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';
import { NOTIFICATION_KINDS, notificationTarget, type NotificationKind } from '../lib/social-notifications.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

export type NotificationItem = Awaited<ReturnType<typeof client.social.notifications.list>>['items'][number];

// The viewer's notifications; between stream hints they are read again every minute.
export function useNotifications(enabled = true) {
  const live = useStreamLive();
  return useQuery({ ...orpc.social.notifications.list.queryOptions({ input: {} }), enabled, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
}

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.notifications.list.key() });

function useLine() {
  const t = useTranslations('social.notifications');
  return (n: NotificationItem): string => {
    const actor = n.actorName ?? t('someone');
    const provider = n.detail.provider ? providerName(n.detail.provider) : '';
    switch (n.kind) {
      case 'decided': {
        const d = n.detail.decision;
        return t(d === 'approved' ? 'text.approved' : d === 'rejected' ? 'text.rejected' : 'text.changes_requested', { actor });
      }
      case 'client_answer': {
        const v = n.detail.verdict;
        return t(v === 'approved' ? 'text.client_approved' : v === 'changes_requested' ? 'text.client_changes_requested' : 'text.client_comment', { name: n.detail.name ?? '' });
      }
      case 'failed':
      case 'needs_attention':
        return t(`text.${n.kind}`, { provider });
      case 'channel_expired':
        return t('text.channel_expired', { channel: n.channel ?? provider });
      default:
        return t(`text.${n.kind}`, { actor });
    }
  };
}

function Settings({ muted }: { muted: readonly NotificationKind[] }) {
  const t = useTranslations('social.notifications');
  const mute = useMutation({
    mutationFn: (v: { kind: NotificationKind; muted: boolean }) => client.social.notifications.mute(v),
    onSettled: refresh,
  });
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('settings')}</h3>
        <p className="text-xs text-subtle-foreground">{t('settingsHint')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {NOTIFICATION_KINDS.map((kind) => {
          const on = mute.isPending && mute.variables?.kind === kind ? !mute.variables.muted : !muted.includes(kind);
          return (
            <label key={kind} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={on} disabled={mute.isPending} onCheckedChange={(checked) => mute.mutate({ kind, muted: checked !== true })} />
              {t(`kinds.${kind}`)}
            </label>
          );
        })}
      </div>
      {mute.error && <ErrorText>{errorMessage(mute.error)}</ErrorText>}
    </Card>
  );
}

export function SocialNotificationsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social.notifications');
  const f = useFormat();
  const navigate = useNavigate();
  const line = useLine();
  const list = useNotifications();
  const read = useMutation({
    mutationFn: (input: { ids: string[] } | { all: true }) => client.social.notifications.read(input),
    onSettled: refresh,
  });
  const open = (n: NotificationItem) => {
    if (!n.read) read.mutate({ ids: [n.id] });
    const target = notificationTarget(n);
    if (target?.to === 'post') void navigate({ to: '/o/$slug/social/$id', params: { slug, id: target.postId } });
    else if (target?.to === 'channels') void navigate({ to: '/o/$slug/social/channels', params: { slug } });
  };
  const items = list.data?.items ?? [];
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!list.data?.unread || read.isPending} onClick={() => read.mutate({ all: true })}>
              {t('readAll')}
            </Button>
            <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
              {t('back')}
            </Link>
          </div>
        }
      />
      {list.isLoading ? (
        <Spinner />
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
                {n.postText && <span className="block truncate text-xs text-subtle-foreground">{n.postText}</span>}
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
