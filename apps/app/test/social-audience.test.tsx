// Who follows a channel (#1146) on the Metrics tab and in the client report, rendered on the server from a seeded cache
// in Vietnamese and English: the ages in age order, the genders, the largest cities and countries with their shares,
// the day of the capture, and nothing at all for a channel or a report without one.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

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

const { FollowerAudiences } = await import('../src/components/social-audience.tsx');
const { SocialReportPage } = await import('../src/routes/social-report.tsx');
const { audienceOf, countryName, sharesOf } = await import('../src/lib/social-audience.ts');

const TOKEN = 'c'.repeat(43);
const AUDIENCE = {
  age: [{ key: '25-34', count: 600 }, { key: '65+', count: 10 }, { key: '18-24', count: 390 }],
  gender: [{ key: 'M', count: 250 }, { key: 'U', count: 0 }, { key: 'F', count: 750 }],
  cities: [{ key: 'Hanoi, Hanoi', count: 300 }, { key: 'Ho Chi Minh City, Ho Chi Minh', count: 700 }],
  countries: [{ key: 'US', count: 20 }, { key: 'VN', count: 980 }],
};

const report = (audience: unknown) => ({
  org: 'Cửa hàng Hoa Mai',
  brand: null,
  title: 'Báo cáo tháng 10',
  periodStart: '2026-09-30T17:00:00.000Z',
  periodEnd: '2026-10-31T17:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  posts: 0,
  totals: {},
  previous: { periodStart: '2026-08-30T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z', posts: 0, totals: {} },
  channels: [],
  top: [],
  note: null,
  goals: null,
  ...(audience === undefined ? {} : { audience }),
});

function render(locale: 'vi' | 'en', node: React.ReactNode, seed: (qc: import('@tanstack/react-query').QueryClient) => void): string {
  const qc = client.current;
  qc.clear();
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}
// The text a screen reader reads (the percentage shown is aria-hidden, its sr-only line says it with the count), tags
// left out and entities read back.
const text = (html: string) =>
  html
    .replace(/<span aria-hidden="true">[^<]*<\/span>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const metricsTab = (locale: 'vi' | 'en', trends: unknown) => text(render(locale, <FollowerAudiences days={30} names={new Map([['0193a000-0000-7000-8000-000000000001', 'Instagram Hoa Mai']])} />, (qc) => qc.setQueryData(['social', 'accounts', 'trends'], trends)));
const reportPage = (locale: 'vi' | 'en', audience: unknown) => text(render(locale, <SocialReportPage />, (qc) => qc.setQueryData(['client-report', TOKEN], report(audience))));

describe('follower demographics (#1146)', () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${TOKEN}` }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
  });
  beforeEach(() => client.current.clear());

  it('orders the ages youngest first and the genders women, men, unknown, with their shares; cities and countries largest first', () => {
    expect(sharesOf(AUDIENCE.age, 'age')).toEqual([
      { key: '18-24', count: 390, percent: 39 },
      { key: '25-34', count: 600, percent: 60 },
      { key: '65+', count: 10, percent: 1 },
    ]);
    expect(sharesOf(AUDIENCE.gender, 'gender').map((s) => [s.key, s.percent])).toEqual([['F', 75], ['M', 25], ['U', 0]]);
    expect(sharesOf(AUDIENCE.countries, 'countries').map((s) => s.key)).toEqual(['VN', 'US']);
    expect(sharesOf(Array.from({ length: 14 }, (_, i) => ({ key: `C${i}`, count: i + 1 })), 'cities')).toHaveLength(10);
    expect(sharesOf([{ key: 'a', count: 1 }, { key: 'b', count: 2 }], 'cities').map((s) => s.percent)).toEqual([66.7, 33.3]);
    expect(sharesOf([], 'age')).toEqual([]);
    expect(audienceOf({})).toBeNull();
    expect(audienceOf(null)).toBeNull();
    expect(audienceOf({ age: [{ key: '18-24', count: 'x' }, { key: '25-34', count: 3 }], cities: 'x' })).toEqual({ age: [{ key: '25-34', count: 3 }], gender: [], cities: [], countries: [] });
    expect(countryName('VN', 'vi')).toBe('Việt Nam');
    expect(countryName('VN', 'en')).toBe('Vietnam');
    expect(countryName('unknown', 'en')).toBe('unknown');
  });

  it('shows a "Người theo dõi" section on the Metrics tab for each channel with an audience', () => {
    const trends = [
      { connectionId: '0193a000-0000-7000-8000-000000000001', provider: 'instagram', points: [], audience: { ...AUDIENCE, day: '2026-10-20' } },
      { connectionId: '0193a000-0000-7000-8000-000000000002', provider: 'threads', points: [], audience: null },
    ];
    const vi = metricsTab('vi', trends);
    expect(vi).toContain('Người theo dõi Độ tuổi, giới tính và nơi sống của người theo dõi trên Instagram và Threads');
    expect(vi).toContain('Instagram Hoa Mai · Instagram Cập nhật ngày 20/10/2026');
    expect(vi).toContain('Độ tuổi 18-24 39% · 390 người 25-34 60% · 600 người 65+ 1% · 10 người');
    expect(vi).toContain('Giới tính Nữ 75% · 750 người Nam 25% · 250 người Không rõ 0% · 0 người');
    expect(vi).toContain('Thành phố Ho Chi Minh City, Ho Chi Minh 70% · 700 người Hanoi, Hanoi 30% · 300 người');
    expect(vi).toContain('Quốc gia Việt Nam 98% · 980 người Hoa Kỳ 2% · 20 người');
    expect(vi).not.toContain('Threads · ');
    const en = metricsTab('en', trends);
    expect(en).toContain('Followers The age, gender and location of followers on Instagram and Threads');
    expect(en).toContain('Gender Women 75% · 750 people Men 25% · 250 people Unknown 0% · 0 people');
    expect(en).toContain('Top countries Vietnam 98% · 980 people United States 2% · 20 people');
    // No channel with an audience: no section.
    expect(metricsTab('vi', [trends[1]])).toBe('');
    expect(metricsTab('vi', [])).toBe('');
    // On screen, each share is its percentage.
    const html = render('vi', <FollowerAudiences days={30} names={new Map()} />, (qc) => qc.setQueryData(['social', 'accounts', 'trends'], trends));
    expect(html).toContain('<span aria-hidden="true">39%</span>');
    expect(html).toContain('style="width:39%"');
  });

  it('shows the latest capture of each channel in the client report, and nothing without one', () => {
    const entries = [{ channel: 'Instagram Hoa Mai', provider: 'instagram', day: '2026-10-22', audience: AUDIENCE }];
    for (const locale of ['vi', 'en'] as const) {
      const html = reportPage(locale, entries);
      const labels = catalog(locale).social.audience;
      expect(html).toContain(`${labels.title} ${labels.reportHint}`);
      expect(html).toContain(locale === 'vi' ? 'Cập nhật ngày 22/10/2026' : 'Updated');
      expect(html).toContain(labels.genders.F);
      expect(html).toContain('Ho Chi Minh City, Ho Chi Minh');
    }
    // A server without it, an empty list, or entries that are not audiences: no section.
    for (const audience of [undefined, [], [{ channel: 'X', provider: 'instagram', day: '2026-10-22', audience: {} }], 'x', [null]]) expect(reportPage('vi', audience)).not.toContain(catalog('vi').social.audience.reportHint);
  });
});
