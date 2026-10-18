// Period lock (issue #329): months in Vietnam time, the month after or before one, and the answer to a posting the
// database guard refused. The lock itself is tested on PostgreSQL in apps/kernel/test/finance-period-lock.db.test.ts.
import { describe, expect, it } from 'vitest';
import { periodLockedError, shiftMonth, vietnamMonth } from '../src/period-lock.ts';

describe('period lock', () => {
  it('reads the month in Vietnam time and steps across years', () => {
    expect(vietnamMonth(new Date('2026-08-31T16:59:59Z'))).toBe('2026-08');
    expect(vietnamMonth(new Date('2026-08-31T17:00:00Z'))).toBe('2026-09');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-09', 1)).toBe('2026-10');
  });

  it('answers PERIOD_LOCKED for the guard refusal only', () => {
    const refused = periodLockedError({ code: '55000', message: 'PERIOD_LOCKED', detail: '{"lockedThrough" : "2026-08-31", "entryDate" : "2026-08-25"}' });
    expect(refused).toMatchObject({ code: 'PERIOD_LOCKED', status: 409, details: { lockedThrough: '2026-08-31', entryDate: '2026-08-25' } });
    expect(refused?.message).toContain('31/08/2026');
    expect(refused?.message).toContain('25/08/2026');
    // A malformed detail still answers PERIOD_LOCKED, without dates.
    expect(periodLockedError({ code: '55000', message: 'PERIOD_LOCKED', detail: 'not json' })).toMatchObject({ details: { lockedThrough: null, entryDate: null } });
    expect(periodLockedError({ code: '55000', message: 'AUTH_GRANTS_MISSING' })).toBeNull();
    expect(periodLockedError({ code: '23514', message: 'PERIOD_LOCKED' })).toBeNull();
    expect(periodLockedError(new Error('boom'))).toBeNull();
  });
});
