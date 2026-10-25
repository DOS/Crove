// The calendar core (#1313): time zones, Vietnamese holidays and free slots; a team's free slots (#1373).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKING_HOURS,
  freeSlots,
  isTimeZone,
  isVietnamHoliday,
  teamSlots,
  vietnamHolidays,
  weekdayOf,
  zCalendarEventAdd,
  zWorkingHours,
  zonedDate,
  zonedInstant,
  zoneOffsetMs,
  type Interval,
  type SlotRules,
  type WorkingHours,
} from '../src/index.ts';

const H = 3_600_000;
const M = 60_000;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const RULES: SlotRules = { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: 60, dailyLimit: null };
const VN: WorkingHours = { timeZone: 'Asia/Ho_Chi_Minh', windows: [{ weekday: 1, start: 9 * 60, end: 11 * 60 }] };

// A small seeded generator, so the property tests are random but repeatable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('time zones', () => {
  it('knows IANA zones and refuses the rest', () => {
    for (const tz of ['Asia/Ho_Chi_Minh', 'UTC', 'Europe/Berlin', 'America/New_York']) expect(isTimeZone(tz), tz).toBe(true);
    for (const tz of ['', 'Mars/Olympus', 'GMT+7 ', 'x'.repeat(65)]) expect(isTimeZone(tz), tz).toBe(false);
  });

  it('converts a wall time to the instant and back, Vietnam having no daylight saving', () => {
    expect(zoneOffsetMs('Asia/Ho_Chi_Minh', at('2026-07-01T00:00:00Z'))).toBe(7 * H);
    expect(iso(zonedInstant('Asia/Ho_Chi_Minh', '2026-11-02', 9 * 60))).toBe('2026-11-02T02:00:00.000Z');
    expect(zonedDate('Asia/Ho_Chi_Minh', at('2026-11-01T18:00:00Z'))).toBe('2026-11-02');
    expect(weekdayOf('2026-11-02')).toBe(1);
    expect(weekdayOf('2026-11-08')).toBe(7);
  });

  it('follows a zone across its daylight saving changes, skipped and repeated wall times included', () => {
    // Berlin moves from +1 to +2 on 2026-03-29 at 02:00 local, and back on 2026-10-25 at 03:00 local.
    expect(iso(zonedInstant('Europe/Berlin', '2026-03-28', 9 * 60))).toBe('2026-03-28T08:00:00.000Z');
    expect(iso(zonedInstant('Europe/Berlin', '2026-03-30', 9 * 60))).toBe('2026-03-30T07:00:00.000Z');
    // 02:30 does not exist that night: the instant after the gap.
    expect(iso(zonedInstant('Europe/Berlin', '2026-03-29', 150))).toBe('2026-03-29T01:30:00.000Z');
    // 02:30 happens twice in October: the first one.
    expect(iso(zonedInstant('Europe/Berlin', '2026-10-25', 150))).toBe('2026-10-25T00:30:00.000Z');
  });

  it('round-trips random wall times in several zones', () => {
    const next = rng(1313);
    for (const tz of ['Asia/Ho_Chi_Minh', 'Europe/Berlin', 'America/New_York', 'Australia/Adelaide', 'Asia/Kolkata']) {
      for (let i = 0; i < 300; i++) {
        const day = new Date(at('2026-01-01T00:00:00Z') + Math.floor(next() * 730) * 86_400_000).toISOString().slice(0, 10);
        // Wall times away from the changes (they happen between 00:00 and 03:59 in these zones).
        const minute = 4 * 60 + Math.floor(next() * 20 * 60);
        const instant = zonedInstant(tz, day, minute);
        expect(zonedDate(tz, instant), `${tz} ${day} ${minute}`).toBe(day);
        expect(instant + zoneOffsetMs(tz, instant), `${tz} ${day} ${minute}`).toBe(Date.parse(`${day}T00:00:00Z`) + minute * M);
      }
    }
  });
});

describe('Vietnamese public holidays', () => {
  it('has the fixed-date holidays every year and the lunar ones where the table has the year', () => {
    expect(vietnamHolidays(2026).map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-04-26',
      '2026-04-30',
      '2026-05-01',
      '2026-09-02',
    ]);
    expect(isVietnamHoliday('2027-02-06')).toBe(true);
    expect(isVietnamHoliday('2026-02-21')).toBe(false);
    // Beyond the table: only the fixed dates.
    expect(vietnamHolidays(2035).map((h) => h.date)).toEqual(['2035-01-01', '2035-04-30', '2035-05-01', '2035-09-02']);
  });
});

describe('working hours', () => {
  it('accepts the default and refuses empty, reversed or overlapping windows and unknown zones', () => {
    expect(zWorkingHours.safeParse(DEFAULT_WORKING_HOURS).success).toBe(true);
    expect(zWorkingHours.safeParse({ timeZone: 'Asia/Ho_Chi_Minh', windows: [] }).success).toBe(true);
    for (const bad of [
      { timeZone: 'Asia/Ho_Chi_Minh', windows: [{ weekday: 1, start: 600, end: 600 }] },
      { timeZone: 'Asia/Ho_Chi_Minh', windows: [{ weekday: 1, start: 540, end: 720 }, { weekday: 1, start: 700, end: 800 }] },
      { timeZone: 'Asia/Ho_Chi_Minh', windows: [{ weekday: 8, start: 540, end: 720 }] },
      { timeZone: 'Nowhere/City', windows: [] },
    ]) {
      expect(zWorkingHours.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('bounds a calendar event to a forward range of at most 31 days', () => {
    const ok = { startsAt: '2026-11-02T02:00:00Z', endsAt: '2026-11-02T03:00:00Z', timeZone: 'Asia/Ho_Chi_Minh', kind: 'manual' };
    expect(zCalendarEventAdd.safeParse(ok).success).toBe(true);
    expect(zCalendarEventAdd.safeParse({ ...ok, endsAt: ok.startsAt }).success).toBe(false);
    expect(zCalendarEventAdd.safeParse({ ...ok, endsAt: '2026-12-10T00:00:00Z' }).success).toBe(false);
    expect(zCalendarEventAdd.safeParse({ ...ok, kind: 'booking' }).success).toBe(false);
  });
});

describe('freeSlots', () => {
  const monday = { from: at('2026-11-01T17:00:00Z'), to: at('2026-11-03T17:00:00Z'), now: at('2026-10-30T00:00:00Z') };

  it('steps through each working window in the host zone', () => {
    const slots = freeSlots({ hours: VN, busy: [], skipVietnamHolidays: true, rules: RULES, ...monday });
    expect(slots.map((s) => iso(s.start))).toEqual(['2026-11-02T02:00:00.000Z', '2026-11-02T02:30:00.000Z', '2026-11-02T03:00:00.000Z', '2026-11-02T03:30:00.000Z']);
  });

  it('keeps clear of busy time widened by the buffers', () => {
    const busy: Interval[] = [{ start: at('2026-11-02T03:00:00Z'), end: at('2026-11-02T03:15:00Z') }];
    // A 15-minute buffer each side: 02:30 now ends too close to 03:00; 03:30 starts 15 minutes after 03:15.
    const plain = freeSlots({ hours: VN, busy, skipVietnamHolidays: true, rules: RULES, ...monday }).map((s) => iso(s.start));
    expect(plain).toEqual(['2026-11-02T02:00:00.000Z', '2026-11-02T02:30:00.000Z', '2026-11-02T03:30:00.000Z']);
    const buffered = freeSlots({ hours: VN, busy, skipVietnamHolidays: true, rules: { ...RULES, bufferBeforeMin: 15, bufferAfterMin: 15 }, ...monday }).map((s) => iso(s.start));
    expect(buffered).toEqual(['2026-11-02T02:00:00.000Z', '2026-11-02T03:30:00.000Z']);
  });

  it('respects the minimum notice, the horizon and the range', () => {
    const now = at('2026-11-02T02:10:00Z');
    expect(freeSlots({ hours: VN, busy: [], skipVietnamHolidays: true, rules: { ...RULES, minNoticeMin: 60 }, from: monday.from, to: monday.to, now }).map((s) => iso(s.start))).toEqual([
      '2026-11-02T03:30:00.000Z',
    ]);
    expect(freeSlots({ hours: VN, busy: [], skipVietnamHolidays: true, rules: { ...RULES, horizonDays: 1 }, ...monday })).toEqual([]);
    expect(freeSlots({ hours: VN, busy: [], skipVietnamHolidays: true, rules: RULES, ...monday, to: at('2026-11-02T03:00:00Z') }).length).toBe(2);
  });

  it('offers nothing on a public holiday unless asked to, nor on a day whose limit is reached', () => {
    const tet = { from: at('2026-02-15T17:00:00Z'), to: at('2026-02-16T17:00:00Z'), now: at('2026-02-01T00:00:00Z') };
    expect(freeSlots({ hours: VN, busy: [], skipVietnamHolidays: true, rules: RULES, ...tet })).toEqual([]);
    expect(freeSlots({ hours: VN, busy: [], skipVietnamHolidays: false, rules: RULES, ...tet }).length).toBe(4);
    const limited = { ...RULES, dailyLimit: 2 };
    expect(freeSlots({ hours: VN, busy: [], skipVietnamHolidays: true, rules: limited, ...monday, bookedPerDay: new Map([['2026-11-02', 1]]) }).length).toBe(4);
    expect(freeSlots({ hours: VN, busy: [], skipVietnamHolidays: true, rules: limited, ...monday, bookedPerDay: new Map([['2026-11-02', 2]]) })).toEqual([]);
  });

  it('places windows on the wall clock of a zone that changes offset inside the range', () => {
    const berlin: WorkingHours = { timeZone: 'Europe/Berlin', windows: [{ weekday: 5, start: 9 * 60, end: 10 * 60 }, { weekday: 1, start: 9 * 60, end: 10 * 60 }] };
    const slots = freeSlots({ hours: berlin, busy: [], skipVietnamHolidays: false, rules: { ...RULES, durationMin: 60 }, from: at('2026-10-23T00:00:00Z'), to: at('2026-10-27T00:00:00Z'), now: at('2026-10-01T00:00:00Z') });
    // Friday at 09:00 summer time (+2), Monday at 09:00 winter time (+1).
    expect(slots.map((s) => iso(s.start))).toEqual(['2026-10-23T07:00:00.000Z', '2026-10-26T08:00:00.000Z']);
  });

  it('never offers a slot that overlaps busy time, starts outside a window, or breaks the rules (random cases)', () => {
    const next = rng(2026);
    for (let i = 0; i < 200; i++) {
      const tz = ['Asia/Ho_Chi_Minh', 'Europe/Berlin', 'America/New_York'][Math.floor(next() * 3)] as string;
      const windows = [1, 2, 3, 4, 5, 6, 7]
        .filter(() => next() < 0.7)
        .map((weekday) => {
          const start = Math.floor(next() * 20) * 30 + 4 * 60;
          return { weekday, start, end: Math.min(1440, start + 30 + Math.floor(next() * 16) * 30) };
        });
      const rules: SlotRules = {
        durationMin: [15, 30, 45, 60][Math.floor(next() * 4)] as number,
        bufferBeforeMin: Math.floor(next() * 3) * 10,
        bufferAfterMin: Math.floor(next() * 3) * 10,
        minNoticeMin: Math.floor(next() * 4) * 60,
        horizonDays: 1 + Math.floor(next() * 30),
        dailyLimit: null,
      };
      const now = at('2026-03-20T00:00:00Z') + Math.floor(next() * 240) * H;
      const from = now - Math.floor(next() * 48) * H;
      const to = from + (1 + Math.floor(next() * 20)) * 24 * H;
      const busy: Interval[] = Array.from({ length: Math.floor(next() * 6) }, () => {
        const start = from + Math.floor(next() * ((to - from) / M)) * M;
        return { start, end: start + (15 + Math.floor(next() * 8) * 15) * M };
      });
      const hours: WorkingHours = { timeZone: tz, windows };
      const slots = freeSlots({ hours, busy, skipVietnamHolidays: true, rules, from, to, now });
      for (const s of slots) {
        const ctx = `${tz} case ${i} slot ${iso(s.start)}`;
        expect(s.end - s.start, ctx).toBe(rules.durationMin * M);
        expect(s.start >= from && s.end <= to, ctx).toBe(true);
        expect(s.start >= now + rules.minNoticeMin * M && s.start <= now + rules.horizonDays * 24 * H, ctx).toBe(true);
        for (const b of busy) expect(b.start < s.end + rules.bufferAfterMin * M && b.end > s.start - rules.bufferBeforeMin * M, ctx).toBe(false);
        const day = zonedDate(tz, s.start);
        expect(isVietnamHoliday(day), ctx).toBe(false);
        const inWindow = windows.some((w) => w.weekday === weekdayOf(day) && s.start >= zonedInstant(tz, day, w.start) && s.end <= zonedInstant(tz, day, w.end));
        expect(inWindow, ctx).toBe(true);
      }
      for (let k = 1; k < slots.length; k++) expect((slots[k] as Interval).start > (slots[k - 1] as Interval).start).toBe(true);
    }
  });
});

describe('team slots (#1373)', () => {
  it("offers any host's slot for round-robin and only shared slots for a collective type (random cases)", () => {
    const next = rng(1373);
    const key = (s: Interval) => `${s.start}:${s.end}`;
    for (let i = 0; i < 200; i++) {
      const hosts = 1 + Math.floor(next() * 4);
      // Slots on a half-hour grid with two lengths, so hosts share some and differ on others.
      const perHost = Array.from({ length: hosts }, () =>
        Array.from({ length: Math.floor(next() * 12) }, () => {
          const start = at('2026-11-02T00:00:00Z') + Math.floor(next() * 16) * 30 * M;
          return { start, end: start + (next() < 0.8 ? 30 : 60) * M };
        }).sort((a, b) => a.start - b.start),
      );
      const any = teamSlots('any', perHost);
      const all = teamSlots('all', perHost);
      const offered = (list: Interval[], s: Interval) => list.some((x) => key(x) === key(s));
      expect(new Set(any.map(key)).size, `case ${i}`).toBe(any.length);
      expect(new Set(all.map(key)).size, `case ${i}`).toBe(all.length);
      for (const list of perHost) for (const s of list) expect(offered(any, s), `case ${i}`).toBe(true);
      for (const s of any) expect(perHost.some((list) => offered(list, s)), `case ${i}`).toBe(true);
      for (const s of all) expect(perHost.every((list) => offered(list, s)), `case ${i}`).toBe(true);
      for (const s of perHost[0] ?? []) if (perHost.every((list) => offered(list, s))) expect(offered(all, s), `case ${i}`).toBe(true);
      for (const list of [any, all]) for (let k = 1; k < list.length; k++) expect((list[k] as Interval).start >= (list[k - 1] as Interval).start).toBe(true);
    }
    expect(teamSlots('any', [])).toEqual([]);
    expect(teamSlots('all', [])).toEqual([]);
  });
});
