// A client report for one campaign label (#1159), with the audience choice (#1155) and Reels watch time (#1151): the
// link form offers the org's labels and the audience switch, the list says which label a link counts and that it hides
// the audience, and the report page shows the period's Reels (the median of their average watch time and the total
// watch time) and no audience section when the link leaves it out. Rendered on the server from a seeded cache, in
// Vietnamese and English.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { reportReels } from '../src/lib/social-insights.ts';

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
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ slug: 'hoa-mai' }), Link: () => null }));

const { ReportLinks } = await import('../src/components/social-report-links.tsx');
const { SocialReportPage } = await import('../src/routes/social-report.tsx');

const SALE = '00000000-0000-4000-8000-0000000000a1';
const link = (over: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Chiến dịch tháng 10',
  note: null,
  periodStart: '2026-09-30T17:00:00.000Z',
  periodEnd: '2026-10-31T17:00:00.000Z',
  connectionIds: [],
  createdBy: '00000000-0000-4000-8000-000000000009',
  createdAt: '2026-11-01T02:00:00.000Z',
  expiresAt: '2099-12-01T00:00:00.000Z',
  revokedAt: null,
  includeExternal: false,
  labelId: null,
  includeAudience: true,
  ...over,
});

const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function form(locale: 'vi' | 'en', links: unknown[], labels: unknown[]): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['me', 'get'], { orgs: [{ slug: 'hoa-mai', role: 'owner' }] });
  qc.setQueryData(['social', 'reportLinks', 'list'], links);
  qc.setQueryData(['social', 'labels', 'list'], labels);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <ReportLinks channels={[]} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const TOKEN = 'c'.repeat(43);
const AUDIENCE = { age: [{ key: '18-24', count: 410 }], gender: [{ key: 'F', count: 780 }], cities: [{ key: 'Hanoi, Hanoi', count: 300 }], countries: [{ key: 'VN', count: 1100 }] };
const page = (over: Record<string, unknown>) => {
  const totals = { reach: 1000, views: 1500, reactions: 50, totalWatchTimeMs: 4_250_000 };
  return {
    org: 'Cửa hàng Hoa Mai',
    brand: null,
    title: 'Chiến dịch tháng 10',
    periodStart: '2026-09-30T17:00:00.000Z',
    periodEnd: '2026-10-31T17:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    posts: 3,
    totals,
    previous: { periodStart: '2026-08-30T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z', posts: 1, totals: { reach: 500, reactions: 10, totalWatchTimeMs: 2_000_000 } },
    channels: [{ channel: 'Instagram Hoa Mai', provider: 'instagram', posts: 3, totals, previous: { posts: 1, totals: { reach: 500, reactions: 10, totalWatchTimeMs: 2_000_000 } } }],
    top: [{ channel: 'Instagram Hoa Mai', provider: 'instagram', excerpt: 'Reel khai trương', publishedAt: '2026-10-05T03:00:00.000Z', url: null, metrics: { reach: 1000, reactions: 50, totalWatchTimeMs: 3_000_000 } }],
    note: null,
    goals: null,
    audience: [],
    reels: { posts: 2, medianAvgWatchTimeMs: 10_001 },
    ...over,
  };
};

function report(locale: 'vi' | 'en', data: unknown): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['client-report', TOKEN], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <SocialReportPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('a campaign report link, its audience choice and Reels watch time (#1159)', () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${TOKEN}`, origin: 'https://crove.example' }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
  });
  beforeEach(() => client.current.clear());

  for (const locale of ['vi', 'en'] as const) {
    const t = catalog(locale).social;
    it(`offers the org's labels and the audience switch, and lists what each link counts (${locale})`, () => {
      const html = form(
        locale,
        [link({ labelId: SALE, includeAudience: false }), link({ id: '00000000-0000-4000-8000-000000000002', title: 'Tháng 10' })],
        [{ id: SALE, name: 'Khuyến mãi', color: 'red', createdBy: '00000000-0000-4000-8000-000000000009', postCount: 4 }],
      );
      expect(html).toContain('id="report-label"');
      expect(html).toContain(`>${escaped(t.reportLinks.labelAll)}</option>`);
      expect(html).toContain(`value="${SALE}">Khuyến mãi</option>`);
      expect(html).toContain(escaped(t.reportLinks.includeAudience));
      // The audience is on for a new link.
      expect(html).toMatch(/role="checkbox"[^>]*aria-checked="true"/);
      expect(html).toContain(escaped(t.reportLinks.withLabel.replace('{name}', 'Khuyến mãi')));
      expect(html.split(escaped(t.reportLinks.withoutAudience)).length - 1).toBe(1);
      // An org without labels gets no picker.
      expect(form(locale, [], [])).not.toContain('id="report-label"');
    });

    it(`shows the Reels' median average and total watch time, and no audience when left out (${locale})`, () => {
      const html = report(locale, page({}));
      expect(html).toContain(`>${t.clientReport.reels}</h2>`);
      expect(html).toContain(escaped(locale === 'vi' ? '2 Reels trong kỳ' : '2 Reels in the period'));
      // 10001 ms is 10 seconds; 4,250,000 ms is 1.2 hours, against 33.3 minutes before.
      expect(html).toContain(escaped(t.clientReport.reelsAverage.replace('{time}', t.watch.seconds.replace('{value}', '10'))));
      // The app's number format decides the decimal mark.
      expect([['1.2', '1,2'].some((v) => html.includes(escaped(t.clientReport.reelsTotal.replace('{time}', t.watch.hours.replace('{value}', v)))))]).toEqual([true]);
      expect([['33.3', '33,3'].some((v) => html.includes(escaped(t.watch.minutes.replace('{value}', v))))]).toEqual([true]);
      // The average watch time is never shown as a summed count.
      expect(html).not.toContain(`>${escaped(t.metric.avgWatchTimeMs)}<`);
      // The engagement rate of #1161 is still worked out from the channels' totals: 50 over 1000.
      expect(html).toMatch(/>5%</);
      // The audience section shows only when the report has one.
      expect(html).not.toContain(escaped(t.audience.title));
      expect(report(locale, page({ audience: [{ channel: 'Instagram Hoa Mai', provider: 'instagram', day: '2026-10-22', audience: AUDIENCE }] }))).toContain(escaped(t.audience.title));
      // No Reels in the period, or a server without them: no Reels section.
      expect(report(locale, page({ reels: { posts: 0, medianAvgWatchTimeMs: null } }))).not.toContain(`>${t.clientReport.reels}</h2>`);
      expect(report(locale, page({ reels: undefined }))).not.toContain(`>${t.clientReport.reels}</h2>`);
    });
  }

  it('reads the Reels object defensively', () => {
    expect(reportReels({ posts: 2, medianAvgWatchTimeMs: 10_001 })).toEqual({ posts: 2, medianAvgWatchTimeMs: 10_001 });
    expect(reportReels({ posts: 1, medianAvgWatchTimeMs: null })).toEqual({ posts: 1, medianAvgWatchTimeMs: null });
    expect(reportReels({ posts: 1, medianAvgWatchTimeMs: -5 })).toEqual({ posts: 1, medianAvgWatchTimeMs: null });
    for (const bad of [null, undefined, 'x', {}, { posts: 0 }, { posts: 1.5 }, { posts: '2' }]) expect(reportReels(bad)).toBeNull();
  });
});
