import { describe, expect, it } from 'vitest';
import { watermarkName, watermarkRect } from '../src/lib/social-watermark.ts';

describe('watermarkRect (#834)', () => {
  const logo = { width: 400, height: 200 };
  it('puts the logo in each corner at its share of the width, with a margin', () => {
    // 1000 x 800: margin 24, logo 200 x 100.
    expect(watermarkRect(1000, 800, logo, 'bottom_right', 20)).toEqual({ x: 776, y: 676, width: 200, height: 100 });
    expect(watermarkRect(1000, 800, logo, 'top_left', 20)).toEqual({ x: 24, y: 24, width: 200, height: 100 });
    expect(watermarkRect(1000, 800, logo, 'top_right', 20)).toEqual({ x: 776, y: 24, width: 200, height: 100 });
    expect(watermarkRect(1000, 800, logo, 'bottom_left', 20)).toEqual({ x: 24, y: 676, width: 200, height: 100 });
  });

  it('keeps a tall logo inside a wide, short image', () => {
    // 1000 x 100: margin 3, room for 94 px of height; a 1:4 logo at 50% would be 2000 px tall.
    const rect = watermarkRect(1000, 100, { width: 100, height: 400 }, 'bottom_right', 50);
    expect(rect.height).toBe(94);
    expect(rect.width).toBe(24);
    expect(rect.y + rect.height).toBeLessThanOrEqual(100);
  });

  it('names the copy after the original', () => {
    expect(watermarkName('banh.webp', 'image/jpeg')).toBe('banh-logo.jpg');
    expect(watermarkName('', 'image/png')).toBe('anh-logo.png');
  });
});
