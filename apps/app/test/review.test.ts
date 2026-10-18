// Bulk approval batches and review shortcuts (issue #315).
import { describe, expect, it } from 'vitest';
import { BULK_LIMIT, bulkSelectable, canApproveProposals, chunks, nextPendingId, planBatches, reviewShortcut, sendBatches, type BulkBatch } from '../src/lib/review.ts';

const REVERSAL = 'finance.reversal';

const key = (k: string, extra: Partial<Parameters<typeof reviewShortcut>[0]> = {}) =>
  reviewShortcut({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra });

describe('bulk approval', () => {
  it('sends at most 50 proposals per batch, in order', () => {
    const ids = Array.from({ length: 120 }, (_, i) => i);
    const batches = chunks(ids);
    expect(BULK_LIMIT).toBe(50);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(ids);
    expect(chunks([])).toEqual([]);
  });

  it('refuses a chunk size that would never advance', () => {
    for (const size of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => chunks([1, 2], size)).toThrow(RangeError);
    expect(chunks([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it('selects only pending purchases without a failed check or a duplicate warning', () => {
    const row = { status: 'pending', failedChecks: 0, kind: 'finance.purchase', duplicateOf: null };
    expect(bulkSelectable(row, REVERSAL)).toBe(true);
    expect(bulkSelectable({ ...row, failedChecks: 1 }, REVERSAL)).toBe(false);
    expect(bulkSelectable({ ...row, status: 'executed' }, REVERSAL)).toBe(false);
    expect(bulkSelectable({ ...row, duplicateOf: 'p0' }, REVERSAL)).toBe(false);
    expect(bulkSelectable({ ...row, kind: REVERSAL }, REVERSAL)).toBe(false);
  });

  it('offers bulk approval to owners and admins only', () => {
    expect(['owner', 'admin', 'member', null, undefined].map(canApproveProposals)).toEqual([true, true, false, false, false]);
  });

  it('plans batches with one fixed idempotency key each', () => {
    let n = 0;
    const items = Array.from({ length: 51 }, (_, i) => ({ id: `p${i}`, revision: 1 }));
    const batches = planBatches(items, () => `k${(n += 1)}`);
    expect(batches.map((b) => [b.items.length, b.idempotencyKey])).toEqual([
      [50, 'k1'],
      [1, 'k2'],
    ]);
  });

  it('stops at a failed batch and resumes from it with the same request', async () => {
    const batches = planBatches(
      Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, revision: 1 })),
      () => 'key',
    );
    const sent: BulkBatch[] = [];
    let stale = true;
    const send = async (batch: BulkBatch) => {
      sent.push(batch);
      // The second batch meets a step-up gone stale the first time.
      if (sent.length === 2 && stale) {
        stale = false;
        throw Object.assign(new Error('stale'), { code: 'STEP_UP_REQUIRED' });
      }
      return { results: batch.items.map((i) => ({ id: i.id, outcome: 'approved' as const })) };
    };
    const seen: number[] = [];
    const first = await sendBatches(batches, { results: [], next: 0 }, send, (p) => seen.push(p.next));
    expect(first).toMatchObject({ next: 1, error: { code: 'STEP_UP_REQUIRED' } });
    expect(first.results).toHaveLength(50);
    expect(seen).toEqual([1]);

    const done = await sendBatches(batches, first, send);
    expect(done).toMatchObject({ next: 3, error: null });
    expect(done.results.map((r) => r.id)).toEqual(batches.flatMap((b) => b.items.map((i) => i.id)));
    // The refused batch was sent again as it was.
    expect(sent[2]).toBe(sent[1]);
  });
});

describe('review shortcuts', () => {
  it('maps J and N to next, A to approve and E to edit, in either case', () => {
    expect([key('j'), key('n'), key('a'), key('e'), key('A'), key('E')]).toEqual(['next', 'next', 'approve', 'edit', 'approve', 'edit']);
    expect(key('x')).toBeNull();
    expect(key('Enter')).toBeNull();
  });

  it('ignores keys with a modifier, held down, already handled, or typed into a field', () => {
    expect(key('a', { ctrlKey: true })).toBeNull();
    expect(key('a', { metaKey: true })).toBeNull();
    expect(key('a', { altKey: true })).toBeNull();
    expect(key('a', { repeat: true })).toBeNull();
    expect(key('a', { defaultPrevented: true })).toBeNull();
    for (const tagName of ['INPUT', 'textarea', 'SELECT']) expect(key('a', { target: { tagName } as unknown as EventTarget })).toBeNull();
    expect(key('a', { target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget })).toBeNull();
    expect(key('a', { target: { tagName: 'BODY' } as unknown as EventTarget })).toBe('approve');
  });

  it('finds the next pending proposal', () => {
    const items = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    expect(nextPendingId(items, 'p1')).toBe('p2');
    expect(nextPendingId(items, 'p3')).toBeNull();
    // The current one was just decided and left the pending list.
    expect(nextPendingId(items, 'gone')).toBe('p1');
    expect(nextPendingId([], 'gone')).toBeNull();
  });
});
