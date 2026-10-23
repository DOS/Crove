// Banned and sensitive words (#1055): case, NFC and diacritics, word boundaries, emoji, the ranges, channel scope and
// the texts of a variant that are checked.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BANNED_COMMAND_OPS_MAX, BANNED_COMMAND_PREPARE_MAX, BANNED_OPS_MAX, BANNED_PREPARE_MAX, BannedWordsTooComplex, MATCH_STEPS, bannedBudget, compileBannedWords, findBannedInTexts, findBannedWords, normalizePhrase, prepareBannedText, variantTexts, wordsForChannel, wordsForChannels, type BannedBudget, type BannedWord } from '../src/domain/banned-words.ts';
import { bannedChecker, bannedCommandBudget, isBlocked } from '../src/banned-words.ts';

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
    const text = '👨‍👩‍👧 mua ngay, 🇻🇳 GIẢM GIÁ';
    const ranges = findBannedWords(text, [word('mua ngay'), word('giảm giá')]).map((m) => [m.start, m.end]);
    expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(['mua ngay', 'GIẢM GIÁ']);
  });
});

describe('findBannedWords: results', () => {
  it('reports each word once, at its first place, with its level and reason, in order', () => {
    const w = word('tốt nhất', { level: 'warn', reason: 'Luật quảng cáo' });
    const v = word('số 1');
    const list = findBannedWords('Số 1 hay tốt nhất và tot nhat, số 1', [w, v]);
    expect(list).toEqual([
      { wordId: v.id, phrase: 'số 1', level: 'block', reason: null, start: 0, end: 4 },
      { wordId: w.id, phrase: 'tốt nhất', level: 'warn', reason: 'Luật quảng cáo', start: 9, end: 17 },
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
  it('checks the text, title, first comment, thread parts, auto-reply, poll options and a LinkedIn poll question', () => {
    const texts = variantTexts(
      { body: 'thân', title: 'tiêu đề' },
      { firstComment: 'bình luận', threadParts: ['phần 2', 3], autoReply: { text: 'cảm ơn', likes: 5 }, poll: { options: ['có', 'không'], question: 'Món nào?' }, privacy: 'PUBLIC' },
    );
    expect(texts).toEqual([
      { field: 'body', text: 'thân' },
      { field: 'title', text: 'tiêu đề' },
      { field: 'settings.firstComment', text: 'bình luận' },
      { field: 'settings.threadParts.0', text: 'phần 2' },
      { field: 'settings.autoReply.text', text: 'cảm ơn' },
      { field: 'settings.poll.0', text: 'có' },
      { field: 'settings.poll.1', text: 'không' },
      { field: 'settings.poll.question', text: 'Món nào?' },
    ]);
    expect(variantTexts({ body: '', title: null }, undefined)).toEqual([{ field: 'body', text: '' }]);
  });

  it('checks YouTube tags, the WordPress excerpt, tags and categories, and Telegram button labels', () => {
    const texts = variantTexts(
      { body: 'thân', title: null },
      {
        tags: ['thẻ một', 7],
        wordpress: { excerpt: 'tóm tắt', tags: ['tag a'], categories: ['mục', null], status: 'draft' },
        telegram: { silent: true, buttons: [[{ text: 'Mua ngay', url: 'https://shop.example/' }, { url: 'https://x.example/' }], 'bad'] },
      },
    );
    expect(texts.slice(1)).toEqual([
      { field: 'settings.tags.0', text: 'thẻ một' },
      { field: 'settings.wordpress.excerpt', text: 'tóm tắt' },
      { field: 'settings.wordpress.tags.0', text: 'tag a' },
      { field: 'settings.wordpress.categories.0', text: 'mục' },
      { field: 'settings.telegram.buttons.0.0.text', text: 'Mua ngay' },
    ]);
    // Wrong shapes add nothing.
    expect(variantTexts({ body: 'x', title: null }, { wordpress: ['a'], telegram: { buttons: 'no' }, tags: 'no' })).toEqual([{ field: 'body', text: 'x' }]);
  });

  it('names the field of each match', () => {
    const w = word('mua ngay');
    const list = findBannedInTexts(variantTexts({ body: 'ok', title: null }, { firstComment: 'Mua ngay!' }), [w]);
    expect(list).toEqual([{ wordId: w.id, phrase: 'mua ngay', level: 'block', reason: null, start: 0, end: 8, field: 'settings.firstComment' }]);
  });
});

describe('cost (#1055 security review)', () => {
  // Distinct two-letter endings for up to 500 words.
  const endings = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(98 + (i % 25)) + String.fromCharCode(98 + Math.floor(i / 25)));
  // Runs a scan with its own budget: the steps it spent, whether it gave up at the budget, and how long it took.
  const run = (fn: (budget: BannedBudget) => unknown, ops: number = BANNED_OPS_MAX): { spent: number; gaveUp: boolean; ms: number } => {
    const budget = bannedBudget(ops);
    const t0 = performance.now();
    let gaveUp = false;
    try {
      fn(budget);
    } catch (error) {
      if (!(error instanceof BannedWordsTooComplex)) throw error;
      gaveUp = true;
    }
    return { spent: ops - budget.left, gaveUp, ms: performance.now() - t0 };
  };
  // Timing is only a loose guard on shared runners; the steps are what is asserted.
  const LOOSE_MS = 2_000;

  it('500 words sharing a 98-letter prefix against a 100k text: one walk at the only word boundary', () => {
    const words = endings(500).map((e) => word(`${'a'.repeat(98)}${e}`));
    const r = run((b) => findBannedWords('a'.repeat(100_000), words, b));
    expect(r.gaveUp).toBe(false);
    // One walk of the prefix, at the only word boundary.
    expect(r.spent).toBeLessThan(1_000);
    expect(r.ms).toBeLessThan(LOOSE_MS);
  });

  it('500 spaced phrases of 100 characters against 100k of spaced letters: stops at the budget', () => {
    const words = endings(500).map((e) => word(`${'a '.repeat(49)}${e}`));
    const r = run((b) => findBannedWords('a '.repeat(50_000), words, b));
    expect(r.gaveUp).toBe(true);
    expect(r.spent).toBeLessThanOrEqual(BANNED_OPS_MAX + 100);
    expect(r.ms).toBeLessThan(LOOSE_MS);
  });

  it('500 phrases of symbols, which need no word boundary, against 100k of the same symbol: stops at the budget', () => {
    const words = endings(500).map((e) => word(`${'.'.repeat(98)}${e}`));
    const r = run((b) => findBannedWords('.'.repeat(100_000), words, b));
    expect(r.gaveUp).toBe(true);
    expect(r.ms).toBeLessThan(LOOSE_MS);
  });

  it('500 words with the same letters and other marks than the text: the mark checks stop at the budget', () => {
    // Each word is "à à ... à" with one letter marked otherwise at its own place: every one matches the text by its
    // letters, has its marks checked at every place, and never matches.
    const marks = ['á', 'ả', 'ã', 'ạ', 'â', 'ấ', 'ầ', 'ẩ', 'ẫ', 'ậ'];
    const words = Array.from({ length: 500 }, (_, i) => {
      const letters = Array.from({ length: 50 }, () => 'à');
      letters[i % 50] = marks[Math.floor(i / 50)] as string;
      return word(letters.join(' '));
    });
    const r = run((b) => findBannedWords('à '.repeat(50_000), words, b));
    expect(r.gaveUp).toBe(true);
    expect(r.ms).toBeLessThan(LOOSE_MS);
  });

  it('a text holding every word many times reports each word once, and stops looking when all are found', () => {
    const words = Array.from({ length: 500 }, (_, i) => word(String.fromCodePoint(0x4e00 + i)));
    const text = Array.from({ length: 50_000 }, (_, i) => String.fromCodePoint(0x4e00 + (i % 500))).join(' ');
    let found = 0;
    const r = run((b) => (found = findBannedWords(text, words, b).length));
    expect(r.gaveUp).toBe(false);
    expect(found).toBe(500);
    // The first 500 places at most a few steps each and one report per word, then nothing.
    expect(r.spent).toBeLessThan(500 * (MATCH_STEPS + 10));
  });

  it('a budget is shared by every text checked with it and refuses past it', () => {
    // A second word the text never holds, so the scan goes on to the end.
    const words = [word('ab'), word('zz')];
    const budget = bannedBudget(1_000);
    findBannedWords('ab '.repeat(100), words, budget);
    expect(() => findBannedWords('ab '.repeat(1_000), words, budget)).toThrow(BannedWordsTooComplex);
  });

  it('preparing text has its own cap in characters, apart from the scan steps', () => {
    const words = [word('ab')];
    const budget = bannedBudget(BANNED_OPS_MAX, 1_000);
    findBannedWords('x'.repeat(900), words, budget);
    // The scan itself took a step or two: only the start of the text is a word boundary.
    expect(budget.left).toBeGreaterThan(BANNED_OPS_MAX - 10);
    expect(budget.prepareLeft).toBe(100);
    expect(() => findBannedWords('x'.repeat(200), words, budget)).toThrow(BannedWordsTooComplex);
    // What one valid post may hold: its text, and on each of its 20 channels its own text, title and settings.
    expect(BANNED_PREPARE_MAX).toBe(100_500 + 20 * (100_500 + 16_384));
  });

  it('a prepared text gives the same matches as the plain one', () => {
    const words = [word('tốt nhất'), word('số 1')];
    const text = 'Số 1 và tot nhat, tốt\u200B nhất';
    expect(findBannedWords(prepareBannedText(text), words)).toEqual(findBannedWords(text, words));
    expect(findBannedWords(text, words).map((m) => text.slice(m.start, m.end))).toEqual(['Số 1', 'tot nhat']);
  });
});

describe('bannedChecker', () => {
  const post = (body: string) => ({ body, title: null, linkUrl: null, media: [] });
  const variant = (connection: string, over: Record<string, unknown> = {}) =>
    ({ channel_connection_id: connection, body: null, title: null, link_url: null, settings: {}, content_frozen: false, ...over }) as never;
  // 500 short phrases that start with a marked a (á, áb, ább, ...), which the texts below meet at nearly every word.
  const oneLetters = () => Array.from({ length: 500 }, (_, i) => word(`${['á', 'à', 'ả', 'ã', 'ạ'][i % 5]}${'b'.repeat(Math.floor(i / 5))}`.slice(0, 1 + Math.floor(i / 5)), { level: 'warn' }));

  it('checks each channel with its words and scans a shared text once per word set', () => {
    const scoped = word('tốt nhất', { connectionIds: ['c1'] });
    const budget = bannedBudget(10_000);
    const check = bannedChecker([scoped], budget);
    expect(check(post('Sản phẩm tốt nhất'), variant('c1')).map((m) => m.field)).toEqual(['body']);
    const after = budget.left;
    expect(check(post('Sản phẩm tốt nhất'), variant('c1'))).toHaveLength(1);
    // The same text against the same words again costs nothing.
    expect(budget.left).toBe(after);
    expect(check(post('Sản phẩm tốt nhất'), variant('c2'))).toEqual([]);
  });

  it('one word and two channels with their own text of 100,000 characters: checked, not refused', () => {
    const check = bannedChecker([word('tốt nhất')]);
    const base = post('Bài chung');
    const own = (n: number) => `${'Khai trương cửa hàng mới, ưu đãi lớn. '.repeat(3_000)}${n}`.slice(-100_000);
    const a = variant('c1', { body: own(1) });
    const b = variant('c2', { body: own(2) });
    expect(isBlocked(check, base, a)).toBe(false);
    expect(isBlocked(check, base, b)).toBe(false);
    expect(check(base, variant('c3', { body: `${own(3).slice(0, 99_990)} tốt nhất` })).map((m) => m.phrase)).toEqual(['tốt nhất']);
  });

  it('500 words, a 100,000-character text and 16 KiB of settings texts: checked, not refused', () => {
    const words = Array.from({ length: 500 }, (_, i) => word(`từ cấm ${i}`, { level: 'warn' }));
    const check = bannedChecker(words);
    const body = `${'Chương trình khuyến mãi tháng mười, áp dụng cho mọi chi nhánh. '.repeat(2_000)}`.slice(0, 100_000);
    const settings = { firstComment: 'Bình luận đầu tiên. '.repeat(400), threadParts: ['Phần hai. '.repeat(300), 'từ cấm 7'] };
    const found = check(post(body), variant('c1', { settings }));
    expect(found.map((m) => [m.phrase, m.field])).toEqual([['từ cấm 7', 'settings.threadParts.1']]);
  });
  it('a check over its budget counts as blocked', () => {
    const check = bannedChecker([word('zzz', { level: 'warn' })], bannedBudget(1));
    expect(isBlocked(check, post('Sản phẩm tốt nhất'), variant('c1'))).toBe(true);
    expect(isBlocked(bannedChecker([word('zzz', { level: 'warn' })]), post('Sản phẩm tốt nhất'), variant('c1'))).toBe(false);
  });

  it('an import of 200 rows of 5 KB shares one budget: past it the rows are held back, not each given a budget of its own', () => {
    const budget = bannedCommandBudget();
    // As the import does: one checker for the command, on its budget; each row's text differs.
    const check = bannedChecker(oneLetters(), budget);
    let held = 0;
    for (let row = 0; row < 200; row += 1) {
      const body = `${row} ${'á à ả ã ạ bản tin '.repeat(270)}`.slice(0, 5_000);
      if (isBlocked(check, post(body), variant('c1'))) held += 1;
    }
    // 200 x 5,000 characters are twice the text the command may prepare: the second half is held back at once.
    expect(budget.prepareLeft < 0 || budget.left < 0).toBe(true);
    expect(held).toBeGreaterThan(90);
    expect(BANNED_COMMAND_PREPARE_MAX).toBe(500_000);
    expect(BANNED_COMMAND_OPS_MAX).toBe(2 * BANNED_OPS_MAX);
  });

  it("a policy change over many posts shares one budget: the posts past it stay in review", () => {
    const budget = bannedCommandBudget();
    const check = bannedChecker(oneLetters(), budget);
    const outcome: boolean[] = [];
    for (let p = 0; p < 1_000; p += 1) {
      outcome.push(isBlocked(check, post(`Bài ${p}: ${'chào mừng khai trương '.repeat(40)}`), variant('c1')));
    }
    const firstHeld = outcome.indexOf(true);
    // The words are warnings: only the budget holds posts back, and from the first one held on, every later one is.
    expect(firstHeld).toBeGreaterThan(0);
    expect(outcome.slice(firstHeld).every(Boolean)).toBe(true);
    expect(budget.prepareLeft < 0 || budget.left < 0).toBe(true);
  });
});
