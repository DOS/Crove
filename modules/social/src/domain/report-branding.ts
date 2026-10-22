// White-label client reports (#1053), the isomorphic part: the rules an org's report branding must meet, applied the
// same by the save command and by the settings form as an owner or admin fills it in. A brand is a display name, a
// logo kept as a small inline data URL (PNG, WebP or JPEG, never SVG, whose markup can carry script), one accent
// colour and "hide Crove". The public report and review views return it from their definers, so no new public route
// serves the logo.

// The longest display name, in characters.
export const BRAND_NAME_MAX = 100;
// The logo the browser makes from a library image: at most this many pixels on its longest side...
export const BRAND_LOGO_MAX_SIDE = 256;
// ...and at most this many bytes once decoded (the server's cap; the data URL is about 4/3 of it).
export const BRAND_LOGO_MAX_BYTES = 64 * 1024;
export const BRAND_LOGO_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const;
export type BrandLogoType = (typeof BRAND_LOGO_TYPES)[number];
// The least contrast an accent colour needs against the page it sits on: WCAG 2.2's 3:1 for user interface components
// and graphical objects (1.4.11). The accent marks rules and borders, never body text.
export const BRAND_MIN_CONTRAST = 3;
// What the accent sits on: the light theme's --background (oklch(0.985 0.003 290) in sRGB), and white paper, which a
// printed report and the report mail use.
export const BRAND_BACKGROUNDS = ['#fafafc', '#ffffff'] as const;
// Where the settings form's colour picker starts when no accent is set: a blue that passes the contrast check.
export const BRAND_ACCENT_START = '#1d4ed8';

/** An org's report branding as the public views and the settings return it. */
export interface ReportBrand {
  name: string | null;
  logo: string | null;
  accent: string | null;
  hideCrove: boolean;
}

const HEX = /^#[0-9a-f]{6}$/;
// A data URL of one of the logo types, in canonical base64 (padding only at the end).
const DATA_URL = /^data:(image\/(?:png|webp|jpeg));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;

/** Whether a value is an accent colour as stored: # and six lower-case hex digits. */
export const isAccent = (value: unknown): value is string => typeof value === 'string' && HEX.test(value);

/** An accent colour as stored (lower case, #rrggbb), from #rgb or #rrggbb in any case; null when it is neither. */
export function normalizeAccent(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX.test(v) ? v : null;
}

// WCAG 2.x relative luminance of #rrggbb.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The WCAG contrast ratio of two #rrggbb colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The accent's lowest contrast against the backgrounds it is shown on. */
export const accentContrast = (accent: string): number => Math.min(...BRAND_BACKGROUNDS.map((bg) => contrastRatio(accent, bg)));

/** Whether an accent stands out enough on the report page and on paper. */
export const accentReadable = (accent: string): boolean => isAccent(accent) && accentContrast(accent) >= BRAND_MIN_CONTRAST;

/** The image type the first bytes of a file say it is, of the logo types; null for anything else (SVG included). */
export function sniffLogoType(bytes: Uint8Array): BrandLogoType | null {
  const at = (i: number, ...expected: number[]) => expected.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

export type LogoCheck = { ok: true; type: BrandLogoType; bytes: number } | { ok: false; reason: 'type' | 'size' };

/**
 * Checks a logo data URL: one of the logo types, canonical base64, at most BRAND_LOGO_MAX_BYTES decoded, and bytes
 * whose magic number is the type the URL declares. 'size' for one too large, 'type' for anything else.
 */
export function checkLogoDataUrl(url: string): LogoCheck {
  // Longer than the largest allowed logo could be, before the regular expression reads it.
  if (url.length > logoDataUrlMax()) return { ok: false, reason: 'size' };
  const m = DATA_URL.exec(url);
  if (!m) return { ok: false, reason: 'type' };
  const declared = m[1] as BrandLogoType;
  const data = m[2] as string;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = (data.length / 4) * 3 - padding;
  if (size > BRAND_LOGO_MAX_BYTES) return { ok: false, reason: 'size' };
  // The magic numbers are in the first 12 bytes: 16 base64 characters.
  const head = atob(data.slice(0, 16));
  const bytes = Uint8Array.from(head, (c) => c.charCodeAt(0));
  if (sniffLogoType(bytes) !== declared) return { ok: false, reason: 'type' };
  return { ok: true, type: declared, bytes: size };
}

/** The longest logo data URL: the longest prefix and the base64 of BRAND_LOGO_MAX_BYTES. */
export const logoDataUrlMax = (): number => 'data:image/jpeg;base64,'.length + Math.ceil(BRAND_LOGO_MAX_BYTES / 3) * 4;
