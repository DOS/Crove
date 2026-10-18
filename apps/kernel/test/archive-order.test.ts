// The order kernel.file.archive.record files an archive's entries in (#314): by content, so two archives that share
// files lock the same file rows in the same order whatever their directories say, and the first copy in an archive
// is the one filed.
import { describe, expect, it } from 'vitest';
import { archiveIngestOrder, type ArchiveEntryInput } from '@crove/kernel';

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
