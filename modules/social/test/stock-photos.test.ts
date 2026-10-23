// The hosts a Pexels photo's links and images may be on, and the cleaning of the text Pexels gives (#1106).
import { describe, expect, it } from 'vitest';
import { STOCK_ALT_MAX, pexelsImageUrl, pexelsPageUrl, stockText, zStockCredit } from '../src/index.ts';

describe('stock photo hosts and text (#1106)', () => {
  it('keeps only https pages on pexels.com', () => {
    expect(pexelsPageUrl('https://www.pexels.com/photo/ca-phe-123/')).toBe('https://www.pexels.com/photo/ca-phe-123/');
    expect(pexelsPageUrl('https://pexels.com/@a')).toBe('https://pexels.com/@a');
    for (const bad of ['http://www.pexels.com/photo/1/', 'https://pexels.com.evil.example/', 'https://evilpexels.com/', 'https://a:b@www.pexels.com/', 'https://www.pexels.com:8443/', 'javascript:alert(1)', 'not a url', 42, null, `https://www.pexels.com/${'a'.repeat(2048)}`]) {
      expect(pexelsPageUrl(bad), String(bad).slice(0, 40)).toBeNull();
    }
  });

  it('keeps only https images on images.pexels.com', () => {
    expect(pexelsImageUrl('https://images.pexels.com/photos/1/a.jpeg?w=940')).toBe('https://images.pexels.com/photos/1/a.jpeg?w=940');
    for (const bad of ['https://www.pexels.com/photos/1/a.jpeg', 'https://images.pexels.com.evil.example/a.jpeg', 'http://images.pexels.com/a.jpeg', 'https://169.254.169.254/', 'https://images.pexels.com:444/a.jpeg']) {
      expect(pexelsImageUrl(bad), bad).toBeNull();
    }
  });

  it('turns Pexels text into one line of plain text, cut to its limit', () => {
    expect(stockText('  Ly\u0000 cà phê \n\t sữa​ đá  ', 100)).toBe('Ly cà phê sữa đá');
    expect(stockText('   ', 100)).toBeNull();
    expect(stockText(undefined, 100)).toBeNull();
    expect([...(stockText('ả'.repeat(STOCK_ALT_MAX + 50), STOCK_ALT_MAX) ?? '')]).toHaveLength(STOCK_ALT_MAX);
  });

  it('takes a credit only with Pexels links and a Pexels id', () => {
    const credit = { provider: 'pexels', externalId: '123', photographer: 'A', photographerUrl: 'https://www.pexels.com/@a', sourceUrl: 'https://www.pexels.com/photo/123/', altText: null };
    expect(zStockCredit.safeParse(credit).success).toBe(true);
    for (const bad of [{ photographerUrl: 'https://evil.example/@a' }, { sourceUrl: 'https://www.pexels.com.evil.example/' }, { externalId: '0' }, { externalId: '12a' }, { provider: 'unsplash' }, { photographer: '' }, { extra: 1 }]) {
      expect(zStockCredit.safeParse({ ...credit, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
