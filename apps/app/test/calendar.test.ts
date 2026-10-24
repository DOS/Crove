// The working hours card's helpers (issue #1313): the form's seven days to the saved hours and back, and days off as
// events on the member's wall clock.
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_HOURS } from '@crove/kernel-contract';
import { dayOffRange, daysOf, datesOf, hoursOf, minuteOf, timeOf } from '../src/lib/calendar.ts';

describe('working hours form', () => {
  it('reads and writes times of day, midnight at the end included', () => {
    expect(timeOf(510)).toBe('08:30');
    expect(timeOf(1440)).toBe('24:00');
    expect(minuteOf('08:30')).toBe(510);
    expect(minuteOf('24:00')).toBe(1440);
    for (const bad of ['8:30', '24:01', '12:60', '']) expect(minuteOf(bad), bad).toBeNull();
  });

  it('shows the default hours as five days on and two off, and saves them back unchanged', () => {
    const days = daysOf(DEFAULT_WORKING_HOURS);
    expect(days.map((d) => d.on)).toEqual([true, true, true, true, true, false, false]);
    expect(days[0]).toEqual({ weekday: 1, on: true, start: '08:00', end: '17:00' });
    expect(hoursOf(DEFAULT_WORKING_HOURS.timeZone, days)).toEqual({ hours: DEFAULT_WORKING_HOURS });
  });

  it('spans a day with several windows from its first start to its last end', () => {
    const days = daysOf({ timeZone: 'UTC', windows: [{ weekday: 2, start: 480, end: 720 }, { weekday: 2, start: 780, end: 1020 }] });
    expect(days[1]).toEqual({ weekday: 2, on: true, start: '08:00', end: '17:00' });
  });

  it('names the first day whose end is not after its start, and reads an end of 00:00 as midnight', () => {
    const days = daysOf(DEFAULT_WORKING_HOURS).map((d) => (d.weekday === 3 ? { ...d, start: '18:00', end: '09:00' } : d));
    expect(hoursOf('UTC', days)).toEqual({ invalid: 3 });
    const late = daysOf({ timeZone: 'UTC', windows: [] }).map((d) => (d.weekday === 6 ? { ...d, on: true, start: '20:00', end: '00:00' } : d));
    expect(hoursOf('UTC', late)).toEqual({ hours: { timeZone: 'UTC', windows: [{ weekday: 6, start: 1200, end: 1440 }] } });
  });
});

describe('days off', () => {
  it('covers whole local days, both ends included, and reads back as the same dates', () => {
    const one = dayOffRange('Asia/Ho_Chi_Minh', '2026-11-02', '2026-11-02');
    expect(one).toEqual({ startsAt: '2026-11-01T17:00:00.000Z', endsAt: '2026-11-02T17:00:00.000Z' });
    expect(datesOf('Asia/Ho_Chi_Minh', one.startsAt, one.endsAt)).toEqual({ from: '2026-11-02', to: '2026-11-02' });
    const week = dayOffRange('Europe/Berlin', '2026-10-24', '2026-10-27');
    // Berlin leaves summer time on 2026-10-25: the start is at +2, the end at +1.
    expect(week).toEqual({ startsAt: '2026-10-23T22:00:00.000Z', endsAt: '2026-10-27T23:00:00.000Z' });
    expect(datesOf('Europe/Berlin', week.startsAt, week.endsAt)).toEqual({ from: '2026-10-24', to: '2026-10-27' });
    // An end before the start is one day.
    expect(dayOffRange('UTC', '2026-11-05', '2026-11-01')).toEqual({ startsAt: '2026-11-05T00:00:00.000Z', endsAt: '2026-11-06T00:00:00.000Z' });
  });
});
