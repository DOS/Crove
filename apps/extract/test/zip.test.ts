// The ZIP reader of bulk intake (issue #314): what it returns from an ordinary archive, what it rejects per entry and
// what refuses the whole archive. One case runs through the real parser process (permission model on).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, zExtractResponse } from '@crove/extract-contract';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { ArchiveError, looksLikeArchive, readZip, safeEntryName } from '../src/zip.ts';
import { buildZip } from './zip-fixture.ts';

const FIXTURE = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));
const decoded = (content: string | null) => (content === null ? null : Buffer.from(content, 'base64'));

describe('readZip', () => {
  it('returns every file entry with its bytes, deflated or stored, in directory order', () => {
    const archive = readZip(
      buildZip([
        { name: 'thang-10/', data: '', method: 'store' },
        { name: 'thang-10/hd-001.xml', data: FIXTURE },
        { name: 'thang-10/hd-002.xml', data: FIXTURE, method: 'store' },
        { name: 'Hóa đơn tháng 10.pdf', data: '%PDF-1.4 test' },
        { name: '__MACOSX/thang-10/._hd-001.xml', data: 'resource fork' },
      ]),
    );
    expect(archive.entries.map((e) => e.name)).toEqual(['thang-10/hd-001.xml', 'thang-10/hd-002.xml', 'Hóa đơn tháng 10.pdf']);
    expect(archive.entries.every((e) => e.rejected === null)).toBe(true);
    expect(decoded(archive.entries[0]?.content ?? null)?.equals(FIXTURE)).toBe(true);
    expect(decoded(archive.entries[1]?.content ?? null)?.equals(FIXTURE)).toBe(true);
    expect(archive.entries[0]?.sizeBytes).toBe(FIXTURE.byteLength);
  });

  it('rejects encrypted, nested, unsupported, oversized and corrupt entries one by one and keeps the rest', () => {
    const inner = buildZip([{ name: 'a.xml', data: FIXTURE }]);
    const archive = readZip(
      buildZip([
        { name: 'ok.xml', data: FIXTURE },
        { name: 'secret.xml', data: FIXTURE, encrypted: true },
        { name: 'inner.zip', data: inner },
        { name: 'renamed.xml', data: inner, method: 'store' },
        { name: 'packed.7z', data: 'whatever' },
        { name: 'bzip.xml', data: FIXTURE, method: 12 },
        { name: 'bad-crc.xml', data: FIXTURE, crc: 1 },
        { name: 'lying-size.xml', data: FIXTURE, size: 10 },
        { name: 'huge.xml', data: 'x', method: 'store', size: EXTRACT_LIMITS.maxFileBytes + 1 },
      ]),
    );
    expect(archive.entries.map((e) => [e.name, e.rejected])).toEqual([
      ['ok.xml', null],
      ['secret.xml', 'encrypted'],
      ['inner.zip', 'nested_archive'],
      ['renamed.xml', 'nested_archive'],
      ['packed.7z', 'nested_archive'],
      ['bzip.xml', 'unsupported_method'],
      ['bad-crc.xml', 'corrupt'],
      ['lying-size.xml', 'corrupt'],
      ['huge.xml', 'too_large'],
    ]);
    expect(archive.entries.filter((e) => e.rejected !== null).every((e) => e.content === null)).toBe(true);
  });

  it('stops inflating at the declared size, so a bomb that lies about its size is only corrupt', () => {
    const bomb = new Uint8Array(20 * 1024 * 1024);
    const archive = readZip(buildZip([{ name: 'bomb.xml', data: bomb, size: 1024 }]));
    expect(archive.entries[0]).toMatchObject({ rejected: 'corrupt', content: null });
  });

  it('refuses the whole archive when the declared sizes pass the total', () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    const zip = buildZip([
      { name: 'a.xml', data: big },
      { name: 'b.xml', data: big },
    ]);
    expect(() => readZip(zip, { maxEntries: 10, maxTotalBytes: 5 * 1024 * 1024, maxEntryBytes: 4 * 1024 * 1024 })).toThrow(ArchiveError);
  });

  it('refuses more entries than allowed before reading any of them', () => {
    const zip = buildZip(Array.from({ length: 4 }, (_, i) => ({ name: `hd-${i}.xml`, data: FIXTURE })));
    expect(() => readZip(zip, { maxEntries: 3, maxTotalBytes: 1024 * 1024, maxEntryBytes: 1024 * 1024 })).toThrow(/hơn 3 mục/);
  });

  it.each(['../evil.xml', 'a/../../evil.xml', '/etc/passwd', '\\windows\\evil.xml', 'C:/evil.xml', 'c:evil.xml', 'a\\..\\evil.xml'])(
    'refuses the whole archive for the entry name %s',
    (name) => {
      expect(() => readZip(buildZip([{ name: 'ok.xml', data: FIXTURE }, { name, data: FIXTURE }]))).toThrow(/đường dẫn không an toàn/);
    },
  );

  it('keeps names that only look odd, with / separators', () => {
    expect(safeEntryName('thang..10/hd.xml')).toBe('thang..10/hd.xml');
    expect(safeEntryName('a\\b.xml')).toBe('a/b.xml');
    expect(() => safeEntryName('a\0b.xml')).toThrow(ArchiveError);
  });

  it('refuses overlapping entries, ZIP64, Office documents, empty archives and things that are not ZIP files', () => {
    expect(() => readZip(buildZip([{ name: 'a.xml', data: FIXTURE }, { name: 'b.xml', data: FIXTURE, sameDataAs: 0 }]))).toThrow(/chồng lên nhau/);
    expect(() => readZip(buildZip([{ name: 'a.xml', data: FIXTURE }], { zip64Locator: true }))).toThrow(/ZIP64/);
    expect(() => readZip(buildZip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'xl/workbook.xml', data: '<x/>' }]))).toThrow(/Office/);
    expect(() => readZip(buildZip([{ name: 'empty/', data: '', method: 'store' }]))).toThrow(/không có tệp nào/);
    expect(() => readZip(new TextEncoder().encode('<xml>not a zip</xml>'))).toThrow(ArchiveError);
    expect(() => readZip(new Uint8Array(0))).toThrow(ArchiveError);
  });

  it('finds the end of the directory behind a comment, and not inside one', () => {
    const zip = buildZip([{ name: 'a.xml', data: FIXTURE }], { comment: 'PK\u0005\u0006 looks like a record' });
    expect(readZip(zip).entries).toHaveLength(1);
    // Cut off: the record no longer ends where the file does.
    expect(() => readZip(zip.subarray(0, zip.length - 3))).toThrow(ArchiveError);
  });

  it('recognises other archives by their first bytes', () => {
    expect(looksLikeArchive(buildZip([{ name: 'a.xml', data: 'x' }]))).toBe(true);
    expect(looksLikeArchive(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe(true);
    expect(looksLikeArchive(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0]))).toBe(true);
    expect(looksLikeArchive(FIXTURE)).toBe(false);
  });
});

describe('the zip kind', () => {
  it('answers a refused archive as invalid with the reason, within the contract', async () => {
    const result = await parse('zip', buildZip([{ name: '../x.xml', data: FIXTURE }]));
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(zExtractResponse.safeParse(result).success).toBe(true);
  });

  it('opens 200 invoices in the sandboxed parser process', { timeout: 60_000 }, async () => {
    const xml = FIXTURE.toString('utf8');
    const zip = buildZip(Array.from({ length: 200 }, (_, i) => ({ name: `hd-${String(i).padStart(3, '0')}.xml`, data: xml.replace('<SHDon>', `<SHDon>${i}`) })));
    const result = await runSandboxed('zip', zip);
    if (!result.ok || result.kind !== 'zip') throw new Error(`unexpected answer ${JSON.stringify(result).slice(0, 300)}`);
    expect(result.archive.entries).toHaveLength(200);
    expect(result.archive.entries.every((e) => e.rejected === null && e.content !== null)).toBe(true);
  });
});
