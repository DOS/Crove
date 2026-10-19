// Period lock on the ledger screen (issue #329): who may lock and unlock, and months counted in Vietnam time, as the
// kernel counts them.
import { describe, expect, it } from 'vitest';
import { canLockPeriods, canUnlockPeriods, currentMonth, monthLabel, previousMonth } from '../src/lib/period-lock.ts';

describe('period lock helpers', () => {
  it('lets owners and admins lock, and only owners unlock', () => {
    expect(['owner', 'admin', 'member', 'viewer', null].map((r) => canLockPeriods(r))).toEqual([true, true, false, false, false]);
    expect(['owner', 'admin', 'member', 'viewer', undefined].map((r) => canUnlockPeriods(r))).toEqual([true, false, false, false, false]);
  });

  it('reads the month in Vietnam time (UTC+7)', () => {
    // 17:00 UTC on 30 September is already 1 October in Vietnam.
    expect(currentMonth(new Date('2026-09-30T16:59:59Z'))).toBe('2026-09');
    expect(currentMonth(new Date('2026-09-30T17:00:00Z'))).toBe('2026-10');
    expect(currentMonth(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01');
  });

  it('steps back a month across the year and writes it as Vietnamese accounting does', () => {
    expect(previousMonth('2026-10')).toBe('2026-09');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(monthLabel('2026-09')).toBe('09/2026');
  });
});
