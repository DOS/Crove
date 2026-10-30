// Bulk intake state (issue #314): what the Inbox shows for each file of an upload batch, and when it stops polling.
import { describe, expect, it } from 'vitest';
import type { BatchFile, FileStatus } from '@crove/kernel-contract';
import {
  ARCHIVES_PER_POLL,
  MAX_INTAKE_FILES,
  applyBatch,
  eachLimited,
  fitsBatch,
  isSettled,
  newItem,
  pendingIds,
  pollGroups,
  precheck,
  summarize,
  undecidedIds,
  uploaded,
  withProposalStatuses,
} from '../src/lib/intake.ts';

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const status = (id: string, value: FileStatus['status'], error: string | null = null): FileStatus => ({
  id,
  filename: 'x',
  contentType: 'application/xml',
  status: value,
  error,
  proposalId: null,
  proposalStatus: null,
  version: 1,
  canReextract: false,
  createdAt: '2026-10-18T00:00:00.000Z',
});
const batchFile = (id: string, value: FileStatus['status'], entries: BatchFile['entries'] = null, truncated = false): BatchFile => ({
  ...status(id, value),
  entries,
  entryCount: entries === null ? null : entries.length + (truncated ? 1 : 0),
  entriesTruncated: truncated,
});

describe('bulk intake state', () => {
  it('prechecks size and extension; the server still decides by content', () => {
    expect(precheck({ name: 'hd.XML', size: 10 })).toBe('ok');
    expect(precheck({ name: 'thang-10.zip', size: 10 })).toBe('ok');
    expect(precheck({ name: 'bang-ke.xlsx', size: 10 })).toBe('unsupported');
    expect(precheck({ name: 'noextension', size: 10 })).toBe('unsupported');
    expect(precheck({ name: 'big.pdf', size: 25 * 1024 * 1024 + 1 })).toBe('too_large');
    expect(MAX_INTAKE_FILES).toBe(500);
  });

  it('follows uploaded files until each is read, and keeps what settled', () => {
    let items = [newItem('a', 'a.xml'), newItem('b', 'b.xml'), newItem('c', 'c.xml')];
    items = [uploaded(items[0]!, { fileId: ID(1), duplicate: false }), uploaded(items[1]!, { fileId: ID(2), duplicate: true }), { ...items[2]!, state: 'upload_failed' }];
    expect(items.map((i) => i.state)).toEqual(['processing', 'duplicate', 'upload_failed']);
    // Only the new file is asked about: the duplicate was already in the org, the refused one never arrived.
    expect(pendingIds(items)).toEqual([ID(1)]);
    expect(isSettled(items)).toBe(false);

    items = applyBatch(items, [batchFile(ID(1), 'proposed')]);
    expect(items.map((i) => i.state)).toEqual(['proposed', 'duplicate', 'upload_failed']);
    expect(pendingIds(items)).toEqual([]);
    expect(isSettled(items)).toBe(true);
    // A later answer that leaves a settled file out does not undo it.
    expect(applyBatch(items, []).map((i) => i.state)).toEqual(['proposed', 'duplicate', 'upload_failed']);
    expect(summarize(items)).toEqual({ total: 3, settled: 3, proposed: 1, duplicate: 1, failed: 1 });
  });

  it("carries a proposed file's proposal status, so its chip tells posted from waiting (#2009)", () => {
    const item = uploaded(newItem('a', 'a.xml'), { fileId: ID(1), duplicate: false });
    expect(item.proposalStatus).toBeNull();
    const waiting = applyBatch([item], [{ ...batchFile(ID(1), 'proposed'), proposalId: ID(9), proposalStatus: 'pending' }]);
    expect(waiting[0]).toMatchObject({ state: 'proposed', proposalStatus: 'pending' });
    const posted = applyBatch(waiting, [{ ...batchFile(ID(1), 'proposed'), proposalId: ID(9), proposalStatus: 'executed' }]);
    expect(posted[0]).toMatchObject({ state: 'proposed', proposalStatus: 'executed' });
    // An archive's entries carry theirs too.
    const zip = uploaded(newItem('z', 'z.zip'), { fileId: ID(2), duplicate: false });
    const entry = { name: 'x.xml', outcome: 'stored' as const, reason: null, file: { ...status(ID(3), 'proposed'), proposalId: ID(8), proposalStatus: 'rejected' as const } };
    const [opened] = applyBatch([zip], [batchFile(ID(2), 'expanded', [entry])]);
    expect(opened?.entries[0]).toMatchObject({ state: 'proposed', proposalStatus: 'rejected' });
  });

  it('asks again about files whose proposal waits, and takes the decision made later (#2009)', () => {
    const zip = uploaded(newItem('z', 'z.zip'), { fileId: ID(2), duplicate: false });
    const waitingEntry = { name: 'x.xml', outcome: 'stored' as const, reason: null, file: { ...status(ID(3), 'proposed'), proposalId: ID(8), proposalStatus: 'pending' as const } };
    const postedEntry = { name: 'y.xml', outcome: 'stored' as const, reason: null, file: { ...status(ID(4), 'proposed'), proposalId: ID(7), proposalStatus: 'executed' as const } };
    const plain = uploaded(newItem('a', 'a.xml'), { fileId: ID(1), duplicate: false });
    let items = applyBatch(
      [plain, zip],
      [
        { ...batchFile(ID(1), 'proposed'), proposalId: ID(9), proposalStatus: 'pending' },
        batchFile(ID(2), 'expanded', [waitingEntry, postedEntry]),
      ],
    );
    // Settled, so no longer polled; the two still waiting are watched, the posted one is not.
    expect(pendingIds(items)).toEqual([]);
    expect(undecidedIds(items)).toEqual([ID(1), ID(3)]);
    items = withProposalStatuses(items, [
      { ...status(ID(1), 'proposed'), proposalId: ID(9), proposalStatus: 'executed' },
      { ...status(ID(3), 'proposed'), proposalId: ID(8), proposalStatus: 'rejected' },
    ]);
    expect(items[0]).toMatchObject({ proposalStatus: 'executed' });
    expect(items[1]?.entries.map((e) => e.proposalStatus)).toEqual(['rejected', 'executed']);
    expect(undecidedIds(items)).toEqual([]);
  });

  it('turns an opened archive into its entries and polls it while an entry is being read', () => {
    let items = [uploaded(newItem('z', 'thang-10.zip'), { fileId: ID(10), duplicate: false })];
    expect(items[0]?.archive).toBe(true);
    items = applyBatch(items, [batchFile(ID(10), 'processing')]);
    expect(summarize(items)).toMatchObject({ total: 1, settled: 0 });

    items = applyBatch(items, [
      batchFile(ID(10), 'expanded', [
        { name: 'hd-1.xml', outcome: 'stored', reason: null, file: status(ID(11), 'proposed') },
        { name: 'hd-2.xml', outcome: 'stored', reason: null, file: status(ID(12), 'processing') },
        { name: 'hd-3.xml', outcome: 'duplicate', reason: null, file: status(ID(13), 'proposed') },
        { name: 'inner.zip', outcome: 'rejected', reason: 'nested_archive', file: null },
      ]),
    ]);
    expect(items[0]?.entries.map((e) => [e.name, e.state])).toEqual([
      ['hd-1.xml', 'proposed'],
      ['hd-2.xml', 'processing'],
      ['hd-3.xml', 'duplicate'],
      ['inner.zip', 'rejected'],
    ]);
    expect(items[0]?.entries[3]?.reason).toBe('nested_archive');
    expect(summarize(items)).toEqual({ total: 4, settled: 3, proposed: 1, duplicate: 1, failed: 1 });
    expect(pendingIds(items)).toEqual([ID(10)]);

    items = applyBatch(items, [
      batchFile(ID(10), 'expanded', [
        { name: 'hd-1.xml', outcome: 'stored', reason: null, file: status(ID(11), 'proposed') },
        { name: 'hd-2.xml', outcome: 'stored', reason: null, file: status(ID(12), 'failed', 'Không đọc được XML hóa đơn điện tử') },
        { name: 'hd-3.xml', outcome: 'duplicate', reason: null, file: status(ID(13), 'proposed') },
        { name: 'inner.zip', outcome: 'rejected', reason: 'nested_archive', file: null },
      ]),
    ]);
    expect(items[0]?.entries[1]).toMatchObject({ state: 'failed', error: 'Không đọc được XML hóa đơn điện tử' });
    expect(isSettled(items)).toBe(true);
    expect(pendingIds(items)).toEqual([]);
  });

  it('counts an archive the sandbox refused as one failed file', () => {
    const items = applyBatch([uploaded(newItem('z', 'bad.zip'), { fileId: ID(20), duplicate: false })], [{ ...batchFile(ID(20), 'failed'), error: 'Tệp ZIP có đường dẫn không an toàn: ../x' }]);
    expect(items[0]).toMatchObject({ state: 'failed', error: 'Tệp ZIP có đường dẫn không an toàn: ../x' });
    expect(summarize(items)).toEqual({ total: 1, settled: 1, proposed: 0, duplicate: 0, failed: 1 });
  });

  it('polls archives a few at a time so their entries always fit one answer, and caps the files in flight', () => {
    const archives = Array.from({ length: ARCHIVES_PER_POLL + 1 }, (_, i) => uploaded(newItem(`z${i}`, `z${i}.zip`), { fileId: ID(100 + i), duplicate: false }));
    const plain = [uploaded(newItem('a', 'a.xml'), { fileId: ID(200), duplicate: false }), uploaded(newItem('b', 'b.xml'), { fileId: ID(201), duplicate: true })];
    const groups = pollGroups([...archives, ...plain]);
    expect(groups).toEqual([[...archives.slice(0, ARCHIVES_PER_POLL).map((a) => a.fileId), ID(200)], [archives[ARCHIVES_PER_POLL]?.fileId]]);
    expect(groups.every((g) => g.length <= 500)).toBe(true);

    const inFlight = Array.from({ length: 400 }, (_, i) => uploaded(newItem(`p${i}`, `p${i}.xml`), { fileId: ID(1000 + i), duplicate: false }));
    expect(fitsBatch(inFlight, 100)).toBe(true);
    expect(fitsBatch(inFlight, 101)).toBe(false);
    // A finished batch makes way for the next one.
    expect(fitsBatch([{ ...newItem('x', 'x.xml'), state: 'proposed' }], MAX_INTAKE_FILES)).toBe(true);
  });

  it('keeps an archive whose entries came back cut short as it was, so it is asked about alone and never settles early', () => {
    const item = uploaded(newItem('z', 'big.zip'), { fileId: ID(30), duplicate: false });
    const partial = applyBatch([item], [batchFile(ID(30), 'expanded', [{ name: 'hd-1.xml', outcome: 'stored', reason: null, file: status(ID(31), 'proposed') }], true)]);
    expect(partial[0]).toMatchObject({ state: 'processing', archive: true, entries: [] });
    expect(pendingIds(partial)).toEqual([ID(30)]);
    expect(isSettled(partial)).toBe(false);
  });

  it('runs at most the given number of tasks at once', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(n);
      running -= 1;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
