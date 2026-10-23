// Suggested edits (#1236) in the app: the words a selection takes (whole emoji, no white space at its ends), and a
// suggestion in the comments with what it changes, where it stands and the buttons for a member who may edit the post,
// in Vietnamese and in English. Rendered on the server.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.ts', () => ({ client: {}, orpc: {}, queryClient: new QueryClient(), errorMessage: (e: unknown) => String(e) }));

const { SuggestionView } = await import('../src/components/social-suggest.tsx');
const { selectedRange } = await import('../src/lib/social-suggest.ts');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
type Props = Parameters<typeof SuggestionView>[0];
const open: Props['suggestion'] = { field: 'post', quote: 'giảm 20%', text: 'giảm 25%', state: 'open', outdated: false, frozen: false, before: 'Khai trương, ', after: ' cả tuần.', revision: 3, decidable: true };

function render(props: Omit<Partial<Props>, 'suggestion'> & { suggestion?: Partial<Props['suggestion']> }, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <SuggestionView commentId="c1" channel={props.channel ?? null} locked={props.locked ?? false} suggestion={{ ...open, ...props.suggestion }} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('selecting the words to change (#1236)', () => {
  it('takes the words selected, without the white space at their ends', () => {
    const body = 'Khai trương cửa hàng mới';
    expect(selectedRange(body, 5, 12)).toEqual({ start: 5, end: 11, quote: 'trương' });
    expect(selectedRange(body, 12, 5)).toEqual({ start: 5, end: 11, quote: 'trương' });
    expect(selectedRange(body, 4, 5)).toBeNull();
    expect(selectedRange(body, 3, 3)).toBeNull();
    expect(selectedRange(body, null, null)).toBeNull();
  });

  it('never cuts an emoji in two', () => {
    const body = 'Vui 🎉 quá';
    expect(selectedRange(body, 5, 10)).toEqual({ start: 4, end: 10, quote: '🎉 quá' });
    expect(selectedRange(body, 0, 5)).toEqual({ start: 0, end: 6, quote: 'Vui 🎉' });
  });

  it('refuses more than 4000 characters', () => {
    expect(selectedRange('a'.repeat(4001), 0, 4001)).toBeNull();
    expect(selectedRange('a'.repeat(4001), 0, 4000)?.quote).toHaveLength(4000);
  });
});

describe('a suggestion in the comments (#1236)', () => {
  it('shows the change with the words around it, and Nhận and Bỏ qua for a member who may edit', () => {
    const html = render({});
    expect(text(html)).toBe('Đề xuất sửa nội dung chung …Khai trương, Thay đoạn: giảm 20% → bằng: giảm 25% cả tuần.… Nhận Bỏ qua');
    expect(html).toContain('<del');
    expect(html).toContain('<ins');
    expect(text(render({}, 'en'))).toBe('Suggested edit of the shared text …Khai trương, Replace: giảm 20% → with: giảm 25% cả tuần.… Accept Skip');
  });

  it("names a channel's own text and a deletion", () => {
    expect(text(render({ channel: 'Trang Tiệm Bánh', suggestion: { field: 'channel', text: '', before: '', after: '' } }))).toBe(
      'Đề xuất sửa nội dung riêng của Trang Tiệm Bánh Thay đoạn: giảm 20% → (xóa đoạn này) Nhận Bỏ qua',
    );
  });

  it('says when it is outdated, and offers only Bỏ qua then', () => {
    const html = render({ suggestion: { outdated: true, before: '', after: '' } });
    expect(text(html)).toContain('Đã cũ');
    expect(text(html)).toContain('Đoạn này không còn trong nội dung nên không nhận được nữa');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Nhận<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Bỏ qua<\/button>/);
  });

  it('waits for unsaved edits on the page before accepting', () => {
    const html = render({ locked: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Nhận<\/button>/);
    expect(text(html)).toContain('Lưu hoặc bỏ thay đổi trên trang trước khi nhận đề xuất.');
  });

  it('shows a closed one with its state and no buttons, and none to a viewer', () => {
    expect(text(render({ suggestion: { state: 'accepted', decidable: false, before: '', after: '' } }))).toBe('Đề xuất sửa nội dung chung Đã nhận Thay đoạn: giảm 20% → bằng: giảm 25%');
    expect(text(render({ suggestion: { state: 'skipped', decidable: false } }))).toContain('Đã bỏ qua');
    expect(render({ suggestion: { decidable: false } })).not.toContain('<button');
  });
});
