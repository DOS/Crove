// Bulk approval batches and review shortcuts (issue #315).
import { describe, expect, it } from 'vitest';
import { BULK_LIMIT, bulkSelectable, canApproveProposals, chunks, nextAfterDecision, nextPendingId, planBatches, previousPendingId, proposalName, reviewShortcut, sendBatches, checksByConcern, showMatched, type BulkBatch } from '../src/lib/review.ts';

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
    // A pending cash or bank voucher (#327) has no checks and no duplicate, and goes in a bulk approval too.
    expect(bulkSelectable({ ...row, kind: 'finance.cash_voucher' }, REVERSAL)).toBe(true);
  });

  it('offers bulk approval to owners and admins only', () => {
    expect(['owner', 'admin', 'member', null, undefined].map((r) => canApproveProposals(r))).toEqual([true, true, false, false, false]);
    // A chief accountant (#1279): a member holding the approval permission org-wide.
    expect(canApproveProposals('member', ['finance.proposal.approve'])).toBe(true);
    expect(canApproveProposals('member', ['finance.period.unlock'])).toBe(false);
    expect(canApproveProposals(null, ['finance.proposal.approve'])).toBe(false);
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
  it('maps J and N to next, K and P to previous, A to approve and E to edit, in either case', () => {
    expect([key('j'), key('n'), key('a'), key('e'), key('A'), key('E')]).toEqual(['next', 'next', 'approve', 'edit', 'approve', 'edit']);
    expect([key('k'), key('p'), key('K')]).toEqual(['previous', 'previous', 'previous']);
    // R rejects, or on a Social post asks for changes (#1221).
    expect([key('r'), key('R')]).toEqual(['reject', 'reject']);
    expect(key('r', { ctrlKey: true })).toBeNull();
    expect(key('r', { target: { tagName: 'TEXTAREA' } as unknown as EventTarget })).toBeNull();
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

  it('opens the next item after a decision in the order the reviewer saw (#1221)', () => {
    const before = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
    // p2 approved and gone: on to p3.
    expect(nextAfterDecision(before, [{ id: 'p1' }, { id: 'p3' }, { id: 'p4' }], 'p2')).toBe('p3');
    // p2 still waits for someone else and moved to the top (newest change first): still on to p3, not back to p1.
    expect(nextAfterDecision(before, [{ id: 'p2' }, { id: 'p1' }, { id: 'p3' }, { id: 'p4' }], 'p2')).toBe('p3');
    // p3 was decided elsewhere meanwhile: the one after it.
    expect(nextAfterDecision(before, [{ id: 'p1' }, { id: 'p4' }], 'p2')).toBe('p4');
    // Nothing left below: the first one still waiting above, or one that came in meanwhile.
    expect(nextAfterDecision(before, [{ id: 'p1' }], 'p4')).toBe('p1');
    expect(nextAfterDecision(before, [{ id: 'p9' }, { id: 'p4' }], 'p4')).toBe('p9');
    // None left.
    expect(nextAfterDecision(before, [{ id: 'p4' }], 'p4')).toBeNull();
    expect(nextAfterDecision(before, [], 'p4')).toBeNull();
    expect(nextAfterDecision([], [], 'p1')).toBeNull();
    // The current one was not in the list seen: the first of that list still waiting.
    expect(nextAfterDecision(before, [{ id: 'p3' }, { id: 'p2' }], 'gone')).toBe('p2');
  });

  it('finds the previous pending proposal', () => {
    const items = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    expect(previousPendingId(items, 'p3')).toBe('p2');
    expect(previousPendingId(items, 'p1')).toBeNull();
    expect(previousPendingId(items, 'gone')).toBeNull();
  });

  it('names a proposal after the other party, or its title', () => {
    const base = { sellerName: 'Bao Bì Phú Thịnh', buyerName: 'Gạo Sạch Mekong', title: 'HĐ 00001284' };
    expect(proposalName({ ...base, direction: 'purchase' })).toBe('Bao Bì Phú Thịnh');
    expect(proposalName({ ...base, direction: 'sale' })).toBe('Gạo Sạch Mekong');
    expect(proposalName({ ...base, direction: null, sellerName: '' })).toBe('HĐ 00001284');
  });
});

describe('matched badge (#435)', () => {
  const VOUCHER = 'finance.cash_voucher';
  const row = { kind: 'finance.purchase', failedChecks: 0, warnChecks: 0, duplicateOf: null, requestedByAgent: null as unknown, extracted: true };
  it('shows matched for an extracted purchase with no failed or warning check', () => {
    expect(showMatched(row, REVERSAL, VOUCHER)).toBe(true);
    expect(showMatched({ ...row, warnChecks: 1 }, REVERSAL, VOUCHER)).toBe(false);
    expect(showMatched({ ...row, failedChecks: 1 }, REVERSAL, VOUCHER)).toBe(false);
    expect(showMatched({ ...row, duplicateOf: 'p0' }, REVERSAL, VOUCHER)).toBe(false);
    expect(showMatched({ ...row, kind: REVERSAL }, REVERSAL, VOUCHER)).toBe(false);
    expect(showMatched({ ...row, kind: VOUCHER }, REVERSAL, VOUCHER)).toBe(false);
    // A general journal voucher (#888) is entered by hand and has no checks either.
    expect(showMatched({ ...row, kind: 'finance.journal_voucher', extracted: false }, REVERSAL, VOUCHER, 'finance.journal_voucher')).toBe(false);
  });
  it('never shows matched for an agent proposal that no extraction read', () => {
    const agent = { id: 'a1', name: 'Kế toán AI' };
    expect(showMatched({ ...row, requestedByAgent: agent, extracted: false }, REVERSAL, VOUCHER)).toBe(false);
    // A human-checked extraction of an agent's request would still show it.
    expect(showMatched({ ...row, requestedByAgent: agent, extracted: true }, REVERSAL, VOUCHER)).toBe(true);
  });
});

describe('check order (#1409)', () => {
  it('lists failed checks first, then warnings, then passes, keeping the stored order in each group', () => {
    const checks = [
      { id: 'a', status: 'pass' },
      { id: 'b', status: 'warn' },
      { id: 'c', status: 'fail' },
      { id: 'd', status: 'pass' },
      { id: 'e', status: 'warn' },
    ];
    expect(checksByConcern(checks).map((c) => c.id)).toEqual(['c', 'b', 'e', 'a', 'd']);
  });
});
