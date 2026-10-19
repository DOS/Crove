// The tax portal reconciliation screen's helpers (issue #465).
import { describe, expect, it } from 'vitest';
import { RECONCILE_OUTCOMES, type PortalReconciliation } from '@crove/kernel-contract';
import { SECTIONS, canImportPortalList, invoiceLabel, itemsByOutcome, outcomeTotal, pickProblem, pollWhilePending, type ReconcileItem } from '../src/lib/portal-list.ts';

const item = (outcome: ReconcileItem['outcome']): ReconcileItem => ({ outcome, portal: null, crove: null, differences: [], withoutTaxCode: false, outsidePeriod: false, duplicateRows: 0, duplicateInCrove: false });

describe('portal reconciliation screen', () => {
  it('lets owners, admins and members import, never viewers', () => {
    expect(['owner', 'admin', 'member'].every(canImportPortalList)).toBe(true);
    expect(canImportPortalList('viewer')).toBe(false);
    expect(canImportPortalList(undefined)).toBe(false);
  });

  it('shows every outcome in exactly one section, work first and the quiet ones folded', () => {
    expect(SECTIONS.map((s) => s.outcome).sort()).toEqual([...RECONCILE_OUTCOMES].sort());
    expect(SECTIONS[0]?.outcome).toBe('missing');
    expect(SECTIONS.filter((s) => s.folded).map((s) => s.outcome)).toEqual(['matched', 'void']);
    const grouped = itemsByOutcome([item('missing'), item('matched'), item('missing')]);
    expect(grouped.get('missing')).toHaveLength(2);
    expect(grouped.get('void')).toBeUndefined();
  });

  it('titles a section with its total from the summary, however many items are listed', () => {
    const summary: PortalReconciliation['summary'] = { portalInvoices: 0, matched: 1, inInbox: 2, amountMismatch: 3, missing: 4, voidInCrove: 5, void: 6, notOnPortal: 7, duplicateRows: 0 };
    expect(Object.fromEntries(RECONCILE_OUTCOMES.map((o) => [o, outcomeTotal(summary, o)]))).toEqual({
      matched: 1,
      in_inbox: 2,
      amount_mismatch: 3,
      missing: 4,
      void_in_crove: 5,
      void: 6,
      not_on_portal: 7,
    });
  });

  it('polls only while a list is being read', () => {
    const data = (status: 'pending' | 'done') => ({ lists: [{ status }] }) as unknown as PortalReconciliation;
    expect(pollWhilePending(data('pending'))).toBe(2000);
    expect(pollWhilePending(data('done'))).toBe(false);
    expect(pollWhilePending(undefined)).toBe(false);
  });

  it('checks the picked file before uploading it', () => {
    expect(pickProblem({ name: 'DANH SÁCH HÓA ĐƠN.xlsx', size: 1000 })).toBeNull();
    expect(pickProblem({ name: 'ds.XLSX', size: 1000 })).toBeNull();
    expect(pickProblem({ name: 'ds.xls', size: 1000 })).toBe('not_xlsx');
    expect(pickProblem({ name: 'ds.csv', size: 1000 })).toBe('not_xlsx');
    expect(pickProblem({ name: 'ds.xlsx', size: 11 * 1024 * 1024 })).toBe('too_large');
  });

  it('labels an invoice by template, series and number', () => {
    expect(invoiceLabel({ template: '1', series: 'C26TAA', number: '123' })).toBe('1C26TAA-123');
    expect(invoiceLabel({ template: null, series: 'C26TAA', number: '123' })).toBe('C26TAA-123');
  });
});
