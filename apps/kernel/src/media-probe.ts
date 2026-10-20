// What the server reads from an uploaded video itself (Social plan S9, issue #409): its container (MP4 or QuickTime,
// from the ftyp box) and its duration (from the movie header, moov/mvhd). Nothing the sender declares is trusted, and
// nothing is decoded: only box headers are read, with every size checked against the bytes there are.

// ISO base media brands of video files; HEIC/AVIF images and M4A audio use the same container and are not videos.
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'mmp4', 'dash', 'msnv', '3gp4', '3gp5', '3gp6', '3g2a']);

// Major brands of files in the same container that are not videos (audio, images): never sniffed as video, even when
// they list a video brand as compatible (M4A lists mp42 and isom).
const NOT_VIDEO = new Set(['M4A ', 'M4B ', 'M4P ', 'heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis', 'crx ']);

const fourcc = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

// video/mp4, video/quicktime, or null when the bytes are not one of them.
export function sniffVideo(bytes: Uint8Array): 'video/mp4' | 'video/quicktime' | null {
  if (bytes.byteLength < 12 || fourcc(bytes, 4) !== 'ftyp') return null;
  const size = readU32(bytes, 0);
  if (size < 16 || size > bytes.byteLength || size > 4096) return null;
  const major = fourcc(bytes, 8);
  if (major === 'qt  ') return 'video/quicktime';
  if (MP4_BRANDS.has(major)) return 'video/mp4';
  if (NOT_VIDEO.has(major)) return null;
  // Another major brand: a video when one of its compatible brands is (they follow the minor version, up to the box end).
  for (let at = 16; at + 4 <= size; at += 4) if (MP4_BRANDS.has(fourcc(bytes, at))) return 'video/mp4';
  return null;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
}

function readU64(bytes: Uint8Array, at: number): number {
  return readU32(bytes, at) * 2 ** 32 + readU32(bytes, at + 4);
}

interface Box {
  type: string;
  // Where the box's content starts and where the box ends.
  body: number;
  end: number;
}

// A real file has a handful of top-level boxes and a few dozen inside moov; a file of millions of tiny boxes would hold
// the event loop, so a walk gives up after this many.
const MAX_BOXES = 10_000;

// The boxes between start and end, stopping at the first header that does not fit, or after MAX_BOXES.
function* boxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  let at = start;
  for (let seen = 0; at + 8 <= end && seen < MAX_BOXES; seen++) {
    let size = readU32(bytes, at);
    const type = fourcc(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = readU64(bytes, at + 8);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end || !Number.isSafeInteger(at + size)) return;
    yield { type, body: at + header, end: at + size };
    at += size;
  }
}

// Whether the movie has a video track (moov/trak/mdia/hdlr with handler type vide): an audio-only file shares the
// container and the generic brands, and is not a video.
export function hasVideoTrack(bytes: Uint8Array): boolean {
  for (const top of boxes(bytes, 0, bytes.byteLength)) {
    if (top.type !== 'moov') continue;
    for (const trak of boxes(bytes, top.body, top.end)) {
      if (trak.type !== 'trak') continue;
      for (const mdia of boxes(bytes, trak.body, trak.end)) {
        if (mdia.type !== 'mdia') continue;
        for (const hdlr of boxes(bytes, mdia.body, mdia.end)) {
          // version and flags (4 bytes), pre_defined (4 bytes), then the handler type.
          if (hdlr.type === 'hdlr' && hdlr.body + 12 <= hdlr.end && fourcc(bytes, hdlr.body + 8) === 'vide') return true;
        }
      }
    }
    return false;
  }
  return false;
}

// The movie's duration in milliseconds, or null when there is no readable movie header.
export function videoDurationMs(bytes: Uint8Array): number | null {
  for (const top of boxes(bytes, 0, bytes.byteLength)) {
    if (top.type !== 'moov') continue;
    for (const box of boxes(bytes, top.body, top.end)) {
      if (box.type !== 'mvhd') continue;
      const version = bytes[box.body];
      // version and flags (4 bytes), then creation and modification times (4 or 8 bytes each).
      const at = box.body + 4 + (version === 1 ? 16 : 8);
      if (version !== 0 && version !== 1) return null;
      const need = at + 4 + (version === 1 ? 8 : 4);
      if (need > box.end) return null;
      const timescale = readU32(bytes, at);
      const duration = version === 1 ? readU64(bytes, at + 4) : readU32(bytes, at + 4);
      // An unknown duration is all ones.
      if (timescale === 0 || (version === 0 && duration === 0xffffffff) || (version === 1 && duration >= 2 ** 53)) return null;
      const ms = Math.round((duration / timescale) * 1000);
      return Number.isSafeInteger(ms) ? ms : null;
    }
    return null;
  }
  return null;
}

// An image's size as it is shown (#636): read from the header of a JPEG (its frame header, turned by its EXIF
// orientation), a PNG (IHDR) or a WebP (VP8, VP8L or VP8X), nothing decoded; null when the header cannot be read.
export interface ImageSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const sized = (width: number, height: number): ImageSize | null => (width >= 1 && height >= 1 && width <= 100_000 && height <= 100_000 ? { width, height } : null);

// The EXIF orientation (1 to 8) in an APP1 segment's body, or 1.
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (end - start < 14 || fourcc(b, start) !== 'Exif' || b[start + 4] !== 0 || b[start + 5] !== 0) return 1;
  const tiff = start + 6;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1;
  const r16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const r32 = (at: number) => (little ? (u16le(b, at) | (u16le(b, at + 2) << 16)) >>> 0 : readU32(b, at));
  if (r16(tiff + 2) !== 42) return 1;
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = Math.min(r16(ifd), 512);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpegSize(b: Uint8Array): ImageSize | null {
  let at = 2;
  let orientation = 1;
  // A JPEG has a few dozen segments before its frame header; a file of countless empty ones is given up on.
  for (let seen = 0; at + 4 <= b.byteLength && seen < 1000; seen++) {
    if (b[at] !== 0xff) return null;
    let marker = b[at + 1] ?? 0;
    // Fill bytes before a marker.
    while (marker === 0xff && at + 2 < b.byteLength) {
      at += 1;
      marker = b[at + 1] ?? 0;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // End of image, or the scan starts before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, at + 2);
    if (length < 2 || at + 2 + length > b.byteLength) return null;
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b, at + 4, at + 2 + length);
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      if (length < 7) return null;
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      // Orientations 5 to 8 turn the picture a quarter: what is shown is the other way round.
      return orientation >= 5 ? sized(height, width) : sized(width, height);
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.byteLength < 30 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return null;
  const chunk = fourcc(b, 12);
  if (chunk === 'VP8 ') {
    // A key frame: its start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const b1 = b[22] ?? 0;
    const b2 = b[23] ?? 0;
    const b3 = b[24] ?? 0;
    return sized(1 + ((b[21] ?? 0) | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
  }
  if (chunk === 'VP8X') return sized(1 + u24le(b, 24), 1 + u24le(b, 27));
  return null;
}

export function imageSize(bytes: Uint8Array, type: string): ImageSize | null {
  if (type === 'image/png') {
    if (bytes.byteLength < 24 || fourcc(bytes, 12) !== 'IHDR') return null;
    return sized(readU32(bytes, 16), readU32(bytes, 20));
  }
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 ? jpegSize(bytes) : null;
  if (type === 'image/webp') return webpSize(bytes);
  return null;
}