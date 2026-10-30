// SPDX-License-Identifier: AGPL-3.0-only
// The periods the statements' comparison columns read (#2090): the same period of the previous year, the period right
// before a month or a quarter, and the end of the previous year for B01's start of year.
import { describe, expect, it } from 'vitest';
import { ledgerPeriod } from '../src/domain/ledger-reports.ts';
import { comparisonPlan } from '../src/domain/statement-comparison.ts';

const plan = (period: string) => {
  const p = comparisonPlan(ledgerPeriod(period));
  return { startOfYear: p.startOfYear, lastYear: p.lastYear?.period ?? null, previous: p.previous?.period ?? null };
};

describe('comparisonPlan', () => {
  it('compares a year with the previous year and has no period before it', () => {
    expect(plan('2026')).toEqual({ startOfYear: '2025-12-31', lastYear: '2025', previous: null });
  });

  it('compares a month with the same month last year, and the month before as the second choice', () => {
    expect(plan('2026-09')).toEqual({ startOfYear: '2025-12-31', lastYear: '2025-09', previous: '2026-08' });
    expect(plan('2026-12')).toEqual({ startOfYear: '2025-12-31', lastYear: '2025-12', previous: '2026-11' });
  });

  it('crosses the year end: January follows the previous December, the first quarter the previous fourth', () => {
    expect(plan('2026-01')).toEqual({ startOfYear: '2025-12-31', lastYear: '2025-01', previous: '2025-12' });
    expect(plan('2026-Q1')).toEqual({ startOfYear: '2025-12-31', lastYear: '2025-Q1', previous: '2025-Q4' });
    expect(plan('2026-Q2')).toEqual({ startOfYear: '2025-12-31', lastYear: '2025-Q2', previous: '2026-Q1' });
  });

  it('reads the real dates of the compared periods', () => {
    const p = comparisonPlan(ledgerPeriod('2026-03'));
    expect([p.lastYear?.from, p.lastYear?.to]).toEqual(['2025-03-01', '2025-03-31']);
    expect([p.previous?.from, p.previous?.to]).toEqual(['2026-02-01', '2026-02-28']);
    const leap = comparisonPlan(ledgerPeriod('2025-03'));
    expect(leap.previous?.to).toBe('2025-02-28');
    expect(comparisonPlan(ledgerPeriod('2028-03')).previous?.to).toBe('2028-02-29');
  });

  it('has nothing before the first year the ledger accepts', () => {
    expect(plan('2000')).toEqual({ startOfYear: null, lastYear: null, previous: null });
    expect(plan('2000-06')).toEqual({ startOfYear: null, lastYear: null, previous: '2000-05' });
    expect(plan('2000-01')).toEqual({ startOfYear: null, lastYear: null, previous: null });
    expect(plan('2000-Q1')).toEqual({ startOfYear: null, lastYear: null, previous: null });
    expect(plan('2001-Q1')).toEqual({ startOfYear: '2000-12-31', lastYear: '2000-Q1', previous: '2000-Q4' });
  });
});
