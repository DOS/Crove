// Helpers for the working hours card in Settings (issue #1313). The form shows one window per weekday; the server
// enforces every rule, these only turn the form into the saved shape and back.
import { WEEKDAYS, zonedDate, zonedInstant, type Weekday, type WorkingHours } from '@crove/kernel-contract';

export interface DayHours {
  weekday: Weekday;
  on: boolean;
  // "HH:MM" on the member's wall clock; end "24:00" is midnight at the end of the day.
  start: string;
  end: string;
}

// The message key of each ISO weekday.
export const WEEKDAY_KEYS = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 7: 'sun' } as const satisfies Record<Weekday, string>;

const pad = (n: number) => String(n).padStart(2, '0');

/** "08:30" for 510 minutes after midnight; "24:00" for 1440. */
export function timeOf(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** Minutes after midnight for "HH:MM", or null when it is not a time of day ("24:00" is the end of the day). */
export function minuteOf(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minute <= 1440 ? minute : null;
}

/** The form's seven days from saved hours: a day with several windows shows from its first start to its last end. */
export function daysOf(hours: WorkingHours): DayHours[] {
  return WEEKDAYS.map((weekday) => {
    const windows = hours.windows.filter((w) => w.weekday === weekday);
    if (windows.length === 0) return { weekday, on: false, start: '08:00', end: '17:00' };
    return { weekday, on: true, start: timeOf(Math.min(...windows.map((w) => w.start))), end: timeOf(Math.max(...windows.map((w) => w.end))) };
  });
}

/** The hours to save from the form, or the first day whose times are not a forward range. */
export function hoursOf(timeZone: string, days: readonly DayHours[]): { hours: WorkingHours } | { invalid: Weekday } {
  const windows: WorkingHours['windows'] = [];
  for (const d of days) {
    if (!d.on) continue;
    const start = minuteOf(d.start);
    const end = minuteOf(d.end === '00:00' ? '24:00' : d.end);
    if (start === null || end === null || start >= 1440 || end <= start) return { invalid: d.weekday };
    windows.push({ weekday: d.weekday, start, end });
  }
  return { hours: { timeZone, windows } };
}

/** A day off from `from` to `to` (dates, both included) on the member's wall clock, as the event to add. */
export function dayOffRange(timeZone: string, from: string, to: string): { startsAt: string; endsAt: string } {
  const last = to < from ? from : to;
  const next = new Date(Date.parse(`${last}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { startsAt: new Date(zonedInstant(timeZone, from, 0)).toISOString(), endsAt: new Date(zonedInstant(timeZone, next, 0)).toISOString() };
}

/** The first and last dates (included) an event covers on the member's wall clock. */
export function datesOf(timeZone: string, startsAt: string, endsAt: string): { from: string; to: string } {
  return { from: zonedDate(timeZone, Date.parse(startsAt)), to: zonedDate(timeZone, Date.parse(endsAt) - 1) };
}

/** The IANA zones this browser knows, the member's own first when it is missing from the list. */
export function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return all.includes(current) ? all : [current, ...all];
}
