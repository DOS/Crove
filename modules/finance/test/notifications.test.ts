// When a period is called closing (#671): its VAT return is due within PERIOD_CLOSING_DAYS days and the lock does not
// cover it. The notification itself is written in apps/kernel/test/notifications.db.test.ts.
import { describe, expect, it } from 'vitest';
import { PERIOD_CLOSING_DAYS, closingPeriod, periodEnd } from '../src/notifications.ts';

describe('periodEnd', () => {
  it('is the last day of the month or quarter', () => {
    expect(periodEnd('2026-09')).toBe('2026-09-30');
    expect(periodEnd('2028-02')).toBe('2028-02-29');
    expect(periodEnd('2026-12')).toBe('2026-12-31');
    expect(periodEnd('2026-Q3')).toBe('2026-09-30');
    expect(periodEnd('2026-Q4')).toBe('2026-12-31');
  });
});

describe('closingPeriod', () => {
  it('names a monthly period whose return is due within the days and is not locked', () => {
    expect(PERIOD_CLOSING_DAYS).toBe(5);
    // September 2026 is due on Tuesday 20 October.
    expect(closingPeriod('month', null, '2026-10-14')).toBeNull();
    expect(closingPeriod('month', null, '2026-10-15')).toEqual({ period: '2026-09', dueDate: '2026-10-20' });
    expect(closingPeriod('month', '2026-08-31', '2026-10-20')).toEqual({ period: '2026-09', dueDate: '2026-10-20' });
    expect(closingPeriod('month', '2026-09-30', '2026-10-16')).toBeNull();
    // After the due date the next return is a month away.
    expect(closingPeriod('month', null, '2026-10-21')).toBeNull();
  });

  it('files monthly when the org has not said, and handles quarters', () => {
    expect(closingPeriod(null, null, '2026-10-16')).toEqual({ period: '2026-09', dueDate: '2026-10-20' });
    // The third quarter of 2026 is due on Saturday 31 October, so Monday 2 November.
    expect(closingPeriod('quarter', null, '2026-10-27')).toBeNull();
    expect(closingPeriod('quarter', null, '2026-10-28')).toEqual({ period: '2026-Q3', dueDate: '2026-11-02' });
    expect(closingPeriod('quarter', '2026-09-30', '2026-10-30')).toBeNull();
    expect(closingPeriod('quarter', null, '2026-10-16')).toBeNull();
  });
});
