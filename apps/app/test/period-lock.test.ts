// Period lock on the ledger screen (issue #329): who may lock and unlock, and month and day steps. Today and this month
// in Vietnam are @crove/kernel-contract vietnamToday and vietnamMonth (#560), tested there.
import { describe, expect, it } from 'vitest';
import { canLockPeriods, canUnlockPeriods, monthLabel, nextDay, postingDateAllowed, previousMonth } from '../src/lib/period-lock.ts';

describe('period lock helpers', () => {
  it('lets owners and admins lock, and only owners unlock', () => {
    expect(['owner', 'admin', 'member', 'viewer', null].map((r) => canLockPeriods(r))).toEqual([true, true, false, false, false]);
    expect(['owner', 'admin', 'member', 'viewer', undefined].map((r) => canUnlockPeriods(r))).toEqual([true, false, false, false, false]);
    // A chief accountant (#1279, ADR-0021).
    expect(canUnlockPeriods('member', ['finance.period.unlock'])).toBe(true);
    expect(canUnlockPeriods('admin', ['finance.proposal.approve'])).toBe(false);
  });

  it('steps back a month across the year and writes it as Vietnamese accounting does', () => {
    expect(previousMonth('2026-10')).toBe('2026-09');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(monthLabel('2026-09')).toBe('09/2026');
  });

  it('offers the first open day for a late invoice and takes only open days up to today (#478)', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(postingDateAllowed('2026-10-01', '2026-09-30', '2026-10-19')).toBe(true);
    expect(postingDateAllowed('2026-10-19', '2026-09-30', '2026-10-19')).toBe(true);
    expect(postingDateAllowed('2026-09-30', '2026-09-30', '2026-10-19')).toBe(false);
    expect(postingDateAllowed('2026-10-20', '2026-09-30', '2026-10-19')).toBe(false);
    expect(postingDateAllowed('', '2026-09-30', '2026-10-19')).toBe(false);
  });
});
