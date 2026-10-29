// Bold and italic text in the composer (#1179): the buttons with their names in Vietnamese and English, nothing while
// the text cannot be edited, and the hints only while the text holds styled letters, X's and the as-is channels' only
// for those. Rendered on the server; nothing is fetched.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { styleSelection } from '@crove/mod-social/contract';
import { catalog } from '../src/i18n/runtime.ts';
import { TextStyleButtons, TextStyleHint } from '../src/components/social-text-style.tsx';

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      {node}
    </IntlProvider>,
  );
}

const bold = styleSelection('Khuyến mãi #sale', 0, 10, 'bold').text;

describe('text style buttons', () => {
  it('names each style and Bỏ định dạng, in Vietnamese and English', () => {
    const html = render(<TextStyleButtons targetId="social-body" value="Khuyến mãi" onChange={() => undefined} />);
    expect(html).toContain('role="group" aria-label="Kiểu chữ"');
    // Each button's name is its style's, from hidden text beside the glyph (#1572).
    for (const label of ['In đậm', 'In nghiêng', 'Vừa đậm vừa nghiêng']) expect(html).toContain(`<span class="sr-only">${label}</span>`);
    expect(html).toContain('<span aria-hidden="true">BI</span>');
    expect(html).toContain('>Bỏ định dạng</button>');
    const en = render(<TextStyleButtons targetId="social-body" value="" onChange={() => undefined} />, 'en');
    expect(en).toContain('aria-label="Text style"');
    for (const label of ['Bold', 'Italic', 'Bold italic']) expect(en).toContain(`<span class="sr-only">${label}</span>`);
    expect(en).toContain('>Remove style</button>');
  });

  it('shows nothing while the text cannot be edited', () => {
    expect(render(<TextStyleButtons targetId="social-body" value="a" disabled onChange={() => undefined} />)).toBe('');
  });
});

describe('text style hints', () => {
  it('shows nothing for plain text', () => {
    expect(render(<TextStyleHint text="Khuyến mãi #sale" providers={['x', 'wordpress']} />)).toBe('');
  });

  it("warns about screen readers, and about X's count and the as-is channels only for those", () => {
    const fb = render(<TextStyleHint text={bold} providers={['facebook_page']} />);
    expect(fb).toContain('trình đọc màn hình đọc sai');
    expect(fb).toContain('Hashtag, tên được nhắc (@), liên kết và emoji vẫn giữ nguyên');
    expect(fb).not.toContain('X tính');
    expect(fb).not.toContain('WordPress');
    const mixed = render(<TextStyleHint text={bold} providers={['x', 'zalo_oa']} />);
    expect(mixed).toContain('X tính mỗi chữ đậm hay nghiêng là 2 ký tự');
    expect(mixed).toContain('bài viết Zalo OA');
    const en = render(<TextStyleHint text={bold} providers={['x', 'google_business']} />, 'en');
    expect(en).toContain('screen readers misread or skip them');
    expect(en).toContain('X counts each bold or italic letter as 2 characters');
    expect(en).toContain('show these letters as they are');
  });
});
