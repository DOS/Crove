// White-label client reports (#1053): the public report page and the review page as a client sees them, with and
// without the org's branding, rendered on the server from a seeded cache; and the brand a page takes from the API,
// read again so only a raster data URL and a #rrggbb accent reach it.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

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

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ slug: 'sao-mai' }), useSearch: () => ({}) }));

const { SocialReportPage } = await import('../src/routes/social-report.tsx');
const { SocialPlanPrintPage } = await import('../src/routes/social-plan-print.tsx');
const { SocialReviewPage } = await import('../src/routes/social-review.tsx');
const { pageBrand, accentStyle } = await import('../src/lib/social-report-branding.ts');
const t = viMessages.social.reportBranding;

const TOKEN = 'a'.repeat(43);
// A PNG signature and a few bytes: what the page checks before it shows a logo.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
// The Crove mark's first path, which only the Crove logo draws.
const CROVE_MARK = 'M141.5 33.7';

const report = (brand: unknown) => ({
  org: 'Công ty Truyền thông Sao Mai',
  ...(brand === undefined ? {} : { brand }),
  title: 'Báo cáo tháng 10',
  periodStart: '2026-09-30T17:00:00.000Z',
  periodEnd: '2026-10-31T17:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  posts: 0,
  totals: {},
  channels: [],
  top: [],
});

const review = (brand: unknown) => ({
  org: 'Công ty Truyền thông Sao Mai',
  ...(brand === undefined ? {} : { brand }),
  expiresAt: '2026-12-01T00:00:00.000Z',
  changed: false,
  channels: [],
  feedback: [],
});

function render(page: 'report' | 'review', data: unknown): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData([page === 'report' ? 'client-report' : 'client-review', TOKEN], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="vi" messages={viMessages as never} timeZone="Asia/Ho_Chi_Minh">
        {page === 'report' ? <SocialReportPage /> : <SocialReviewPage />}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('white-label client pages (#1053)', () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${TOKEN}` }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
  });
  beforeEach(() => client.current.clear());

  it('shows the report as today without branding: the Crove logo, the org line, no accent and no credit', () => {
    for (const html of [render('report', report(null)), render('report', report(undefined))]) {
      expect(html).toContain(CROVE_MARK);
      expect(html).toContain('Công ty Truyền thông Sao Mai');
      expect(html).not.toContain('--brand-accent');
      expect(html).not.toContain(t.madeWith);
      expect(html).not.toContain('<img');
    }
  });

  it('shows the agency logo, name and accent instead of the Crove logo, and the credit unless hidden', () => {
    const html = render('report', report({ name: 'Sao Mai Agency', logo: PNG, accent: '#1d4ed8', hideCrove: false }));
    expect(html).not.toContain(CROVE_MARK);
    expect(html).toContain(`<img src="${PNG}" alt="Sao Mai Agency"`);
    expect(html).toContain('Sao Mai Agency');
    expect(html).toContain('--brand-accent:#1d4ed8');
    expect(html).toContain('border-(--brand-accent)');
    expect(html).toContain(t.madeWith);

    const hidden = render('report', report({ name: null, logo: null, accent: null, hideCrove: true }));
    expect(hidden).not.toContain(CROVE_MARK);
    expect(hidden).not.toContain('Crove');
    // No name: the org's own, as text.
    expect(hidden).toContain('Công ty Truyền thông Sao Mai');
    expect(hidden).not.toContain('--brand-accent');
  });

  it('brands the review page the same way, and leaves it as today without branding', () => {
    const plain = render('review', review(null));
    expect(plain).toContain(CROVE_MARK);
    expect(plain).not.toContain(t.madeWith);
    const branded = render('review', review({ name: 'Sao Mai Agency', logo: PNG, accent: '#1d4ed8', hideCrove: true }));
    expect(branded).not.toContain(CROVE_MARK);
    expect(branded).not.toContain('Crove');
    expect(branded).toContain(`<img src="${PNG}"`);
    expect(branded).toContain('Sao Mai Agency');
    expect(branded).toContain('--brand-accent:#1d4ed8');
  });

  it('brands the plan print from the org settings, and leaves it as today without them', () => {
    const print = (brand: unknown) => {
      const qc = client.current;
      qc.clear();
      qc.setQueryData(['me', 'get'], { orgs: [{ slug: 'sao-mai', name: 'Công ty Truyền thông Sao Mai', role: 'member' }] });
      qc.setQueryData(['social', 'reportBranding', 'get'], brand);
      return renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <IntlProvider locale="vi" messages={viMessages as never} timeZone="Asia/Ho_Chi_Minh">
            <SocialPlanPrintPage />
          </IntlProvider>
        </QueryClientProvider>,
      );
    };
    expect(print(null)).toContain(CROVE_MARK);
    const branded = print({ name: 'Sao Mai Agency', logo: PNG, accent: '#1d4ed8', hideCrove: true, updatedAt: '2026-10-22T00:00:00.000Z' });
    expect(branded).not.toContain(CROVE_MARK);
    expect(branded).toContain(`<img src="${PNG}"`);
    expect(branded).toContain('--brand-accent:#1d4ed8');
  });

  it('drops a logo that is not a raster data URL and an accent that is not #rrggbb, so nothing reaches a style', () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg onload="alert(1)"/>')}`;
    const html = render('report', report({ name: 'X', logo: svg, accent: 'red;background:url(https://evil.example/)', hideCrove: false }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('--brand-accent');
    expect(pageBrand({ name: 'X', logo: 'javascript:alert(1)', accent: '#ABCDEF', hideCrove: 'yes' })).toEqual({ name: 'X', logo: null, accent: null, hideCrove: false });
    // A PNG declared, a JPEG inside.
    expect(pageBrand({ logo: 'data:image/png;base64,/9j/4AAQSkZJRgABAQ==' })?.logo).toBeNull();
    expect(pageBrand(null)).toBeNull();
    expect(pageBrand('brand')).toBeNull();
    // An array is an object too, but not a brand.
    expect(pageBrand([])).toBeNull();
    expect(pageBrand(['Sao Mai Agency', PNG])).toBeNull();
    expect(accentStyle(null)).toBeUndefined();
    expect(accentStyle({ name: null, logo: null, accent: '#0f766e', hideCrove: false })).toEqual({ '--brand-accent': '#0f766e' });
  });
});
