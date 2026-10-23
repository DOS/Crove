// Engagement rate (#1157) on the screens, rendered on the server in Vietnamese and English with the app's number
// formatting: the post page's counts, the Metrics tab's totals card and channels table, What works and the client
// report page, over reach, over impressions with its label where nothing reports reach, and "-" with neither or with
// zero reach.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e), fetchFile: () => Promise.reject(new Error('not fetched')), uploadFiles: () => Promise.reject(new Error('not uploaded')) };
});

const { engagementRateOf, rateBasesOf } = await import('@crove/mod-social/contract');
const { EngagementRateItem } = await import('../src/components/social-engagement-rate.tsx');
const { ChannelTotals, EngagementRateCard } = await import('../src/components/social-growth.tsx');
const { WhatWorks } = await import('../src/components/social-insights.tsx');
const { SocialReportPage } = await import('../src/routes/social-report.tsx');

type Locale = 'vi' | 'en';
const render = (node: React.ReactNode, locale: Locale) => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};
// The text a reader sees, tags left out.
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const REACH = { reach: 2000, impressions: 5000, reactions: 40, comments: 10, shares: 5, saves: 4, clicks: 10 };
const SHOWN = { impressions: 800, reactions: 6, comments: 2 };
const WORDS = {
  vi: { label: 'Tỷ lệ tương tác', reach: '3,45%', shown: '1%', byImpressions: 'theo lượt hiển thị' },
  en: { label: 'Engagement rate', reach: '3.45%', shown: '1%', byImpressions: 'by impressions' },
} as const;

describe('engagement rate on the screens (#1157)', () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${'d'.repeat(43)}` }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
    setActiveLocale('vi');
  });
  beforeEach(() => client.current.clear());

  for (const locale of ['vi', 'en'] as const) {
    const w = WORDS[locale];

    it(`shows a post's rate over reach, over impressions with its label, and "-" without either (${locale})`, () => {
      const item = (metrics: Record<string, number>) => text(render(<dl><EngagementRateItem metrics={metrics} /></dl>, locale));
      expect(item(REACH)).toBe(`${w.label} ${w.reach}`);
      expect(item(SHOWN)).toBe(`${w.label} ${w.shown} ${w.byImpressions}`);
      expect(item({ views: 300, reactions: 4 })).toBe(`${w.label} -`);
      // Zero reach divides by nothing: "-", never Infinity or NaN.
      const zero = item({ reach: 0, reactions: 4 });
      expect(zero).toBe(`${w.label} -`);
      expect(zero).not.toMatch(/Infinity|NaN|∞/);
    });

    it(`shows the period's rate as a sum over its channels, with the change against the period before (${locale})`, () => {
      // 150 over 10 100 people reached (1,49%), not the mean of 50% and 1%; the channel with impressions only is left out.
      const now = engagementRateOf([{ reach: 100, reactions: 50 }, { reach: 10_000, reactions: 100 }, { impressions: 50, reactions: 25 }]);
      const before = engagementRateOf([{ reach: 1000, reactions: 10 }]);
      const card = text(render(<EngagementRateCard current={now} previous={before} against="30" />, locale));
      expect(card).toContain(w.label);
      expect(card).toContain(locale === 'vi' ? '1,49%' : '1.49%');
      // 1,49% against 1%: up 49%, and the rate before as a percentage.
      expect(card).toContain('↑ 49%');
      expect(card).toContain(locale === 'vi' ? 'Trước đó: 1%' : 'Before: 1%');
      // A rate over impressions is not compared with one over reach.
      const mixed = text(render(<EngagementRateCard current={engagementRateOf([SHOWN])} previous={before} against="30" />, locale));
      expect(mixed).toContain(`${w.shown} ${w.byImpressions}`);
      expect(mixed).not.toContain('↑');
      expect(mixed).not.toContain('↓');
      expect(text(render(<EngagementRateCard current={null} previous={before} against="30" />, locale))).toContain(`${w.label} -`);
    });

    it(`adds a rate column to the channels table, each channel over its own basis (${locale})`, () => {
      const current = [
        { connectionId: 'c1', provider: 'facebook_page', posts: 3, metrics: REACH, rateBases: rateBasesOf([REACH]) },
        { connectionId: 'c2', provider: 'x', posts: 2, metrics: SHOWN, rateBases: rateBasesOf([SHOWN]) },
        { connectionId: 'c3', provider: 'bluesky', posts: 0, metrics: {}, rateBases: {} },
      ];
      const previous = [{ connectionId: 'c1', provider: 'facebook_page', posts: 2, metrics: { reach: 1000, reactions: 23 }, rateBases: rateBasesOf([{ reach: 1000, reactions: 23 }]) }];
      const html = text(render(<ChannelTotals current={current} previous={previous} days={30} names={new Map([['c1', 'Trang A'], ['c2', 'X A'], ['c3', 'Bluesky A']])} />, locale));
      expect(html).toContain(w.label);
      // 3,45% against 2,3%: up 50%.
      expect(html).toContain(`${w.reach} ↑ 50%`);
      expect(html).toContain(`${w.shown} ${w.byImpressions}`);
      expect(html).not.toMatch(/Infinity|NaN/);
    });

    it(`takes a channel's rate from the posts that report reach when it mixes posts with and without reach (#1164, ${locale})`, () => {
      // One post with reach and one without (an older capture): the plain sums would give 60 over 2000 (3%); the rate
      // is the reached post's own 40 over 2000 (2%).
      const posts = [{ reach: 2000, reactions: 40 }, { reactions: 20 }];
      const sums = { reach: 2000, reactions: 60 };
      const html = text(render(<ChannelTotals current={[{ connectionId: 'c1', provider: 'facebook_page', posts: 2, metrics: sums, rateBases: rateBasesOf(posts) }]} previous={[]} days={30} names={new Map([['c1', 'Trang A']])} />, locale));
      expect(html).toContain(' 2%');
      expect(html).not.toContain(' 3%');
    });

    it(`shows each What works group's and channel's rate when its posts report reach or impressions (${locale})`, () => {
      const rate = { rate: 0.02, basis: 'reach', engagement: 40, denominator: 2000 };
      const group = { key: 'image', posts: 2, median: 20, ratio: 1.2, rate };
      client.current.setQueryData(['social', 'metrics', 'insights'], {
        channels: [
          {
            connectionId: 'c1',
            provider: 'facebook_page',
            posts: 3,
            median: 15,
            rate,
            best: [],
            worst: [],
            byLabel: [],
            byFormat: [group, { key: 'text', posts: 1, median: 5, ratio: 0.3, rate: { rate: 0.01, basis: 'impressions', engagement: 5, denominator: 500 } }, { key: 'video', posts: 1, median: 5, ratio: 0.3 }],
            byWeekday: [],
            byHour: [],
            byHashtag: [],
          },
        ],
        truncated: false,
      });
      setActiveLocale(locale);
      const html = text(render(<WhatWorks slug="o" days={30} names={new Map([['c1', 'Trang A']])} />, locale));
      const inline = locale === 'vi' ? 'tỷ lệ tương tác' : 'engagement rate';
      expect(html).toContain(`${inline} 2%`);
      expect(html).toContain(`${inline} 1% ${w.byImpressions}`);
      // The video group reports neither: no rate written for it.
      expect(html.split(inline)).toHaveLength(4);
    });

    it(`shows the client report's rate from the totals and channels it already gets (${locale})`, () => {
      const facebook = { reach: 2000, reactions: 40, comments: 10, shares: 5, saves: 4, clicks: 10, linkClicks: 7 };
      const x = { impressions: 900, reactions: 9 };
      client.current.setQueryData(['client-report', 'd'.repeat(43)], {
        org: 'Cửa hàng Hoa Mai',
        brand: null,
        title: 'Báo cáo tháng 10',
        periodStart: '2026-09-30T17:00:00.000Z',
        periodEnd: '2026-10-31T17:00:00.000Z',
        expiresAt: '2026-12-01T00:00:00.000Z',
        posts: 5,
        totals: { reach: 2000, impressions: 900, reactions: 49, comments: 10, shares: 5, saves: 4, clicks: 10, linkClicks: 7 },
        previous: { periodStart: '2026-08-30T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z', posts: 2, totals: { reach: 1000, reactions: 23 } },
        channels: [
          { channel: 'Trang Hoa Mai', provider: 'facebook_page', posts: 3, totals: facebook, previous: { posts: 2, totals: { reach: 1000, reactions: 23 } } },
          { channel: 'X Hoa Mai', provider: 'x', posts: 2, totals: x, previous: { posts: 0, totals: {} } },
        ],
        top: [{ channel: 'Trang Hoa Mai', provider: 'facebook_page', excerpt: 'Khai trương', publishedAt: '2026-10-06T03:00:00.000Z', url: null, metrics: { reach: 400, reactions: 8 } }],
        note: null,
        goals: null,
      });
      setActiveLocale(locale);
      const html = text(render(<SocialReportPage />, locale));
      // The period: Facebook's 69 over its 2000 people reached (X reports no reach), up 50% on 2,3%.
      expect(html).toContain(`${w.label} ${w.reach} ↑ 50%`);
      // Each channel over its own basis, and the best post's line.
      expect(html).toContain(`${w.shown} ${w.byImpressions}`);
      expect(html).toContain(`${w.label}: 2%`);
      expect(html).not.toMatch(/Infinity|NaN/);
    });

    it(`takes the client report's rate from its rate sums when the server sends them (#1164, ${locale})`, () => {
      // The page's channel mixes a post with reach (40 over 2000) and one without (20): 2%, not the 3% of the sums.
      client.current.setQueryData(['client-report', 'd'.repeat(43)], {
        org: 'Cửa hàng Hoa Mai',
        brand: null,
        title: null,
        periodStart: '2026-09-30T17:00:00.000Z',
        periodEnd: '2026-10-31T17:00:00.000Z',
        expiresAt: '2026-12-01T00:00:00.000Z',
        posts: 2,
        totals: { reach: 2000, reactions: 60 },
        rateBases: { reach: { engagement: 40, denominator: 2000 } },
        previous: { periodStart: '2026-08-30T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z', posts: 0, totals: {}, rateBases: {} },
        channels: [{ channel: 'Trang Hoa Mai', provider: 'facebook_page', posts: 2, totals: { reach: 2000, reactions: 60 }, rateBases: { reach: { engagement: 40, denominator: 2000 } }, previous: { posts: 0, totals: {}, rateBases: {} } }],
        top: [],
        note: null,
        goals: null,
      });
      setActiveLocale(locale);
      const html = text(render(<SocialReportPage />, locale));
      expect(html).toContain(`${w.label} 2%`);
      expect(html).not.toContain(`${w.label} 3%`);
    });
  }
});
