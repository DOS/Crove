// What the server reads from an uploaded video itself (Social plan S9, issue #409): its container (MP4 or QuickTime,
// from the ftyp box) and its duration (from the movie header, moov/mvhd). Nothing the sender declares is trusted, and
// nothing is decoded: only box headers are read, with every size checked against the bytes there are.

// ISO base media brands of video files; HEIC/AVIF images and M4A audio use the same container and are not videos.
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'mmp4', 'dash', 'msnv', '3gp4', '3gp5', '3gp6', '3g2a']);

const fourcc = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

// video/mp4, video/quicktime, or null when the bytes are not one of them.
export function sniffVideo(bytes: Uint8Array): 'video/mp4' | 'video/quicktime' | null {
  if (bytes.byteLength < 12 || fourcc(bytes, 4) !== 'ftyp') return null;
  const size = readU32(bytes, 0);
  if (size < 16 || size > bytes.byteLength || size > 4096) return null;
  const major = fourcc(bytes, 8);
  if (major === 'qt  ') return 'video/quicktime';
  if (MP4_BRANDS.has(major)) return 'video/mp4';
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
      if (timescale === 0 || duration === 0xffffffff || (version === 1 && duration >= 2 ** 53)) return null;
      const ms = Math.round((duration / timescale) * 1000);
      return Number.isSafeInteger(ms) ? ms : null;
    }
    return null;
  }
  return null;
}
