// Period lock (issue #329): the month after or before one, and the answer to a posting the database guard refused
// (months and days in Vietnam time are @crove/kernel-contract vietnamMonth and vietnamToday, tested there). The lock
// itself is tested on PostgreSQL in apps/kernel/test/finance-period-lock.db.test.ts.
import { describe, expect, it } from 'vitest';
import { openingEntryError, periodLockedError, postingGuardError, shiftMonth } from '../src/period-lock.ts';
import { latePostingRefusal } from '../src/record.ts';

describe('period lock', () => {
  it('steps months across years', () => {
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

  it('answers the opening entry rule of the posting guard (#366)', () => {
    const before = openingEntryError({ code: '55000', message: 'BEFORE_OPENING_BALANCE', detail: '{"openingDate" : "2025-12-31", "entryDate" : "2025-12-20"}' });
    expect(before).toMatchObject({ code: 'BEFORE_OPENING_BALANCE', status: 409, details: { openingDate: '2025-12-31', entryDate: '2025-12-20' } });
    expect(before?.message).toContain('31/12/2025');
    expect(before?.message).toContain('20/12/2025');
    expect(openingEntryError({ code: '55000', message: 'OPENING_BALANCE_AFTER_ENTRIES', detail: '{"firstEntryDate" : "2026-01-05", "entryDate" : "2026-01-05"}' })).toMatchObject({
      code: 'OPENING_BALANCE_AFTER_ENTRIES',
      status: 422,
      details: { firstEntryDate: '2026-01-05' },
    });
    expect(openingEntryError({ code: '55000', message: 'BEFORE_OPENING_BALANCE', detail: 'not json' })).toMatchObject({ details: { openingDate: null, entryDate: null } });
    expect(openingEntryError({ code: '55000', message: 'PERIOD_LOCKED' })).toBeNull();
    expect(openingEntryError({ code: '23514', message: 'BEFORE_OPENING_BALANCE' })).toBeNull();
    // The guard's refusals, whichever rule: the period lock first, then the opening entry.
    expect(postingGuardError({ code: '55000', message: 'PERIOD_LOCKED', detail: '{}' })).toMatchObject({ code: 'PERIOD_LOCKED' });
    expect(postingGuardError({ code: '55000', message: 'BEFORE_OPENING_BALANCE', detail: '{}' })).toMatchObject({ code: 'BEFORE_OPENING_BALANCE' });
    expect(postingGuardError(new Error('boom'))).toBeNull();
  });

  it('takes a later posting date only for a purchase, from its invoice date up to today in Vietnam (#478)', () => {
    expect(latePostingRefusal('purchase', '2026-09-20', '2026-10-01', '2026-10-19')).toBeNull();
    expect(latePostingRefusal('purchase', '2026-09-20', '2026-10-19', '2026-10-19')).toBeNull();
    expect(latePostingRefusal('sale', '2026-09-20', '2026-10-01', '2026-10-19')).toMatchObject({ code: 'POSTING_DATE_NOT_ALLOWED', status: 422 });
    expect(latePostingRefusal('purchase', '2026-09-20', '2026-09-19', '2026-10-19')).toMatchObject({ code: 'POSTING_DATE_NOT_ALLOWED' });
    expect(latePostingRefusal('purchase', '2026-09-20', '2026-10-20', '2026-10-19')).toMatchObject({ code: 'POSTING_DATE_IN_FUTURE' });
  });
});
