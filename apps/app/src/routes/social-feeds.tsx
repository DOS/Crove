// Blog feeds that become drafts (#708): an org's RSS or Atom feeds, the channels their drafts are for, and how their
// reads went. Owners and admins add, pause and remove them; every draft made from one waits for review as usual.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';

type Feed = Awaited<ReturnType<typeof client.social.feeds.list>>[number];
type Channel = Awaited<ReturnType<typeof client.channels.list>>[number];

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.feeds.key() });

function ChannelPicks({ channels, value, onChange, disabled }: { channels: readonly Channel[]; value: readonly string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {channels.map((c) => {
        const on = value.includes(c.id);
        return (
          <Button key={c.id} type="button" size="sm" variant={on ? 'secondary' : 'outline'} aria-pressed={on} disabled={disabled} onClick={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])}>
            {providerName(c.provider)} · {c.displayName}
          </Button>
        );
      })}
    </div>
  );
}

function FeedRow({ feed, channels, canManage }: { feed: Feed; channels: readonly Channel[]; canManage: boolean }) {
  const t = useTranslations('social.feeds');
  const f = useFormat();
  const update = useMutation({ mutationFn: (paused: boolean) => client.social.feeds.update({ feedId: feed.id, paused }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => client.social.feeds.remove({ feedId: feed.id }), onSuccess: refresh });
  const names = feed.connectionIds.map((id) => channels.find((c) => c.id === id)).filter((c): c is Channel => c !== undefined);
  return (
    <Card className="block space-y-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{feed.title ?? feed.url}</p>
          <a href={feed.url} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-link hover:underline">
            {feed.url}
          </a>
        </div>
        {feed.paused ? <Badge variant="warning">{t('paused')}</Badge> : <Badge variant="secondary">{t('active')}</Badge>}
      </div>
      <p className="text-xs text-subtle-foreground">{t('for', { channels: names.map((c) => c.displayName).join(', ') || t('noChannels') })}</p>
      <p className="text-xs text-subtle-foreground">
        {feed.lastCheckedAt ? t('lastRead', { when: f.dateTime(feed.lastCheckedAt) }) : t('notReadYet')}
        {' · '}
        {t('drafts', { count: feed.drafts })}
      </p>
      {feed.lastError && <p className="text-xs text-destructive">{t('lastError', { failures: feed.failures, error: t(`errors.${feed.lastError in ERRORS ? (feed.lastError as keyof typeof ERRORS) : 'other'}`) })}</p>}
      {canManage && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate(!feed.paused)}>
            {t(feed.paused ? 'resume' : 'pause')}
          </Button>
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => window.confirm(t('removeConfirm')) && remove.mutate()}>
            {t('remove')}
          </Button>
        </div>
      )}
      {(update.error ?? remove.error) && <ErrorText>{errorMessage(update.error ?? remove.error)}</ErrorText>}
    </Card>
  );
}

// The read errors the worker records, by code; any other is "other".
const ERRORS = { http: 1, not_feed: 1, invalid_url: 1, blocked: 1, dns: 1, timeout: 1, too_large: 1, redirects: 1, encoding: 1, network: 1 } as const;

export function SocialFeedsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social.feeds');
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canManage = role === 'owner' || role === 'admin';
  const feeds = useQuery(orpc.social.feeds.list.queryOptions({ input: {} }));
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const live = (channels.data ?? []).filter((c) => c.status !== 'revoked');
  const [url, setUrl] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const add = useMutation({
    mutationFn: () => client.social.feeds.add({ url: url.trim(), connectionIds: picked }),
    onSuccess: () => {
      setUrl('');
      setPicked([]);
      refresh();
    },
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
            {t('back')}
          </Link>
        }
      />
      {canManage && (
        <Card className="block space-y-3 p-4">
          <h3 className="text-sm font-medium text-foreground">{t('add')}</h3>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim() && picked.length > 0 && !add.isPending) add.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="feed-url">{t('url')}</Label>
              <Input id="feed-url" type="url" value={url} maxLength={2000} placeholder="https://blog.example.vn/feed" onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{t('channels')}</p>
              {live.length === 0 ? <p className="text-xs text-subtle-foreground">{t('noChannelsYet')}</p> : <ChannelPicks channels={live} value={picked} onChange={setPicked} disabled={add.isPending} />}
            </div>
            <p className="text-xs text-subtle-foreground">{t('hint')}</p>
            {add.error && <ErrorText>{errorMessage(add.error)}</ErrorText>}
            <Button type="submit" disabled={!url.trim() || picked.length === 0 || add.isPending}>
              {add.isPending ? <Spinner className="text-current" /> : null}
              {t('save')}
            </Button>
          </form>
        </Card>
      )}
      {feeds.isLoading ? (
        <Spinner />
      ) : feeds.error ? (
        <ErrorText>{errorMessage(feeds.error)}</ErrorText>
      ) : (feeds.data ?? []).length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-3">
          {(feeds.data ?? []).map((feed) => (
            <FeedRow key={feed.id} feed={feed} channels={channels.data ?? []} canManage={canManage} />
          ))}
        </div>
      )}
    </div>
  );
}
