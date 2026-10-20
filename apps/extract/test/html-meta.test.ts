// A web page's head for a link preview (#641): which tags win, decoding, and what is never read.
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS } from '@crove/extract-contract';
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
    ).toEqual({ title: 'Khai trương cửa hàng', description: 'Giảm 20% tuần đầu', siteName: 'Crove Shop' });
    expect(readHtmlMeta(page('<title>Chỉ có tiêu đề</title><meta name=description content=Ngắn>'))).toEqual({ title: 'Chỉ có tiêu đề', description: 'Ngắn', siteName: null });
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
    });
  });

  it('caps every field, on a code point', () => {
    const long = 'ư'.repeat(EXTRACT_LIMITS.maxPageTitleChars + 50);
    expect(readHtmlMeta(page(`<title>${long}</title>`)).title).toHaveLength(EXTRACT_LIMITS.maxPageTitleChars);
    const emoji = '😀'.repeat(EXTRACT_LIMITS.maxPageTitleChars + 1);
    expect(Array.from(readHtmlMeta(page(`<title>${emoji}</title>`)).title ?? '')).toHaveLength(EXTRACT_LIMITS.maxPageTitleChars);
  });

  it('answers through the contract, and refuses what is not HTML', async () => {
    expect(await parse('html_meta', page('<title>Trang</title>'))).toEqual({ ok: true, kind: 'html_meta', page: { title: 'Trang', description: null, siteName: null } });
    expect(await parse('html_meta', new TextEncoder().encode('{"json": true}'))).toEqual({ ok: false, code: 'invalid', message: 'Trang không phải HTML' });
    expect(await parse('html_meta', page(''))).toEqual({ ok: true, kind: 'html_meta', page: { title: null, description: null, siteName: null } });
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    readHtmlMeta(new TextEncoder().encode(`<html><head>${'<meta a="'.repeat(20_000)}${'<'.repeat(100_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><head><title>${'&'.repeat(200_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><head>${'<script>'.repeat(50_000)}`));
    readHtmlMeta(new TextEncoder().encode(`<html><head>${'<!-- --><style></style><title'.repeat(15_000)}`));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
