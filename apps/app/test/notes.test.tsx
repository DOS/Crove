// The notes screens' rules (issue #1671): a note's Markdown renders as React elements only, links open safe addresses
// with rel set, raw HTML stays text; tags parse as the server keeps them; a password line warns; the address parses.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks } from '../src/lib/markdown.tsx';
import { looksLikePassword, parseNotesSearch, parseTags } from '../src/lib/notes.ts';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('note Markdown (#1671)', () => {
  it('renders headings, paragraphs, lists and checklists', () => {
    expect(parseBlocks('# Khách\nGọi sau 15h\nhỏi kế toán\n\n- một\n- [x] xong\n- [ ] chưa\n1. đầu\n2. sau').map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list']);
    const out = html('**Đậm** và _nghiêng_ và `mã`\n\n- [x] xong\n- [ ] chưa');
    expect(out).toContain('<strong>Đậm</strong>');
    expect(out).toContain('<em>nghiêng</em>');
    expect(out).toContain('mã</code>');
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""/);
  });

  it('opens only safe links, with rel set, and keeps raw HTML as text', () => {
    const out = html('[Cổng thuế](https://thuedientu.gdt.gov.vn) [x](javascript:alert(1)) <script>alert(1)</script> <img src="https://t.example/p.gif">');
    expect(out).toContain('href="https://thuedientu.gdt.gov.vn"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toContain('href="javascript');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });
});

describe('note helpers (#1671)', () => {
  it('parses tags as the server keeps them', () => {
    expect(parseTags(' Ngân hàng, thuế,, ngân hàng ,')).toEqual(['ngân hàng', 'thuế']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(','))).toHaveLength(20);
  });

  it('warns on a line that looks like a password', () => {
    for (const text of ['Mật khẩu: abc', 'mat khau = 123', 'Ngân hàng\npassword: x', 'pass:1']) expect(looksLikePassword(text), text).toBe(true);
    for (const text of ['Đổi mật khẩu cổng thuế trước ngày 5', 'passport của giám đốc', '']) expect(looksLikePassword(text), text).toBe(false);
  });

  it('parses the address, dropping what is not a note id or a list', () => {
    const id = '0192f3a4-5b6c-7d8e-9f01-23456789ABCD';
    expect(parseNotesSearch({ note: id, list: 'trash', q: '  hoa don ' })).toEqual({ note: id.toLowerCase(), list: 'trash', q: 'hoa don' });
    expect(parseNotesSearch({ note: 'x', list: 'all', q: ' ' })).toEqual({});
  });
});
