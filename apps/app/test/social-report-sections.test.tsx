// The sections of a client report (#1259): the report link and report schedule forms offer a box per section with
// arrows to move it, the extras and the best posts' count; the schedule form has a link's note and label; the report
// page shows only what the server returned, in the link's order, and a report from before sections as it was.
// Rendered on the server from a seeded cache, in Vietnamese and English.
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
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ slug: 'hoa-mai' }), Link: () => null }));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ aiEnabled: false }) }));

const { ReportLinks } = await import('../src/components/social-report-links.tsx');
const { ReportSchedules, ScheduleForm } = await import('../src/components/social-report-schedules.tsx');
const { ReportSectionsPicker } = await import('../src/components/social-report-sections.tsx');
const { SocialReportPage } = await import('../src/routes/social-report.tsx');
const { draftOf } = await import('../src/lib/social-report.ts');

const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const LABEL = '00000000-0000-4000-8000-0000000000a1';
const labels = [{ id: LABEL, name: 'Khuyến mãi', color: 'red', createdBy: '00000000-0000-4000-8000-000000000009', postCount: 4 }];

function render(locale: 'vi' | 'en', node: React.ReactNode, seed: (qc: import('@tanstack/react-query').QueryClient) => void): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['me', 'get'], { orgs: [{ slug: 'hoa-mai', role: 'owner' }] });
  qc.setQueryData(['social', 'labels', 'list'], labels);
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const TOKEN = 'd'.repeat(43);
const TOTALS = { reach: 1000, reactions: 50, replies: 7 };
const full = {
  org: 'Cửa hàng Hoa Mai',
  brand: null,
  title: 'Báo cáo tháng 10',
  periodStart: '2026-09-30T17:00:00.000Z',
  periodEnd: '2026-10-31T17:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  posts: 2,
  totals: TOTALS,
  rateBases: { reach: { engagement: 50, denominator: 1000 } },
  previous: { periodStart: '2026-08-30T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z', posts: 1, totals: { reach: 500 }, rateBases: {} },
  channels: [{ channel: 'Trang Hoa Mai', provider: 'facebook', posts: 2, totals: TOTALS, rateBases: { reach: { engagement: 50, denominator: 1000 } }, previous: { posts: 1, totals: { reach: 500 }, rateBases: {} } }],
  top: [{ channel: 'Trang Hoa Mai', provider: 'facebook', excerpt: 'Khai trương cửa hàng', publishedAt: '2026-10-05T03:00:00.000Z', url: null, metrics: { reach: 1000, reactions: 50 } }],
  note: 'Tháng này tăng trưởng tốt.',
  goals: null,
  audience: [],
  reels: { posts: 0, medianAvgWatchTimeMs: null },
};
const page = (locale: 'vi' | 'en', data: unknown) => render(locale, <SocialReportPage />, (qc) => qc.setQueryData(['client-report', TOKEN], data));

describe('client report sections (#1259)', () => {
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

    it(`offers every section ticked in the page's order, with arrows, the extras and the best posts' count (${locale})`, () => {
      const html = render(locale, <ReportLinks channels={[]} />, (qc) => qc.setQueryData(['social', 'reportLinks', 'list'], []));
      expect(html).toContain(escaped(t.reportSections.title));
      const blocks = ['note', 'goals', 'totals', 'reels', 'channels', 'top', 'audience'] as const;
      const at = blocks.map((b) => html.indexOf(`${escaped(t.reportSections.block[b])}</label>`));
      expect(at.every((i) => i > 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      for (const e of ['comparison', 'stories', 'clicks'] as const) expect(html).toContain(escaped(t.reportSections.extra[e]));
      expect(html).toContain(`aria-label="${escaped(t.reportSections.up.replace('{name}', t.reportSections.block.top))}"`);
      expect(html).toContain('id="report-sections-top"');
      // Seven blocks and three extras, all ticked: the link saves no sections, a report as before.
      expect(html.match(/role="checkbox"[^>]*aria-checked="true"/g)?.length).toBe(10);
    });

    it(`keeps a saved order and leaves the rest unticked after it, without the count when the best posts are off (${locale})`, () => {
      const html = render(locale, <ReportSectionsPicker id="x" value={draftOf(['top', 'note', 'stories'], 5)} onChange={() => undefined} />, () => undefined);
      const top = html.indexOf(`${escaped(t.reportSections.block.top)}</label>`);
      const note = html.indexOf(`${escaped(t.reportSections.block.note)}</label>`);
      const goals = html.indexOf(`${escaped(t.reportSections.block.goals)}</label>`);
      expect(top).toBeLessThan(note);
      expect(note).toBeLessThan(goals);
      expect(html.match(/role="checkbox"[^>]*aria-checked="true"/g)?.length).toBe(3);
      expect(html).toContain('value="5"');
      const off = render(locale, <ReportSectionsPicker id="x" value={draftOf(['note'], null)} onChange={() => undefined} />, () => undefined);
      expect(off).not.toContain('id="x-top"');
    });

    it(`gives a schedule a note, a label and the sections, and lists what a schedule carries (${locale})`, () => {
      const schedule = {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Báo cáo tuần',
        cadence: 'weekly',
        weekday: 1,
        monthDay: null,
        sendHour: 8,
        timeZone: 'Asia/Ho_Chi_Minh',
        period: 'previous_week',
        connectionIds: [],
        recipients: ['khach@example.vn'],
        note: 'Chào anh chị',
        labelId: LABEL,
        includeAudience: false,
        sections: ['totals', 'top'],
        topCount: 5,
        paused: false,
        nextRunAt: '2026-10-26T01:00:00.000Z',
        lastRunAt: null,
        runs: [],
      };
      const list = render(locale, <ReportSchedules channels={[]} />, (qc) => qc.setQueryData(['social', 'reportSchedules', 'list'], [schedule]));
      expect(list).toContain(escaped(t.reportSchedules.withLabel.replace('{name}', 'Khuyến mãi')));
      expect(list).toContain(escaped(t.reportSchedules.withNote));
      expect(list).toContain(escaped(t.reportSections.custom.replace('{count, number}', '2')));
    });
  }

  it("renders a new schedule with a note, the org's labels and the sections", () => {
    const t = catalog('vi').social;
    const html = render('vi', <ScheduleForm channels={[]} onDone={() => undefined} />, () => undefined);
    expect(html).toContain('id="schedule-note"');
    expect(html).toContain('id="schedule-label"');
    expect(html).toContain(`value="${LABEL}">Khuyến mãi</option>`);
    expect(html).toContain(escaped(t.reportSchedules.labelHint));
    expect(html).toContain(escaped(t.reportSections.title));
    expect(html).toContain('id="schedule-sections-top"');
    // An org without labels gets no picker.
    expect(render('vi', <ScheduleForm channels={[]} onDone={() => undefined} />, (qc) => qc.setQueryData(['social', 'labels', 'list'], []))).not.toContain('id="schedule-label"');
  });

  for (const locale of ['vi', 'en'] as const) {
    const t = catalog(locale).social;

    it(`shows a report from before sections as it was: note, totals, channels, best posts, comparison (${locale})`, () => {
      const html = page(locale, full);
      expect(html).toContain(escaped(t.clientReport.note.replace('{org}', 'Cửa hàng Hoa Mai')));
      expect(html).toContain(`>${escaped(t.clientReport.byChannel)}</h2>`);
      expect(html).toContain(`>${escaped(t.clientReport.top)}</h2>`);
      expect(html).toContain(escaped(t.metric.replies));
      const note = html.indexOf('Tháng này tăng trưởng tốt.');
      const channels = html.indexOf(`>${escaped(t.clientReport.byChannel)}</h2>`);
      const top = html.indexOf(`>${escaped(t.clientReport.top)}</h2>`);
      expect(note).toBeLessThan(channels);
      expect(channels).toBeLessThan(top);
    });

    it(`shows only the sections that came back, in the link's order (${locale})`, () => {
      const html = page(locale, {
        ...full,
        sections: ['top', 'note', 'channels'],
        totals: null,
        rateBases: null,
        previous: null,
        channels: [{ ...full.channels[0], previous: null }],
        audience: null,
        reels: null,
      });
      const note = html.indexOf('Tháng này tăng trưởng tốt.');
      const channels = html.indexOf(`>${escaped(t.clientReport.byChannel)}</h2>`);
      const top = html.indexOf(`>${escaped(t.clientReport.top)}</h2>`);
      expect(top).toBeGreaterThan(0);
      expect(top).toBeLessThan(note);
      expect(note).toBeLessThan(channels);
      // No totals cards and no period before; the channels' table keeps its counts.
      expect(html).not.toContain(escaped(t.clientReport.compared.split('{from}')[0] ?? 'x'));
      expect(html).toContain('Trang Hoa Mai');
    });

    it(`shows nothing of a section left out, and says once that nothing went out (${locale})`, () => {
      const html = page(locale, { ...full, sections: ['note'], note: null, totals: null, rateBases: null, previous: null, channels: null, top: null, audience: null, reels: null });
      expect(html).not.toContain(`>${escaped(t.clientReport.byChannel)}</h2>`);
      expect(html).not.toContain(`>${escaped(t.clientReport.top)}</h2>`);
      expect(html).not.toContain('Khai trương cửa hàng');
      const empty = page(locale, { ...full, posts: 0, sections: ['note', 'top', 'channels'], totals: null, previous: null, channels: [], top: [], audience: null, reels: null });
      expect(empty.split(escaped(t.clientReport.empty)).length - 1).toBe(1);
    });
  }
});
