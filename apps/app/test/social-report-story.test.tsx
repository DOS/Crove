// A Story's own counts in the client report (#1087): the report page, rendered on the server from a seeded cache in
// Vietnamese and English, shows a Story's replies, taps, exits, swipes, follows and profile visits in the totals, the
// channels table and the best posts, as report_link_view now returns them, and a report without them as before.
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

const { SocialReportPage } = await import('../src/routes/social-report.tsx');

const TOKEN = 'b'.repeat(43);
const STORY = { replies: 7, tapsForward: 120, tapsBack: 15, exits: 30, nextStory: 12, follows: 3, profileVisits: 9 };
const STORY_NAMES = Object.keys(STORY) as (keyof typeof STORY)[];

const report = (withStory: boolean) => {
  const story = withStory ? STORY : {};
  const totals = { reach: 400, views: 420, shares: 2, reactions: 5, ...story };
  return {
    org: 'Cửa hàng Hoa Mai',
    brand: null,
    title: 'Báo cáo tháng 10',
    periodStart: '2026-09-30T17:00:00.000Z',
    periodEnd: '2026-10-31T17:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    posts: 2,
    totals,
    previous: { periodStart: '2026-08-30T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z', posts: 0, totals: {} },
    channels: [{ channel: 'Instagram Hoa Mai', provider: 'instagram', posts: 2, totals, previous: { posts: 0, totals: {} } }],
    top: [
      { channel: 'Instagram Hoa Mai', provider: 'instagram', excerpt: 'Bài thường', publishedAt: '2026-10-06T03:00:00.000Z', url: null, metrics: { reach: 100, reactions: 5 } },
      { channel: 'Instagram Hoa Mai', provider: 'instagram', excerpt: '', publishedAt: '2026-10-05T03:00:00.000Z', url: null, metrics: { reach: 300, views: 420, shares: 2, ...story } },
    ],
    note: null,
    goals: null,
  };
};

function render(locale: 'vi' | 'en', data: unknown): string {
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

// Each label as React writes it into the markup.
const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const count = (html: string, s: string) => html.split(escaped(s)).length - 1;

describe("a Story's counts in the client report (#1087)", () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${TOKEN}` }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
  });
  beforeEach(() => client.current.clear());

  for (const locale of ['vi', 'en'] as const) {
    it(`shows them in the totals, the channels table and the Story's line (${locale})`, () => {
      const labels = catalog(locale).social.metric;
      const html = render(locale, report(true));
      for (const m of STORY_NAMES) {
        // A total card, a channels column, and the Story's line among the best posts.
        expect([m, count(html, labels[m])]).toEqual([m, 3]);
        expect(html).toContain(escaped(`${labels[m]}: `));
      }
      // The feed post's line keeps its own counts only.
      expect(html).toContain(`${escaped(labels.reach)}: 100 · ${escaped(labels.reactions)}: 5</p>`);
      const plain = render(locale, report(false));
      for (const m of STORY_NAMES) expect(count(plain, labels[m])).toBe(0);
    });
  }
});
