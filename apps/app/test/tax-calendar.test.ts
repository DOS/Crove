// The tax calendar on the home screen (#921): the list across clients by due date, period parts, who may mark done.
import { describe, expect, it } from 'vitest';
import { dueAcrossClients, entityToMark, markableEntities, taxPeriodParts } from '../src/lib/tax-calendar.ts';

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

  it('reads a year, a month and a quarter, and offers the mark only where the server says it is taken (#1917)', () => {
    expect(taxPeriodParts('2026')).toEqual({ kind: 'year', year: 2026 });
    expect(taxPeriodParts('2026-09')).toEqual({ kind: 'month', index: 9, year: 2026 });
    expect(taxPeriodParts('2026-Q3')).toEqual({ kind: 'quarter', index: 3, year: 2026 });
    expect(taxPeriodParts('x')).toBeNull();
    // The server answers per open entity; the screens keep the ones it may be marked in, in order.
    const open = [
      { id: 'a', name: 'A', canMark: false },
      { id: 'b', name: 'B', canMark: true },
      { id: 'c', name: 'C', canMark: true },
    ];
    expect(markableEntities({ openEntities: open }).map((e) => e.id)).toEqual(['b', 'c']);
    expect(markableEntities({ openEntities: [{ id: 'a', name: 'A', canMark: false }] })).toEqual([]);
    // A single entity the user may mark is marked without a choice; one they may not, never.
    expect(entityToMark(markableEntities({ openEntities: open.slice(0, 2) }), undefined)).toBe('b');
    expect(entityToMark(markableEntities({ openEntities: open.slice(0, 2) }), 'a')).toBeNull();
  });

  it('marks the chosen entity while it is open, or the one open entity without a choice (#1553)', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    // No choice (the multi-client home, or the entity list not known yet): the one open entity.
    expect(entityToMark([a], undefined)).toBe('a');
    expect(entityToMark([a], null)).toBe('a');
    expect(entityToMark([a], 'a')).toBe('a');
    // Working in b, which already marked it: a's due is not marked from b.
    expect(entityToMark([a], 'b')).toBeNull();
    expect(entityToMark([a, b], 'b')).toBe('b');
    // The chosen entity already marked it: the others must, from their own choice.
    expect(entityToMark([a, b], 'c')).toBeNull();
    // The multi-client home has no choice: it sends the user to the org instead.
    expect(entityToMark([a, b], undefined)).toBeNull();
    expect(entityToMark([], 'a')).toBeNull();
  });
});
