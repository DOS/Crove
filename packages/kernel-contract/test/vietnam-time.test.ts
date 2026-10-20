import { describe, expect, it } from 'vitest';
import { VIETNAM_TIME_ZONE, vietnamMonth, vietnamToday } from '../src/index.ts';

describe('vietnamToday and vietnamMonth', () => {
  it('are the date and month in UTC+7, the day turning at 17:00 UTC', () => {
    expect(vietnamToday(new Date('2026-10-19T16:59:59Z'))).toBe('2026-10-19');
    expect(vietnamToday(new Date('2026-10-19T17:00:00Z'))).toBe('2026-10-20');
    expect(vietnamMonth(new Date('2026-09-30T16:59:59Z'))).toBe('2026-09');
    expect(vietnamMonth(new Date('2026-09-30T17:00:00Z'))).toBe('2026-10');
    expect(vietnamMonth(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01');
  });

  it('agree with the IANA zone the database uses, on every hour of a year', () => {
    const zoned = new Intl.DateTimeFormat('en-CA', { timeZone: VIETNAM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) {
      expect(vietnamToday(new Date(t))).toBe(zoned.format(new Date(t)));
    }
  });
});
