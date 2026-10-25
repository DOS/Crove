import { describe, expect, it } from 'vitest';
import { CAPABILITIES, IMAGE_RULES, PROVIDERS } from '@crove/mod-social/contract';
import { FIX_LOW_QUALITY, FIX_MIN_SIDE, FIX_QUALITY, FIX_TYPE, firstFit, fixName, fixSteps, imageFix, isAnimated, refusals, replaceMedia, takesFixType, type FixStep } from '../src/lib/social-image-fix.ts';

const MB = 1024 * 1024;

describe('fixing an image a channel refuses (#1500)', () => {
  it('reads the refusals the contract makes: the type and the byte limit', () => {
    expect(refusals('instagram', { mime: 'image/png', sizeBytes: 100_000 })).toEqual(['type']);
    expect(refusals('zalo_oa', { mime: 'image/jpeg', sizeBytes: 2 * MB })).toEqual(['size']);
    expect(refusals('facebook_page', { mime: 'image/webp', sizeBytes: 5 * MB })).toEqual(['type', 'size']);
    expect(refusals('mastodon', { mime: 'image/png', sizeBytes: 2 * MB })).toEqual([]);
    expect(refusals('not-a-channel', { mime: 'image/png', sizeBytes: 50 * MB })).toEqual([]);
  });

  it('turns a 6 MB PNG on Instagram and Zalo OA into a JPEG under 1 MB', () => {
    const offer = imageFix({ mime: 'image/png', sizeBytes: 6 * MB }, ['instagram', 'zalo_oa']);
    expect(offer).toEqual({ kind: 'fix', target: { type: 'image/jpeg', maxBytes: CAPABILITIES.zalo_oa.media.maxImageBytes, minWidth: IMAGE_RULES.instagram?.minWidth, refusedBy: ['instagram', 'zalo_oa'] } });
    expect(CAPABILITIES.zalo_oa.media.maxImageBytes).toBe(MB);
  });

  it('turns a WebP on Facebook into a JPEG under 4 MB', () => {
    expect(imageFix({ mime: 'image/webp', sizeBytes: 300_000 }, ['facebook_page'])).toEqual({ kind: 'fix', target: { type: 'image/jpeg', maxBytes: 4 * MB, minWidth: 0, refusedBy: ['facebook_page'] } });
  });

  it('holds the fix to the strictest limit of every channel that takes images, refusing or not', () => {
    // Facebook refuses the WebP; Bluesky takes it but allows 1,000,000 bytes, so the JPEG must fit that too.
    const offer = imageFix({ mime: 'image/webp', sizeBytes: 500_000 }, ['facebook_page', 'bluesky', 'facebook_page']);
    expect(offer).toMatchObject({ kind: 'fix', target: { maxBytes: 1_000_000, refusedBy: ['facebook_page'] } });
  });

  it('offers nothing for a JPEG under every limit, a video, a PDF or no channel', () => {
    expect(imageFix({ mime: 'image/jpeg', sizeBytes: 900_000 }, ['instagram', 'zalo_oa', 'bluesky', 'facebook_page'])).toBeNull();
    expect(imageFix({ mime: 'video/mp4', sizeBytes: 90 * MB }, ['zalo_oa'])).toBeNull();
    expect(imageFix({ mime: 'application/pdf', sizeBytes: 90 * MB }, ['instagram'])).toBeNull();
    expect(imageFix({ mime: 'image/png', sizeBytes: 6 * MB }, [])).toBeNull();
  });

  it('never offers the fix for a GIF or another animated image, only the note', () => {
    expect(imageFix({ mime: 'image/gif', sizeBytes: 2 * MB }, ['instagram'])).toEqual({ kind: 'animated', refusedBy: ['instagram'] });
    expect(imageFix({ mime: 'image/webp', sizeBytes: 2 * MB, animated: true }, ['instagram'])).toEqual({ kind: 'animated', refusedBy: ['instagram'] });
    // Nothing to say when no channel refuses it.
    expect(imageFix({ mime: 'image/gif', sizeBytes: 100_000 }, ['mastodon'])).toBeNull();
  });

  it('makes a type every channel takes: each one takes JPEG', () => {
    for (const p of PROVIDERS) expect(takesFixType(p), p).toBe(true);
    expect(FIX_TYPE).toBe('image/jpeg');
  });

  it('encodes once at full size when no channel has a byte limit', () => {
    expect(fixSteps(4032, 3024, { maxBytes: null, minWidth: 320 })).toEqual([{ quality: FIX_QUALITY, width: 4032, height: 3024 }]);
  });

  it('steps the quality down, then the size, never below the minimum width', () => {
    const steps = fixSteps(4032, 3024, { maxBytes: MB, minWidth: 320 });
    expect(steps.slice(0, 2)).toEqual([
      { quality: FIX_QUALITY, width: 4032, height: 3024 },
      { quality: FIX_LOW_QUALITY, width: 4032, height: 3024 },
    ]);
    expect(steps[2]).toEqual({ quality: FIX_LOW_QUALITY, width: 3226, height: 2419 });
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.width).toBeLessThanOrEqual(steps[i - 1]!.width);
    expect(steps.every((s) => s.width >= 320)).toBe(true);
    expect(steps.at(-1)).toEqual({ quality: FIX_LOW_QUALITY, width: 320, height: 240 });
    // A tall image: its width is held to the channel's minimum, not its long side.
    const tall = fixSteps(1200, 3600, { maxBytes: MB, minWidth: 1080 });
    expect(tall.every((s) => s.width >= 1080)).toBe(true);
    expect(tall.at(-1)).toMatchObject({ width: 1080, height: 3240 });
  });

  it('never makes the long side shorter than FIX_MIN_SIDE, nor an image already at its floor smaller', () => {
    expect(fixSteps(2000, 1000, { maxBytes: MB, minWidth: 0 }).at(-1)).toEqual({ quality: FIX_LOW_QUALITY, width: FIX_MIN_SIDE, height: 160 });
    expect(fixSteps(300, 200, { maxBytes: MB, minWidth: 320 })).toEqual([
      { quality: FIX_QUALITY, width: 300, height: 200 },
      { quality: FIX_LOW_QUALITY, width: 300, height: 200 },
    ]);
  });

  it('has no step for an image with no size', () => {
    expect(fixSteps(0, 100, { maxBytes: MB, minWidth: 0 })).toEqual([]);
    expect(fixSteps(Number.NaN, 100, { maxBytes: null, minWidth: 0 })).toEqual([]);
  });

  it('keeps the first encode that fits, or none', async () => {
    const steps = fixSteps(4032, 3024, { maxBytes: MB, minWidth: 320 });
    // A fake encoder whose bytes follow the area and the quality.
    const tried: FixStep[] = [];
    const encode = async (s: FixStep) => {
      tried.push(s);
      return { size: Math.round(s.width * s.height * s.quality * 0.3) };
    };
    const fit = await firstFit(steps, MB, encode);
    expect(fit?.result.size).toBeLessThanOrEqual(MB);
    expect(fit?.step).toBe(tried.at(-1));
    expect(tried.length).toBeLessThan(steps.length);
    expect(await firstFit(steps, 10, encode)).toBeNull();
    expect(await firstFit(steps.slice(0, 1), null, encode)).toMatchObject({ step: steps[0] });
  });

  it('tells an animated WebP or PNG from a still one by its first bytes', () => {
    const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
    const webp = (flags: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [flags, 0, 0, 0]);
    expect(isAnimated('image/webp', webp(0x02))).toBe(true);
    expect(isAnimated('image/webp', webp(0x10))).toBe(false);
    expect(isAnimated('image/webp', bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 '))).toBe(false);
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const chunk = (type: string, length: number) => [0, 0, 0, length, ...[...type].map((c) => c.charCodeAt(0)), ...Array.from({ length: length + 4 }, () => 0)];
    expect(isAnimated('image/png', bytes(sig, chunk('IHDR', 13), chunk('acTL', 8), chunk('IDAT', 2)))).toBe(true);
    expect(isAnimated('image/png', bytes(sig, chunk('IHDR', 13), chunk('IDAT', 2), chunk('acTL', 8)))).toBe(false);
    expect(isAnimated('image/png', bytes(sig, chunk('IHDR', 13)))).toBe(false);
    expect(isAnimated('image/gif', new Uint8Array())).toBe(true);
    expect(isAnimated('image/jpeg', webp(0x02))).toBe(false);
  });

  it('names the file after the original and puts it in place of the original only', () => {
    expect(fixName('khai-truong.png')).toBe('khai-truong-sua.jpg');
    expect(fixName(null)).toBe('anh-sua.jpg');
    const a = { fileId: 'a', mime: 'image/png' };
    const b = { fileId: 'b', mime: 'image/jpeg' };
    const fixed = { fileId: 'c', mime: 'image/jpeg' };
    expect(replaceMedia([b, a, b], 'a', fixed)).toEqual([b, fixed, b]);
    expect(replaceMedia([b], 'a', fixed)).toEqual([b]);
  });
});
