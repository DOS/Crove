// Banned and sensitive words (#1055): case, NFC and diacritics, word boundaries, emoji, the ranges, channel scope and
// the texts of a variant that are checked.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileBannedWords, findBannedInTexts, findBannedWords, normalizePhrase, variantTexts, wordsForChannel, wordsForChannels, type BannedWord } from '../src/domain/banned-words.ts';

let n = 0;
const word = (phrase: string, over: Partial<BannedWord> = {}): BannedWord => ({ id: `w${(n += 1)}`, phrase, level: 'block', reason: null, connectionIds: [], ...over });
const found = (text: string, ...phrases: string[]) => findBannedWords(text, phrases.map((p) => word(p))).map((m) => text.slice(m.start, m.end));

describe('normalizePhrase', () => {
  it('is NFC, lower case, trimmed, with white space collapsed and format characters dropped', () => {
    expect(normalizePhrase('  Tốt   NHẤT\n')).toBe('tốt nhất');
    expect(normalizePhrase('chüa'.normalize('NFD'))).toBe('chüa');
    expect(normalizePhrase('cháy')).toBe('cháy');
    expect(normalizePhrase('s​ố 1')).toBe('số 1');
  });
});

describe('findBannedWords: case and Unicode forms', () => {
  it('ignores case', () => {
    expect(found('Sản phẩm TỐT NHẤT thị trường', 'tốt nhất')).toEqual(['TỐT NHẤT']);
    expect(found('Sản phẩm tốt nhất', 'TỐT NHẤT')).toEqual(['tốt nhất']);
  });

  it('matches text typed decomposed (NFD) and ranges cover the letter with its marks', () => {
    const text = 'Thuốc chữa khỏi bệnh'.normalize('NFD');
    const [m] = findBannedWords(text, [word('chữa khỏi')]);
    expect(m).toBeDefined();
    expect(text.slice(m?.start, m?.end).normalize('NFC')).toBe('chữa khỏi');
  });

  it('matches a phrase typed decomposed against text typed precomposed', () => {
    expect(found('Thuốc chữa khỏi bệnh', 'chữa khỏi'.normalize('NFD'))).toEqual(['chữa khỏi']);
  });
});

describe('findBannedWords: diacritics', () => {
  it('matches the text without diacritics', () => {
    expect(found('thuoc nay chua khoi benh', 'chữa khỏi')).toEqual(['chua khoi']);
    expect(found('Thuoc CHUA KHOI benh', 'chữa khỏi')).toEqual(['CHUA KHOI']);
  });

  it('matches a phrase listed without diacritics in text with them', () => {
    expect(found('Thuốc chữa khỏi bệnh', 'chua khoi')).toEqual(['chữa khỏi']);
  });

  it('matches text with some diacritics left out', () => {
    expect(found('thuốc chữa khoi bệnh', 'chữa khỏi')).toEqual(['chữa khoi']);
  });

  it('does not match other diacritics on the same letters', () => {
    // "chưa khỏi" (not yet cured) is not "chữa khỏi" (cures).
    expect(found('Bệnh chưa khỏi hẳn', 'chữa khỏi')).toEqual([]);
    expect(found('Đi chùa', 'chua')).toEqual(['chùa']);
    expect(found('Đi chùa', 'chưa')).toEqual([]);
  });

  it('treats đ as d', () => {
    expect(found('hang dau thi truong', 'hàng đầu')).toEqual(['hang dau']);
    expect(found('HÀNG ĐẦU', 'hang dau')).toEqual(['HÀNG ĐẦU']);
    expect(found('Đảm bảo', 'dam bao')).toEqual(['Đảm bảo']);
  });
});

describe('findBannedWords: word boundaries', () => {
  it('matches whole words only', () => {
    expect(found('Hàng số 1 Việt Nam', 'số 1')).toEqual(['số 1']);
    expect(found('Gọi số 10 để đặt', 'số 1')).toEqual([]);
    expect(found('cured, uncured', 'cure')).toEqual([]);
    expect(found('the cure.', 'cure')).toEqual(['cure']);
  });

  it('counts letters of any script and digits as word characters', () => {
    expect(found('ทดสอบคำ', 'คำ')).toEqual([]);
    expect(found('ทดสอบ คำ', 'คำ')).toEqual(['คำ']);
    expect(found('số 12', 'số 1')).toEqual([]);
  });

  it('a phrase that starts or ends with a symbol needs no boundary there', () => {
    expect(found('giảm 100%!', '100%')).toEqual(['100%']);
    expect(found('rẻ nhất#ad', '#ad')).toEqual(['#ad']);
  });

  it('a space in the phrase matches any white space', () => {
    expect(found('tốt\n\tnhất', 'tốt nhất')).toEqual(['tốt\n\tnhất']);
    expect(found('tốtnhất', 'tốt nhất')).toEqual([]);
  });

  it('format characters inside a match do not hide it, nor make a boundary', () => {
    expect(found('tố​t nhất', 'tốt nhất')).toEqual(['tố​t nhất']);
    expect(found('t­ốt nhất', 'tốt nhất')).toEqual(['t­ốt nhất']);
    expect(found('a​cure', 'cure')).toEqual([]);
  });
});

describe('findBannedWords: emoji', () => {
  it('emoji are not letters: they bound a word, and ranges never split them', () => {
    const text = '🔥tốt nhất🔥 👍🏽';
    const [m] = findBannedWords(text, [word('tốt nhất')]);
    expect(text.slice(m?.start, m?.end)).toBe('tốt nhất');
    expect(m?.start).toBe(2);
  });

  it('matches a phrase with an emoji in it', () => {
    expect(found('Chỉ hôm nay 🔥 giảm giá', '🔥 giảm')).toEqual(['🔥 giảm']);
    expect(found('a 👍🏽 b', '👍🏽')).toEqual(['👍🏽']);
  });

  it('keeps offsets right after astral characters and ZWJ sequences', () => {
    const text = '👨‍👩‍👧 mua ngay, MUA NGAY';
    const ranges = findBannedWords(text, [word('mua ngay')]).map((m) => [m.start, m.end]);
    expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(['mua ngay', 'MUA NGAY']);
  });
});

describe('findBannedWords: results', () => {
  it('reports every match with its word, level and reason, in order', () => {
    const w = word('tốt nhất', { level: 'warn', reason: 'Luật quảng cáo' });
    const list = findBannedWords('tốt nhất và tot nhat', [w]);
    expect(list).toEqual([
      { wordId: w.id, phrase: 'tốt nhất', level: 'warn', reason: 'Luật quảng cáo', start: 0, end: 8 },
      { wordId: w.id, phrase: 'tốt nhất', level: 'warn', reason: 'Luật quảng cáo', start: 12, end: 20 },
    ]);
  });

  it('reports overlapping words, the longer first', () => {
    expect(found('loại tốt nhất', 'tốt', 'tốt nhất')).toEqual(['tốt nhất', 'tốt']);
  });

  it('finds nothing without words, in empty text, or for a phrase of format characters only', () => {
    expect(findBannedWords('tốt nhất', [])).toEqual([]);
    expect(findBannedWords('', [word('a')])).toEqual([]);
    expect(findBannedWords('a​b', [word('​')])).toEqual([]);
  });

  it('a compiled matcher gives the same answer', () => {
    const words = [word('tốt nhất'), word('số 1')];
    const text = 'Số 1 và tốt nhất';
    expect(findBannedWords(text, compileBannedWords(words))).toEqual(findBannedWords(text, words));
  });

  it('ranges are inside the text and on code point boundaries, whatever the text', () => {
    const words = [word('ab'), word('á b'), word('đ'), word('😀')];
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'á', 'á', ' ', 'đ', 'D', '😀', '​', 'x', '1', '.'), { maxLength: 30 }), (parts) => {
        const text = parts.join('');
        for (const m of findBannedWords(text, words)) {
          expect(m.start).toBeGreaterThanOrEqual(0);
          expect(m.end).toBeLessThanOrEqual(text.length);
          expect(m.end).toBeGreaterThan(m.start);
          for (const at of [m.start, m.end]) {
            const code = text.charCodeAt(at);
            expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
          }
        }
      }),
    );
  });
});

describe('channel scope', () => {
  const all = word('a');
  const one = word('b', { connectionIds: ['c1'] });
  const two = word('c', { connectionIds: ['c2', 'c3'] });
  it('a word with no channels applies to every channel; one with channels only to those', () => {
    expect(wordsForChannel([all, one, two], 'c1')).toEqual([all, one]);
    expect(wordsForChannel([all, one, two], 'c3')).toEqual([all, two]);
    expect(wordsForChannel([all, one, two], 'c9')).toEqual([all]);
  });
  it('the shared text takes the words of any of the post channels, or all without channels', () => {
    expect(wordsForChannels([all, one, two], ['c1', 'c2'])).toEqual([all, one, two]);
    expect(wordsForChannels([all, one, two], ['c9'])).toEqual([all]);
    expect(wordsForChannels([all, one, two], [])).toEqual([all, one, two]);
  });
});

describe('variantTexts', () => {
  it('checks the text, title, first comment, thread parts, auto-reply and poll options', () => {
    const texts = variantTexts(
      { body: 'thân', title: 'tiêu đề' },
      { firstComment: 'bình luận', threadParts: ['phần 2', 3], autoReply: { text: 'cảm ơn', likes: 5 }, poll: { options: ['có', 'không'] }, privacy: 'PUBLIC' },
    );
    expect(texts).toEqual([
      { field: 'body', text: 'thân' },
      { field: 'title', text: 'tiêu đề' },
      { field: 'settings.firstComment', text: 'bình luận' },
      { field: 'settings.threadParts.0', text: 'phần 2' },
      { field: 'settings.autoReply.text', text: 'cảm ơn' },
      { field: 'settings.poll.0', text: 'có' },
      { field: 'settings.poll.1', text: 'không' },
    ]);
    expect(variantTexts({ body: '', title: null }, undefined)).toEqual([{ field: 'body', text: '' }]);
  });

  it('names the field of each match', () => {
    const w = word('mua ngay');
    const list = findBannedInTexts(variantTexts({ body: 'ok', title: null }, { firstComment: 'Mua ngay!' }), [w]);
    expect(list).toEqual([{ wordId: w.id, phrase: 'mua ngay', level: 'block', reason: null, start: 0, end: 8, field: 'settings.firstComment' }]);
  });
});
