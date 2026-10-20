// When a client report schedule sends and the period each send covers (#704), in the schedule's time zone.
import { describe, expect, it } from 'vitest';
import { nextReportRun, reportPeriodAt } from '../src/domain/report-schedule.ts';

const VN = 'Asia/Ho_Chi_Minh';
const at = (iso: string) => Date.parse(iso);

describe('nextReportRun', () => {
  it('finds the next weekday at the hour, in the zone', () => {
    const weekly = { cadence: 'weekly' as const, weekday: 1, monthDay: null, sendHour: 8, timeZone: VN };
    // Tuesday 2026-10-20 10:00 in Vietnam: the next Monday 08:00 is 2026-10-26, 01:00 UTC.
    expect(new Date(nextReportRun(weekly, at('2026-10-20T03:00:00Z'))).toISOString()).toBe('2026-10-26T01:00:00.000Z');
    // Monday 07:59 in Vietnam: today at 08:00; at 08:00 itself, the week after.
    expect(new Date(nextReportRun(weekly, at('2026-10-26T00:59:00Z'))).toISOString()).toBe('2026-10-26T01:00:00.000Z');
    expect(new Date(nextReportRun(weekly, at('2026-10-26T01:00:00Z'))).toISOString()).toBe('2026-11-02T01:00:00.000Z');
  });

  it('finds the next day of the month, across a year end', () => {
    const monthly = { cadence: 'monthly' as const, weekday: null, monthDay: 1, sendHour: 9, timeZone: VN };
    expect(new Date(nextReportRun(monthly, at('2026-12-15T00:00:00Z'))).toISOString()).toBe('2027-01-01T02:00:00.000Z');
    const late = { ...monthly, monthDay: 28 };
    expect(new Date(nextReportRun(late, at('2027-02-28T03:00:00Z'))).toISOString()).toBe('2027-03-28T02:00:00.000Z');
  });
});

describe('reportPeriodAt', () => {
  const run = at('2026-10-26T01:00:00Z'); // Monday 2026-10-26 08:00 in Vietnam
  it('covers the week before, Monday to Sunday, from local midnights', () => {
    const p = reportPeriodAt('previous_week', run, VN);
    expect([new Date(p.start).toISOString(), new Date(p.end).toISOString()]).toEqual(['2026-10-18T17:00:00.000Z', '2026-10-25T17:00:00.000Z']);
    // Sent on a Wednesday, it is still the full week before.
    const midweek = reportPeriodAt('previous_week', at('2026-10-28T05:00:00Z'), VN);
    expect(new Date(midweek.start).toISOString()).toBe('2026-10-18T17:00:00.000Z');
  });

  it('covers the month before, and the last 7 or 30 days before the day of the send', () => {
    const month = reportPeriodAt('previous_month', at('2027-01-01T02:00:00Z'), VN);
    expect([new Date(month.start).toISOString(), new Date(month.end).toISOString()]).toEqual(['2026-11-30T17:00:00.000Z', '2026-12-31T17:00:00.000Z']);
    const week = reportPeriodAt('last_7_days', run, VN);
    expect([new Date(week.start).toISOString(), new Date(week.end).toISOString()]).toEqual(['2026-10-18T17:00:00.000Z', '2026-10-25T17:00:00.000Z']);
    const thirty = reportPeriodAt('last_30_days', run, VN);
    expect(new Date(thirty.start).toISOString()).toBe('2026-09-25T17:00:00.000Z');
  });
});
