// Connected channels: connect (the offline sandbox today; Facebook, Instagram and Zalo OA come with their adapters),
// disconnect, and each channel's posting queue: weekly slots in a time zone.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { OAUTH_CHANNEL_PROVIDERS } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { VoiceEditor } from '../components/social-brand-voice.tsx';
import { WatermarkCard } from '../components/social-watermark.tsx';
import { ChatAlertCard } from '../components/social-chat-alert.tsx';
import { PublishHoldCard } from '../components/social-publish-hold.tsx';
import { BannedWordsCard } from '../components/social-banned-words.tsx';
import { ChannelSetsCard } from '../components/social-channel-sets.tsx';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { rememberOAuthAttempt } from '../lib/oauth.ts';
import { minuteLabel, parseMinute, providerName } from '../lib/social.ts';
import { shuffleRange } from '../lib/social-queue-order.ts';

type Channel = Awaited<ReturnType<typeof orpc.channels.list.call>>[number];
type OAuthProvider = (typeof OAUTH_CHANNEL_PROVIDERS)[number];
// Platforms in the order Crove adds them (Social plan §6).
const PLATFORMS = ['facebook_page', 'instagram', 'zalo_oa', 'threads', 'linkedin', 'youtube', 'tiktok', 'x', 'google_business', 'pinterest'] as const;
const OAUTH_PROVIDERS: readonly string[] = OAUTH_CHANNEL_PROVIDERS;
type Slot = { weekday: number; minute: number; label?: string; labelId?: string | null };

const CHANNEL_TONE = { active: 'success', expired: 'warning', error: 'destructive', revoked: 'outline' } as const;
// Platforms whose tokens Crove cannot renew: the member reconnects before the date, and is warned two weeks ahead.
const NO_RENEWAL: readonly string[] = ['linkedin'];
const WARN_BEFORE_MS = 14 * 86_400_000;
// The time zones most Crove orgs post in; the queue keeps any IANA zone it already has.
const ZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const dayKeyOf = (weekday: number) => DAY_KEYS[(weekday - 1) % 7] ?? 'mon';

// How many different people approve a post for this channel before it may be scheduled (S9 review policy).
// loading: the policies are still being read, so the select waits instead of showing the default.
function ReviewPolicy({ channel, required, reminders, shortLinks, fourEyes, clientApproval, canEdit, canOwn, loading }: { channel: Channel; required: number; reminders: boolean; shortLinks: boolean; fourEyes: boolean; clientApproval: boolean; canEdit: boolean; canOwn: boolean; loading: boolean }) {
  const t = useTranslations('social');
  const set = useMutation({
    mutationFn: (approvalsRequired: number) => client.social.policies.set({ connectionId: channel.id, approvalsRequired }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  // Reminders of posts waiting for review (#703), on unless turned off.
  const remind = useMutation({
    mutationFn: (reviewReminders: boolean) => client.social.policies.setReminders({ connectionId: channel.id, reviewReminders }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.social.policies.list.key() }),
  });
  const remindOn = remind.isPending && remind.variables !== undefined ? remind.variables : reminders;
  // Crove's short links with click counts (#706), off unless turned on.
  const shorten = useMutation({
    mutationFn: (on: boolean) => client.social.policies.setShortLinks({ connectionId: channel.id, shortLinks: on }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.social.policies.list.key() }),
  });
  const shortOn = shorten.isPending && shorten.variables !== undefined ? shorten.variables : shortLinks;
  // Four-eyes (#740): owners only, since turning it off weakens review.
  const eyes = useMutation({
    mutationFn: (on: boolean) => client.social.policies.setFourEyes({ connectionId: channel.id, fourEyes: on }),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const eyesOn = eyes.isPending && eyes.variables !== undefined ? eyes.variables : fourEyes;
  // The client's approval on a review link as a step (#770): owners only, like four-eyes.
  const clientStep = useMutation({
    mutationFn: (on: boolean) => client.social.policies.setClientApproval({ connectionId: channel.id, clientApproval: on }),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const clientOn = clientStep.isPending && clientStep.variables !== undefined ? clientStep.variables : clientApproval;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`policy-${channel.id}`} className="text-sm font-medium text-muted-foreground">
        {t('policyTitle')}
      </Label>
      <NativeSelect
        id={`policy-${channel.id}`}
        size="sm"
        className="w-full max-w-xs"
        value={String(required)}
        disabled={loading || !canEdit || set.isPending || channel.status === 'revoked'}
        onChange={(e) => set.mutate(Number(e.target.value))}
      >
        {[1, 2, 3].map((n) => (
          <NativeSelectOption key={n} value={String(n)}>
            {t('policyApprovals', { count: String(n) })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-subtle-foreground">{t(canEdit ? 'policyHint' : 'policyAdmins')}</p>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
      <label className="flex items-start gap-2 pt-1 text-sm text-muted-foreground">
        <Checkbox
          className="mt-0.5"
          checked={remindOn}
          disabled={loading || !canEdit || remind.isPending || channel.status === 'revoked'}
          onCheckedChange={(checked) => remind.mutate(checked === true)}
        />
        <span>
          {t('remindersLabel')}
          <span className="block text-xs text-subtle-foreground">{t('remindersHint')}</span>
        </span>
      </label>
      {remind.error && <ErrorText>{errorMessage(remind.error)}</ErrorText>}
      <label className="flex items-start gap-2 pt-1 text-sm text-muted-foreground">
        <Checkbox className="mt-0.5" checked={shortOn} disabled={loading || !canEdit || shorten.isPending || channel.status === 'revoked'} onCheckedChange={(checked) => shorten.mutate(checked === true)} />
        <span>
          {t('shortLinksLabel')}
          <span className="block text-xs text-subtle-foreground">{t('shortLinksHint')}</span>
        </span>
      </label>
      {shorten.error && <ErrorText>{errorMessage(shorten.error)}</ErrorText>}
      <label className="flex items-start gap-2 pt-1 text-sm text-muted-foreground">
        <Checkbox className="mt-0.5" checked={eyesOn} disabled={loading || !canOwn || eyes.isPending || channel.status === 'revoked'} onCheckedChange={(checked) => eyes.mutate(checked === true)} />
        <span>
          {t('fourEyesLabel')}
          <span className="block text-xs text-subtle-foreground">{t(canOwn ? 'fourEyesHint' : 'fourEyesOwners')}</span>
        </span>
      </label>
      {eyes.error && <ErrorText>{errorMessage(eyes.error)}</ErrorText>}
      <label className="flex items-start gap-2 pt-1 text-sm text-muted-foreground">
        <Checkbox className="mt-0.5" checked={clientOn} disabled={loading || !canOwn || clientStep.isPending || channel.status === 'revoked'} onCheckedChange={(checked) => clientStep.mutate(checked === true)} />
        <span>
          {t('clientApprovalLabel')}
          <span className="block text-xs text-subtle-foreground">{t(canOwn ? 'clientApprovalHint' : 'fourEyesOwners')}</span>
        </span>
      </label>
      {clientStep.error && <ErrorText>{errorMessage(clientStep.error)}</ErrorText>}
    </div>
  );
}

function QueueEditor({ channel, canEdit }: { channel: Channel; canEdit: boolean }) {
  const t = useTranslations('social');
  const f = useFormat();
  const queue = useQuery(orpc.social.queues.get.queryOptions({ input: { connectionId: channel.id } }));
  const [draft, setDraft] = useState<{ timeZone: string; slots: Slot[] } | null>(null);
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState('09:00');
  // A content category (#745): the label a new slot is kept for; '' is an open slot.
  const [category, setCategory] = useState('');
  const labels = useQuery(orpc.social.labels.list.queryOptions({ input: {} }));
  const labelName = new Map((labels.data ?? []).map((l) => [l.id, l.name]));
  const current = draft ?? (queue.data ? { timeZone: queue.data.timeZone ?? 'Asia/Ho_Chi_Minh', slots: queue.data.slots.map((s) => ({ weekday: s.weekday, minute: s.minute, ...(s.label ? { label: s.label } : {}), ...(s.labelId ? { labelId: s.labelId } : {}) })) } : null);
  const save = useMutation({
    mutationFn: (next: { timeZone: string; slots: Slot[]; paused?: boolean }) => client.social.queues.set({ connectionId: channel.id, ...next }),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries();
    },
  });
  if (queue.isLoading || !current) return <Spinner />;
  const sorted = [...current.slots].sort((a, b) => a.weekday - b.weekday || a.minute - b.minute);
  const add = () => {
    const minute = parseMinute(time);
    if (minute === null || current.slots.some((s) => s.weekday === weekday && s.minute === minute)) return;
    setDraft({ ...current, slots: [...current.slots, { weekday, minute, ...(category ? { labelId: category } : {}) }] });
  };
  const everyDay = () => {
    const minute = parseMinute(time);
    if (minute === null) return;
    const missing = WEEKDAYS.filter((d) => !current.slots.some((s) => s.weekday === d && s.minute === minute)).map((d) => ({ weekday: d, minute, ...(category ? { labelId: category } : {}) }));
    setDraft({ ...current, slots: [...current.slots, ...missing] });
  };
  const paused = queue.data?.paused ?? false;
  return (
    <div className="space-y-3">
      {paused && <p className="text-xs text-warning">{t('queuePausedNote')}</p>}
      <div className="flex flex-wrap items-end gap-2">
        {canEdit && queue.data?.queueId && (
          <label className="flex h-7 items-center gap-2 text-sm text-muted-foreground" title={draft ? t('saveQueueFirst') : undefined}>
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={paused}
              disabled={Boolean(draft) || save.isPending}
              onChange={(e) => save.mutate({ ...current, paused: e.target.checked })}
            />
            {t('pauseQueue')}
          </label>
        )}
        <div className="space-y-1">
          <Label className="text-xs">{t('timeZone')}</Label>
          <NativeSelect size="sm" value={current.timeZone} disabled={!canEdit} onChange={(e) => setDraft({ ...current, timeZone: e.target.value })}>
            {[...new Set([current.timeZone, ...ZONES])].map((z) => (
              <NativeSelectOption key={z} value={z}>
                {z}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="text-xs text-subtle-foreground">{t('noSlots')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {sorted.map((s) => (
            <span key={`${s.weekday}:${s.minute}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1 text-xs text-foreground">
              {t(`weekday.${dayKeyOf(s.weekday)}`)} <span className="font-mono tabular-nums">{minuteLabel(s.minute)}</span>
              {s.labelId && <span className="text-subtle-foreground">· {labelName.get(s.labelId) ?? t('queueCategoryGone')}</span>}
              {canEdit && (
                <button
                  type="button"
                  aria-label={t('removeSlot')}
                  className="rounded text-subtle-foreground hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  onClick={() => setDraft({ ...current, slots: current.slots.filter((x) => !(x.weekday === s.weekday && x.minute === s.minute)) })}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect size="sm" value={String(weekday)} onChange={(e) => setWeekday(Number(e.target.value))} aria-label={t('weekdayLabel')}>
            {WEEKDAYS.map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {t(`weekday.${dayKeyOf(d)}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input type="time" step={60} value={time} onChange={(e) => setTime(e.target.value)} className="h-7 w-28" aria-label={t('timeLabel')} />
          {(labels.data?.length ?? 0) > 0 && (
            <NativeSelect size="sm" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('queueCategory')} title={t('queueCategoryHint')}>
              <NativeSelectOption value="">{t('queueCategoryOpen')}</NativeSelectOption>
              {(labels.data ?? []).map((l) => (
                <NativeSelectOption key={l.id} value={l.id}>
                  {t('queueCategoryFor', { label: l.name })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          <Button variant="outline" size="sm" onClick={add}>
            {t('addSlot')}
          </Button>
          <Button variant="ghost" size="sm" onClick={everyDay}>
            {t('addEveryDay')}
          </Button>
          <Button size="sm" disabled={!draft || save.isPending} onClick={() => draft && save.mutate(draft)}>
            {t('saveQueue')}
          </Button>
        </div>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      {!draft && (queue.data?.nextFree.length ?? 0) > 0 && (
        <p className="text-xs text-subtle-foreground">{t('nextFree', { list: (queue.data?.nextFree ?? []).map((s) => f.dateTime(s)).join(', ') })}</p>
      )}
      {canEdit && queue.data?.queueId && <QueueShuffle connectionId={channel.id} timeZone={queue.data.timeZone ?? current.timeZone} unsaved={Boolean(draft)} />}
    </div>
  );
}

// Shuffling the queue (#1020): the scheduled posts waiting in it trade their times, all of them or those of a few days.
function QueueShuffle({ connectionId, timeZone, unsaved }: { connectionId: string; timeZone: string; unsaved: boolean }) {
  const t = useTranslations('social');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = shuffleRange(from, to, timeZone);
  const shuffle = useMutation({
    mutationFn: () => client.social.queues.shuffle({ connectionId, ...range }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`shuffle-from-${connectionId}`}>
            {t('shuffleFrom')}
          </Label>
          <Input id={`shuffle-from-${connectionId}`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`shuffle-to-${connectionId}`}>
            {t('shuffleTo')}
          </Label>
          <Input id={`shuffle-to-${connectionId}`} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-7 w-40" />
        </div>
        <Button variant="outline" size="sm" disabled={unsaved || !range || shuffle.isPending} title={unsaved ? t('saveQueueFirst') : undefined} onClick={() => shuffle.mutate()}>
          {t('shuffleQueue')}
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground">{t('shuffleHint')}</p>
      {!range && <ErrorText>{t('shuffleRangeInvalid')}</ErrorText>}
      {shuffle.data && (
        <p role="status" className="text-xs text-muted-foreground">
          {shuffle.data.moved.length > 0 ? t('shuffled', { count: shuffle.data.moved.length }) : t('shuffledNone')}
        </p>
      )}
      {shuffle.error && <ErrorText>{errorMessage(shuffle.error)}</ErrorText>}
    </div>
  );
}

export function SocialChannelsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social');
  const f = useFormat();
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const voices = useQuery(orpc.social.brandVoices.list.queryOptions({ input: {} }));
  const orgVoice = voices.data?.find((v) => v.connectionId === null);
  const channelVoice = new Map((voices.data ?? []).filter((v) => v.connectionId !== null).map((v) => [v.connectionId as string, v]));
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const policyRows = useQuery(orpc.social.policies.list.queryOptions({ input: {} }));
  const policies = new Map((policyRows.data ?? []).map((p) => [p.connectionId, p.approvalsRequired]));
  const reminders = new Map((policyRows.data ?? []).map((p) => [p.connectionId, p.reviewReminders]));
  const shortLinks = new Map((policyRows.data ?? []).map((p) => [p.connectionId, p.shortLinks]));
  const fourEyes = new Map((policyRows.data ?? []).map((p) => [p.connectionId, p.fourEyes]));
  const clientApproval = new Map((policyRows.data ?? []).map((p) => [p.connectionId, p.clientApproval]));
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const sandbox = getConfig().channels?.sandbox ?? false;
  const connect = useMutation({
    mutationFn: () => client.channels.connectSandbox({ displayName: name.trim(), key: crypto.randomUUID() }),
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries();
    },
  });
  const oauth = getConfig().channels?.oauth ?? [];
  // Bluesky: the account's handle and an app password, checked by the server and sealed; the form forgets them.
  const blueskyOn = getConfig().channels?.bluesky ?? false;
  const [bsky, setBsky] = useState({ handle: '', appPassword: '' });
  const connectBluesky = useMutation({
    mutationFn: () => client.channels.connectBluesky({ handle: bsky.handle.trim(), appPassword: bsky.appPassword.trim() }),
    onSuccess: () => {
      setBsky({ handle: '', appPassword: '' });
      void queryClient.invalidateQueries();
    },
  });
  // Mastodon: the instance and an access token, checked by the server and sealed; the form forgets the token.
  const mastodonOn = getConfig().channels?.mastodon ?? false;
  const [mdn, setMdn] = useState({ instance: '', accessToken: '' });
  const connectMastodon = useMutation({
    mutationFn: () => client.channels.connectMastodon({ instance: mdn.instance.trim(), accessToken: mdn.accessToken.trim() }),
    onSuccess: () => {
      setMdn({ instance: '', accessToken: '' });
      void queryClient.invalidateQueries();
    },
  });
  // WordPress: the site, a user name and an application password, checked by the server and sealed; the form forgets
  // the password.
  const wordpressOn = getConfig().channels?.wordpress ?? false;
  const [wp, setWp] = useState({ site: '', username: '', appPassword: '' });
  const connectWordPress = useMutation({
    mutationFn: () => client.channels.connectWordPress({ site: wp.site.trim(), username: wp.username.trim(), appPassword: wp.appPassword.trim() }),
    onSuccess: () => {
      setWp({ site: '', username: '', appPassword: '' });
      void queryClient.invalidateQueries();
    },
  });
  // Telegram: a bot token and the channel, checked by the server and sealed; the form forgets the token.
  const telegramOn = getConfig().channels?.telegram ?? false;
  const [tg, setTg] = useState({ botToken: '', channel: '' });
  const connectTelegram = useMutation({
    mutationFn: () => client.channels.connectTelegram({ botToken: tg.botToken.trim(), channel: tg.channel.trim() }),
    onSuccess: () => {
      setTg({ botToken: '', channel: '' });
      void queryClient.invalidateQueries();
    },
  });
  // Discord: a channel's webhook URL, checked by the server and sealed; the form forgets it.
  const discordOn = getConfig().channels?.discord ?? false;
  const [webhookUrl, setWebhookUrl] = useState('');
  const connectDiscord = useMutation({
    mutationFn: () => client.channels.connectDiscord({ webhookUrl: webhookUrl.trim() }),
    onSuccess: () => {
      setWebhookUrl('');
      void queryClient.invalidateQueries();
    },
  });
  // The provider's dialog runs in this tab; it comes back to the callback screen, which finishes the attempt.
  const start = useMutation({
    mutationFn: (provider: OAuthProvider) => client.channels.oauthStart({ provider }),
    onSuccess: (attempt) => {
      rememberOAuthAttempt(attempt.state, slug);
      window.location.assign(attempt.authorizeUrl);
    },
  });
  const waiting = useQuery(orpc.social.channels.waiting.queryOptions({ input: {} }));
  const pausedOn = new Map((waiting.data ?? []).map((w) => [w.connectionId, w.paused]));
  const blueskyForm = useRef<HTMLInputElement>(null);
  const telegramForm = useRef<HTMLInputElement>(null);
  const mastodonForm = useRef<HTMLInputElement>(null);
  const discordForm = useRef<HTMLInputElement>(null);
  const wordpressForm = useRef<HTMLInputElement>(null);
  // Reconnecting connects the same account again: the provider's dialog, or the Bluesky form with its handle.
  const reconnect = (c: Channel) => {
    if (c.provider === 'bluesky') {
      setBsky({ handle: c.displayName.replace(/^@/, ''), appPassword: '' });
      blueskyForm.current?.focus();
      return;
    }
    if (c.provider === 'telegram') {
      telegramForm.current?.focus();
      return;
    }
    if (c.provider === 'discord') {
      discordForm.current?.focus();
      return;
    }
    if (c.provider === 'mastodon') {
      // The account id ends with its instance's host.
      setMdn({ instance: c.displayName.match(/@([^@\s)]+)\)$/)?.[1] ?? '', accessToken: '' });
      mastodonForm.current?.focus();
      return;
    }
    if (c.provider === 'wordpress') {
      // The account id is the site's host and path.
      setWp({ site: `https://${c.externalAccountId}`, username: '', appPassword: '' });
      wordpressForm.current?.focus();
      return;
    }
    if (oauth.includes(c.provider as OAuthProvider)) start.mutate(c.provider as OAuthProvider);
  };
  const canReconnect = (c: Channel) => isAdmin && c.status !== 'revoked' && (c.provider === 'bluesky' ? blueskyOn : c.provider === 'telegram' ? telegramOn : c.provider === 'mastodon' ? mastodonOn : c.provider === 'discord' ? discordOn : c.provider === 'wordpress' ? wordpressOn : oauth.includes(c.provider as OAuthProvider));
  const disconnect = useMutation({
    mutationFn: (connectionId: string) => client.channels.disconnect({ connectionId, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries();
    },
  });

  return (
    <>
      <PageHeader
        title={t('channelsTitle')}
        subtitle={t('channelsSubtitle')}
        actions={
          <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
            {t('back')}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card className="block space-y-2 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('voice.orgTitle')}</p>
              <p className="text-xs text-subtle-foreground">{t('voice.orgHint')}</p>
            </div>
            {!voices.isLoading && <VoiceEditor key={orgVoice?.updatedAt ?? 'none'} connectionId={null} voice={orgVoice} canEdit={isAdmin} />}
          </Card>
          <Card className="block space-y-2 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('watermark.title')}</p>
              <p className="text-xs text-subtle-foreground">{t('watermark.hint')}</p>
            </div>
            <WatermarkCard canEdit={isAdmin} />
          </Card>
          <Card className="block p-4">
            <PublishHoldCard key={slug} />
          </Card>
          <BannedWordsCard channels={(channels.data ?? []).filter((c) => c.status !== 'revoked')} canEdit={isAdmin} />
          <Card className="block space-y-2 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('chatAlert.title')}</p>
              <p className="text-xs text-subtle-foreground">{t('chatAlert.hint')}</p>
            </div>
            <ChatAlertCard canEdit={isAdmin} />
          </Card>
          {/* Once the channels are loaded: before, every set would read as having none left. */}
          {channels.data && <ChannelSetsCard channels={channels.data.filter((c) => c.status !== 'revoked')} canEdit={isAdmin} />}
          {channels.isLoading ? (
            <Spinner />
          ) : channels.error ? (
            <ErrorText>{errorMessage(channels.error)}</ErrorText>
          ) : (channels.data?.length ?? 0) === 0 ? (
            <Empty title={t('noChannelsTitle')} hint={t('noChannelsHint')} />
          ) : (
            channels.data?.map((c) => (
              <Card key={c.id} className="block space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{providerName(c.provider)}</Badge>
                      <span className="truncate text-sm font-medium text-foreground">{c.displayName}</span>
                      <Badge variant={CHANNEL_TONE[c.status]}>{t(`channelStatus.${c.status}`)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-subtle-foreground">{t('connectedAt', { when: f.dateTime(c.connectedAt) })}</p>
                    {c.status !== 'active' && <p className="mt-1 text-xs text-warning">{t('reconnectHint')}</p>}
                    {c.status === 'active' && c.expiresAt && NO_RENEWAL.includes(c.provider) && (
                      <p className={Date.parse(c.expiresAt) - Date.now() < WARN_BEFORE_MS ? 'mt-1 text-xs text-warning' : 'mt-1 text-xs text-subtle-foreground'}>
                        {t(Date.parse(c.expiresAt) - Date.now() < WARN_BEFORE_MS ? 'expiresSoon' : 'expiresOn', { when: f.date(c.expiresAt) })}
                      </p>
                    )}
                    {(pausedOn.get(c.id) ?? 0) > 0 && (
                      <p className="mt-1 text-xs text-warning">
                        {t('pausedPosts', { count: pausedOn.get(c.id) ?? 0 })}{' '}
                        <Link to="/o/$slug/social" params={{ slug }} className="text-link hover:underline">
                          {t('seePosts')}
                        </Link>
                      </p>
                    )}
                    {canReconnect(c) && (c.status !== 'active' || (c.expiresAt !== null && NO_RENEWAL.includes(c.provider) && Date.parse(c.expiresAt) - Date.now() < WARN_BEFORE_MS)) && (
                      <Button variant="outline" size="sm" className="mt-2" disabled={start.isPending} onClick={() => reconnect(c)}>
                        {t('reconnect')}
                      </Button>
                    )}
                  </div>
                  {isAdmin &&
                    (confirming === c.id ? (
                      <div className="flex gap-2">
                        <Button variant="destructive" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate(c.id)}>
                          {t('confirmDisconnect')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                          {t('keep')}
                        </Button>
                      </div>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(c.id)}>
                        {t('disconnect')}
                      </Button>
                    ))}
                </div>
                {confirming === c.id && <p className="text-xs text-muted-foreground">{t('disconnectHint')}</p>}
                <div className="border-t pt-3">
                  <ReviewPolicy channel={c} required={policies.get(c.id) ?? 1} reminders={reminders.get(c.id) ?? true} shortLinks={shortLinks.get(c.id) ?? false} fourEyes={fourEyes.get(c.id) ?? false} clientApproval={clientApproval.get(c.id) ?? false} canEdit={isAdmin} canOwn={role === 'owner'} loading={policyRows.isLoading} />
                </div>
                <div className="border-t pt-3">
                  <p className="mb-2 text-sm font-medium text-muted-foreground">{t('voice.channelTitle')}</p>
                  {!voices.isLoading && <VoiceEditor key={channelVoice.get(c.id)?.updatedAt ?? 'none'} connectionId={c.id} voice={channelVoice.get(c.id)} canEdit={isAdmin} inherited={orgVoice !== undefined} />}
                </div>
                <div className="border-t pt-3">
                  <p className="mb-2 text-sm font-medium text-muted-foreground">{t('queueTitle')}</p>
                  <QueueEditor channel={c} canEdit={isAdmin} />
                </div>
              </Card>
            ))
          )}
          {disconnect.error && <ErrorText>{errorMessage(disconnect.error)}</ErrorText>}
        </div>
        <Card className="block h-fit space-y-4 p-4">
          <p className="text-sm font-medium text-foreground">{t('connectTitle')}</p>
          {sandbox && isAdmin ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) connect.mutate();
              }}
            >
              <Label htmlFor="sandbox-name">{t('sandboxName')}</Label>
              <Input id="sandbox-name" value={name} placeholder={t('sandboxPlaceholder')} onChange={(e) => setName(e.target.value)} />
              <p className="text-xs text-subtle-foreground">{t('sandboxHint')}</p>
              <Button type="submit" size="lg" disabled={!name.trim() || connect.isPending}>
                {t('connectSandbox')}
              </Button>
              {connect.error && <ErrorText>{errorMessage(connect.error)}</ErrorText>}
            </form>
          ) : (
            <p className="text-xs text-subtle-foreground">{isAdmin ? t('sandboxOff') : t('adminsConnect')}</p>
          )}
          <div className="space-y-2 border-t pt-3">
            {PLATFORMS.map((p) => (
              <div key={p} className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                {providerName(p)}
                {oauth.includes(p) ? (
                  isAdmin ? (
                    <Button variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate(p as OAuthProvider)}>
                      {t('connectWith', { provider: providerName(p) })}
                    </Button>
                  ) : null
                ) : (
                  <Badge variant="secondary">{OAUTH_PROVIDERS.includes(p) ? t('notConfigured') : t('comingSoon')}</Badge>
                )}
              </div>
            ))}
            {isAdmin && <p className="text-xs text-subtle-foreground">{t(oauth.includes('google_business') ? 'gbpConnectHint' : 'gbpSetupHint')}</p>}
            {isAdmin && oauth.length > 0 && <p className="text-xs text-subtle-foreground">{t('oauthHint')}</p>}
            {start.error && <ErrorText>{errorMessage(start.error)}</ErrorText>}
          </div>
          {blueskyOn && isAdmin && (
            <form
              className="space-y-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (bsky.handle.trim() && bsky.appPassword.trim()) connectBluesky.mutate();
              }}
            >
              <p className="text-sm font-medium text-foreground">{providerName('bluesky')}</p>
              <Label htmlFor="bsky-handle">{t('blueskyHandle')}</Label>
              <Input id="bsky-handle" ref={blueskyForm} value={bsky.handle} autoComplete="off" placeholder="ten.bsky.social" onChange={(e) => setBsky({ ...bsky, handle: e.target.value })} />
              <Label htmlFor="bsky-password">{t('blueskyAppPassword')}</Label>
              <Input id="bsky-password" type="password" autoComplete="off" value={bsky.appPassword} placeholder="xxxx-xxxx-xxxx-xxxx" onChange={(e) => setBsky({ ...bsky, appPassword: e.target.value })} />
              <p className="text-xs text-subtle-foreground">{t('blueskyHint')}</p>
              <Button type="submit" variant="outline" size="sm" disabled={!bsky.handle.trim() || !bsky.appPassword.trim() || connectBluesky.isPending}>
                {t('connectWith', { provider: providerName('bluesky') })}
              </Button>
              {connectBluesky.error && <ErrorText>{errorMessage(connectBluesky.error)}</ErrorText>}
            </form>
          )}
          {mastodonOn && isAdmin && (
            <form
              className="space-y-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (mdn.instance.trim() && mdn.accessToken.trim()) connectMastodon.mutate();
              }}
            >
              <p className="text-sm font-medium text-foreground">{providerName('mastodon')}</p>
              <Label htmlFor="mdn-instance">{t('mastodonInstance')}</Label>
              <Input id="mdn-instance" ref={mastodonForm} autoComplete="off" value={mdn.instance} placeholder="mastodon.social" onChange={(e) => setMdn({ ...mdn, instance: e.target.value })} />
              <Label htmlFor="mdn-token">{t('mastodonToken')}</Label>
              <Input id="mdn-token" type="password" autoComplete="off" value={mdn.accessToken} onChange={(e) => setMdn({ ...mdn, accessToken: e.target.value })} />
              <p className="text-xs text-subtle-foreground">{t('mastodonHint')}</p>
              <Button type="submit" variant="outline" size="sm" disabled={!mdn.instance.trim() || !mdn.accessToken.trim() || connectMastodon.isPending}>
                {t('connectWith', { provider: providerName('mastodon') })}
              </Button>
              {connectMastodon.error && <ErrorText>{errorMessage(connectMastodon.error)}</ErrorText>}
            </form>
          )}
          {wordpressOn && isAdmin && (
            <form
              className="space-y-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (wp.site.trim() && wp.username.trim() && wp.appPassword.trim()) connectWordPress.mutate();
              }}
            >
              <p className="text-sm font-medium text-foreground">{providerName('wordpress')}</p>
              <Label htmlFor="wp-site">{t('wordpressSite')}</Label>
              <Input id="wp-site" ref={wordpressForm} autoComplete="off" value={wp.site} placeholder="https://tiemcuaban.vn" onChange={(e) => setWp({ ...wp, site: e.target.value })} />
              <Label htmlFor="wp-username">{t('wordpressUsername')}</Label>
              <Input id="wp-username" autoComplete="off" value={wp.username} onChange={(e) => setWp({ ...wp, username: e.target.value })} />
              <Label htmlFor="wp-password">{t('wordpressAppPassword')}</Label>
              <Input id="wp-password" type="password" autoComplete="off" value={wp.appPassword} placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" onChange={(e) => setWp({ ...wp, appPassword: e.target.value })} />
              <p className="text-xs text-subtle-foreground">{t('wordpressHint')}</p>
              <Button type="submit" variant="outline" size="sm" disabled={!wp.site.trim() || !wp.username.trim() || !wp.appPassword.trim() || connectWordPress.isPending}>
                {t('connectWith', { provider: providerName('wordpress') })}
              </Button>
              {connectWordPress.error && <ErrorText>{errorMessage(connectWordPress.error)}</ErrorText>}
            </form>
          )}
          {telegramOn && isAdmin && (
            <form
              className="space-y-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (tg.botToken.trim() && tg.channel.trim()) connectTelegram.mutate();
              }}
            >
              <p className="text-sm font-medium text-foreground">{providerName('telegram')}</p>
              <Label htmlFor="tg-token">{t('telegramBotToken')}</Label>
              <Input id="tg-token" ref={telegramForm} type="password" autoComplete="off" value={tg.botToken} placeholder="123456789:AA..." onChange={(e) => setTg({ ...tg, botToken: e.target.value })} />
              <Label htmlFor="tg-channel">{t('telegramChannel')}</Label>
              <Input id="tg-channel" autoComplete="off" value={tg.channel} placeholder="@tenkenh" onChange={(e) => setTg({ ...tg, channel: e.target.value })} />
              <p className="text-xs text-subtle-foreground">{t('telegramHint')}</p>
              <Button type="submit" variant="outline" size="sm" disabled={!tg.botToken.trim() || !tg.channel.trim() || connectTelegram.isPending}>
                {t('connectWith', { provider: providerName('telegram') })}
              </Button>
              {connectTelegram.error && <ErrorText>{errorMessage(connectTelegram.error)}</ErrorText>}
            </form>
          )}
          {discordOn && isAdmin && (
            <form
              className="space-y-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (webhookUrl.trim()) connectDiscord.mutate();
              }}
            >
              <p className="text-sm font-medium text-foreground">{providerName('discord')}</p>
              <Label htmlFor="dc-webhook">{t('discordWebhook')}</Label>
              <Input id="dc-webhook" ref={discordForm} type="password" autoComplete="off" value={webhookUrl} placeholder="https://discord.com/api/webhooks/..." onChange={(e) => setWebhookUrl(e.target.value)} />
              <p className="text-xs text-subtle-foreground">{t('discordHint')}</p>
              <Button type="submit" variant="outline" size="sm" disabled={!webhookUrl.trim() || connectDiscord.isPending}>
                {t('connectWith', { provider: providerName('discord') })}
              </Button>
              {connectDiscord.error && <ErrorText>{errorMessage(connectDiscord.error)}</ErrorText>}
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
