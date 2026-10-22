import { describe, expect, it } from 'vitest';
import { sentLink, sentSettings } from '../src/domain/utm.ts';
import { SHORT_CODE_LENGTH, shortCode, shortened, shortenedSettings, shortUrl } from '../src/short-links.ts';

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

  it('sends a Telegram button to the link of the post through its short link, and other buttons as they are (#1017)', () => {
    const link = { target: 'https://shop.example/a?utm_source=telegram', url: 'https://crove.example/l/AbCdEfGhIjKl' };
    const settings = { telegram: { pin: true, buttons: [[{ text: 'Mua ngay', url: link.target }], [{ text: 'Zalo', url: 'https://zalo.me/0901234567' }]] } };
    expect(shortenedSettings(settings, link)).toEqual({ telegram: { pin: true, buttons: [[{ text: 'Mua ngay', url: link.url }], [{ text: 'Zalo', url: 'https://zalo.me/0901234567' }]] } });
    const plain = { telegram: { silent: true } };
    expect(shortenedSettings(plain, link)).toBe(plain);
  });

  it('matches a tagged button to the short link made from the link the post sends (#1017)', () => {
    // The short link's target is the link as sent (withShortLink stores the work's linkUrl, which withSentLink made).
    const post = 'https://shop.example/pho';
    const settings = { utm: { campaign: 'he' }, telegram: { buttons: [[{ text: 'Xem', url: post }]] } };
    const url = 'https://crove.example/l/AbCdEfGhIjKl';
    for (const body of ['Phở mới', `Phở mới ${post}`]) {
      const sent = sentLink('telegram', post, settings, body) as string;
      const out = shortenedSettings(sentSettings('telegram', settings, { plain: post, sent }), { target: sent, url });
      expect((out.telegram as { buttons: { url: string }[][] }).buttons[0]?.[0]?.url).toBe(url);
    }
  });

  it('sends the short link in place of the link, in the text too', () => {
    const link = { target: 'https://shop.example/a?utm_source=facebook', url: shortUrl('https://crove.example/', 'AbCdEfGhIjKl') };
    expect(link.url).toBe('https://crove.example/l/AbCdEfGhIjKl');
    expect(shortened({ body: 'Xem tại https://shop.example/a?utm_source=facebook nhé', linkUrl: link.target }, link)).toEqual({ body: 'Xem tại https://crove.example/l/AbCdEfGhIjKl nhé', linkUrl: link.url });
    expect(shortened({ body: 'Không có liên kết', linkUrl: null }, link)).toEqual({ body: 'Không có liên kết', linkUrl: null });
    // A longer link the target begins, and the target inside a word, stay as they are; the whole link, even in brackets
    // or before a full stop, is replaced.
    const site = { target: 'https://shop.example', url: 'https://crove.example/l/AbCdEfGhIjKl' };
    expect(shortened({ body: 'Trang chủ https://shop.example. Bài https://shop.example/a và (https://shop.example) xhttps://shop.example', linkUrl: site.target }, site).body).toBe(
      'Trang chủ https://crove.example/l/AbCdEfGhIjKl. Bài https://shop.example/a và (https://crove.example/l/AbCdEfGhIjKl) xhttps://shop.example',
    );
  });
});
