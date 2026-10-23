// A web page's head for a link preview (#641), and its main text for AI drafts (#779): which tags win, decoding, and
// what is never read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, zExtractedPage } from '@crove/extract-contract';
import { parse } from '../src/parse.ts';
import { readHtmlMeta } from '../src/html-meta.ts';

const page = (head: string, body = '<p>body</p>') => new TextEncoder().encode(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);

describe('readHtmlMeta', () => {
  it('takes Open Graph first, then Twitter cards, then the title and description', () => {
    expect(
      readHtmlMeta(
        page(
          '<title>Tiêu đề trang</title><meta name="description" content="Mô tả HTML"><meta name="twitter:title" content="Twitter"><meta property="og:title" content="Khai trương cửa hàng"><meta property="og:description" content="Giảm 20% tuần đầu"><meta property="og:site_name" content="Crove Shop">',
        ),
      ),
    ).toEqual({ title: 'Khai trương cửa hàng', description: 'Giảm 20% tuần đầu', siteName: 'Crove Shop', text: 'body' });
    expect(readHtmlMeta(page('<title>Chỉ có tiêu đề</title><meta name=description content=Ngắn>'))).toEqual({ title: 'Chỉ có tiêu đề', description: 'Ngắn', siteName: null, text: 'body' });
    expect(readHtmlMeta(page("<meta name='twitter:title' content='Từ Twitter'>"))).toMatchObject({ title: 'Từ Twitter' });
    expect(readHtmlMeta(page('<title>A < B và <b>đậm</b></title>'))).toMatchObject({ title: 'A < B và <b>đậm</b>' });
  });

  it('decodes entities and the declared charset, and collapses whitespace', () => {
    expect(readHtmlMeta(page('<title>  Cà phê &amp; bánh\n\t mì &#8211; &#x1F600; </title>'))).toMatchObject({ title: 'Cà phê & bánh mì – 😀' });
    const latin = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title></head></html>')]);
    expect(readHtmlMeta(latin)).toMatchObject({ title: 'Café' });
    expect(readHtmlMeta(page('<meta charset="no-such-charset"><title>Vẫn đọc được</title>'))).toMatchObject({ title: 'Vẫn đọc được' });
  });

  it('reads only the head, and never comments, scripts or the body', () => {
    expect(readHtmlMeta(page('<!-- <meta property="og:title" content="comment"> --><script>var t = "<meta property=\'og:title\' content=\'script\'>";</script><title>Thật</title>', '<meta property="og:title" content="body">'))).toEqual({
      title: 'Thật',
      description: null,
      siteName: null,
      text: null,
    });
  });

  it('caps every field in UTF-16 units, as the contract counts them, never inside a surrogate pair', () => {
    const long = 'ư'.repeat(EXTRACT_LIMITS.maxPageTitleChars + 50);
    expect(readHtmlMeta(page(`<title>${long}</title>`)).title).toHaveLength(EXTRACT_LIMITS.maxPageTitleChars);
    const emoji = readHtmlMeta(page(`<title>a${'😀'.repeat(EXTRACT_LIMITS.maxPageTitleChars)}</title>`)).title ?? '';
    expect(emoji.length).toBeLessThanOrEqual(EXTRACT_LIMITS.maxPageTitleChars);
    expect(emoji.endsWith('😀')).toBe(true);
    // A long page full of emoji still answers within the contract (#779).
    const text = readHtmlMeta(page('', `<p>a${'😀'.repeat(EXTRACT_LIMITS.maxPageTextChars)}</p>`)).text ?? '';
    expect(text.length).toBeLessThanOrEqual(EXTRACT_LIMITS.maxPageTextChars);
    expect(text.endsWith('😀')).toBe(true);
  });

  it('answers through the contract, and refuses what is not HTML', async () => {
    // Emoji-heavy fields stay within the contract's limits.
    expect(zExtractedPage.safeParse(readHtmlMeta(page(`<title>${'😀'.repeat(400)}</title>`, `<p>${'😀'.repeat(5000)}</p>`))).success).toBe(true);
    expect(await parse('html_meta', page('<title>Trang</title>'))).toEqual({ ok: true, kind: 'html_meta', page: { title: 'Trang', description: null, siteName: null, text: 'body' } });
    expect(await parse('html_meta', new TextEncoder().encode('{"json": true}'))).toEqual({ ok: false, code: 'invalid', message: 'Trang không phải HTML' });
    expect(await parse('html_meta', page(''))).toEqual({ ok: true, kind: 'html_meta', page: { title: null, description: null, siteName: null, text: 'body' } });
  });

  it('reads the main text from the article, else main, else the body, without the page furniture (#779)', () => {
    const body = [
      '<header><nav><a href="/">Trang chủ</a> <a href="/menu">Thực đơn</a></nav></header>',
      '<article><h1>Khai trương chi nhánh Quận 3</h1><p>Từ <b>1/11</b>, tiệm mở cửa 7 giờ &amp; giảm 20%.</p>',
      '<script>var leak = "không đọc";</script><form><input value="email"><button>Gửi</button></form>',
      '<ul><li>Bánh mì</li><li>Cà phê</li></ul></article>',
      '<aside>Bài liên quan</aside><footer>© 2026 Tiệm</footer>',
    ].join('');
    expect(readHtmlMeta(page('<title>Tiệm</title>', body)).text).toBe('Khai trương chi nhánh Quận 3\nTừ 1/11, tiệm mở cửa 7 giờ & giảm 20%.\nBánh mì\nCà phê');
    expect(readHtmlMeta(page('', '<nav>Menu</nav><main><p>Trong main</p></main><p>Ngoài</p>')).text).toBe('Trong main');
    expect(readHtmlMeta(page('', '<div>Dòng một<br>Dòng hai</div><footer>Chân trang</footer>')).text).toBe('Dòng một\nDòng hai');
    expect(readHtmlMeta(page('', '<nav>Chỉ có menu</nav>')).text).toBeNull();
    const long = `<p>${'ư'.repeat(EXTRACT_LIMITS.maxPageTextChars + 100)}</p>`;
    expect(Array.from(readHtmlMeta(page('', long)).text ?? '')).toHaveLength(EXTRACT_LIMITS.maxPageTextChars);
  });

  it('reads a news page: the article with the most text, not a teaser card before it, nor the cards beside it (#1235)', async () => {
    const html = readFileSync(join(import.meta.dirname, 'fixtures', 'news-article.html'));
    const result = await parse('html_meta', new Uint8Array(html));
    if (!result.ok || result.kind !== 'html_meta') throw new Error('not read');
    expect(result.page.title).toBe('Giá cà phê tăng mạnh đầu vụ');
    expect(result.page.text?.split('\n')).toEqual([
      'Giá cà phê tăng mạnh đầu vụ',
      'Sáng 22/10, giá cà phê nhân xô tại Đắk Lắk đạt 128.500 đồng/kg, tăng 2.000 đồng so với tuần trước.',
      'Nông dân thu hoạch cà phê ở Buôn Ma Thuột.',
      'Theo Hiệp hội Cà phê, sản lượng niên vụ 2026-2027 dự kiến giảm khoảng 8% do hạn hán kéo dài.',
      'Các doanh nghiệp xuất khẩu cho biết đơn hàng sang châu Âu vẫn ổn định & giá có thể còn tăng.',
      // A comment nested in the article stays part of it.
      'Bình luận: giá vậy là tốt rồi.',
    ]);
    // Nested articles: the outer one is read whole, not cut at the inner one's end.
    expect(readHtmlMeta(page('', '<article><p>Mở đầu</p><article><p>Trong</p></article><p>Kết luận</p></article>')).text).toBe('Mở đầu\nTrong\nKết luận');
    // Of several <main>, the one with the most text.
    expect(readHtmlMeta(page('', '<main><p>Ngắn</p></main><main><p>Phần dài hơn nhiều</p></main>')).text).toBe('Phần dài hơn nhiều');
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    readHtmlMeta(new TextEncoder().encode(`<html><head>${'<meta a="'.repeat(20_000)}${'<'.repeat(100_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><head><title>${'&'.repeat(200_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><head>${'<script>'.repeat(50_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><head>${'<!-- --><style></style><title'.repeat(15_000)}`));
    // The body: stray <, unclosed furniture and blocks.
    readHtmlMeta(new TextEncoder().encode(`<html><body>${'<'.repeat(200_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><body>${'<nav><p>x'.repeat(30_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><body>${'<article><br x'.repeat(30_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><body>${'<article>x</article>'.repeat(25_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><body>${'<main><article'.repeat(30_000)}`));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
