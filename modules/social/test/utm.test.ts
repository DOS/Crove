import { describe, expect, it } from 'vitest';
import { sentLink, sentSettings, tagLink, utmOf } from '../src/domain/utm.ts';
import { validateVariant } from '../src/domain/validate.ts';

describe('UTM tags (#585)', () => {
  it('tags the button links of a Telegram post like the link of the post (#1017)', () => {
    const buttons = [[{ text: 'Mua ngay', url: 'https://shop.example/pho' }, { text: 'Zalo', url: 'https://zalo.me/0901234567?ref=1&utm_source=tay' }]];
    const settings = { utm: { campaign: 'khai truong' }, telegram: { silent: true, buttons } };
    expect(sentSettings('telegram', settings)).toEqual({
      utm: { campaign: 'khai truong' },
      telegram: {
        silent: true,
        buttons: [[{ text: 'Mua ngay', url: 'https://shop.example/pho?utm_source=telegram&utm_medium=social&utm_campaign=khai%20truong' }, { text: 'Zalo', url: 'https://zalo.me/0901234567?ref=1&utm_source=tay&utm_medium=social&utm_campaign=khai%20truong' }]],
      },
    });
    // The stored settings are left as they are; without tags, buttons or Telegram, nothing changes.
    expect(settings.telegram.buttons).toBe(buttons);
    const untagged = { telegram: { buttons } };
    expect(sentSettings('telegram', untagged)).toBe(untagged);
    const noButtons = { utm: { campaign: 'x' }, telegram: { pin: true } };
    expect(sentSettings('telegram', noButtons)).toBe(noButtons);
    expect(sentSettings('mastodon', settings)).toBe(settings);
  });

  it('reads tags only with a campaign, and only plain values', () => {
    expect(utmOf({ utm: { campaign: 'khai-truong', medium: 'social' } })).toEqual({ campaign: 'khai-truong', medium: 'social' });
    expect(utmOf({ utm: { medium: 'social' } })).toBeNull();
    expect(utmOf({ utm: { campaign: '<script>' } })).toBeNull();
    // Vietnamese in either Unicode form, and the punctuation campaign names use.
    expect(utmOf({ utm: { campaign: 'Khai trương'.normalize('NFD') } })?.campaign).toBe('Khai trương');
    expect(utmOf({ utm: { campaign: 'Sale 20/10' } })?.campaign).toBe('Sale 20/10');
    expect(utmOf({})).toBeNull();
    expect(utmOf(undefined)).toBeNull();
  });

  const utm = { campaign: 'khai truong' };
  it('tags an http(s) link per channel and keeps what the link already has', () => {
    expect(tagLink('https://quan-a.vn/menu', 'facebook_page', utm)).toBe('https://quan-a.vn/menu?utm_source=facebook&utm_medium=social&utm_campaign=khai%20truong');
    expect(tagLink('https://quan-a.vn/?ref=1&utm_source=tay', 'zalo_oa', utm)).toBe('https://quan-a.vn/?ref=1&utm_source=tay&utm_medium=social&utm_campaign=khai%20truong');
    // The rest of the link stays as written: an IDN host, encoded spaces, a bare flag, a fragment route.
    expect(tagLink('https://quán-ăn.vn/thực-đơn?q=a%20b&flag#/menu', 'x', utm)).toBe('https://quán-ăn.vn/thực-đơn?q=a%20b&flag&utm_source=x&utm_medium=social&utm_campaign=khai%20truong#/menu');
    expect(tagLink('mailto:a@b.vn', 'x', utm)).toBe('mailto:a@b.vn');
    expect(tagLink('not a url', 'x', utm)).toBe('not a url');
    expect(tagLink(null, 'x', utm)).toBeNull();
    expect(sentLink('tiktok', 'https://a.vn', {})).toBe('https://a.vn');
    // A text that already holds the plain link sends it as written, so it is not shown twice.
    expect(sentLink('x', 'https://a.vn/m', { utm }, 'Xem https://a.vn/m nhé')).toBe('https://a.vn/m');
  });

  it('counts the tagged link where the channel counts the link', () => {
    const base = { provider: 'threads' as const, body: 'a'.repeat(400), title: null, media: [], linkUrl: 'https://quan-a.vn/menu' };
    expect(validateVariant(base)).toEqual([]);
    const tagged = validateVariant({ ...base, settings: { utm: { campaign: 'c'.repeat(80) } } });
    expect(tagged.map((i) => i.code)).toEqual(['TEXT_TOO_LONG']);
  });
});