// The AI summary controls (#1237): the report form offers "Viết tóm tắt" next to its note to owners and admins on a
// server with AI, and says the note is saved only with the link; the Metrics tab's box shows the draft to edit and
// copy, and says it is not saved.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const config = vi.hoisted(() => ({ aiEnabled: true }));

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
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => config }));

const { ReportLinks } = await import('../src/components/social-report-links.tsx');
const { MetricsSummary } = await import('../src/components/social-summary.tsx');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const wrap = (locale: 'vi' | 'en', node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );

function form(locale: 'vi' | 'en', role: string) {
  client.current.clear();
  client.current.setQueryData(['me', 'get'], { orgs: [{ slug: 'hoa-mai', role }] });
  client.current.setQueryData(['social', 'reportLinks', 'list'], []);
  client.current.setQueryData(['social', 'labels', 'list'], []);
  return text(wrap(locale, <ReportLinks channels={[]} />));
}

describe('AI summary controls (#1237)', () => {
  it('offers a summary for the report note, saved only with the link', () => {
    config.aiEnabled = true;
    const vi_ = form('vi', 'owner');
    expect(vi_).toContain('Viết tóm tắt');
    expect(vi_).toContain('nhận xét chỉ được lưu khi bạn tạo liên kết');
    expect(form('en', 'admin')).toContain('Write a summary');
    // Not on a server without AI.
    config.aiEnabled = false;
    expect(form('vi', 'owner')).not.toContain('Viết tóm tắt');
    config.aiEnabled = true;
  });

  it("shows the Metrics tab's draft to edit and copy, and says it is not saved", () => {
    const summary = {
      open: { days: 30, labelId: undefined, includeExternal: false },
      text: 'Kỳ này chúng tôi đăng 12 bài.',
      setText: () => undefined,
      write: { isPending: false, error: null, mutate: () => undefined },
      start: () => undefined,
      close: () => undefined,
    } as unknown as Parameters<typeof MetricsSummary>[0]['summary'];
    const vi_ = text(wrap('vi', <MetricsSummary summary={summary} />));
    expect(vi_).toContain('Tóm tắt 30 ngày qua');
    expect(vi_).toContain('Kỳ này chúng tôi đăng 12 bài.');
    expect(vi_).toContain('Bản nháp không được lưu');
    expect(vi_).toContain('Sao chép');
    expect(vi_).toContain('Viết lại');
    const en = text(wrap('en', <MetricsSummary summary={summary} />));
    expect(en).toContain('Summary of the last 30 days');
    expect(en).toContain('The draft is not saved');
    // Closed: nothing.
    expect(wrap('vi', <MetricsSummary summary={{ ...summary, open: null }} />)).toBe('');
  });
});
