// Suggested edits (#1236): where a suggestion's words still apply in a text that changed, the text with them
// replaced, the words around them, and the frozen and whole-character rules the commands use.
import { describe, expect, it } from 'vitest';
import { SUGGESTION_CONTEXT, channelFrozen, contextOf, locateSuggestion, postFrozen, replaceRange, textHash, wholeCharacters } from '../src/domain/suggestion.ts';

const range = (text: string, quote: string) => {
  const start = text.indexOf(quote);
  return { start, end: start + quote.length, quote };
};

describe('locateSuggestion', () => {
  const text = 'Khai trương cửa hàng mới ở Quận 1, giảm 20% cả tuần.';

  it('applies where the words were while they are still there', () => {
    const s = range(text, 'giảm 20%');
    expect(locateSuggestion(text, s)).toEqual({ start: s.start, end: s.end });
  });

  it('follows the words when an edit before them moved them, if they are there once', () => {
    const s = range(text, 'giảm 20%');
    const moved = `Tin vui! ${text}`;
    expect(locateSuggestion(moved, s)).toEqual({ start: s.start + 'Tin vui! '.length, end: s.end + 'Tin vui! '.length });
  });

  it('is outdated when the words are gone or could be in two places', () => {
    const s = range(text, 'giảm 20%');
    expect(locateSuggestion(text.replace('giảm 20%', 'giảm 30%'), s)).toBeNull();
    expect(locateSuggestion(`Tin vui: giảm 20%! ${text}`, s)).toBeNull();
  });

  it('refuses a range that does not hold the quote', () => {
    expect(locateSuggestion(text, { start: 0, end: 4, quote: 'Khai trương' })).toBeNull();
    expect(locateSuggestion(text, { start: 0, end: 0, quote: '' })).toBeNull();
  });

  it('counts emoji as the browser does (UTF-16 code units)', () => {
    const emoji = '🎉 Khai trương 🎉 hôm nay';
    const s = range(emoji, 'hôm nay');
    expect(s.start).toBe(18);
    expect(locateSuggestion(emoji, s)).toEqual({ start: 18, end: 25 });
    expect(replaceRange(emoji, { start: s.start, end: s.end }, 'ngày mai')).toBe('🎉 Khai trương 🎉 ngày mai');
  });
});

describe('replaceRange and contextOf', () => {
  it('replaces the range and deletes it with an empty suggestion', () => {
    expect(replaceRange('một hai ba', { start: 4, end: 7 }, 'bốn')).toBe('một bốn ba');
    expect(replaceRange('một hai ba', { start: 3, end: 7 }, '')).toBe('một ba');
  });

  it('shows at most SUGGESTION_CONTEXT whole characters on each side', () => {
    const long = `${'a'.repeat(60)}[X]${'😀'.repeat(60)}`;
    const at = { start: 60, end: 63 };
    const { before, after } = contextOf(long, at);
    expect(before).toBe('a'.repeat(SUGGESTION_CONTEXT));
    expect([...after]).toHaveLength(SUGGESTION_CONTEXT);
    expect(wholeCharacters(after)).toBe(true);
    expect(contextOf('ab[X]cd', { start: 2, end: 5 })).toEqual({ before: 'ab', after: 'cd' });
  });
});

describe('the rules the commands share', () => {
  it('finds a selection that splits an emoji', () => {
    expect(wholeCharacters('🎉 vui')).toBe(true);
    expect(wholeCharacters('🎉'.slice(0, 1))).toBe(false);
    expect(wholeCharacters('🎉'.slice(1))).toBe(false);
  });

  it('freezes a channel that went out or is going out, and the post once every channel did', () => {
    const open = { status: 'in_review' as const, content_frozen: false };
    expect(channelFrozen(open)).toBe(false);
    for (const status of ['published', 'cancelled', 'removed', 'publishing', 'processing', 'ambiguous', 'needs_attention'] as const) expect(channelFrozen({ status, content_frozen: false })).toBe(true);
    expect(channelFrozen({ status: 'draft', content_frozen: true })).toBe(true);
    expect(postFrozen([open, { status: 'published', content_frozen: true }])).toBe(false);
    expect(postFrozen([{ status: 'published', content_frozen: true }])).toBe(true);
    expect(postFrozen([])).toBe(false);
  });

  it('hashes the whole text', () => {
    expect(textHash('a')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(textHash('a')).not.toBe(textHash('a '));
  });
});
