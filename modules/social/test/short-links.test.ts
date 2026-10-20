import { describe, expect, it } from 'vitest';
import { SHORT_CODE_LENGTH, shortCode, shortened, shortUrl } from '../src/short-links.ts';

describe('short links (#706)', () => {
  it('draws codes of letters and digits, skipping the bytes that would bias them', () => {
    expect(shortCode()).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(new Set(Array.from({ length: 200 }, () => shortCode())).size).toBe(200);
    // 248 and above are skipped: only the bytes under it make letters, 0 -> A, 61 -> 9, 62 -> A again.
    const bytes = [255, 248, 0, 61, 62, 249, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const fixed = shortCode((size) => Uint8Array.from({ length: size }, (_, i) => bytes[i] ?? 0));
    expect(fixed).toBe('A9ABCDEFGHIJ');
    expect(fixed).toHaveLength(SHORT_CODE_LENGTH);
  });

  it('sends the short link in place of the link, in the text too', () => {
    const link = { target: 'https://shop.example/a?utm_source=facebook', url: shortUrl('https://crove.example/', 'AbCdEfGhIjKl') };
    expect(link.url).toBe('https://crove.example/l/AbCdEfGhIjKl');
    expect(shortened({ body: 'Xem tại https://shop.example/a?utm_source=facebook nhé', linkUrl: link.target }, link)).toEqual({ body: 'Xem tại https://crove.example/l/AbCdEfGhIjKl nhé', linkUrl: link.url });
    expect(shortened({ body: 'Không có liên kết', linkUrl: null }, link)).toEqual({ body: 'Không có liên kết', linkUrl: null });
  });
});
