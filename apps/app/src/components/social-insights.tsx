// What works (#705): for each channel, its best and worst posts of the window and how its labels, formats, weekdays,
// hours and hashtags do against the channel's own median engagement. Each bar shows a group's median against that
// median (the middle mark), with its post count so a thin sample shows as one. A format whose posts report a watch
// time (#1147, Reels) shows their median average watch time under its bar. A channel and a group whose posts report
// reach or impressions also show their engagement rate (#1157), the sum over those posts, never a mean of rates.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { cn } from '@crove/ui/lib/utils';
import { useLabels } from './social-labels.tsx';
import { MedianWatchTime } from './social-reel-metrics.tsx';
import { useRatePhrase } from './social-engagement-rate.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { barWidth, DAY_KEYS } from '../lib/social-insights.ts';

type Channel = Awaited<ReturnType<typeof client.social.metrics.insights>>['channels'][number];
type Group = Channel['byLabel'][number];

function Bars({ title, groups, name }: { title: string; groups: readonly Group[]; name: (key: string) => string }) {
  const t = useTranslations('social.insights');
  const f = useFormat();
  const rate = useRatePhrase('inline');
  if (groups.length === 0) return null;
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="space-y-1">
        {groups.slice(0, 8).map((g) => (
          <li key={g.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 text-xs">
            <span className="truncate text-foreground" title={name(g.key)}>
              {name(g.key)}
            </span>
            <span className="relative h-2 rounded-full bg-muted" aria-hidden="true">
              <span className={cn('absolute inset-y-0 left-0 rounded-full', g.ratio !== null && g.ratio >= 1 ? 'bg-primary' : 'bg-muted-foreground/50')} style={{ width: `${barWidth(g.ratio)}%` }} />
              <span className="absolute inset-y-[-2px] left-1/2 w-px bg-foreground/40" />
            </span>
            <span className="text-subtle-foreground tabular-nums">
              {t('group', { median: f.number(Math.round(g.median)), posts: String(g.posts) })}
              {g.rate && `, ${rate(g.rate)}`}
            </span>
            {g.avgWatchTimeMs !== undefined && (
              <span className="col-span-3">
                <MedianWatchTime ms={g.avgWatchTimeMs} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PostList({ title, posts, slug }: { title: string; posts: Channel['best']; slug: string }) {
  const t = useTranslations('social.insights');
  const f = useFormat();
  if (posts.length === 0) return null;
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ol className="space-y-1">
        {posts.map((p) => (
          <li key={p.variantId}>
            <Link to="/o/$slug/social/$id" params={{ slug, id: p.postId }} className="flex items-baseline justify-between gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted">
              <span className="line-clamp-1 [overflow-wrap:anywhere] text-foreground">{p.excerpt || t('noText')}</span>
              <span className="shrink-0 text-subtle-foreground tabular-nums">{t('engagement', { count: f.number(p.engagement) })}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function WhatWorks({ slug, days, labelId, names }: { slug: string; days: number; labelId?: string | undefined; names: Map<string, string> }) {
  const t = useTranslations('social.insights');
  const tw = useTranslations('social.weekday');
  const f = useFormat();
  const rate = useRatePhrase('inline');
  const labels = new Map((useLabels().data ?? []).map((l) => [l.id, l.name]));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const insights = useQuery(orpc.social.metrics.insights.queryOptions({ input: { days, timeZone, ...(labelId ? { labelId } : {}) } }));
  if (insights.isLoading) return <Spinner />;
  if (insights.error) return <ErrorText>{errorMessage(insights.error)}</ErrorText>;
  const channels = insights.data?.channels ?? [];
  if (channels.length === 0) return null;
  return (
    <Card className="block space-y-4 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {channels.map((c) => (
        <section key={c.connectionId} aria-label={names.get(c.connectionId) ?? c.connectionId} className="space-y-3 border-t pt-3 first:border-t-0 first:pt-0">
          <p className="text-sm text-foreground">
            <span className="font-medium">{names.get(c.connectionId) ?? c.connectionId.slice(0, 8)}</span>
            <span className="text-subtle-foreground">
              {' · '}
              {t('channelLine', { posts: String(c.posts), median: f.number(Math.round(c.median)) })}
              {c.rate && `, ${rate(c.rate)}`}
            </span>
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <PostList title={t('best')} posts={c.best} slug={slug} />
            <PostList title={t('worst')} posts={c.worst} slug={slug} />
            <Bars title={t('byFormat')} groups={c.byFormat} name={(k) => t(`formats.${k as 'text'}`)} />
            <Bars title={t('byLabel')} groups={c.byLabel} name={(k) => labels.get(k) ?? t('unknownLabel')} />
            <Bars title={t('byWeekday')} groups={c.byWeekday} name={(k) => tw(DAY_KEYS[Number(k) - 1] ?? 'mon')} />
            <Bars title={t('byHour')} groups={c.byHour} name={(k) => `${k.padStart(2, '0')}:00`} />
            <Bars title={t('byHashtag')} groups={c.byHashtag} name={(k) => `#${k}`} />
          </div>
        </section>
      ))}
      {insights.data?.truncated && <p className="text-xs text-subtle-foreground">{t('truncated')}</p>}
    </Card>
  );
}
