// Video type and duration read from the file itself (#409): box headers only, every size checked.
import { describe, expect, it } from 'vitest';
import { hasVideoTrack, imageSize, sniffVideo, videoDurationMs } from '../src/media-probe.ts';

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...text(type), ...body];
const ftyp = (brand: string) => box('ftyp', [...text(brand), ...u32(0), ...text('isom'), ...text('mp41')]);
// mvhd version 0: version and flags, creation and modification times, timescale, duration, then the rest of the header.
const mvhd0 = (timescale: number, duration: number) => box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...Array.from({ length: 80 }, () => 0)]);
const mvhd1 = (timescale: number, high: number, low: number) => box('mvhd', [1, 0, 0, 0, ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(timescale), ...u32(high), ...u32(low), ...Array.from({ length: 80 }, () => 0)]);
const file = (...parts: number[][]) => new Uint8Array(parts.flat());

describe('sniffVideo', () => {
  it('tells MP4 and QuickTime from other files of the same container', () => {
    expect(sniffVideo(file(ftyp('isom')))).toBe('video/mp4');
    expect(sniffVideo(file(ftyp('mp42')))).toBe('video/mp4');
    expect(sniffVideo(file(ftyp('qt  ')))).toBe('video/quicktime');
    // HEIC images and M4A audio are not videos.
    expect(sniffVideo(file(ftyp('heic')))).toBeNull();
    expect(sniffVideo(file(ftyp('M4A ')))).toBeNull();
    // Another major brand counts by its compatible brands (ftyp lists isom and mp41).
    expect(sniffVideo(file(ftyp('XAVC')))).toBe('video/mp4');
    expect(sniffVideo(file(box('ftyp', [...text('XAVC'), ...u32(0), ...text('abcd')])))).toBeNull();
    expect(sniffVideo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(sniffVideo(file([...u32(9999), ...text('ftyp'), ...text('isom')]))).toBeNull();
  });
});

describe('hasVideoTrack', () => {
  const hdlr = (handler: string) => box('hdlr', [0, 0, 0, 0, ...u32(0), ...text(handler), ...Array.from({ length: 12 }, () => 0)]);
  const trak = (handler: string) => box('trak', box('mdia', hdlr(handler)));
  it('finds a video track, and not in an audio-only file', () => {
    expect(hasVideoTrack(file(ftyp('isom'), box('moov', [...mvhd0(1000, 5000), ...trak('soun'), ...trak('vide')])))).toBe(true);
    expect(hasVideoTrack(file(ftyp('isom'), box('moov', [...mvhd0(1000, 5000), ...trak('soun')])))).toBe(false);
    expect(hasVideoTrack(file(ftyp('isom')))).toBe(false);
  });
});

describe('videoDurationMs', () => {
  it('reads the movie header, version 0 and 1, wherever moov is', () => {
    expect(videoDurationMs(file(ftyp('isom'), box('moov', mvhd0(1000, 15_250))))).toBe(15_250);
    expect(videoDurationMs(file(ftyp('isom'), box('mdat', Array.from({ length: 64 }, () => 7)), box('moov', mvhd0(600, 1800))))).toBe(3000);
    expect(videoDurationMs(file(ftyp('qt  '), box('moov', [...box('trak', [1, 2, 3]), ...mvhd1(90_000, 0, 900_000)])))).toBe(10_000);
  });

  it('answers null for a missing, truncated or unknown duration', () => {
    expect(videoDurationMs(file(ftyp('isom')))).toBeNull();
    expect(videoDurationMs(file(ftyp('isom'), box('moov', mvhd0(0, 100))))).toBeNull();
    expect(videoDurationMs(file(ftyp('isom'), box('moov', mvhd0(1000, 0xffffffff))))).toBeNull();
    // In a 64-bit header 0xffffffff is an ordinary duration.
    expect(videoDurationMs(file(ftyp('isom'), box('moov', mvhd1(1_000_000, 0, 0xffffffff))))).toBe(4_294_967);
    const whole = file(ftyp('isom'), box('moov', mvhd0(1000, 5000)));
    expect(videoDurationMs(whole.slice(0, whole.length - 60))).toBeNull();
    // A file of thousands of tiny boxes is given up on rather than walked to the end.
    const tiny = Array.from({ length: 20_000 }, () => box('free', [])).flat();
    expect(videoDurationMs(file(ftyp('isom'), tiny, box('moov', mvhd0(1000, 5000))))).toBeNull();
    expect(videoDurationMs(file(ftyp('isom'), tiny.slice(0, 8 * 100), box('moov', mvhd0(1000, 5000))))).toBe(5000);
    // A box claiming more bytes than there are stops the walk.
    expect(videoDurationMs(file(ftyp('isom'), [...u32(1 << 30), ...text('moov')]))).toBeNull();
  });
});

describe('imageSize (#636)', () => {
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const le16 = (n: number) => [n & 255, (n >> 8) & 255];
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  const segment = (marker: number, body: number[]) => [0xff, marker, ...u16(body.length + 2), ...body];
  // SOF0: precision, height, width, components.
  const sof = (marker: number, width: number, height: number) => segment(marker, [8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  // APP1 with a big- or little-endian TIFF holding only the orientation tag.
  const exif = (orientation: number, little = false) => {
    const w16 = little ? le16 : u16;
    const w32 = (n: number) => (little ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255] : u32(n));
    const tiff = [...(little ? text('II') : text('MM')), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0, ...w32(0)];
    return segment(0xe1, [...text('Exif'), 0, 0, ...tiff]);
  };
  const jpeg = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9]);

  it('reads a PNG from its IHDR', () => {
    // A real 1x1 PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
    expect(imageSize(png, 'image/png')).toEqual({ width: 1, height: 1 });
    const wide = file([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a], u32(13), text('IHDR'), u32(1080), u32(1350));
    expect(imageSize(wide, 'image/png')).toEqual({ width: 1080, height: 1350 });
    expect(imageSize(file([0x89, ...text('PNG')]), 'image/png')).toBeNull();
  });

  it('reads a JPEG frame header after other segments, baseline or progressive, turned by its EXIF orientation', () => {
    expect(imageSize(jpeg(segment(0xe0, [...text('JFIF'), 0, 1, 2, 0, 0, 1, 0, 1, 0, 0]), segment(0xdb, Array.from({ length: 65 }, () => 1)), sof(0xc0, 4032, 3024)), 'image/jpeg')).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpeg(sof(0xc2, 800, 600)), 'image/jpeg')).toEqual({ width: 800, height: 600 });
    // A phone photo stored landscape and shown portrait (orientation 6), in either byte order.
    expect(imageSize(jpeg(exif(6), sof(0xc0, 4032, 3024)), 'image/jpeg')).toEqual({ width: 3024, height: 4032 });
    expect(imageSize(jpeg(exif(8, true), sof(0xc0, 4032, 3024)), 'image/jpeg')).toEqual({ width: 3024, height: 4032 });
    expect(imageSize(jpeg(exif(3), sof(0xc0, 4032, 3024)), 'image/jpeg')).toEqual({ width: 4032, height: 3024 });
    // The Huffman table marker C4 is not a frame header; a scan with no frame before it, or a cut file, gives null.
    expect(imageSize(jpeg(segment(0xc4, [0, 1, 2, 3, 4, 5, 6, 7]), sof(0xc0, 10, 20)), 'image/jpeg')).toEqual({ width: 10, height: 20 });
    expect(imageSize(jpeg(segment(0xda, [1, 2, 3])), 'image/jpeg')).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 8]), 'image/jpeg')).toBeNull();
    expect(imageSize(jpeg(sof(0xc0, 0, 20)), 'image/jpeg')).toBeNull();
    // Endless empty segments are given up on.
    expect(imageSize(jpeg(...Array.from({ length: 2000 }, () => segment(0xfe, []))), 'image/jpeg')).toBeNull();
  });

  it('reads the three kinds of WebP', () => {
    const riff = (chunk: string, body: number[]) => file(text('RIFF'), u32(0), text('WEBP'), text(chunk), le16(body.length), [0, 0], body, Array.from({ length: 16 }, () => 0));
    expect(imageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(1080), ...le16(1920)]), 'image/webp')).toEqual({ width: 1080, height: 1920 });
    // VP8L: the signature, then 14 bits of width - 1 and 14 bits of height - 1.
    const w = 1199;
    const h = 627;
    const bits = (w - 1) | ((h - 1) << 14);
    expect(imageSize(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255]), 'image/webp')).toEqual({ width: w, height: h });
    expect(imageSize(riff('VP8X', [0, 0, 0, 0, ...le24(1999), ...le24(999)]), 'image/webp')).toEqual({ width: 2000, height: 1000 });
    expect(imageSize(riff('VP8 ', [0, 0, 0, 0, 0, 0, ...le16(10), ...le16(10)]), 'image/webp')).toBeNull();
  });

  it('reads nothing of other types', () => {
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46]), 'image/gif')).toBeNull();
    expect(imageSize(new Uint8Array(), 'image/jpeg')).toBeNull();
  });
});