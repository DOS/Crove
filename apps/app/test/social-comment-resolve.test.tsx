// Resolved internal comments (#1168) in the app: the timeline greys a resolved comment with who resolved it and when,
// offers Resolve or Reopen only to who may, and the lists show the open count, in Vietnamese and in English. Rendered
// on the server, with the timeline answered from a seeded cache; nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const off = (key: string) => ({ queryOptions: () => ({ queryKey: [key], queryFn: () => null, enabled: false }), key: () => [key] });
vi.mock('../src/lib/api.ts', () => ({
  client: { social: { posts: {} } },
  orpc: { org: { get: off('org') }, social: { posts: { activity: off('activity'), get: off('post'), list: off('list') } } },
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));

const { OpenComments, PostActivity } = await import('../src/components/social-activity.tsx');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const none = { variantId: null, decision: null, editedAt: null, editable: false, url: null, code: null, checklist: null, resolvedAt: null, resolvedBy: null, resolvedByName: null, resolvable: false };
const open = { ...none, id: 'c-open', kind: 'comment' as const, at: '2026-10-22T03:00:00.000Z', userId: U1, name: 'Minh', body: 'Thêm giá khai trương', resolvable: true };
const done = { ...none, id: 'c-done', kind: 'comment' as const, at: '2026-10-22T02:00:00.000Z', userId: U1, name: 'Minh', body: 'Đổi ảnh bìa', resolvedAt: '2026-10-22T04:30:00.000Z', resolvedBy: U2, resolvedByName: 'Lan', resolvable: true };

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  const qc = new QueryClient();
  qc.setQueryData(['activity'], { items: [open, done], more: false });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}
const entries = (html: string) => html.split('<li').slice(1);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('resolved comments on the timeline (#1168)', () => {
  it('greys a resolved comment with who resolved it and when, and offers to reopen it', () => {
    const [first, second] = entries(render(<PostActivity postId="p-1" channels={[]} canWrite />));
    expect(first).not.toContain('data-resolved');
    expect(first).toContain('border-primary');
    expect(text(first ?? '')).toContain('Đánh dấu đã xử lý');
    expect(second).toContain('data-resolved="true"');
    expect(second).toContain('opacity-60');
    expect(text(second ?? '')).toMatch(/Đã xử lý · Lan · .*22/);
    expect(text(second ?? '')).toContain('Mở lại');
    const english = entries(render(<PostActivity postId="p-1" channels={[]} canWrite />, 'en'));
    expect(text(english[0] ?? '')).toContain('Resolve');
    expect(text(english[1] ?? '')).toMatch(/Resolved · Lan · .*22.*Reopen/);
  });

  it('shows no button to a reader, nor on a comment the viewer may not resolve, but still who resolved it', () => {
    const reader = entries(render(<PostActivity postId="p-1" channels={[]} canWrite={false} />));
    expect(reader.join('')).not.toContain('<button');
    expect(text(reader[1] ?? '')).toContain('Đã xử lý · Lan');
  });

  it('counts the open comments on a row, a board card and the review inbox, in both languages', () => {
    expect(text(render(<OpenComments count={3} />))).toBe('3 bình luận chưa xử lý');
    expect(text(render(<OpenComments count={1} />, 'en'))).toBe('1 open comment');
    expect(text(render(<OpenComments count={2} />, 'en'))).toBe('2 open comments');
    expect(render(<OpenComments count={0} />)).toBe('');
  });

  it('warns before a review without blocking it, in natural Vietnamese and in English', () => {
    expect(viMessages.social.submitOpenComments).toContain('Bạn vẫn gửi duyệt được');
    expect(en.social.submitOpenComments).toContain('You can still submit it');
  });
});
