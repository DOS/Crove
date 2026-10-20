// Test helper: writes ZIP archives byte by byte, including the hostile ones a real tool would never make (a declared
// size that lies, overlapping entries, a path outside the archive). Node built-ins only, so the kernel tests and the
// container smoke test (apps/extract/test/container/smoke.mjs) import it too.
import { randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array | string;
  // deflate by default.
  method?: 'store' | 'deflate' | number;
  encrypted?: boolean;
  // Overrides of what the headers declare (by default the true values).
  crc?: number;
  size?: number;
  // Point this entry's local header offset at another entry's (by index): overlapping data.
  sameDataAs?: number;
}

export interface ZipSpec {
  // Write a ZIP64 end of central directory locator in front of the end record.
  zip64Locator?: boolean;
  comment?: string;
}

const bytesOf = (data: Uint8Array | string) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

export function buildZip(entries: ZipEntrySpec[], spec: ZipSpec = {}): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  entries.forEach((entry) => {
    const raw = bytesOf(entry.data);
    const method = entry.method === 'store' ? 0 : entry.method === undefined || entry.method === 'deflate' ? 8 : entry.method;
    const body = method === 8 ? deflateRawSync(raw) : Buffer.from(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.crc ?? crc32(raw) >>> 0;
    const size = entry.size ?? raw.byteLength;
    const flags = 0x800 | (entry.encrypted ? 0x1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    const localOffset = entry.sameDataAs === undefined ? offset : (offsets[entry.sameDataAs] ?? 0);
    offsets.push(offset);
    if (entry.sameDataAs === undefined) {
      locals.push(local, name, body);
      offset += local.byteLength + name.byteLength + body.byteLength;
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
  });
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(spec.comment ?? '', 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.byteLength, 20);
  const locator = Buffer.alloc(spec.zip64Locator ? 20 : 0);
  if (spec.zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  return new Uint8Array(Buffer.concat([...locals, directory, locator, end, comment]));
}

export interface LimitArchiveSpec {
  // How many entries, and how many bytes they decompress to in all (spread as evenly as whole bytes allow).
  entries: number;
  totalBytes: number;
  // Incompressible bytes in each entry: the archive itself then weighs about entries * randomBytesPerEntry.
  randomBytesPerEntry: number;
}

// An archive at the reader's limits (#432): `entries` e-invoice-like files that decompress to exactly `totalBytes`.
// Each entry starts with an XML declaration (so it is not taken for a nested archive), then random bytes, then
// repeated text, so the ZIP stays under the upload limit while the entries fill the decompressed limit.
export function buildLimitArchive(spec: LimitArchiveSpec): Uint8Array<ArrayBuffer> {
  const base = Math.floor(spec.totalBytes / spec.entries);
  const extra = spec.totalBytes - base * spec.entries;
  const head = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><HDon>');
  const filler = new TextEncoder().encode('<DLHDon><TTChung><SHDon>1</SHDon></TTChung></DLHDon>');
  return buildZip(
    Array.from({ length: spec.entries }, (_, i) => {
      const data = new Uint8Array(base + (i < extra ? 1 : 0));
      data.set(head);
      data.set(randomBytes(Math.min(spec.randomBytesPerEntry, data.length - head.length)), head.length);
      for (let at = head.length + spec.randomBytesPerEntry; at < data.length; at += filler.length) data.set(filler.subarray(0, data.length - at), at);
      return { name: `thang-10/hd-${String(i).padStart(3, '0')}.xml`, data };
    }),
  );
}
