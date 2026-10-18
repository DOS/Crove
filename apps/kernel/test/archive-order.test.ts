// The order kernel.file.archive.record files an archive's entries in (#314): by content, so two archives that share
// files lock the same file rows in the same order whatever their directories say, and the first copy in an archive
// is the one filed.
import { describe, expect, it } from 'vitest';
import { archiveIngestOrder, type ArchiveEntryInput } from '@crove/kernel';
import { entryName, truncateText } from '../src/archive.ts';

const stored = (name: string, sha: string): ArchiveEntryInput => ({
  outcome: 'stored',
  name,
  file: { filename: name, contentType: 'application/xml', sizeBytes: 1, sha256: sha.repeat(64), storageKey: 'k', generation: `content:${sha.repeat(64)}` },
});
const rejected = (name: string): ArchiveEntryInput => ({ outcome: 'rejected', name, reason: 'nested_archive' });

describe('archive ingest order', () => {
  it('files stored entries by sha256, then by their place in the archive, and skips rejected ones', () => {
    const entries = [stored('c.xml', 'c'), rejected('x.zip'), stored('a.xml', 'a'), stored('copy-of-c.xml', 'c'), stored('b.xml', 'b')];
    expect(archiveIngestOrder(entries)).toEqual([2, 4, 0, 3]);
  });

  it('takes the same rows in the same order for two archives that list shared files differently', () => {
    const one = [stored('a.xml', 'a'), stored('b.xml', 'b'), stored('c.xml', 'c')];
    const two = [stored('c.xml', 'c'), stored('a.xml', 'a'), stored('b.xml', 'b')];
    const shas = (entries: ArchiveEntryInput[]) => archiveIngestOrder(entries).map((i) => (entries[i] as Extract<ArchiveEntryInput, { outcome: 'stored' }>).file.sha256);
    expect(shas(one)).toEqual(shas(two));
  });
});

describe('archive entry names', () => {
  it('cut at 255 UTF-16 units never leave half of a surrogate pair, which jsonb refuses', () => {
    const name = `${'a'.repeat(254)}😀.xml`;
    expect(name.charCodeAt(254)).toBeGreaterThanOrEqual(0xd800);
    const cut = entryName(name);
    expect(cut).toBe('a'.repeat(254));
    expect(cut.isWellFormed()).toBe(true);
    expect(truncateText(`${'b'.repeat(253)}😀x`, 255)).toBe(`${'b'.repeat(253)}😀`);
    expect(entryName('')).toBe('(không tên)');
    expect(entryName('thang-10/hd.xml')).toBe('thang-10/hd.xml');
  });
});
