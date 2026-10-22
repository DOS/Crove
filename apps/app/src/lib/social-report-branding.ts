// White-label client reports (#1053) in the browser: the logo an owner or admin picks from the Social library, scaled
// to at most 256 px on its longest side and kept as a small inline data URL, and the brand a public page gets from the
// API, read again before it is shown: a logo only as a PNG, WebP or JPEG data URL with the matching magic number, an
// accent only as #rrggbb, which then reaches the page through one CSS custom property and nowhere else.
import type { CSSProperties } from 'react';
import { BRAND_LOGO_MAX_BYTES, BRAND_LOGO_MAX_SIDE, checkLogoDataUrl, isAccent, type ReportBrand } from '@crove/mod-social/contract';
import { ClientError } from './errors.ts';

export type { ReportBrand };

/** A brand as a public page shows it, from whatever the API answered: unknown parts dropped, null for none. */
export function pageBrand(value: unknown): ReportBrand | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { name, logo, accent, hideCrove } = value as Record<string, unknown>;
  return {
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null,
    logo: typeof logo === 'string' && checkLogoDataUrl(logo).ok ? logo : null,
    accent: isAccent(accent) ? accent : null,
    hideCrove: hideCrove === true,
  };
}

/** The style that carries the accent to the page, as the --brand-accent custom property; undefined without one. */
export function accentStyle(brand: ReportBrand | null): CSSProperties | undefined {
  if (!brand || !isAccent(brand.accent)) return undefined;
  return { '--brand-accent': brand.accent } as CSSProperties;
}

// The longest side of a logo image after scaling: the image's own when it is already small enough.
export function logoSize(width: number, height: number, max = BRAND_LOGO_MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height, 1);
  const scale = Math.min(1, max / longest);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(blob);
  });

/**
 * A logo data URL from an image of the library: drawn at most 256 px on its longest side, PNG for a PNG or WebP (their
 * transparency kept), JPEG for a JPEG, then smaller sides until it fits BRAND_LOGO_MAX_BYTES. Throws a ClientError when
 * the image cannot be read or stays too large.
 */
export async function makeLogoDataUrl(image: Blob, mime: string): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new ClientError('social.reportBranding.logoUnreadable', (t) => t('social.reportBranding.logoUnreadable'));
  }
  try {
    const type = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    for (const side of [BRAND_LOGO_MAX_SIDE, 192, 128, 96]) {
      const size = logoSize(bitmap.width, bitmap.height, side);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new ClientError('social.reportBranding.logoUnreadable', (t) => t('social.reportBranding.logoUnreadable'));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
      if (blob && blob.size <= BRAND_LOGO_MAX_BYTES) return asDataUrl(blob);
    }
    throw new ClientError('social.reportBranding.logoTooLarge', (t) => t('social.reportBranding.logoTooLarge', { kb: String(BRAND_LOGO_MAX_BYTES / 1024) }));
  } finally {
    bitmap.close();
  }
}
