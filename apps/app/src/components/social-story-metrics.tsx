// A Story's own counts on the Metrics tab (#1082): one line under its row in the published posts table, and the
// window's Story totals under the cards. Both show nothing when no Story reported them.
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { storyCounts } from '../lib/social-insights.ts';

// A Story's own counts (#1082), on one line under its row; nothing for a post without them.
export function StoryLine({ metrics }: { metrics: Record<string, number> }) {
  const t = useTranslations('social');
  const f = useFormat();
  const counts = storyCounts(metrics);
  if (counts.length === 0) return null;
  return (
    <p className="text-xs text-subtle-foreground">
      <span className="font-medium text-muted-foreground">{t('metricsStory')}</span>
      {': '}
      {counts.map((c) => `${t(`metric.${c.name}`)} ${f.number(c.value)}`).join(' · ')}
    </p>
  );
}

// The window's Story counts (#1082), summed by the server with the others; shown only when a Story has them.
export function StoryTotals({ metrics }: { metrics: Record<string, number> }) {
  const t = useTranslations('social');
  const f = useFormat();
  const counts = storyCounts(metrics);
  if (counts.length === 0) return null;
  return (
    <Card className="block space-y-2 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('metricsStoryTotals')}</p>
        <p className="text-xs text-subtle-foreground">{t('metricsStoryHint')}</p>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {counts.map((c) => (
          <div key={c.name} className="flex gap-1">
            <dt className="text-subtle-foreground">{t(`metric.${c.name}`)}</dt>
            <dd className="font-medium text-foreground tabular-nums">{f.number(c.value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
