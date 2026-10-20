import { describe, expect, it } from 'vitest';
import { CROP_MAX_SIDE, cropAxis, cropName, cropRect, cropType, outputSize } from '../src/lib/social-crop.ts';

describe('cropping a post image (#636)', () => {
  it('keeps the largest part with the frame, placed along the free axis', () => {
    // A 4032 x 3024 photo to 4:5: full height, 2419 wide, centred, at the left or at the right.
    expect(cropRect(4032, 3024, 4 / 5, 0.5)).toEqual({ x: 807, y: 0, width: 2419, height: 3024 });
    expect(cropRect(4032, 3024, 4 / 5, 0)).toMatchObject({ x: 0 });
    expect(cropRect(4032, 3024, 4 / 5, 1)).toMatchObject({ x: 4032 - 2419 });
    // A 1080 x 1920 story to 1:1: full width, from the top down.
    expect(cropRect(1080, 1920, 1, 0.5)).toEqual({ x: 0, y: 420, width: 1080, height: 1080 });
    expect(cropRect(1080, 1920, 1, 2)).toMatchObject({ y: 840 });
    expect(cropAxis(4032, 3024, 4 / 5)).toBe('x');
    expect(cropAxis(1080, 1920, 1)).toBe('y');
    // Already the shape: the whole image.
    expect(cropRect(1080, 1080, 1, 0.5)).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
  });

  it('saves at most CROP_MAX_SIDE on the long side, never upscaled', () => {
    expect(outputSize({ width: 2419, height: 3024 })).toEqual({ width: Math.round((2419 * CROP_MAX_SIDE) / 3024), height: CROP_MAX_SIDE });
    expect(outputSize({ width: 800, height: 1000 })).toEqual({ width: 800, height: 1000 });
  });

  it('keeps PNG, saves the rest as JPEG, and names the file after the original', () => {
    expect(cropType('image/png')).toBe('image/png');
    expect(cropType('image/webp')).toBe('image/jpeg');
    expect(cropName('khai-truong.webp', 'portrait', 'image/jpeg')).toBe('khai-truong-portrait.jpg');
    expect(cropName('logo.png', 'square', 'image/png')).toBe('logo-square.png');
    expect(cropName('', 'story', 'image/jpeg')).toBe('anh-story.jpg');
  });
});
