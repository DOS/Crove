// The tax calendar on the home screen (#921): the list across clients by due date, period parts, who may mark done.
import { describe, expect, it } from 'vitest';
import { canMarkTaxDone, dueAcrossClients, entityToMark, taxPeriodParts } from '../src/lib/tax-calendar.ts';

const due = (obligation: 'vat_return' | 'cit_provisional', period: string, dueDate: string) => ({ obligation, period, dueDate, daysLeft: 0, legalBasis: 'x', confirmed: false, openEntities: [] });

describe('tax calendar on the home screen', () => {
  it('lists every client dues by due date, then by client name', () => {
    const rows = dueAcrossClients(
      [
        { orgId: 'b', slug: 'b', name: 'Beta', role: 'owner', overview: { taxDues: [due('vat_return', '2026-09', '2026-10-20'), due('cit_provisional', '2026-Q3', '2026-10-30')] } },
        { orgId: 'a', slug: 'a', name: 'Alpha', role: 'member', overview: { taxDues: [due('vat_return', '2026-Q3', '2026-11-02'), due('vat_return', '2026-09', '2026-10-20')] } },
        { orgId: 'c', slug: 'c', name: 'Gamma', role: 'viewer', overview: {} },
      ],
      'vi',
    );
    expect(rows.map((r) => [r.dueDate, r.name, r.period])).toEqual([
      ['2026-10-20', 'Alpha', '2026-09'],
      ['2026-10-20', 'Beta', '2026-09'],
      ['2026-10-30', 'Beta', '2026-Q3'],
      ['2026-11-02', 'Alpha', '2026-Q3'],
    ]);
  });

  it('reads a year, a month and a quarter, and lets members but not viewers mark done', () => {
    expect(taxPeriodParts('2026')).toEqual({ kind: 'year', year: 2026 });
    expect(taxPeriodParts('2026-09')).toEqual({ kind: 'month', index: 9, year: 2026 });
    expect(taxPeriodParts('2026-Q3')).toEqual({ kind: 'quarter', index: 3, year: 2026 });
    expect(taxPeriodParts('x')).toBeNull();
    expect(['owner', 'admin', 'member', 'viewer', null].map((role) => canMarkTaxDone(role))).toEqual([true, true, true, false, false]);
    // With finance on, the VAT return's mark records it as filed (#1400): owners and admins only.
    expect(['owner', 'admin', 'member', 'viewer'].map((role) => canMarkTaxDone(role, 'vat_return', true))).toEqual([true, true, false, false]);
    expect(canMarkTaxDone('member', 'vat_return', false)).toBe(true);
    expect(canMarkTaxDone('member', 'cit_provisional', true)).toBe(true);
  });

  it('marks the one open entity, or the chosen one while it is open, and none without a choice (#1553)', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    expect(entityToMark([a], undefined)).toBe('a');
    expect(entityToMark([a], 'b')).toBe('a');
    expect(entityToMark([a, b], 'b')).toBe('b');
    // The chosen entity already marked it: the others must, from their own choice.
    expect(entityToMark([a, b], 'c')).toBeNull();
    // The multi-client home has no choice: it sends the user to the org instead.
    expect(entityToMark([a, b], undefined)).toBeNull();
    expect(entityToMark([], 'a')).toBeNull();
  });
});
