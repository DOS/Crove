// Fixing an image a channel refuses (#1500): a photo straight from a phone is too large for Zalo OA or Bluesky, a PNG
// or a WebP is not JPEG for Instagram. The composer offers to re-encode it in the browser as a JPEG that every channel
// of the post takes, uploaded as a new library file in place of the original (the original stays), as a crop is.
// This module decides, from the contract's limits, whether an image needs the fix, what it must become and the encodes
// to try; the drawing runs in components/social-image-fix.tsx.
import { CAPABILITIES, IMAGE_RULES, isProvider, mediaKindOf, type Provider } from '@crove/mod-social/contract';
import { CROP_MAX_SIDE } from './social-crop.ts';

// Every channel takes JPEG (a test checks the contract), so the fix always makes one.
export const FIX_TYPE = 'image/jpeg';
// The first encode, then a lower quality before the image is made smaller.
export const FIX_QUALITY = 0.9;
export const FIX_LOW_QUALITY = 0.7;
// Each smaller step keeps this share of the previous one's sides.
export const FIX_SCALE = 0.8;
// The long side is never made shorter than this, whatever the channels allow.
export const FIX_MIN_SIDE = 320;

export type Refusal = 'type' | 'size';

// Why a channel refuses an image, as the contract's check says it (validate.ts: IMAGE_TYPE_NOT_ALLOWED,
// IMAGE_TOO_LARGE). A channel that takes no images at all refuses it for another reason, which no re-encode fixes.
export function refusals(provider: string, image: { mime: string; sizeBytes: number }): Refusal[] {
  if (!isProvider(provider)) return [];
  const rule = CAPABILITIES[provider].media;
  if (!rule.kinds.includes('image')) return [];
  const out: Refusal[] = [];
  if (rule.imageTypes.length > 0 && !rule.imageTypes.includes(image.mime.toLowerCase())) out.push('type');
  if (rule.maxImageBytes !== null && image.sizeBytes > rule.maxImageBytes) out.push('size');
  return out;
}

export interface FixTarget {
  type: typeof FIX_TYPE;
  // The strictest byte limit among the post's channels that take images; null when none has one.
  maxBytes: number | null;
  // The widest minimum width among them (IMAGE_RULES); 0 when none has one.
  minWidth: number;
  // The channels that refuse the image as it is.
  refusedBy: Provider[];
}

// What the composer offers for an image on the given channels: the fix and its target, a note that an animated image
// cannot be fixed here (a canvas keeps one frame), or nothing when no channel refuses it.
export type FixOffer = { kind: 'fix'; target: FixTarget } | { kind: 'animated'; refusedBy: Provider[] } | null;

export function imageFix(image: { mime: string; sizeBytes: number; animated?: boolean }, providers: readonly string[]): FixOffer {
  if (mediaKindOf(image.mime) !== 'image') return null;
  const known = [...new Set(providers)].filter(isProvider);
  const refusedBy = known.filter((p) => refusals(p, image).length > 0);
  if (refusedBy.length === 0) return null;
  if (image.mime.toLowerCase() === 'image/gif' || image.animated === true) return { kind: 'animated', refusedBy };
  const takers = known.filter((p) => CAPABILITIES[p].media.kinds.includes('image'));
  if (takers.some((p) => !takesFixType(p))) return null;
  const limits = takers.map((p) => CAPABILITIES[p].media.maxImageBytes).filter((n): n is number => n !== null);
  return {
    kind: 'fix',
    target: { type: FIX_TYPE, maxBytes: limits.length > 0 ? Math.min(...limits) : null, minWidth: Math.max(0, ...takers.map((p) => IMAGE_RULES[p]?.minWidth ?? 0)), refusedBy },
  };
}

export function takesFixType(provider: Provider): boolean {
  const types = CAPABILITIES[provider].media.imageTypes;
  return types.length === 0 || types.includes(FIX_TYPE);
}

export interface FixStep {
  quality: number;
  width: number;
  height: number;
}

// The encodes to try, in order, for a width x height image (turned the way its EXIF says): at most CROP_MAX_SIDE on
// the long side, as a crop is saved (a full-size 24 MP phone photo is over the canvas iOS Safari draws), at
// FIX_QUALITY, then at FIX_LOW_QUALITY, then smaller by FIX_SCALE at a time, down to the narrowest the channels take
// (and never a long side under FIX_MIN_SIDE), with that floor itself as the last step. Without a byte limit the first
// encode always fits, so it is the only one. The cap never makes an image narrower than the channels' minimum, and an
// image already at or under the floor is never made smaller; one with no size (never a decoded image) has no step.
export function fixSteps(width: number, height: number, target: Pick<FixTarget, 'maxBytes' | 'minWidth'>): FixStep[] {
  if (!(width > 0 && height > 0)) return [];
  const long = Math.max(width, height);
  const floor = Math.min(1, Math.max(target.minWidth / width, FIX_MIN_SIDE / long));
  const start = Math.min(1, Math.max(CROP_MAX_SIDE / long, floor));
  const at = (scale: number, quality: number): FixStep => ({ quality, width: Math.max(Math.round(width * scale), Math.min(width, target.minWidth)), height: Math.max(1, Math.round(height * scale)) });
  const steps: FixStep[] = [at(start, FIX_QUALITY)];
  if (target.maxBytes === null) return steps;
  steps.push(at(start, FIX_LOW_QUALITY));
  for (let scale = start * FIX_SCALE; scale > floor; scale *= FIX_SCALE) steps.push(at(scale, FIX_LOW_QUALITY));
  if (floor < start) steps.push(at(floor, FIX_LOW_QUALITY));
  return steps;
}

// The outcome of the encodes: the first whose bytes fit, too_large when every one that worked was over the limit,
// failed when none worked (the browser could not draw or encode the image at any size).
export type FitResult<T> = { step: FixStep; result: T } | 'too_large' | 'failed';

// Runs the encodes in order and returns the first whose bytes fit the limit. An encode that fails (null, or an error
// such as a canvas over the browser's limit) moves on to the next, smaller step. encode is the browser's canvas in the
// app and a fake in the tests.
export async function firstFit<T extends { size: number }>(steps: readonly FixStep[], maxBytes: number | null, encode: (step: FixStep) => Promise<T | null>): Promise<FitResult<T>> {
  let encoded = false;
  for (const step of steps) {
    const result = await encode(step).catch(() => null);
    if (!result) continue;
    encoded = true;
    if (maxBytes === null || result.size <= maxBytes) return { step, result };
  }
  return encoded ? 'too_large' : 'failed';
}

const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

// Whether an image moves, from its first bytes: a GIF (counted as animated, as most posted GIFs are), a WebP whose
// VP8X header has the animation flag, or a PNG with an animation control chunk (acTL, APNG) before its first image data.
export function isAnimated(mime: string, head: Uint8Array): boolean {
  const type = mime.toLowerCase();
  if (type === 'image/gif') return true;
  if (type === 'image/webp') return ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP') && ascii(head, 12, 'VP8X') && ((head[20] ?? 0) & 0x02) !== 0;
  if (type !== 'image/png') return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  for (let at = 8; at + 8 <= head.byteLength; ) {
    if (ascii(head, at + 4, 'acTL')) return true;
    if (ascii(head, at + 4, 'IDAT')) return false;
    at += 12 + view.getUint32(at);
  }
  return false;
}

// The fixed file's name: the original's, with -sua (fixed) and .jpg.
export function fixName(original: string | null | undefined): string {
  const base = (original ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'anh';
  return `${base}-sua.jpg`;
}

// The post's images with the fixed file in place of the original, wherever it is; the others as they are.
export const replaceMedia = <T extends { fileId: string }>(media: readonly T[], fromFileId: string, next: T): T[] => media.map((m) => (m.fileId === fromFileId ? next : m));

// A fix made in one list, applied to every channel of the post (#1505): the fixed file in place of the original in
// each channel's own images that hold it. A channel without the original is left as it is (the same object), so the
// caller can tell which channels changed. The post's shared images take replaceMedia themselves.
export function replaceInChannels<M extends { fileId: string }, O extends { media: readonly M[] }>(own: Readonly<Record<string, O>>, fromFileId: string, next: M): Record<string, O> {
  return Object.fromEntries(Object.entries(own).map(([id, o]) => [id, o.media.some((m) => m.fileId === fromFileId) ? { ...o, media: replaceMedia(o.media, fromFileId, next) } : o]));
}
