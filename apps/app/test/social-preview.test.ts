import { describe, expect, it } from 'vitest';
import { previewRule, previewText } from '../src/lib/social-preview.ts';

describe('platform previews (#588)', () => {
  it('cuts the text at a word before the platform limit, and never inside a letter with its marks', () => {
    const text = 'Khai trương chi nhánh mới tại Quận 3 với nhiều ưu đãi hấp dẫn cho khách hàng thân thiết';
    const cut = previewText(text, 40);
    expect(cut.more).toBe(true);
    expect(text.startsWith(cut.shown)).toBe(true);
    expect(cut.shown.endsWith(' ')).toBe(false);
    expect([...cut.shown].length).toBeLessThanOrEqual(40);
    expect(previewText('Ngắn', 40)).toEqual({ shown: 'Ngắn', more: false });
    expect(previewText(text, null)).toEqual({ shown: text, more: false });
    // One family emoji is one character to the reader.
    expect(previewText('👨‍👩‍👧‍👦'.repeat(5), 3).shown).toBe('👨‍👩‍👧‍👦'.repeat(3));
  });

  it('frames each platform its own way', () => {
    expect(previewRule('instagram')).toMatchObject({ layout: 'square', linkCard: false });
    expect(previewRule('tiktok').layout).toBe('vertical');
    expect(previewRule('youtube').layout).toBe('video');
    expect(previewRule('zalo_oa').layout).toBe('article');
    expect(previewRule('x')).toMatchObject({ cut: null, gridMax: 4 });
    expect(previewRule('sandbox')).toMatchObject({ layout: 'feed', cut: null });
  });
});