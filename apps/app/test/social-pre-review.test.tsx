// The automatic checks in the post page's review panel (#1193): the content agent's task says only how many points
// there are, so the review panel lists what social.post.pre_review found, in Vietnamese and in English, and says when
// nothing was found. Rendered on the server, with the query answered from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { PreReviewFindings } = await import('../src/components/social-pre-review.tsx');

const waiting = [{ id: '0b5c6f7e-1d2a-4c3b-9e8f-7a6b5c4d3e2f', revision: 3, contentHash: 'h1' }];
const key = ['social', 'posts', 'preReview', `${waiting[0]?.id}:3:h1`];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function render(findings: string[] | null, locale: 'vi' | 'en' = 'vi', channels = waiting): string {
  setActiveLocale(locale);
  const qc = client.current;
  qc.clear();
  if (findings) qc.setQueryData(key, { postId: 'p1', waiting: channels.length, findings });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <PreReviewFindings postId="p1" waiting={channels} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the automatic checks in the review panel (#1193)', () => {
  it('lists what the pre-review found for the channels waiting', () => {
    const html = render(['Kênh thử: có từ nên tránh theo giọng thương hiệu (rẻ nhất).', '1 bình luận nội bộ chưa xử lý.']);
    expect(text(html)).toBe('Kiểm tra tự động Kênh thử: có từ nên tránh theo giọng thương hiệu (rẻ nhất). 1 bình luận nội bộ chưa xử lý.');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(text(render(['x'], 'en'))).toBe('Automatic checks x');
  });

  it('says when the checks found nothing, in both languages', () => {
    expect(text(render([]))).toBe('Kiểm tra tự động Không thấy điểm nào cần xem trên các kênh đang chờ duyệt.');
    expect(text(render([], 'en'))).toBe('Automatic checks Nothing to look at on the channels waiting for review.');
  });

  it('shows nothing before the answer, or with no channel waiting', () => {
    expect(render(null)).toBe('');
    expect(render(['x'], 'vi', [])).toBe('');
  });
});
