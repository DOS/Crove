// A long text split into a thread (#1222): where it cuts (blank lines, then sentence ends, then words, a word only as a
// last resort), the room for the first post's signature and link and for " 1/n", the text left over past the last
// post, and the reverse. Properties: the text comes back from the posts up to the white space at the cuts, every post
// passes validateVariant, no link, hashtag, mention, emoji or styled run is ever cut, and X's weighted limit holds
// with Vietnamese text.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countText, isFoldable, joinThread, splitThread, styleText, styleTokens, THREAD_PARTS_MAX, THREAD_RULES, validateVariant, type Provider, type ThreadSplit } from '../src/contract.ts';

const SIGNATURE = 'Hotline 0901 234 567\n#TiemBanhAnNhien';
const sentence = (i: number) => `Câu thứ ${i} kể về bánh mì nóng giòn của tiệm, ăn kèm pa tê và rau thơm.`;
const paragraph = (from: number, count: number) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

function split(provider: Provider, text: string, options: Parameters<typeof splitThread>[2] = {}): ThreadSplit {
  const result = splitThread(provider, text, options);
  if (!result) throw new Error(`no thread on ${provider}`);
  return result;
}

// The variant the split fills in: the first post as its text, the others as its thread parts.
function issuesOf(provider: Provider, result: ThreadSplit, settings: Record<string, unknown> = {}, linkUrl: string | null = null) {
  const [body = '', ...parts] = result.posts;
  return validateVariant({ provider, body, title: null, linkUrl, media: [], settings: parts.length > 0 ? { ...settings, threadParts: parts } : settings });
}

describe('splitThread', () => {
  it('takes no thread on a channel without thread parts', () => {
    expect(splitThread('facebook_page', 'a'.repeat(70_000))).toBeNull();
    expect(splitThread('instagram', 'Bài dài')).toBeNull();
  });

  it('leaves a text that fits as one post', () => {
    const result = split('x', '  Bánh mì nóng giòn.  ');
    expect(result.posts).toEqual(['Bánh mì nóng giòn.']);
    expect(result.leftover).toBe('');
    expect(split('x', '').posts).toEqual([]);
  });

  it('cuts at the blank line between paragraphs before a sentence end', () => {
    const first = paragraph(1, 2);
    const second = paragraph(3, 3);
    const result = split('x', `${first}\n\n${second}`);
    expect(result.posts[0]).toBe(first);
    expect(result.posts.slice(1).join(' ')).toBe(second);
    expect(issuesOf('x', result)).toEqual([]);
  });

  it('cuts at a sentence end rather than between words', () => {
    const text = paragraph(1, 8);
    const result = split('threads', text);
    expect(result.posts.length).toBeGreaterThan(1);
    for (const post of result.posts) expect(post).toMatch(/\.$/);
    expect(issuesOf('threads', result)).toEqual([]);
  });

  it('keeps a short heading with what follows it', () => {
    const text = `Tin vui!\n\n${paragraph(1, 6)}`;
    const result = split('x', text);
    expect(result.posts[0]?.startsWith('Tin vui!\n\nCâu thứ 1')).toBe(true);
  });

  it("makes room in the first post for the signature and the appended link, which the parts don't carry", () => {
    const settings = { signature: SIGNATURE };
    const link = 'https://tiembanh.vn/thuc-don';
    const text = paragraph(1, 6);
    const result = split('x', text, { settings, linkUrl: link });
    expect(result.sent[0]?.endsWith(`${SIGNATURE}\n\n${link}`)).toBe(true);
    expect(countText(result.sent[0] as string, 'weighted')).toBeLessThanOrEqual(280);
    for (const post of result.posts.slice(1)) {
      expect(post).not.toContain('Hotline');
      expect(post).not.toContain(link);
    }
    expect(issuesOf('x', result, settings, link)).toEqual([]);
    // Without them the first post takes more of the text.
    expect((split('x', text).posts[0] as string).length).toBeGreaterThan((result.posts[0] as string).length);
  });

  it('splits a text that already ends with the signature as if it did not, so it goes out once', () => {
    const settings = { signature: SIGNATURE };
    const text = `${paragraph(1, 6)}\n\n${SIGNATURE}`;
    const result = split('x', text, { settings });
    expect(result.posts.join('\n')).not.toContain('Hotline');
    expect(result.sent[0]).toContain('Hotline');
    expect(issuesOf('x', result, settings)).toEqual([]);
  });

  it('numbers the posts " 1/n" and counts the room for it', () => {
    const result = split('x', paragraph(1, 9), { numbered: true });
    const n = result.posts.length;
    expect(n).toBeGreaterThan(2);
    result.posts.forEach((post, i) => {
      expect(post.endsWith(` ${i + 1}/${n}`)).toBe(true);
      expect(countText(post, 'weighted')).toBeLessThanOrEqual(280);
    });
    expect(issuesOf('x', result)).toEqual([]);
    // One post alone takes no number.
    expect(split('x', 'Ngắn thôi.', { numbered: true }).posts).toEqual(['Ngắn thôi.']);
  });

  it('cuts a word longer than a post at a grapheme boundary, and never inside a link in it', () => {
    // X counts the link 23 and every ế 2: 423 in all.
    const word = `${'ế'.repeat(200)}https://tiembanh.vn/${'a'.repeat(30)}`;
    const result = split('x', word);
    expect(result.posts.join('')).toBe(word);
    expect(result.posts.length).toBeGreaterThan(1);
    const link = word.indexOf('https://');
    const linkEnd = word.length;
    for (const [a] of result.ranges) expect(a <= link || a >= linkEnd).toBe(true);
    expect(issuesOf('x', result)).toEqual([]);
  });

  it('never cuts a letter from its marks or an emoji sequence', () => {
    const family = '👨‍👩‍👧‍👦';
    const word = `${'ệ'.normalize('NFD').repeat(150)}${family.repeat(80)}`;
    const result = split('bluesky', word);
    expect(result.posts.join('')).toBe(word);
    for (const post of result.posts) {
      expect(post.normalize('NFD').startsWith('̣') || post.startsWith('‍')).toBe(false);
      expect(countText(post, 'graphemes')).toBeLessThanOrEqual(300);
    }
    expect(issuesOf('bluesky', result)).toEqual([]);
  });

  it('keeps a run of styled letters whole', () => {
    const styled = styleText('KHUYENMAI', 'bold');
    const word = `${'a'.repeat(270)}${styled}${'b'.repeat(40)}`;
    const result = split('x', word);
    expect(result.posts.join('')).toBe(word);
    expect(result.posts.some((p) => p.includes(styled))).toBe(true);
  });

  it('stops at 1 + THREAD_PARTS_MAX posts and says what is left over, dropping nothing', () => {
    const text = paragraph(1, 60);
    const result = split('x', text);
    expect(result.posts).toHaveLength(1 + THREAD_PARTS_MAX);
    expect(result.leftover.length).toBeGreaterThan(0);
    expect(result.leftoverCount).toBe(countText(result.leftover, 'weighted'));
    expect(text.endsWith(result.leftover)).toBe(true);
    expect(`${result.posts.join(' ')} ${result.leftover}`).toBe(text);
    // With more room, nothing is left.
    expect(split('x', text, { maxPosts: 40 }).leftover).toBe('');
  });

  it("counts Bluesky's bytes besides its graphemes", () => {
    // 300 graphemes of 4-byte emoji are 1,200 bytes; 1,000 of them need more than 3,000 bytes in all.
    const text = Array.from({ length: 1000 }, () => '😀').join(' ');
    const result = split('bluesky', text);
    for (const post of result.posts) {
      expect(countText(post, 'graphemes')).toBeLessThanOrEqual(300);
      expect(countText(post, 'bytes')).toBeLessThanOrEqual(3000);
    }
    expect(issuesOf('bluesky', result)).toEqual([]);
  });
});

describe('joinThread', () => {
  it('puts the posts back with a blank line between them, numbers off', () => {
    expect(joinThread(['Một. 1/3', 'Hai. 2/3', 'Ba. 3/3'])).toBe('Một.\n\nHai.\n\nBa.');
    // Numbers that are not the thread's own stay.
    expect(joinThread(['Giảm 1/2 giá', 'Chỉ hôm nay'])).toBe('Giảm 1/2 giá\n\nChỉ hôm nay');
    expect(joinThread(['Một', '  ', 'Hai'])).toBe('Một\n\nHai');
  });

  it('reverses a split up to the white space at the cuts', () => {
    const text = `${paragraph(1, 3)}\n\n${paragraph(4, 5)}`;
    const result = split('x', text, { numbered: true });
    expect(joinThread(result.posts).replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });
});

// Texts of Vietnamese words with tone marks (NFC and NFD), English words, emoji, hashtags, mentions, links, styled words
// and the odd long word, joined by spaces, sentence ends, line breaks and blank lines.
const word = fc.oneof(
  { weight: 10, arbitrary: fc.constantFrom('bánh', 'mì', 'nóng', 'giòn', 'Phở', 'bò', 'tái', 'chín', 'người', 'được', 'khuyến', 'mãi', 'Đà', 'Lạt', 'ưu', 'đãi', 'sale', 'today', 'TP.HCM', '100%', '1.200.000đ') },
  { weight: 2, arbitrary: fc.constantFrom('mừng'.normalize('NFD'), 'Hồ Gươm'.normalize('NFD'), 'tiệm'.normalize('NFD')) },
  { weight: 2, arbitrary: fc.constantFrom('😀', '👍🏽', '👨‍👩‍👧', '🇻🇳', '1️⃣', '❤️') },
  { weight: 2, arbitrary: fc.constantFrom('#BánhMì', '#sale2024', '@tiembanh', '@an.nhien_vn') },
  { weight: 1, arbitrary: fc.constantFrom('https://tiembanh.vn/thuc-don?ngay=hom-nay', 'crove.vn/gia', 'www.example.com/a/b', 'hi@tiembanh.vn') },
  { weight: 1, arbitrary: fc.constantFrom('khuyến mãi', 'SALE', 'Đặc sản').map((w) => styleText(w, 'bold')) },
  { weight: 1, arbitrary: fc.integer({ min: 40, max: 400 }).map((n) => 'ạ'.repeat(n)) },
);
const separator = fc.oneof({ weight: 12, arbitrary: fc.constant(' ') }, { weight: 3, arbitrary: fc.constantFrom('. ', '! ', '? ') }, { weight: 2, arbitrary: fc.constant('\n') }, { weight: 2, arbitrary: fc.constant('\n\n') });
const longText = fc.array(fc.tuple(word, separator), { minLength: 1, maxLength: 260 }).map((pairs) => pairs.map(([w, s]) => w + s).join(''));
const threadProvider = fc.constantFrom<Provider>('x', 'threads', 'bluesky', 'sandbox');
const settingsArb = fc.constantFrom<Record<string, unknown>>({}, { signature: SIGNATURE }, { signature: false }, { utm: { campaign: 'tet', medium: 'social' } });
const linkArb = fc.constantFrom<string | null>(null, 'https://tiembanh.vn/khuyen-mai');

// Every cut: where a post ends and the next one starts.
const cutsOf = (result: ThreadSplit) => result.ranges.flatMap(([a, b]) => [a, b]);

describe('splitThread properties', () => {
  it('gives the text back from the posts, up to the white space at the cuts', () => {
    fc.assert(
      fc.property(threadProvider, longText, settingsArb, linkArb, fc.boolean(), (provider, text, settings, linkUrl, numbered) => {
        const result = split(provider, text, { settings, linkUrl, numbered });
        const { source, ranges, posts } = result;
        let at = 0;
        ranges.forEach(([a, b], i) => {
          expect(source.slice(at, a).trim()).toBe('');
          const n = posts.length;
          expect(posts[i]).toBe(source.slice(a, b) + (numbered && n > 1 ? ` ${i + 1}/${n}` : ''));
          at = b;
        });
        const rest = source.slice(at);
        expect(rest.trim()).toBe(result.leftover);
      }),
      { numRuns: 150 },
    );
  });

  it('makes posts that each pass validateVariant, unless text is left over', () => {
    fc.assert(
      fc.property(threadProvider, longText, settingsArb, linkArb, fc.boolean(), (provider, text, settings, linkUrl, numbered) => {
        const result = split(provider, text, { settings, linkUrl, numbered });
        if (result.leftover !== '' || result.posts.length === 0) return;
        expect(issuesOf(provider, result, settings, linkUrl)).toEqual([]);
        expect(result.posts.length).toBeLessThanOrEqual(1 + THREAD_PARTS_MAX);
      }),
      { numRuns: 150 },
    );
  });

  it('never cuts inside a link, hashtag, mention, emoji or run of styled letters', () => {
    fc.assert(
      fc.property(threadProvider, longText, fc.boolean(), (provider, text, numbered) => {
        const result = split(provider, text, { numbered });
        const tokens = styleTokens(result.source);
        for (const cut of cutsOf(result)) {
          for (const [a, b] of tokens) expect(a < cut && cut < b).toBe(false);
          const before = result.source.codePointAt(cut - 2);
          const after = result.source.codePointAt(cut);
          // A styled letter is one code point above U+FFFF, two UTF-16 units.
          if (before !== undefined && after !== undefined && isFoldable(before)) expect(isFoldable(after)).toBe(false);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("holds X's weighted limit with Vietnamese text", () => {
    const vietnamese = fc
      .array(fc.tuple(fc.constantFrom('Ưu', 'đãi', 'cuối', 'tuần', 'giảm', 'giá', 'bánh', 'kem', 'trứng', 'muối', 'nướng', 'thơm', 'phức', 'mời', 'người', 'thưởng', 'thức'), separator), { minLength: 80, maxLength: 300 })
      .map((pairs) => pairs.map(([w, s]) => w + s).join(''));
    fc.assert(
      fc.property(vietnamese, settingsArb, fc.boolean(), (text, settings, numbered) => {
        const result = split('x', text, { settings, numbered });
        expect(countText(result.sent[0] as string, 'weighted')).toBeLessThanOrEqual(280);
        for (const post of result.posts.slice(1)) expect(countText(post, 'weighted')).toBeLessThanOrEqual(THREAD_RULES.x?.max as number);
        // Weighted: the same text is far over 280 counted in characters, which a plain count would let through.
        if (result.leftover === '') expect(issuesOf('x', result, settings)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
