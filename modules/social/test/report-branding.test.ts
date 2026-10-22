// White-label client reports (#1053): the rules a brand's logo and accent meet, the same in the command and the form.
import { describe, expect, it } from 'vitest';
import {
  accentContrast,
  accentReadable,
  BRAND_LOGO_MAX_BYTES,
  BRAND_ACCENT_START,
  checkLogoDataUrl,
  contrastRatio,
  isAccent,
  logoDataUrlMax,
  normalizeAccent,
  sniffLogoType,
} from '../src/domain/report-branding.ts';

const b64 = (bytes: number[], pad = 0) => Buffer.from([...bytes, ...Array.from({ length: pad }, () => 0)]).toString('base64');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

describe('report branding rules (#1053)', () => {
  it('stores an accent as #rrggbb in lower case, from #rgb or any case', () => {
    expect(normalizeAccent('#1D4ED8')).toBe('#1d4ed8');
    expect(normalizeAccent(' #0af ')).toBe('#00aaff');
    expect(normalizeAccent('1d4ed8')).toBeNull();
    expect(normalizeAccent('red')).toBeNull();
    expect(normalizeAccent('#1d4ed8;background:url(x)')).toBeNull();
    expect(isAccent('#1d4ed8')).toBe(true);
    expect(isAccent('#1D4ED8')).toBe(false);
    expect(isAccent(null)).toBe(false);
  });

  it('measures contrast as WCAG does, and refuses an accent under 3:1 on the page or on paper', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    // Symmetric.
    expect(contrastRatio('#1d4ed8', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#1d4ed8'), 10);
    expect(accentReadable('#1d4ed8')).toBe(true);
    expect(accentReadable(BRAND_ACCENT_START)).toBe(true);
    expect(accentReadable('#b91c1c')).toBe(true);
    // Yellow, a pale grey and white are too light.
    expect(accentReadable('#ffff00')).toBe(false);
    expect(accentReadable('#dddddd')).toBe(false);
    expect(accentReadable('#ffffff')).toBe(false);
    // #949494 is just under 3:1 on white; #767676 is well over it.
    expect(accentContrast('#949494')).toBeLessThan(3);
    expect(accentReadable('#767676')).toBe(true);
    expect(accentReadable('not a colour')).toBe(false);
  });

  it('knows PNG, JPEG and WebP by their magic numbers, and nothing else', () => {
    expect(sniffLogoType(Uint8Array.from(PNG))).toBe('image/png');
    expect(sniffLogoType(Uint8Array.from(JPEG))).toBe('image/jpeg');
    expect(sniffLogoType(Uint8Array.from(WEBP))).toBe('image/webp');
    expect(sniffLogoType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffLogoType(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(sniffLogoType(new Uint8Array())).toBeNull();
  });

  it('accepts a logo data URL whose bytes match its type, within 64 KB', () => {
    expect(checkLogoDataUrl(`data:image/png;base64,${b64(PNG, 40)}`)).toEqual({ ok: true, type: 'image/png', bytes: 48 });
    expect(checkLogoDataUrl(`data:image/jpeg;base64,${b64(JPEG, 20)}`)).toMatchObject({ ok: true, type: 'image/jpeg' });
    expect(checkLogoDataUrl(`data:image/webp;base64,${b64(WEBP, 4)}`)).toMatchObject({ ok: true, type: 'image/webp' });
    // Exactly the cap.
    expect(checkLogoDataUrl(`data:image/png;base64,${b64(PNG, BRAND_LOGO_MAX_BYTES - PNG.length)}`)).toMatchObject({ ok: true, bytes: BRAND_LOGO_MAX_BYTES });
    expect(`data:image/jpeg;base64,${b64(JPEG, BRAND_LOGO_MAX_BYTES - JPEG.length)}`.length).toBeLessThanOrEqual(logoDataUrlMax());
  });

  it('refuses another type, SVG, a mismatched magic number, bad base64 and an oversized logo', () => {
    const svg = Buffer.from('<svg onload="alert(1)"/>').toString('base64');
    expect(checkLogoDataUrl(`data:image/svg+xml;base64,${svg}`)).toEqual({ ok: false, reason: 'type' });
    expect(checkLogoDataUrl(`data:image/gif;base64,${b64([0x47, 0x49, 0x46, 0x38], 8)}`)).toEqual({ ok: false, reason: 'type' });
    // Declared PNG, the bytes are a JPEG (and the other way round).
    expect(checkLogoDataUrl(`data:image/png;base64,${b64(JPEG, 20)}`)).toEqual({ ok: false, reason: 'type' });
    expect(checkLogoDataUrl(`data:image/jpeg;base64,${b64(PNG, 20)}`)).toEqual({ ok: false, reason: 'type' });
    // An SVG with a PNG's type.
    expect(checkLogoDataUrl(`data:image/png;base64,${svg}`)).toEqual({ ok: false, reason: 'type' });
    expect(checkLogoDataUrl('https://logo.example/logo.png')).toEqual({ ok: false, reason: 'type' });
    expect(checkLogoDataUrl(`data:image/png,${b64(PNG)}`)).toEqual({ ok: false, reason: 'type' });
    expect(checkLogoDataUrl(`data:image/png;base64,${b64(PNG, 4)}"><script>`)).toEqual({ ok: false, reason: 'type' });
    expect(checkLogoDataUrl(`data:image/png;base64,${b64(PNG, 4)}=`)).toEqual({ ok: false, reason: 'type' });
    expect(checkLogoDataUrl(`data:image/png;base64,${b64(PNG, BRAND_LOGO_MAX_BYTES - PNG.length + 1)}`)).toEqual({ ok: false, reason: 'size' });
    expect(checkLogoDataUrl(`data:image/png;base64,${'A'.repeat(200_000)}`)).toEqual({ ok: false, reason: 'size' });
  });
});
