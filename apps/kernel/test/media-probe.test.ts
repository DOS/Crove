// Video type and duration read from the file itself (#409): box headers only, every size checked.
import { describe, expect, it } from 'vitest';
import { hasVideoTrack, sniffVideo, videoDurationMs } from '../src/media-probe.ts';

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
