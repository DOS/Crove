// Which errors of a nested approval refuse only that item of a bulk approval (issue #315): an explicit list of
// per-proposal codes, never a status. The database flows are in bulk-approve-api.db.test.ts and the invariant suite.
import { describe, expect, it } from 'vitest';
import { BULK_ITEM_REFUSALS, bulkApproveOrder, isBulkItemRefusal } from '@crove/kernel';
import { DomainError } from '@crove/kernel-runtime';

describe('bulk approval item refusals', () => {
  it('refuses one item for its proposal, policy or content codes', () => {
    for (const [code, status] of [
      ['NOT_FOUND', 404],
      ['PROPOSAL_DECIDED', 409],
      ['STALE_REVISION', 409],
      ['FOUR_EYES_REQUIRED', 403],
      ['NOT_ELIGIBLE', 403],
      ['CHECKS_FAILED', 422],
      ['DUPLICATE_INVOICE', 409],
      ['NOT_OWN_SALE', 422],
      ['OWN_INVOICE', 422],
      ['PERIOD_LOCKED', 409],
    ] as const) {
      expect(isBulkItemRefusal(new DomainError(code, status, 'refused'))).toBe(true);
    }
  });

  it('aborts the batch for any other code, whatever its status', () => {
    for (const [code, status] of [
      ['FORBIDDEN', 403],
      ['STEP_UP_REQUIRED', 403],
      ['CONFLICT', 409],
      ['RETRY', 409],
      ['INVALID', 422],
      ['VALIDATION', 422],
      ['SOMETHING_NEW', 409],
      ['INTERNAL', 500],
    ] as const) {
      expect(isBulkItemRefusal(new DomainError(code, status, 'refused'))).toBe(false);
    }
    expect(isBulkItemRefusal(new Error('pg: deadlock detected'))).toBe(false);
    expect(isBulkItemRefusal(Object.assign(new Error('look-alike'), { code: 'NOT_FOUND', status: 404 }))).toBe(false);
  });

  it('never lists a code that concerns the whole batch', () => {
    for (const code of ['FORBIDDEN', 'STEP_UP_REQUIRED', 'AUTH_UNAVAILABLE', 'NOT_A_MEMBER', 'INTERNAL', 'RETRY']) {
      expect(BULK_ITEM_REFUSALS.has(code)).toBe(false);
    }
  });
});

describe('bulk approval order (#509)', () => {
  const item = (id: string) => ({ id, revision: 1 });

  it('keeps id order for every proposal that is not a voucher', () => {
    expect(bulkApproveOrder([item('c'), item('a'), item('b')], new Map()).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('runs vouchers after the rest, by voucher type then id, so concurrent batches take numbering locks in one order', () => {
    const types = new Map([
      ['a', 'cash_payment'],
      ['b', 'cash_receipt'],
      ['d', 'bank_debit'],
      ['e', 'bank_credit'],
      ['f', 'cash_receipt'],
    ]);
    const order = bulkApproveOrder([item('f'), item('e'), item('d'), item('c'), item('b'), item('a'), item('g')], types).map((i) => i.id);
    expect(order).toEqual(['c', 'g', 'b', 'f', 'a', 'e', 'd']);
    // Two batches that would cross in id order (PT then PC, and PC then PT) both take PT first.
    expect(bulkApproveOrder([item('b'), item('a')], types).map((i) => types.get(i.id))).toEqual(['cash_receipt', 'cash_payment']);
    expect(bulkApproveOrder([item('a'), item('f')], types).map((i) => types.get(i.id))).toEqual(['cash_receipt', 'cash_payment']);
  });

  it('does not change the items it is given', () => {
    const items = [item('b'), item('a')];
    bulkApproveOrder(items, new Map());
    expect(items.map((i) => i.id)).toEqual(['b', 'a']);
  });
});
