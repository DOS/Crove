// Bold and italic text (#1179): the styles' letters and the italic hole, digits, Vietnamese by NFD with đ plain, the
// round trip back to the same NFC text, tokens kept, the selection widened to whole letters, the fold of the block
// only, and how the channels count the letters.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countText, foldMathAlphanumerics, hasStyledText, isFoldable, styleSelection, styleText, styleTokens, TEXT_STYLES } from '../src/contract.ts';

const all = (text: string, style: (typeof TEXT_STYLES)[number] | null) => styleSelection(text, 0, text.length, style).text;

describe('styleText', () => {
  it('maps Latin letters to the bold, italic and bold italic letters of the block', () => {
    expect(styleText('Sale', 'bold')).toBe('\u{1D412}\u{1D41A}\u{1D425}\u{1D41E}');
    expect(styleText('Sale', 'italic')).toBe('\u{1D446}\u{1D44E}\u{1D459}\u{1D452}');
    expect(styleText('Sale', 'boldItalic')).toBe('\u{1D47A}\u{1D482}\u{1D48D}\u{1D486}');
  });

  it('writes italic h as U+210E, the hole in the italic block, and never the reserved code point', () => {
    expect(styleText('h', 'italic')).toBe('ℎ');
    expect(styleText('H', 'italic')).toBe('\u{1D43B}');
    expect(styleText('h', 'boldItalic')).toBe('\u{1D489}');
    for (const style of TEXT_STYLES) expect([...styleText('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', style)].every((c) => /\p{L}/u.test(c))).toBe(true);
  });

  it('styles digits in bold (and bold italic, with the bold digits) only', () => {
    expect(styleText('2024', 'bold')).toBe('\u{1D7D0}\u{1D7CE}\u{1D7D0}\u{1D7D2}');
    expect(styleText('2024', 'boldItalic')).toBe(styleText('2024', 'bold'));
    expect(styleText('2024', 'italic')).toBe('2024');
  });

  it('maps the base letter of a Vietnamese letter and keeps its marks; đ and Đ stay plain', () => {
    const bold = styleText('Khuyến mãi', 'bold');
    expect(bold).toBe('\u{1D40A}\u{1D421}\u{1D42E}\u{1D432}\u{1D41E}̂́\u{1D427} \u{1D426}\u{1D41A}̃\u{1D422}');
    expect(styleText('Đồ đẹp', 'bold')).toBe('Đ\u{1D428}̂̀ đ\u{1D41E}̣\u{1D429}');
    // Other scripts, punctuation and spaces stay as they are.
    expect(styleText('Giá: 100% 東京 ✓', 'italic')).toBe(`${styleText('Gia', 'italic')}́: 100% 東京 ✓`);
  });

  it('round-trips to the same NFC text, from NFC or NFD, through any style and back', () => {
    for (const text of ['Khuyến mãi', 'KHUYẾN MÃI cuối tuần, giảm 50%!', 'Đặc sản Đà Lạt: dâu tây, atisô', 'Ưu đãi ở Hồ Gươm']) {
      for (const style of TEXT_STYLES) {
        expect(styleText(styleText(text, style), null)).toBe(text.normalize('NFC'));
        expect(styleText(styleText(text.normalize('NFD'), style), null)).toBe(text.normalize('NFC'));
        // Restyling goes through the plain letters: bold of italic is bold.
        expect(styleText(styleText(text, 'italic'), style)).toBe(styleText(text, style));
      }
    }
  });

  it('round-trips any text of Latin, Vietnamese, digits and symbols', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'Z', 'h', 'ế', 'Ữ', 'đ', 'Đ', '7', ' ', '.', '😀', '東', 'é'.normalize('NFD')), { maxLength: 30 }), fc.constantFrom(...TEXT_STYLES), (parts, style) => {
        const text = parts.join('');
        expect(styleText(styleText(text, style), null)).toBe(text.normalize('NFC'));
      }),
    );
  });
});

describe('styleSelection', () => {
  it('styles only the selection and selects the styled part', () => {
    const text = 'Mua ngay hôm nay';
    const out = styleSelection(text, 4, 8, 'bold');
    expect(out.text).toBe(`Mua ${styleText('ngay', 'bold')} hôm nay`);
    expect(out.text.slice(out.start, out.end)).toBe(styleText('ngay', 'bold'));
    expect(styleSelection(out.text, out.start, out.end, null)).toEqual({ text, start: 4, end: 8 });
  });

  it('keeps hashtags, @mentions, links, emails and emoji in the selection as they are, even ones it cuts', () => {
    const text = 'Sale #khuyenmai @lan.anh xem crove.vn/gia, https://x.com/a, www.crove.vn và hi@crove.vn 1️⃣ 🇻🇳 👍🏽 #️⃣ ok';
    const bold = all(text, 'bold');
    for (const token of ['#khuyenmai', '@lan.anh', 'crove.vn/gia', 'https://x.com/a', 'www.crove.vn', 'hi@crove.vn', '1️⃣', '🇻🇳', '👍🏽', '#️⃣']) expect(bold).toContain(token);
    expect(bold.startsWith(styleText('Sale', 'bold'))).toBe(true);
    expect(bold.endsWith(styleText('ok', 'bold'))).toBe(true);
    expect(all(bold, null)).toBe(text);
    // A selection starting inside a hashtag leaves the whole hashtag plain.
    expect(styleSelection('Mua #khuyenmai ngay', 8, 19, 'bold').text).toBe(`Mua #khuyenmai ${styleText('ngay', 'bold')}`);
    // A Vietnamese hashtag keeps working.
    expect(all('Ưu đãi #khuyếnmãi', 'italic')).toBe(`${styleText('Ưu đãi', 'italic')} #khuyếnmãi`);
  });

  it('removing the style folds styled tokens back too, and leaves plain ones byte for byte', () => {
    const styledTag = `#${styleText('sale', 'bold')}`;
    expect(all(`Mua ${styledTag}`, null)).toBe('Mua #sale');
    const nfdTag = '#khuyến'.normalize('NFD');
    expect(all(nfdTag, null)).toBe(nfdTag);
  });

  it('widens a selection that cuts a letter from its marks or splits a styled letter', () => {
    const text = 'ế'.normalize('NFD') + 'x';
    // From after the base letter: the letter and its marks move together.
    expect(styleSelection(text, 1, 2, 'bold').text).toBe(`${styleText('ế', 'bold')}x`);
    const bold = styleText('ab', 'bold');
    // Offsets in the middle of a surrogate pair.
    expect(styleSelection(bold, 1, 3, null)).toEqual({ text: 'ab', start: 0, end: 2 });
  });

  it('changes nothing with an empty selection, and clamps offsets past the text', () => {
    expect(styleSelection('abc', 2, 2, 'bold')).toEqual({ text: 'abc', start: 2, end: 2 });
    expect(styleSelection('abc', 5, 9, 'bold').text).toBe('abc');
    expect(styleSelection('abc', 2, 0, 'bold').text).toBe(styleText('ab', 'bold') + 'c');
  });

  it('finds tokens as the AI proofread does', () => {
    expect(styleTokens('a #b @c d.vn 😀 e').map(([s, e]) => 'a #b @c d.vn 😀 e'.slice(s, e))).toEqual(['#b', '@c', 'd.vn', '😀']);
  });
});

describe('foldMathAlphanumerics', () => {
  it('folds every assigned letter and digit of the block to one plain code point outside it', () => {
    for (let cp = 0x1d400; cp <= 0x1d7ff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const plain = foldMathAlphanumerics(ch);
      expect([...plain]).toHaveLength(1);
      expect(isFoldable(cp)).toBe(true);
      // A reserved code point (a hole) stays itself; an assigned one leaves the block.
      if (/\p{Cn}/u.test(ch)) expect(plain).toBe(ch);
      else expect(plain.codePointAt(0)).toBeLessThan(0x1d400);
    }
  });

  it('folds the letterlike symbols in the holes, and Greek to Greek', () => {
    expect(foldMathAlphanumerics('ℎℬℂℝℤℯ')).toBe('hBCRZe');
    expect(foldMathAlphanumerics('\u{1D6A8}\u{1D6C2}')).toBe('Αα');
    expect(foldMathAlphanumerics('\u{1D5EE}\u{1D68A}\u{1D552}\u{1D7EC}')).toBe('aaa0');
  });

  it('folds that block only: not full NFKC', () => {
    const others = 'ﬁ ² ⓐ Ａ ㎏ ℃ № ™ ½';
    expect(foldMathAlphanumerics(others)).toBe(others);
    expect(foldMathAlphanumerics('Khuyến mãi')).toBe('Khuyến mãi');
    expect(hasStyledText('Khuyến mãi')).toBe(false);
    expect(hasStyledText(styleText('a', 'italic'))).toBe(true);
  });
});

describe('counting styled letters (#1179)', () => {
  it('X weighs each styled letter 2 and each mark after it 1; code points count each once', () => {
    expect(countText(styleText('Sale', 'bold'), 'weighted')).toBe(8);
    expect(countText(styleText('ế', 'bold'), 'weighted')).toBe(4);
    expect(countText('ế', 'weighted')).toBe(2);
    expect(countText(styleText('Sale', 'bold'), 'codepoints')).toBe(4);
    expect(countText(styleText('Sale', 'bold'), 'utf16')).toBe(8);
  });
});
