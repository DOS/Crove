// In-app notifications (#637): the viewer's own, newest first. Opening one marks it read and goes to its post (or to
// the channels page for an expired channel, or a new post for a channel whose queue runs low); the settings turn kinds
// off for this member only, and browser push (#1238) goes on or off for this device.
import { useEffect, useState } from 'react';
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
import { DIGEST_KIND, NOTIFICATION_KINDS, notificationTarget, type NotificationKind } from '../lib/social-notifications.ts';
import { PushDenied, currentEndpoint, deviceOf, disablePush, enablePush, pushPermission, pushSupported } from '../lib/push.ts';
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
      // A planned takedown that did not happen (#861).
      case 'failed':
        return t(n.detail.removal === 'scheduled' ? 'text.remove_failed' : 'text.failed', { provider });
      case 'needs_attention':
        return t(`text.${n.kind}`, { provider });
      case 'channel_expired':
        return t('text.channel_expired', { channel: n.channel ?? provider });
      case 'feed_paused':
        return t('text.feed_paused', { feed: n.detail.feed ?? '' });
      case 'review_reminder':
        return t(n.detail.stage === 'due' ? 'text.reminder_due' : 'text.reminder_waiting');
      // A channel's queue running low (#1079).
      case 'queue_low':
        return t('text.queue_low', { channel: n.channel ?? t('aChannel'), days: Number(n.detail.days ?? 0), filled: n.detail.filled ?? '0', posting: n.detail.posting ?? '0' });
      // A post doing much better than usual (#1132), with its reach when the channel reports it.
      case 'post_outperforming': {
        const values = { channel: n.channel ?? (provider || t('aChannel')), ratio: Number(n.detail.ratio ?? 0) };
        // Reach only when it is at least the usual (#1132).
        return Number(n.detail.reach ?? 0) >= 1 ? t('text.post_outperforming_reach', { ...values, reach: Number(n.detail.reach) }) : t('text.post_outperforming', values);
      }
      // The org's publishing held or released (#946).
      case 'publishing_hold': {
        if (n.detail.state !== 'released') return t('text.publishing_held', { actor, reason: n.detail.reason ?? '' });
        const count = Number(n.detail.heldTooLong ?? 0);
        return count > 0 ? t('text.publishing_released_stale', { actor, count }) : t('text.publishing_released', { actor });
      }
      // A bulk assignment (#1062): one item for all its posts.
      case 'assigned':
        return n.detail.count ? t('text.assigned_many', { actor, count: Number(n.detail.count) }) : t('text.assigned', { actor });
      // A mail only (#1104); never an item of the list.
      case 'weekly_digest':
        return t('digest');
      default:
        return t(`text.${n.kind}`, { actor });
    }
  };
}

// Browser push on this device (#1238): hidden when the deployment has no VAPID keys. Turning it on asks the browser for
// permission, subscribes it and saves the subscription as the viewer's; off removes both. The viewer's other devices
// are listed with a way to remove each.
function PushSetting() {
  const t = useTranslations('social.notifications');
  const f = useFormat();
  const supported = pushSupported();
  // undefined while the browser is asked for its subscription.
  const [endpoint, setEndpoint] = useState<string | null | undefined>(supported ? undefined : null);
  const [denied, setDenied] = useState(() => pushPermission() === 'denied');
  useEffect(() => {
    if (!supported) return;
    let gone = false;
    currentEndpoint()
      .then((e) => !gone && setEndpoint(e))
      .catch(() => !gone && setEndpoint(null));
    return () => {
      gone = true;
    };
  }, [supported]);
  const status = useQuery({ ...orpc.social.notifications.push.status.queryOptions({ input: { endpoint: endpoint ?? null } }), enabled: endpoint !== undefined });
  const reload = () => void queryClient.invalidateQueries({ queryKey: orpc.social.notifications.push.status.key() });
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) {
        const publicKey = status.data?.publicKey;
        if (!publicKey) return;
        const sub = await enablePush(publicKey);
        const device = deviceOf(navigator.userAgent);
        const label = device.browser && device.os ? t('pushDevice', { browser: device.browser, os: device.os }) : (device.browser ?? device.os ?? undefined);
        await client.social.notifications.push.subscribe({ ...sub, ...(label ? { label } : {}) });
        setEndpoint(sub.endpoint);
      } else {
        if (endpoint) await client.social.notifications.push.unsubscribe({ endpoint });
        await disablePush();
        setEndpoint(null);
      }
    },
    onError: (error) => {
      if (error instanceof PushDenied) setDenied(true);
    },
    onSettled: reload,
  });
  const remove = useMutation({ mutationFn: (id: string) => client.social.notifications.push.unsubscribe({ id }), onSettled: reload });
  if (!status.data?.enabled) return null;
  const on = toggle.isPending && toggle.variables !== undefined ? toggle.variables : status.data.subscribed;
  const devices = status.data.devices;
  return (
    <div className="space-y-2 border-t pt-3">
      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <Checkbox checked={supported && on} disabled={!supported || toggle.isPending || (denied && !on)} onCheckedChange={(checked) => toggle.mutate(checked === true)} />
        <span>
          <span className="block text-foreground">{t('push')}</span>
          <span className="block text-xs text-subtle-foreground">{!supported ? t('pushUnsupported') : denied && !on ? t('pushDenied') : t('pushHint')}</span>
        </span>
      </label>
      {devices.length > 0 && (
        <div className="space-y-1 pl-6">
          <p className="text-xs font-medium text-muted-foreground">{t('pushDevices')}</p>
          <ul className="space-y-1">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-xs text-subtle-foreground">
                <span className="min-w-0 truncate">
                  {d.label ?? t('pushUnknownDevice')}
                  {d.current ? ` (${t('pushThisDevice')})` : ''} · {t('pushSince', { date: f.date(d.createdAt) })}
                </span>
                {!d.current && (
                  <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(d.id)}>
                    {t('pushRemove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(toggle.error && !(toggle.error instanceof PushDenied)) || remove.error ? <ErrorText>{errorMessage(toggle.error ?? remove.error)}</ErrorText> : null}
    </div>
  );
}

function Settings({ muted, mailOff }: { muted: readonly NotificationKind[]; mailOff: boolean }) {
  const t = useTranslations('social.notifications');
  const mute = useMutation({
    mutationFn: (v: { kind: NotificationKind; muted: boolean }) => client.social.notifications.mute(v),
    onSettled: refresh,
  });
  const mail = useMutation({ mutationFn: (enabled: boolean) => client.social.notifications.mail({ enabled }), onSettled: refresh });
  const mailOn = mail.isPending && mail.variables !== undefined ? mail.variables : !mailOff;
  const digestOn = mute.isPending && mute.variables?.kind === DIGEST_KIND ? !mute.variables.muted : !muted.includes(DIGEST_KIND);
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
      <label className="flex items-start gap-2 border-t pt-3 text-sm text-muted-foreground">
        <Checkbox checked={mailOn} disabled={mail.isPending} onCheckedChange={(checked) => mail.mutate(checked === true)} />
        <span>
          <span className="block text-foreground">{t('mail')}</span>
          <span className="block text-xs text-subtle-foreground">{t('mailHint')}</span>
        </span>
      </label>
      {/* The weekly digest (#1104): a mail, so it needs the mail switch on too. */}
      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <Checkbox checked={mailOn && digestOn} disabled={mute.isPending || !mailOn} onCheckedChange={(checked) => mute.mutate({ kind: DIGEST_KIND, muted: checked !== true })} />
        <span>
          <span className="block text-foreground">{t('digest')}</span>
          <span className="block text-xs text-subtle-foreground">{mailOn ? t('digestHint') : t('digestMailOff')}</span>
        </span>
      </label>
      {(mute.error ?? mail.error) && <ErrorText>{errorMessage(mute.error ?? mail.error)}</ErrorText>}
      <PushSetting />
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
    else if (target?.to === 'feeds') void navigate({ to: '/o/$slug/social/feeds', params: { slug } });
    else if (target?.to === 'compose') void navigate({ to: '/o/$slug/social/new', params: { slug }, search: { channel: target.channelId } });
    else if (target?.to === 'mine') void navigate({ to: '/o/$slug/social', params: { slug }, search: { mine: true } });
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
      {list.data && <Settings muted={list.data.muted} mailOff={list.data.mailOff} />}
    </div>
  );
}
