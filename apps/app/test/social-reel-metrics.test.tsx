// A Reel's watch time (#1147) on the post screen and in What works, in natural Vietnamese and in English with the
// app's number formatting, and nothing for a post without it. Rendered on the server.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MedianWatchTime, WatchTimeItems } from '../src/components/social-reel-metrics.tsx';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { reelCounts, REEL_METRICS, watchDuration, watchSeconds } from '../src/lib/social-insights.ts';

const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
};
// The text a reader sees, tags left out.
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (metrics: Record<string, number>, locale: 'vi' | 'en' = 'vi') =>
  text(
    render(
      <dl>
        <WatchTimeItems metrics={metrics} />
      </dl>,
      locale,
    ),
  );

describe('Reel watch time (#1147)', () => {
  it('lists the watch times a capture holds, in order, and turns milliseconds into a readable duration', () => {
    expect(REEL_METRICS).toEqual(['avgWatchTimeMs', 'totalWatchTimeMs']);
    expect(reelCounts({ totalWatchTimeMs: 1_230_000, reach: 30, avgWatchTimeMs: 12345 })).toEqual([
      { name: 'avgWatchTimeMs', ms: 12345 },
      { name: 'totalWatchTimeMs', ms: 1_230_000 },
    ]);
    expect(reelCounts({ reach: 30, views: 50 })).toEqual([]);
    expect(watchSeconds(12345)).toBe(12.3);
    expect(watchDuration(8_000)).toEqual({ unit: 'seconds', value: 8 });
    expect(watchDuration(1_230_000)).toEqual({ unit: 'minutes', value: 20.5 });
    expect(watchDuration(18_517_500)).toEqual({ unit: 'hours', value: 5.1 });
  });

  it('reads "Thời gian xem trung bình 12,3 giây" on the post screen, with the total in the unit that reads best', () => {
    const metrics = { views: 1500, avgWatchTimeMs: 12345, totalWatchTimeMs: 18_517_500 };
    expect(items(metrics)).toBe('Thời gian xem trung bình 12,3 giây Tổng thời gian xem 5,1 giờ');
    expect(items(metrics, 'en')).toBe('Average watch time 12.3 s Total watch time 5.1 h');
    // A metric the platform refused is left out, never shown as zero.
    expect(items({ avgWatchTimeMs: 8200 })).toBe('Thời gian xem trung bình 8,2 giây');
    expect(render(<WatchTimeItems metrics={{ reach: 30, views: 50 }} />)).toBe('');
  });

  it("shows a format's median average watch time in What works", () => {
    expect(text(render(<MedianWatchTime ms={12300} />))).toBe('Thời gian xem trung bình 12,3 giây (trung vị của các bài)');
    expect(text(render(<MedianWatchTime ms={12300} />, 'en'))).toBe('Average watch time 12.3 s (median across posts)');
  });
});
