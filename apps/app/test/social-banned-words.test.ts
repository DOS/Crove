// The excerpt shown around a banned or sensitive word (#1055).
import { describe, expect, it } from 'vitest';
import { bannedSnippet } from '../src/lib/social-banned-words.ts';

const hit = (start: number, end: number) => ({ wordId: 'w1', phrase: 'tốt nhất', level: 'block' as const, reason: null, field: 'body', start, end });

describe('bannedSnippet', () => {
  it('shows the whole text when it is short', () => {
    const text = 'Sản phẩm tốt nhất!';
    expect(bannedSnippet(text, hit(9, 17))).toMatchObject({ before: 'Sản phẩm ', match: 'tốt nhất', after: '!' });
  });

  it('cuts a long text at whole words, with an ellipsis', () => {
    const text = `${'mở đầu '.repeat(10)}tốt nhất${' kết thúc'.repeat(10)}`;
    const start = text.indexOf('tốt nhất');
    const s = bannedSnippet(text, hit(start, start + 8));
    expect(s.match).toBe('tốt nhất');
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.after.endsWith('…')).toBe(true);
    expect(s.before.slice(1).startsWith('mở')).toBe(true);
    expect(s.after).toMatch(/^( kết| thúc)+…$/u);
    expect(s.before).toMatch(/^…(mở |đầu )+$/u);
  });

  it('never cuts an emoji in half and folds line breaks', () => {
    const text = `${'😀'.repeat(30)}tốt\nnhất${'🔥'.repeat(30)}`;
    const start = text.indexOf('tốt');
    const s = bannedSnippet(text, hit(start, start + 8));
    expect(s.before).toMatch(/^…(😀)+$/u);
    expect(s.after).toMatch(/^(🔥)+…$/u);
    expect(s.match).toBe('tốt nhất');
  });

  it('falls back to the phrase when the range is outside the text', () => {
    expect(bannedSnippet('ngắn', hit(10, 18))).toMatchObject({ before: '', match: 'tốt nhất', after: '' });
  });
});
