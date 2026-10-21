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
import { engagementOf, growthOf, sparkline, topPosts } from '../lib/social-growth.ts';
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
