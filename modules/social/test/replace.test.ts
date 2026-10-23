// Find and replace in post text (#1144): literal text whatever characters it holds, case and whole words, the first
// match in its context, and the length bound that stops a short pattern with a long replacement early.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REPLACE_CONTEXT, replaceLiteral, type ReplaceOptions } from '../src/domain/replace.ts';

const opts = (find: string, replace: string, over: Partial<ReplaceOptions> = {}): ReplaceOptions => ({ find, replace, caseSensitive: false, wholeWord: false, ...over });

describe('replaceLiteral', () => {
  it('replaces every match, left to right, without overlaps', () => {
    expect(replaceLiteral('aaaa', opts('aa', 'b'))).toMatchObject({ text: 'bb', count: 2 });
    expect(replaceLiteral('Giá 100k, chỉ 100k', opts('100k', '120k'))).toMatchObject({ text: 'Giá 120k, chỉ 120k', count: 2 });
    expect(replaceLiteral('nothing here', opts('xyz', 'q'))).toEqual({ text: 'nothing here', count: 0, first: null, overflow: false });
  });

  it('treats the pattern and the replacement as plain text, never as a regular expression', () => {
    expect(replaceLiteral('a.b axb', opts('a.b', 'X'))).toMatchObject({ text: 'X axb', count: 1 });
    expect(replaceLiteral('(.*) and [x]+', opts('(.*)', '$1'))).toMatchObject({ text: '$1 and [x]+', count: 1 });
    expect(replaceLiteral('price $5', opts('$5', '$& $$'))).toMatchObject({ text: 'price $& $$', count: 1 });
    expect(replaceLiteral('a\\b', opts('\\', '/'))).toMatchObject({ text: 'a/b', count: 1 });
  });

  it('ignores case unless asked, Vietnamese letters included', () => {
    expect(replaceLiteral('KHUYẾN MÃI và khuyến mãi', opts('khuyến mãi', 'ưu đãi'))).toMatchObject({ text: 'ưu đãi và ưu đãi', count: 2 });
    expect(replaceLiteral('KHUYẾN MÃI và khuyến mãi', opts('khuyến mãi', 'ưu đãi', { caseSensitive: true }))).toMatchObject({ text: 'KHUYẾN MÃI và ưu đãi', count: 1 });
    expect(replaceLiteral('Đà Nẵng', opts('đà', 'Hội'))).toMatchObject({ text: 'Hội Nẵng', count: 1 });
  });

  it('matches whole words only when asked, with letters, digits, marks and underscores as word characters', () => {
    expect(replaceLiteral('sale wholesale sale_x sale.', opts('sale', 'deal', { wholeWord: true }))).toMatchObject({ text: 'deal wholesale sale_x deal.', count: 2 });
    expect(replaceLiteral('mã SALE10 và SALE1', opts('sale1', 'NEW', { wholeWord: true }))).toMatchObject({ text: 'mã SALE10 và NEW', count: 1 });
    // A combining mark after the match makes it part of a longer word.
    expect(replaceLiteral('cá ca', opts('ca', 'X', { wholeWord: true }))).toMatchObject({ text: 'cá X', count: 1 });
    // An emoji is no word character, so it is a boundary.
    expect(replaceLiteral('😀sale😀', opts('sale', 'deal', { wholeWord: true }))).toMatchObject({ text: '😀deal😀', count: 1 });
  });

  it('replaces links and codes inside longer text', () => {
    const text = 'Đặt ngay: https://shop.example/spring?utm=a và https://shop.example/spring';
    expect(replaceLiteral(text, opts('https://shop.example/spring', 'https://shop.example/summer'))).toMatchObject({ count: 2, text: 'Đặt ngay: https://shop.example/summer?utm=a và https://shop.example/summer' });
  });

  it('gives the first match in its context, with an ellipsis where the text goes on', () => {
    const text = `${'x'.repeat(100)} SALE ${'y'.repeat(100)} sale`;
    const r = replaceLiteral(text, opts('sale', 'deal'));
    expect(r.first).toEqual({ before: `…${'x'.repeat(REPLACE_CONTEXT - 1)} `, match: 'SALE', after: ` ${'y'.repeat(REPLACE_CONTEXT - 1)}…` });
    expect(replaceLiteral('a sale', opts('sale', 'deal')).first).toEqual({ before: 'a ', match: 'sale', after: '' });
    // Never half an emoji at an edge.
    const emoji = `${'😀'.repeat(30)}sale`;
    const cut = replaceLiteral(emoji, opts('sale', 'deal')).first;
    expect(cut?.before.isWellFormed()).toBe(true);
  });

  it('gives up as soon as the result would be longer than the limit', () => {
    const r = replaceLiteral('a'.repeat(1000), opts('a', 'b'.repeat(2000)), 100_000);
    expect(r).toMatchObject({ overflow: true, text: null });
    expect(r.count).toBeLessThan(1000);
    expect(replaceLiteral('abc', opts('b', 'xx'), 4)).toMatchObject({ overflow: false, text: 'axxc' });
    expect(replaceLiteral('abc', opts('b', 'xxx'), 4)).toMatchObject({ overflow: true, text: null, count: 1 });
  });

  it('agrees with a plain split and join when case matters and words do not', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ minLength: 1, maxLength: 4 }), fc.string({ maxLength: 4 }), (text, find, replace) => {
        const r = replaceLiteral(text, opts(find, replace, { caseSensitive: true }));
        const parts = text.split(find);
        expect(r.count).toBe(parts.length - 1);
        expect(r.text).toBe(parts.join(replace));
      }),
    );
  });
});
