import { describe, expect, it } from 'vitest';
import { sentLink, tagLink, utmOf } from '../src/domain/utm.ts';
import { validateVariant } from '../src/domain/validate.ts';

describe('UTM tags (#585)', () => {
  it('reads tags only with a campaign, and only plain values', () => {
    expect(utmOf({ utm: { campaign: 'khai-truong', medium: 'social' } })).toEqual({ campaign: 'khai-truong', medium: 'social' });
    expect(utmOf({ utm: { medium: 'social' } })).toBeNull();
    expect(utmOf({ utm: { campaign: 'a&b=c' } })).toBeNull();
    expect(utmOf({})).toBeNull();
    expect(utmOf(undefined)).toBeNull();
  });

  it('tags an http(s) link per channel and keeps what the link already has', () => {
    const utm = { campaign: 'khai truong' };
    expect(tagLink('https://quan-a.vn/menu', 'facebook_page', utm)).toBe('https://quan-a.vn/menu?utm_source=facebook&utm_medium=social&utm_campaign=khai+truong');
    expect(tagLink('https://quan-a.vn/?ref=1&utm_source=tay', 'zalo_oa', utm)).toBe('https://quan-a.vn/?ref=1&utm_source=tay&utm_medium=social&utm_campaign=khai+truong');
    expect(tagLink('mailto:a@b.vn', 'x', utm)).toBe('mailto:a@b.vn');
    expect(tagLink('not a url', 'x', utm)).toBe('not a url');
    expect(tagLink(null, 'x', utm)).toBeNull();
    expect(sentLink('tiktok', 'https://a.vn', {})).toBe('https://a.vn');
  });

  it('counts the tagged link where the channel counts the link', () => {
    const base = { provider: 'threads' as const, body: 'a'.repeat(400), title: null, media: [], linkUrl: 'https://quan-a.vn/menu' };
    expect(validateVariant(base)).toEqual([]);
    const tagged = validateVariant({ ...base, settings: { utm: { campaign: 'c'.repeat(80) } } });
    expect(tagged.map((i) => i.code)).toEqual(['TEXT_TOO_LONG']);
  });
});