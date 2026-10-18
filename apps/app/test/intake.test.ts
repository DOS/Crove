// Bulk intake state (issue #314): what the Inbox shows for each file of an upload batch, and when it stops polling.
import { describe, expect, it } from 'vitest';
import type { BatchFile, FileStatus } from '@crove/kernel-contract';
import { MAX_INTAKE_FILES, applyBatch, eachLimited, isSettled, newItem, pendingIds, precheck, summarize, uploaded } from '../src/lib/intake.ts';

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const status = (id: string, value: FileStatus['status'], error: string | null = null): FileStatus => ({
  id,
  filename: 'x',
  contentType: 'application/xml',
  status: value,
  error,
  proposalId: null,
  version: 1,
  canReextract: false,
  createdAt: '2026-10-18T00:00:00.000Z',
});
const batchFile = (id: string, value: FileStatus['status'], entries: BatchFile['entries'] = null): BatchFile => ({ ...status(id, value), entries });

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
