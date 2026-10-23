// A Reel's watch time (#1147), as Instagram reports it in milliseconds: on the post screen, the average time a play
// lasted ("Thời gian xem trung bình 12,3 giây") and the time it was played in all; in What works, the median average
// watch time of a format's posts. Both show nothing when no post reported one.
import { useTranslations } from 'use-intl';
import { useFormat } from '../i18n/provider.tsx';
import { reelCounts, watchDuration, watchSeconds } from '../lib/social-insights.ts';

// The watch times of a capture, as items of the post screen's counts list (a <dl>); nothing for a post without them.
export function WatchTimeItems({ metrics }: { metrics: Record<string, number> }) {
  const t = useTranslations('social');
  const f = useFormat();
  return (
    <>
      {reelCounts(metrics).map((c) => {
        // The average in seconds, as the platforms show it; the total in the unit that reads best.
        const d = c.name === 'avgWatchTimeMs' ? { unit: 'seconds' as const, value: watchSeconds(c.ms) } : watchDuration(c.ms);
        return (
          <div key={c.name} className="flex gap-1">
            <dt>{t(`metric.${c.name}`)}</dt>
            <dd className="font-medium text-foreground tabular-nums">{t(`watch.${d.unit}`, { value: f.number(d.value) })}</dd>
          </div>
        );
      })}
    </>
  );
}

// What works: a format's median average watch time, under its bar.
export function MedianWatchTime({ ms }: { ms: number }) {
  const t = useTranslations('social');
  const f = useFormat();
  return <span className="text-subtle-foreground tabular-nums">{t('insights.watchTime', { time: t('watch.seconds', { value: f.number(watchSeconds(ms)) }) })}</span>;
}
