// The composer's preview names a post's audience (#983): who may reply on Threads and who sees a LinkedIn post, when
// not everyone; who may reply to and quote a Bluesky post (#1102). Rendered on the server; nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { PreviewContent } from '../src/components/social-preview.tsx';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));

const { PlatformPreview } = await import('../src/components/social-preview.tsx');

function render(provider: string, extra: Partial<PreviewContent> = {}): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        <PlatformPreview channel="Tiệm Bánh B" provider={provider} content={{ body: 'Khai trương chi nhánh mới.', title: '', linkUrl: '', media: [], ...extra }} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('audience in the preview', () => {
  it('names who may reply on Threads and who sees a LinkedIn post', () => {
    expect(render('threads', { replySettings: 'followers' })).toContain('Chỉ người theo dõi bạn mới trả lời được');
    expect(render('threads', { replySettings: 'mentionedUsers' })).toContain('Chỉ tài khoản được nhắc đến mới trả lời được');
    expect(render('linkedin', { visibility: 'connections' })).toContain('Chỉ những người đã kết nối với bạn mới xem được');
    expect(render('linkedin', { visibility: 'loggedIn' })).toContain('Chỉ người đã đăng nhập LinkedIn mới xem được');
  });

  it('names who may reply to a Bluesky post, several groups in one sentence, and quotes off (#1102)', () => {
    expect(render('bluesky', { replyRules: 'nobody' })).toContain('Không ai trả lời được');
    expect(render('bluesky', { replyRules: ['followers'] })).toContain('Chỉ người theo dõi bạn mới trả lời được');
    expect(render('bluesky', { replyRules: ['mentionedUsers', 'following', 'followers'] })).toContain('Chỉ tài khoản được nhắc đến, tài khoản bạn theo dõi và người theo dõi bạn mới trả lời được');
    expect(render('bluesky', { quotesOff: true })).toContain('Đã tắt trích dẫn bài');
    expect(render('bluesky')).not.toContain('trả lời được');
    expect(render('bluesky')).not.toContain('trích dẫn');
  });

  it('says nothing for the default audience', () => {
    for (const provider of ['threads', 'linkedin']) {
      const html = render(provider);
      expect(html).not.toContain('trả lời được');
      expect(html).not.toContain('xem được');
    }
  });
});
