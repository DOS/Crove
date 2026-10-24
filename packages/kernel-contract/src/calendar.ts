// The calendar core (issue #1313, plan docs/plan/calendar.md §3): a member's weekly working hours in their time zone,
// the events on their calendar, Vietnamese public holidays, and the free slots that follow. Pure functions on UTC
// instants (milliseconds), converted to a zone's wall clock only at the edges, so a zone that changes its offset inside
// a range stays correct. The kernel stores what a member set; the booking page (crm, #1318) only ever receives slots.
//
// Reference for the slot rules: Cal.diy (MIT, https://github.com/calcom/cal.diy), studied for behavior; no code copied.
import { z } from 'zod';
import { zId } from './schemas.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// ISO weekdays: 1 Monday ... 7 Sunday.
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const CALENDAR_EVENT_KINDS = ['manual', 'time_off', 'booking'] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

// A calendar event is at most this long: a day off is one event per day range, not an open-ended block.
export const CALENDAR_EVENT_MAX_DAYS = 31;
// How far a free/busy or slot query may reach.
export const CALENDAR_RANGE_MAX_DAYS = 120;

export const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';

/** True for an IANA time zone this runtime knows ("Asia/Ho_Chi_Minh", "UTC"). */
export function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const zTimeZone = z.string().refine(isTimeZone, 'IANA time zone');
const zInstant = z.iso.datetime({ offset: true });

export const zWorkingWindow = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  // Minutes after local midnight; end is exclusive and may be 1440 (midnight at the end of the day).
  start: z.number().int().min(0).max(1439),
  end: z.number().int().min(1).max(1440),
});
export type WorkingWindow = z.infer<typeof zWorkingWindow>;

export const zWorkingHours = z
  .strictObject({ timeZone: zTimeZone, windows: z.array(zWorkingWindow).max(28) })
  .superRefine((value, ctx) => {
    value.windows.forEach((w, i) => {
      if (w.end <= w.start) ctx.addIssue({ code: 'custom', path: ['windows', i, 'end'], message: 'end must be after start' });
    });
    for (const day of WEEKDAYS) {
      const sorted = value.windows.filter((w) => w.weekday === day).sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        if ((sorted[i] as WorkingWindow).start < (sorted[i - 1] as WorkingWindow).end) {
          ctx.addIssue({ code: 'custom', path: ['windows'], message: `windows overlap on weekday ${day}` });
        }
      }
    }
  });
export type WorkingHours = z.infer<typeof zWorkingHours>;

// What a member gets before saving anything: Monday to Friday, 8:00 to 17:00, Vietnam time.
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  timeZone: DEFAULT_TIME_ZONE,
  windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 8 * 60, end: 17 * 60 })),
};

export const zCalendarEventAdd = z
  .strictObject({
    startsAt: zInstant,
    endsAt: zInstant,
    timeZone: zTimeZone,
    title: z.string().trim().max(200).nullable().optional(),
    kind: z.enum(['manual', 'time_off']),
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine((v) => Date.parse(v.endsAt) - Date.parse(v.startsAt) <= CALENDAR_EVENT_MAX_DAYS * DAY_MS, {
    message: `an event lasts at most ${CALENDAR_EVENT_MAX_DAYS} days`,
    path: ['endsAt'],
  });
export type CalendarEventAdd = z.infer<typeof zCalendarEventAdd>;

export const zCalendarEventView = z.strictObject({
  id: zId,
  startsAt: zInstant,
  endsAt: zInstant,
  timeZone: zTimeZone,
  title: z.string().nullable(),
  kind: z.enum(CALENDAR_EVENT_KINDS),
});
export type CalendarEventView = z.infer<typeof zCalendarEventView>;

export const zCalendarRange = z
  .strictObject({ from: zInstant, to: zInstant })
  .refine((v) => Date.parse(v.to) > Date.parse(v.from), { message: 'to must be after from', path: ['to'] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= CALENDAR_RANGE_MAX_DAYS * DAY_MS, {
    message: `a range spans at most ${CALENDAR_RANGE_MAX_DAYS} days`,
    path: ['to'],
  });

export const zMyCalendar = z.strictObject({ hours: zWorkingHours, saved: z.boolean(), events: z.array(zCalendarEventView) });
export type MyCalendar = z.infer<typeof zMyCalendar>;

export const zCalendarEventCancel = z.strictObject({ eventId: zId });

// A member's own free slots over a range, for a duration: what a booking page of theirs would offer, before buffers,
// notice and limits (those belong to an event type, #1314).
export const zCalendarSlotsQuery = z
  .strictObject({ from: zInstant, to: zInstant, durationMin: z.number().int().min(5).max(480) })
  .refine((v) => Date.parse(v.to) > Date.parse(v.from), { message: 'to must be after from', path: ['to'] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= CALENDAR_RANGE_MAX_DAYS * DAY_MS, {
    message: `a range spans at most ${CALENDAR_RANGE_MAX_DAYS} days`,
    path: ['to'],
  });
export const zCalendarSlot = z.strictObject({ start: zInstant, end: zInstant });

// ---------------------------------------------------------------------------------------------------------------------
// Time zones

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(timeZone: string, at: number): WallClock {
  const parts = Object.fromEntries(formatterOf(timeZone).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** The offset of `timeZone` from UTC at the instant `at`, in milliseconds (Vietnam: +7 h). */
export function zoneOffsetMs(timeZone: string, at: number): number {
  const w = wallClock(timeZone, at);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant at which the wall clock of `timeZone` reads `date` at `minute` minutes after midnight. A wall time that
 * a forward change skips maps to the instant after the gap; one that a backward change repeats maps to its first
 * occurrence.
 */
export function zonedInstant(timeZone: string, date: string, minute: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + minute * MINUTE_MS;
  // The offsets in force a day either side cover any change near `wall` (zones change at most once a day).
  const before = zoneOffsetMs(timeZone, wall - DAY_MS);
  const after = zoneOffsetMs(timeZone, wall + DAY_MS);
  const reads = (at: number) => at + zoneOffsetMs(timeZone, at) === wall;
  const candidates = [wall - before, wall - after].filter(reads).sort((a, b) => a - b);
  // In a gap neither reads `wall`: the offset before the change puts it just after the gap.
  return candidates[0] ?? wall - before;
}

/** The calendar date (YYYY-MM-DD) of `at` on the wall clock of `timeZone`. */
export function zonedDate(timeZone: string, at: number): string {
  const w = wallClock(timeZone, at);
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** The ISO weekday of a calendar date. */
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (js === 0 ? 7 : js) as Weekday;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------------
// Vietnamese public holidays (Labor Code 45/2019/QH14, Article 112)

export interface PublicHoliday {
  date: string;
  name: string;
}

// The fixed-date holidays, every year.
const FIXED_HOLIDAYS: ReadonlyArray<{ monthDay: string; name: string }> = [
  { monthDay: '01-01', name: 'Tết Dương lịch' },
  { monthDay: '04-30', name: 'Ngày Giải phóng miền Nam' },
  { monthDay: '05-01', name: 'Ngày Quốc tế Lao động' },
  { monthDay: '09-02', name: 'Quốc khánh' },
];

// The holidays that follow the lunar calendar, per year: Tết (the last day of the lunar year and the first four days of
// the new one, the usual split of its five days) and the Hùng Kings' commemoration (10th day of the 3rd lunar month).
// The government sets each year's exact Tết days, the day next to 2 September and swapped working days by decision;
// an org adds those, and the compensatory days off, as its own days off. Extend this table each year.
const LUNAR_HOLIDAYS: Readonly<Record<number, readonly PublicHoliday[]>> = {
  2026: [
    ...['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20'].map((date) => ({ date, name: 'Tết Nguyên đán' })),
    { date: '2026-04-26', name: 'Giỗ Tổ Hùng Vương' },
  ],
  2027: [
    ...['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09'].map((date) => ({ date, name: 'Tết Nguyên đán' })),
    { date: '2027-04-16', name: 'Giỗ Tổ Hùng Vương' },
  ],
  2028: [
    ...['2028-01-25', '2028-01-26', '2028-01-27', '2028-01-28', '2028-01-29'].map((date) => ({ date, name: 'Tết Nguyên đán' })),
    { date: '2028-04-04', name: 'Giỗ Tổ Hùng Vương' },
  ],
};

/** The Vietnamese public holidays of a year, by date. A year beyond the lunar table has only the fixed-date ones. */
export function vietnamHolidays(year: number): PublicHoliday[] {
  const fixed = FIXED_HOLIDAYS.map((h) => ({ date: `${year}-${h.monthDay}`, name: h.name }));
  return [...fixed, ...(LUNAR_HOLIDAYS[year] ?? [])].sort((a, b) => a.date.localeCompare(b.date));
}

const holidayDates = new Map<number, Set<string>>();
/** True when `date` (YYYY-MM-DD) is a Vietnamese public holiday. */
export function isVietnamHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  let dates = holidayDates.get(year);
  if (!dates) {
    dates = new Set(vietnamHolidays(year).map((h) => h.date));
    holidayDates.set(year, dates);
  }
  return dates.has(date);
}

// ---------------------------------------------------------------------------------------------------------------------
// Free slots

export interface Interval {
  start: number;
  end: number;
}

export interface SlotRules {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  // The earliest a slot may start, counted from `now`.
  minNoticeMin: number;
  // The latest a slot may start, counted in days from `now`.
  horizonDays: number;
  // At most this many bookings per local day of the host; null for no limit.
  dailyLimit: number | null;
  // Slots start this often within a window; defaults to the duration.
  stepMin?: number;
}

export interface SlotQuery {
  hours: WorkingHours;
  // The host's busy time: events, bookings and days off. Instants in milliseconds.
  busy: readonly Interval[];
  // Whether Vietnamese public holidays have no slots (the default for an org in Vietnam).
  skipVietnamHolidays: boolean;
  rules: SlotRules;
  from: number;
  to: number;
  now: number;
  // Bookings already held per local date of the host, for the daily limit.
  bookedPerDay?: ReadonlyMap<string, number>;
}

/**
 * The free slots of a host between `from` and `to`, earliest first: within the working windows of each local day in
 * the host's zone, not on a public holiday (when asked), clear of every busy interval widened by the buffers, no
 * earlier than the minimum notice and no later than the horizon, and not on a day whose limit is reached.
 */
export function freeSlots(q: SlotQuery): Interval[] {
  const { hours, rules } = q;
  const duration = rules.durationMin * MINUTE_MS;
  const step = (rules.stepMin ?? rules.durationMin) * MINUTE_MS;
  if (duration <= 0 || step <= 0) return [];
  const earliest = Math.max(q.from, q.now + rules.minNoticeMin * MINUTE_MS);
  const latestStart = Math.min(q.to - duration, q.now + rules.horizonDays * DAY_MS);
  if (latestStart < earliest) return [];
  const before = rules.bufferBeforeMin * MINUTE_MS;
  const after = rules.bufferAfterMin * MINUTE_MS;
  const busy = [...q.busy].filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const clear = (start: number, end: number) => !busy.some((b) => b.start < end + after && b.end > start - before);

  const slots: Interval[] = [];
  // One day before and after the range in the host's zone, so windows that cross into it are not missed.
  let date = zonedDate(hours.timeZone, earliest - DAY_MS);
  const lastDate = zonedDate(hours.timeZone, latestStart + DAY_MS);
  for (let guard = 0; date <= lastDate && guard < CALENDAR_RANGE_MAX_DAYS + 3; guard++, date = nextDate(date)) {
    if (q.skipVietnamHolidays && isVietnamHoliday(date)) continue;
    // A day whose limit is reached offers nothing; below it, every free slot is offered.
    if (rules.dailyLimit !== null && (q.bookedPerDay?.get(date) ?? 0) >= rules.dailyLimit) continue;
    const weekday = weekdayOf(date);
    const windows = hours.windows.filter((w) => w.weekday === weekday).sort((a, b) => a.start - b.start);
    for (const w of windows) {
      const windowStart = zonedInstant(hours.timeZone, date, w.start);
      const windowEnd = zonedInstant(hours.timeZone, date, w.end);
      for (let start = windowStart; start + duration <= windowEnd; start += step) {
        if (start < earliest || start > latestStart) continue;
        const end = start + duration;
        if (clear(start, end)) slots.push({ start, end });
      }
    }
  }
  return slots;
}

/**
 * The free slots of a team of hosts (#1373), from each host's own free slots: for `any` (round-robin), a slot any host
 * offers; for `all` (collective), a slot every host offers, at the same start and end. Earliest first, no repeats.
 */
export function teamSlots(mode: 'any' | 'all', perHost: readonly (readonly Interval[])[]): Interval[] {
  const key = (s: Interval) => `${s.start}:${s.end}`;
  const [first, ...rest] = perHost;
  if (!first) return [];
  const others = rest.map((list) => new Set(list.map(key)));
  const seen = new Map<string, Interval>();
  for (const list of mode === 'all' ? [first] : perHost) {
    for (const s of list) {
      if (seen.has(key(s)) || (mode === 'all' && !others.every((set) => set.has(key(s))))) continue;
      seen.set(key(s), { start: s.start, end: s.end });
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}
