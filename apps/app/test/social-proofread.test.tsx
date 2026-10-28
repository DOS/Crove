// The AI proofread proposal in the composer (#1167): the fix shown as a word diff with Áp dụng and Bỏ qua, a note when
// there is nothing to fix, and no Áp dụng once the text was typed on. Rendered on the server; nothing is fetched.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ aiEnabled: true }) }));

const { ProofreadProposal, proofreadDiff } = await import('../src/components/social-proofread.tsx');

const before = { text: 'Khai truong chi nhanh moi , giam 20% #khaitruong', title: null };
const after = { text: 'Khai trương chi nhánh mới, giảm 20% #khaitruong', title: null };

function render(props: { before: typeof before; after: typeof after; outdated?: boolean }, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <ProofreadProposal before={props.before} after={props.after} outdated={props.outdated ?? false} onApply={() => undefined} onDiscard={() => undefined} />
    </IntlProvider>,
  );
}

describe('AI proofread proposal', () => {
  it('shows the fix as a word diff, with Áp dụng and Bỏ qua', () => {
    const html = render({ before, after });
    expect(html).toContain('<del');
    expect(html).toContain('truong');
    expect(html).toContain('<ins');
    expect(html).toContain('trương');
    expect(html).toContain('Áp dụng');
    expect(html).toContain('Bỏ qua');
    expect(html).toContain('liên kết, hashtag, tài khoản được nhắc (@), con số, giá và emoji được giữ nguyên');
    const en = render({ before, after }, 'en');
    expect(en).toContain('Apply');
    expect(en).toContain('Discard');
  });

  it('says there is nothing to fix, with nothing to apply', () => {
    const html = render({ before, after: { ...before, text: `${before.text}\n` } });
    expect(html).toContain('Vy không thấy lỗi chính tả hay dấu câu nào cần sửa.');
    expect(html).not.toContain('Áp dụng');
    expect(render({ before, after: before }, 'en')).toContain('Vy found no spelling or punctuation to fix.');
  });

  it('offers no Áp dụng once the text changed after the ask', () => {
    const html = render({ before, after, outdated: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Áp dụng<\/button>/);
    expect(html).toContain('Nội dung đã đổi sau khi nhờ Vy');
  });

  it('diffs the title on its own, and only what changed', () => {
    expect(proofreadDiff({ text: 'a', title: 'Khai truong' }, { text: 'a', title: 'Khai trương' })).toEqual({
      body: null,
      title: [
        { kind: 'same', text: 'Khai ' },
        { kind: 'removed', text: 'truong' },
        { kind: 'added', text: 'trương' },
      ],
    });
    expect(proofreadDiff(before, before)).toBeNull();
  });
});
