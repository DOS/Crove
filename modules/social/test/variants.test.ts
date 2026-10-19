import { describe, expect, it } from 'vitest';
import { mediaOf } from '../src/variants.ts';

describe('mediaOf', () => {
  const image = { fileId: '0190a000-0000-7000-8000-000000000001', generation: 'g1', altText: 'Mặt tiền', mime: 'image/jpeg', sizeBytes: 1200, durationMs: null };

  it('reads a list the commands wrote, and anything but a list as no list of its own', () => {
    expect(mediaOf([image])).toEqual([image]);
    expect(mediaOf([{ fileId: image.fileId, mime: 'video/mp4', sizeBytes: 9 }])).toEqual([{ fileId: image.fileId, generation: null, altText: null, mime: 'video/mp4', sizeBytes: 9, durationMs: null }]);
    expect(mediaOf([])).toEqual([]);
    expect(mediaOf(null)).toBeNull();
    expect(mediaOf({ fileId: image.fileId })).toBeNull();
  });

  it('refuses a list with an entry it cannot read rather than reading it shorter (#379)', () => {
    for (const bad of [null, 'x', { fileId: image.fileId, mime: 'image/png' }, { ...image, sizeBytes: '1200' }]) {
      expect(() => mediaOf([image, bad])).toThrow(expect.objectContaining({ code: 'VARIANT_MEDIA_INVALID' }));
    }
  });
});
