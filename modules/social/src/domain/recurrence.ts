// Recurring posts (#979): a post repeats every 1 to 4 weeks on chosen weekdays at a local time, until a date or for a
// number of copies. Pure: nothing here reads the clock, callers pass `now`. Weekdays are 0 = Sunday ... 6 = Saturday
// (as Date.getDay), weeks start on Monday (the Vietnamese week, T2 to CN), and the time is a wall-clock time in the
// post's IANA zone, so 09:00 stays 09:00 across a daylight-saving change (a time a forward change skips lands the
// same distance after it, as the queues do).
import { localTime, zonedToEpoch } from './queue.ts';

export interface Recurrence {
  everyWeeks: number;
  weekdays: number[];
  // "HH:mm", local to the post's time zone.
  time: string;
  // The last local date an occurrence may fall on ("YYYY-MM-DD"), or null.
  until: string | null;
  // How many copies the series makes, or null.
  times: number | null;
}

export const RECURRENCE_WEEKS_MAX = 4;
export const RECURRENCE_TIMES_MAX = 500;
const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

// A date "YYYY-MM-DD" that exists on the calendar.
export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/**
 * A stored rule as the commands wrote it, or null when the value is not one (the database refuses other shapes, so a
 * null here means no rule). Weekdays come back sorted.
 */
export function parseRecurrence(value: unknown): Recurrence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const { everyWeeks, weekdays, time } = r;
  const until = r.until ?? null;
  const times = r.times ?? null;
  if (typeof everyWeeks !== 'number' || !Number.isInteger(everyWeeks) || everyWeeks < 1 || everyWeeks > RECURRENCE_WEEKS_MAX) return null;
  if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7) return null;
  if (!weekdays.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6) || new Set(weekdays).size !== weekdays.length) return null;
  if (typeof time !== 'string' || !TIME.test(time)) return null;
  if (until !== null && (typeof until !== 'string' || !isCalendarDate(until))) return null;
  if (times !== null && (typeof times !== 'number' || !Number.isInteger(times) || times < 1 || times > RECURRENCE_TIMES_MAX)) return null;
  return { everyWeeks, weekdays: [...(weekdays as number[])].sort((a, b) => a - b), time, until, times };
}

// The local date of an instant in a zone, "YYYY-MM-DD".
export function localDate(epochMs: number, timeZone: string): string {
  const l = localTime(epochMs, timeZone);
  return `${String(l.year).padStart(4, '0')}-${String(l.month).padStart(2, '0')}-${String(l.day).padStart(2, '0')}`;
}

// The ISO weekday (1 = Monday ... 7 = Sunday) of a rule's weekday (0 = Sunday).
const isoWeekday = (d: number) => (d === 0 ? 7 : d);

/**
 * The first occurrence of the rule after `afterMs` (the last occurrence, or the original's publish) and after `nowMs`,
 * or null when the rule's end date comes first. The weeks that count are those a multiple of everyWeeks from the week
 * of `afterMs`, so every second week stays every second week however late the series runs; an occurrence that went by
 * while a copy waited is skipped, never made late. `times` is the caller's to count.
 */
export function nextOccurrence(rule: Recurrence, timeZone: string, afterMs: number, nowMs: number): number | null {
  const [hour, minute] = rule.time.split(':').map(Number) as [number, number];
  const days = [...new Set(rule.weekdays.map(isoWeekday))].sort((a, b) => a - b);
  if (days.length === 0) return null;
  const floor = Math.max(afterMs, nowMs);
  // Local calendar days as UTC day numbers (no zone involved), Monday of the week of `afterMs` first.
  const a = localTime(afterMs, timeZone);
  const phase = Date.UTC(a.year, a.month - 1, a.day) - (a.weekday - 1) * DAY;
  const f = localTime(floor, timeZone);
  const floorWeek = Date.UTC(f.year, f.month - 1, f.day) - (f.weekday - 1) * DAY;
  const n = rule.everyWeeks;
  // Start at the last week of the cycle that is not after the floor's week; the next cycles are all that can hold it.
  let week = phase + Math.max(0, Math.floor(Math.round((floorWeek - phase) / WEEK) / n)) * n * WEEK;
  for (let i = 0; i < 4; i += 1, week += n * WEEK) {
    for (const iso of days) {
      const d = new Date(week + (iso - 1) * DAY);
      const date = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
      if (rule.until !== null && `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` > rule.until) return null;
      const at = zonedToEpoch({ ...date, hour, minute }, timeZone);
      if (at > floor) return at;
    }
  }
  return null;
}
