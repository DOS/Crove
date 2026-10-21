// Account growth on the Metrics tab (#645): each channel's followers over the window (a number, its change and a
// small line from the daily snapshots the worker takes), and the posts of the window with the most engagement.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { changeOf, engagementOf, growthOf, sparkline, topPosts } from '../lib/social-growth.ts';
import { providerName } from '../lib/social.ts';

export function AccountGrowth({ days, names }: { days: number; names: Map<string, string> }) {
  const t = useTranslations('social.growth');
  const f = useFormat();
  const trends = useQuery(orpc.social.accounts.trends.queryOptions({ input: { days } }));
  if (trends.isLoading) return <Spinner />;
  if (trends.error) return <ErrorText>{errorMessage(trends.error)}</ErrorText>;
  const list = trends.data ?? [];
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title', { days: String(days) })}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y">
          {list.map((trend) => {
            const g = growthOf(trend.points);
            const values = trend.points.map((p) => p.followers).filter((v): v is number => v !== null);
            const path = sparkline(values, 120, 28);
            return (
              <li key={trend.connectionId} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{names.get(trend.connectionId) ?? providerName(trend.provider)}</span>
                  <span className="block text-xs text-subtle-foreground">{providerName(trend.provider)}</span>
                </span>
                {path && (
                  <svg viewBox="0 0 120 28" className="h-7 w-28 text-primary" role="img" aria-label={t('line')}>
                    <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  </svg>
                )}
                <span className="w-32 text-right">
                  <span className="block text-sm font-semibold text-foreground tabular-nums">{g.latest === null ? '-' : t('followers', { count: f.number(g.latest) })}</span>
                  {g.change !== null && (
                    <span className={cn('block text-xs tabular-nums', g.change > 0 ? 'text-success' : g.change < 0 ? 'text-destructive' : 'text-subtle-foreground')}>
                      {g.change > 0 ? '+' : ''}
                      {f.number(g.change)}
                    </span>
                  )}
                  {g.reach !== null && <span className="block text-xs text-subtle-foreground tabular-nums">{t('reach', { count: f.number(g.reach) })}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// A count's change against the period just before (#947): an up or down arrow and the percentage, green up and red
// down, "-" when the period before has no data or is zero. against: that period in words ("30 ngày trước"), for the
// label a screen reader reads. withPrevious: the count of the period before, written next to it.
export function ChangeChip({ current, previous, against, withPrevious = false, className }: { current: number | null | undefined; previous: number | null | undefined; against: string; withPrevious?: boolean; className?: string }) {
  const t = useTranslations('social.growth.change');
  const f = useFormat();
  const change = changeOf(current, previous);
  const percent = change ? `${f.number(Math.abs(change.percent))}%` : '';
  const label = !change ? t('none', { against }) : t(change.direction, { percent, against });
  const before = previous === null || previous === undefined ? null : t('previous', { value: f.number(previous) });
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 text-xs tabular-nums', className)}>
      <span
        title={before ? `${label} (${before})` : label}
        className={cn(
          'inline-flex items-center rounded-md border px-1.5 py-0.5 leading-none font-medium',
          change?.direction === 'up' ? 'border-success/30 bg-success/10 text-success' : change?.direction === 'down' ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border text-subtle-foreground',
        )}
      >
        <span aria-hidden="true">{!change ? '-' : change.direction === 'up' ? `↑ ${percent}` : change.direction === 'down' ? `↓ ${percent}` : percent}</span>
        <span className="sr-only">{label}</span>
      </span>
      {withPrevious && before && <span className="text-subtle-foreground">{before}</span>}
    </span>
  );
}

interface ChannelTotal {
  connectionId: string;
  provider: string;
  posts: number;
  metrics: Record<string, number>;
}

// Each channel's posts, reach and engagement in the window (#947), with the change against the window just before.
export function ChannelTotals({ current, previous, days, names }: { current: readonly ChannelTotal[]; previous: readonly ChannelTotal[]; days: number; names: Map<string, string> }) {
  const t = useTranslations('social.growth');
  const f = useFormat();
  const against = t('change.days', { days: String(days) });
  const before = new Map(previous.map((c) => [c.connectionId, c] as const));
  const cell = (now: number | undefined, then: number | undefined) => (
    <td className="px-3 py-2 text-right tabular-nums">
      <span className="block text-foreground">{now === undefined ? '-' : f.number(now)}</span>
      <ChangeChip current={now} previous={then} against={against} />
    </td>
  );
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('byChannel')}</h3>
        <p className="text-xs text-subtle-foreground">{t('byChannelHint', { days: String(days) })}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-subtle-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('channel')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('posts')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('reachColumn')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('engagementColumn')}</th>
            </tr>
          </thead>
          <tbody>
            {current.map((c) => {
              const then = before.get(c.connectionId);
              return (
                <tr key={c.connectionId} className="border-t align-top">
                  <td className="px-3 py-2">
                    <span className="block truncate text-foreground">{names.get(c.connectionId) ?? providerName(c.provider)}</span>
                    <span className="block text-xs text-subtle-foreground">{providerName(c.provider)}</span>
                  </td>
                  {cell(c.posts, then?.posts)}
                  {cell(c.metrics.reach, then?.metrics.reach)}
                  {cell(engagementOf(c.metrics), then ? engagementOf(then.metrics) : undefined)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

interface Row {
  postId: string;
  provider: string;
  connectionId: string;
  excerpt: string;
  publishedAt: string | null;
  metrics: Record<string, number>;
}

export function TopPosts({ rows, names, slug }: { rows: readonly Row[]; names: Map<string, string>; slug: string }) {
  const t = useTranslations('social.growth');
  const f = useFormat();
  const top = topPosts(rows, 5);
  if (top.length === 0) return null;
  return (
    <Card className="block space-y-2 p-4">
      <h3 className="text-sm font-medium text-foreground">{t('topTitle')}</h3>
      <ol className="space-y-2">
        {top.map((r, i) => (
          <li key={`${r.postId}-${r.connectionId}`} className="flex items-start gap-3 text-sm">
            <span className="w-5 shrink-0 text-right text-subtle-foreground tabular-nums">{i + 1}.</span>
            <span className="min-w-0 flex-1">
              <Link to="/o/$slug/social/$id" params={{ slug, id: r.postId }} className="block truncate text-foreground hover:underline">
                {r.excerpt || t('noText')}
              </Link>
              <span className="block text-xs text-subtle-foreground">
                {names.get(r.connectionId) ?? providerName(r.provider)} · {r.publishedAt ? f.dateTime(r.publishedAt) : ''}
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t('engagement', { count: f.number(engagementOf(r.metrics)) })}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
