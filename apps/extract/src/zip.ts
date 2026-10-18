// ZIP reader for bulk intake (issue #314). Runs only inside a parser process (see sandbox.ts): the archive is
// untrusted, so it is read from the central directory with every size, offset and count checked before anything is
// decompressed, and nothing is ever written to disk. node:zlib does the inflating, with the output capped at the size
// the entry declares, so a decompression bomb stops at that size; the declared sizes are capped in total first.
//
// Refused whole (ArchiveError, reported as invalid): no end of central directory, a split or ZIP64 archive, more
// entries or more decompressed bytes than allowed, an entry name that escapes the archive (absolute, a drive letter,
// a .. segment, a NUL), entries whose data overlap or run into the directory, an Office document (xlsx, docx, odt:
// also ZIP files, but not a batch of invoices), and an archive with no file at all.
// Returned without content (rejected): encrypted entries, compression other than stored or deflate, nested archives,
// entries larger than a document may be, and entries whose size or CRC-32 does not match their bytes.
import { crc32, inflateRawSync } from 'node:zlib';
import { EXTRACT_LIMITS, type ArchiveRejection, type ExtractedArchive } from '@crove/extract-contract';

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: EXTRACT_LIMITS.maxArchiveEntries,
  maxTotalBytes: EXTRACT_LIMITS.maxArchiveTotalBytes,
  maxEntryBytes: EXTRACT_LIMITS.maxFileBytes,
};

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const STORED = 0;
const DEFLATE = 8;

const NESTED_NAME = /\.(zip|zipx|rar|7z|tar|gz|tgz|bz2|tbz2?|xz|txz|zst|lz|lzma|cab|jar|iso)$/i;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
}

// Another archive, by its first bytes: ZIP, RAR, 7z, gzip, bzip2, xz, zstd, or a tar header.
export function looksLikeArchive(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]) ||
    startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) ||
    startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    startsWith(bytes, [0x1f, 0x8b]) ||
    startsWith(bytes, [0x42, 0x5a, 0x68]) ||
    startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd]) ||
    startsWith(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257)
  );
}

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function decodeName(raw: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8) return utf8.decode(raw);
  // Archives made without the UTF-8 flag mostly hold UTF-8 anyway; anything else is shown byte for byte.
  try {
    return utf8.decode(raw);
  } catch {
    return latin1.decode(raw);
  }
}

// The name with / separators, or an ArchiveError when it could point outside the archive. Nothing is written to
// disk, but the name travels on as a filename, so a hostile one is refused rather than repaired.
export function safeEntryName(name: string): string {
  if (name.includes('\0')) throw new ArchiveError('Tệp ZIP có tên mục không hợp lệ');
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new ArchiveError(`Tệp ZIP có đường dẫn không an toàn: ${normalized.slice(0, 200)}`);
  }
  return normalized;
}

function findEndOfDirectory(view: DataView, length: number): number {
  const lowest = Math.max(0, length - EOCD_SIZE - MAX_COMMENT);
  for (let at = length - EOCD_SIZE; at >= lowest; at--) {
    // The record must end exactly where the file does, comment included, so a signature inside a comment or inside
    // entry data is not taken for it.
    if (view.getUint32(at, true) === EOCD && at + EOCD_SIZE + view.getUint16(at + 20, true) === length) return at;
  }
  throw new ArchiveError('Không phải tệp ZIP hoặc tệp ZIP bị hỏng');
}

function readDirectory(bytes: Uint8Array, limits: ZipLimits): { entries: CentralEntry[]; directoryStart: number } {
  if (bytes.length < EOCD_SIZE) throw new ArchiveError('Không phải tệp ZIP hoặc tệp ZIP bị hỏng');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfDirectory(view, bytes.length);
  if (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR) throw new ArchiveError('Tệp ZIP64 chưa được hỗ trợ; hãy nén lại thành ZIP thường');
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const onDisk = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffff_ffff || directoryStart === 0xffff_ffff) {
    throw new ArchiveError('Tệp ZIP64 chưa được hỗ trợ; hãy nén lại thành ZIP thường');
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) throw new ArchiveError('Tệp ZIP chia nhiều phần chưa được hỗ trợ');
  if (count > limits.maxEntries) throw new ArchiveError(`Tệp ZIP có hơn ${limits.maxEntries} mục; hãy chia thành nhiều tệp ZIP`);
  const directoryEnd = directoryStart + directorySize;
  if (directoryEnd > end) throw new ArchiveError('Tệp ZIP bị hỏng (thư mục mục lục sai vị trí)');

  const entries: CentralEntry[] = [];
  let at = directoryStart;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > directoryEnd || view.getUint32(at, true) !== CENTRAL) throw new ArchiveError('Tệp ZIP bị hỏng (mục lục không đọc được)');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    if (compressedSize === 0xffff_ffff || size === 0xffff_ffff || localOffset === 0xffff_ffff) {
      throw new ArchiveError('Tệp ZIP64 chưa được hỗ trợ; hãy nén lại thành ZIP thường');
    }
    const next = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw new ArchiveError('Tệp ZIP bị hỏng (mục lục không đọc được)');
    const name = safeEntryName(decodeName(bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength), flags));
    entries.push({ name, flags, method, crc, compressedSize, size, localOffset });
    at = next;
  }
  return { entries, directoryStart };
}

// Where an entry's data starts and ends, from its local header. Entries must not overlap one another or the directory:
// overlapping entries are how a small archive declares the same bytes many times over.
function dataRanges(bytes: Uint8Array, entries: CentralEntry[], directoryStart: number): Array<{ start: number; end: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ranges = entries.map((entry) => {
    const at = entry.localOffset;
    if (at + LOCAL_SIZE > directoryStart || view.getUint32(at, true) !== LOCAL) throw new ArchiveError('Tệp ZIP bị hỏng (mục không đọc được)');
    const start = at + LOCAL_SIZE + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const end = start + entry.compressedSize;
    if (end > directoryStart) throw new ArchiveError('Tệp ZIP bị hỏng (mục vượt quá tệp)');
    return { header: at, start, end };
  });
  const ordered = [...ranges].sort((a, b) => a.header - b.header);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous && current && current.header < previous.end) throw new ArchiveError('Tệp ZIP bị hỏng (các mục chồng lên nhau)');
  }
  return ranges.map(({ start, end }) => ({ start, end }));
}

function isSkipped(name: string): boolean {
  // Directories, and the resource forks macOS adds to every archive it makes.
  return name.endsWith('/') || name === '__MACOSX' || name.startsWith('__MACOSX/');
}

function decompress(entry: CentralEntry, data: Uint8Array): Uint8Array | ArchiveRejection {
  let out: Uint8Array;
  if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) return 'corrupt';
    out = data;
  } else if (entry.method === DEFLATE) {
    try {
      // maxOutputLength: inflating stops with an error past the declared size, so the declared sizes, already capped
      // in total, bound the memory a bomb can take.
      out = inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      return 'corrupt';
    }
  } else {
    return 'unsupported_method';
  }
  if (out.byteLength !== entry.size || crc32(out) >>> 0 !== entry.crc) return 'corrupt';
  return out;
}

// The name within the contract's string limit, without splitting a surrogate pair (a lone one cannot be stored).
function capName(name: string): string {
  if (name.length <= EXTRACT_LIMITS.maxStringChars) return name;
  const cut = name.slice(0, EXTRACT_LIMITS.maxStringChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
export function readZip(bytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): ExtractedArchive {
  const { entries: all, directoryStart } = readDirectory(bytes, limits);
  if (all.some((e) => e.name === '[Content_Types].xml' || e.name === 'mimetype')) {
    throw new ArchiveError('Đây là tệp Office (xlsx, docx), không phải tệp ZIP chứa hóa đơn');
  }
  const ranges = dataRanges(bytes, all, directoryStart);
  const files = all.map((entry, i) => ({ entry, range: ranges[i] })).filter(({ entry }) => !isSkipped(entry.name));
  if (files.length === 0) throw new ArchiveError('Tệp ZIP không có tệp nào');
  // Declared sizes first, so a bomb is refused before anything is inflated; the inflated sizes are checked against
  // them below.
  const declared = files.reduce((sum, { entry }) => sum + (entry.size <= limits.maxEntryBytes ? entry.size : 0), 0);
  if (declared > limits.maxTotalBytes) {
    throw new ArchiveError(`Tệp ZIP giải nén ra hơn ${Math.floor(limits.maxTotalBytes / (1024 * 1024))} MB; hãy chia thành nhiều tệp ZIP`);
  }

  const result: ExtractedArchive['entries'] = [];
  for (const { entry, range } of files) {
    const reject = (rejected: ArchiveRejection) => result.push({ name: capName(entry.name), sizeBytes: entry.size, content: null, rejected });
    if (entry.flags & FLAG_ENCRYPTED) {
      reject('encrypted');
      continue;
    }
    if (NESTED_NAME.test(entry.name)) {
      reject('nested_archive');
      continue;
    }
    if (entry.size > limits.maxEntryBytes) {
      reject('too_large');
      continue;
    }
    if (!range) {
      reject('corrupt');
      continue;
    }
    const out = decompress(entry, bytes.subarray(range.start, range.end));
    if (typeof out === 'string') {
      reject(out);
      continue;
    }
    if (looksLikeArchive(out)) {
      reject('nested_archive');
      continue;
    }
    result.push({
      name: capName(entry.name),
      sizeBytes: entry.size,
      content: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64'),
      rejected: null,
    });
  }
  return { entries: result };
}
