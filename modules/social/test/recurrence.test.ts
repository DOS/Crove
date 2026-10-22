// Recurring posts (#979): the next occurrence of a weekday-and-time rule in a time zone, across DST, week wraps,
// every N weeks and the rule's end.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { localDate, localTime, nextOccurrence, parseRecurrence, zonedToEpoch, type Recurrence } from '../src/index.ts';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';
const MINUTE = 60_000;
const DAY = 86_400_000;

const rule = (r: Partial<Recurrence>): Recurrence => ({ everyWeeks: 1, weekdays: [1], time: '09:00', until: null, times: null, ...r });
const at = (zone: string, year: number, month: number, day: number, hour: number, minute = 0) => zonedToEpoch({ year, month, day, hour, minute }, zone);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('next occurrence', () => {
  it('keeps Monday 09:00 New York time across the autumn and spring DST changes', () => {
    // 2026-10-26 is a Monday in EDT (UTC-4); New York goes back to EST (UTC-5) on 2026-11-01.
    const before = at(NY, 2026, 10, 26, 9);
    expect(iso(before)).toBe('2026-10-26T13:00:00.000Z');
    expect(iso(nextOccurrence(rule({}), NY, before, before + MINUTE))).toBe('2026-11-02T14:00:00.000Z');
    // And forward on 2026-03-08: Monday 2026-03-02 09:00 EST, then 2026-03-09 09:00 EDT.
    const march = at(NY, 2026, 3, 2, 9);
    expect(iso(nextOccurrence(rule({}), NY, march, march))).toBe('2026-03-09T13:00:00.000Z');
  });

  it('puts a time the forward change skips the same distance after it', () => {
    // 02:30 does not exist in New York on 2026-03-08: the copy goes at 03:30 EDT.
    const saturday = at(NY, 2026, 3, 7, 2, 30);
    expect(iso(nextOccurrence(rule({ weekdays: [0, 6], time: '02:30' }), NY, saturday, saturday))).toBe('2026-03-08T07:30:00.000Z');
  });

  it('goes to a later weekday of the same week, then wraps to the next week (weeks start on Monday)', () => {
    const weekend = rule({ weekdays: [6, 0], time: '20:00' });
    const saturday = at(HCM, 2026, 10, 24, 20);
    const sunday = nextOccurrence(weekend, HCM, saturday, saturday);
    expect(iso(sunday)).toBe(iso(at(HCM, 2026, 10, 25, 20)));
    expect(iso(nextOccurrence(weekend, HCM, sunday as number, sunday as number))).toBe(iso(at(HCM, 2026, 10, 31, 20)));
  });

  it('skips the weeks between when it repeats every 2 weeks, with several weekdays', () => {
    const monday = at(HCM, 2026, 10, 19, 9);
    expect(iso(nextOccurrence(rule({ everyWeeks: 2 }), HCM, monday, monday))).toBe(iso(at(HCM, 2026, 11, 2, 9)));
    const twice = rule({ everyWeeks: 2, weekdays: [5, 1] });
    const friday = nextOccurrence(twice, HCM, monday, monday) as number;
    expect(iso(friday)).toBe(iso(at(HCM, 2026, 10, 23, 9)));
    expect(iso(nextOccurrence(twice, HCM, friday, friday))).toBe(iso(at(HCM, 2026, 11, 2, 9)));
  });

  it('skips occurrences that went by while a copy waited, keeping the series on its weeks', () => {
    const monday = at(HCM, 2026, 10, 19, 9);
    // Every 2 weeks from 19 October: 2 and 16 November. On Tuesday 10 November the next one is the 16th.
    expect(iso(nextOccurrence(rule({ everyWeeks: 2 }), HCM, monday, at(HCM, 2026, 11, 10, 12)))).toBe(iso(at(HCM, 2026, 11, 16, 9)));
    // Every week: the Monday after now, not one already gone.
    expect(iso(nextOccurrence(rule({}), HCM, monday, at(HCM, 2026, 11, 9, 9, 1)))).toBe(iso(at(HCM, 2026, 11, 16, 9)));
    // Earlier the same day it is still today.
    expect(iso(nextOccurrence(rule({}), HCM, monday, at(HCM, 2026, 11, 9, 8)))).toBe(iso(at(HCM, 2026, 11, 9, 9)));
  });

  it('stops at its end date, which counts in the local calendar', () => {
    const monday = at(HCM, 2026, 10, 19, 9);
    expect(nextOccurrence(rule({ until: '2026-10-25' }), HCM, monday, monday)).toBeNull();
    expect(iso(nextOccurrence(rule({ until: '2026-10-26' }), HCM, monday, monday))).toBe(iso(at(HCM, 2026, 10, 26, 9)));
    // 23:30 on the end date in New York is already the next day in UTC, and still within the end.
    const nyMonday = at(NY, 2026, 10, 19, 23, 30);
    expect(iso(nextOccurrence(rule({ time: '23:30', until: '2026-10-26' }), NY, nyMonday, nyMonday))).toBe('2026-10-27T03:30:00.000Z');
  });

  it('always lands later than both the last occurrence and now, on a chosen weekday at the local time, in phase', () => {
    const zones = [HCM, NY, 'Europe/London', 'Australia/Sydney', 'UTC'];
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.integer({ min: 1, max: 4 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2030, 0, 1) }),
        fc.integer({ min: 0, max: 400 * DAY }),
        (zone, everyWeeks, weekdays, hour, minute, after, late) => {
          const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          const r = rule({ everyWeeks, weekdays, time });
          const now = after + late;
          const next = nextOccurrence(r, zone, after, now);
          expect(next).not.toBeNull();
          const n = next as number;
          expect(n).toBeGreaterThan(Math.max(after, now));
          const l = localTime(n, zone);
          expect(weekdays.map((d) => (d === 0 ? 7 : d))).toContain(l.weekday);
          // The local time, unless a forward change skipped it (then it lands up to an hour later that day).
          const shift = (l.hour * 60 + l.minute) - (hour * 60 + minute);
          expect(shift === 0 || (shift > 0 && shift <= 60)).toBe(true);
          // In phase: a whole number of everyWeeks from the week of `after`.
          const a = localTime(after, zone);
          const weekOf = (x: { year: number; month: number; day: number; weekday: number }) => Date.UTC(x.year, x.month - 1, x.day) - (x.weekday - 1) * DAY;
          expect(Math.round((weekOf(l) - weekOf(a)) / (7 * DAY)) % everyWeeks).toBe(0);
          // And within a cycle of the floor.
          expect(n - Math.max(after, now)).toBeLessThanOrEqual((everyWeeks + 1) * 7 * DAY);
          expect(localDate(n, zone)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('stored rules', () => {
  it('reads a rule the commands wrote, weekdays sorted', () => {
    expect(parseRecurrence({ everyWeeks: 2, weekdays: [5, 1], time: '20:00', until: '2027-02-28', times: null })).toEqual({ everyWeeks: 2, weekdays: [1, 5], time: '20:00', until: '2027-02-28', times: null });
    expect(parseRecurrence({ everyWeeks: 1, weekdays: [0], time: '00:00' })).toEqual({ everyWeeks: 1, weekdays: [0], time: '00:00', until: null, times: null });
  });

  it('reads anything else as no rule', () => {
    for (const bad of [
      null,
      'weekly',
      [],
      { everyWeeks: 5, weekdays: [1], time: '09:00' },
      { everyWeeks: 1.5, weekdays: [1], time: '09:00' },
      { everyWeeks: 1, weekdays: [], time: '09:00' },
      { everyWeeks: 1, weekdays: [7], time: '09:00' },
      { everyWeeks: 1, weekdays: [1, 1], time: '09:00' },
      { everyWeeks: 1, weekdays: [1], time: '24:00' },
      { everyWeeks: 1, weekdays: [1], time: '9:00' },
      { everyWeeks: 1, weekdays: [1], time: '09:00', until: '2026-02-30' },
      { everyWeeks: 1, weekdays: [1], time: '09:00', times: 0 },
      { everyWeeks: 1, weekdays: [1], time: '09:00', times: 501 },
    ]) {
      expect(parseRecurrence(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
