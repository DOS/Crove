// Posting queue slot math (issue #231): IANA zones, DST, and the keep-your-slot placement rules.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isSlot, isValidTimeZone, localTime, nextFreeSlot, placeQueued, retime, slotsBetween, zonedToEpoch, type QueueSpec } from '../src/index.ts';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';
const MINUTE = 60_000;
const DAY = 86_400_000;

// Monday 9:00, Wednesday 12:30, Friday 20:00, Ho Chi Minh City time.
const queue: QueueSpec = {
  timeZone: HCM,
  slots: [
    { weekday: 1, minute: 9 * 60 },
    { weekday: 3, minute: 12 * 60 + 30 },
    { weekday: 5, minute: 20 * 60 },
  ],
};

// 2026-10-19 is a Monday.
const monday9 = Date.UTC(2026, 9, 19, 2, 0); // 09:00 +07:00

describe('time zones', () => {
  it('validates zone names', () => {
    expect(isValidTimeZone(HCM)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('converts Ho Chi Minh City local time (UTC+7, no DST)', () => {
    expect(zonedToEpoch({ year: 2026, month: 10, day: 19, hour: 9, minute: 0 }, HCM)).toBe(monday9);
    expect(localTime(monday9, HCM)).toEqual({ year: 2026, month: 10, day: 19, hour: 9, minute: 0, weekday: 1 });
  });

  it('maps a time skipped by a forward DST change to just after the change', () => {
    // 2026-03-08 02:30 does not exist in New York; it reads as 03:30 EDT.
    const t = zonedToEpoch({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
    expect(localTime(t, NY)).toMatchObject({ hour: 3, minute: 30 });
  });

  it('maps a repeated time of a backward DST change to its first occurrence', () => {
    // 2026-11-01 01:30 happens twice in New York: first at EDT (UTC-4).
    expect(zonedToEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it('round-trips any minute through local time', () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2020, 0, 1) / MINUTE, max: Date.UTC(2035, 0, 1) / MINUTE }), fc.constantFrom(HCM, NY, 'Europe/London', 'Australia/Lord_Howe'), (minutes, tz) => {
        const t = minutes * MINUTE;
        const local = localTime(t, tz);
        const back = zonedToEpoch(local, tz);
        expect(localTime(back, tz)).toEqual(local);
        expect(back).toBeLessThanOrEqual(t);
      }),
    );
  });
});

describe('slots', () => {
  it('lists a week of slots in order', () => {
    const week = slotsBetween(queue, monday9 - MINUTE, monday9 + 7 * DAY - MINUTE);
    expect(week.map((t) => localTime(t, HCM))).toEqual([
      { year: 2026, month: 10, day: 19, hour: 9, minute: 0, weekday: 1 },
      { year: 2026, month: 10, day: 21, hour: 12, minute: 30, weekday: 3 },
      { year: 2026, month: 10, day: 23, hour: 20, minute: 0, weekday: 5 },
    ]);
  });

  it('excludes the start and includes the end', () => {
    expect(slotsBetween(queue, monday9, monday9 + MINUTE)).toEqual([]);
    expect(slotsBetween(queue, monday9 - MINUTE, monday9)).toEqual([monday9]);
  });

  it('recognizes slot instants', () => {
    expect(isSlot(queue, monday9)).toBe(true);
    expect(isSlot(queue, monday9 + MINUTE)).toBe(false);
    expect(isSlot(queue, monday9 + 1)).toBe(false);
  });

  it('finds the next free slot, skipping taken ones', () => {
    const wednesday = Date.UTC(2026, 9, 21, 5, 30);
    expect(nextFreeSlot(queue, monday9 - MINUTE, new Set())).toBe(monday9);
    expect(nextFreeSlot(queue, monday9 - MINUTE, new Set([monday9]))).toBe(wednesday);
    expect(nextFreeSlot({ timeZone: HCM, slots: [] }, monday9, new Set())).toBeNull();
  });

  it('never returns a taken slot, a non-slot, or a time before the start', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1) / MINUTE, max: Date.UTC(2030, 0, 1) / MINUTE }),
        fc.uniqueArray(fc.record({ weekday: fc.integer({ min: 1, max: 7 }), minute: fc.integer({ min: 0, max: 1439 }) }), {
          minLength: 1,
          maxLength: 6,
          selector: (s) => `${s.weekday}:${s.minute}`,
        }),
        fc.constantFrom(HCM, NY),
        fc.integer({ min: 0, max: 8 }),
        (minutes, slots, tz, takeCount) => {
          const spec: QueueSpec = { timeZone: tz, slots };
          const after = minutes * MINUTE;
          const taken = new Set(slotsBetween(spec, after, after + 30 * DAY).slice(0, takeCount));
          const next = nextFreeSlot(spec, after, taken);
          expect(next).not.toBeNull();
          if (next === null) return;
          expect(next).toBeGreaterThan(after);
          expect(taken.has(next)).toBe(false);
          // A slot skipped by DST lands after the gap, so it is not a slot by local clock time: allow that case.
          const local = localTime(next, tz);
          const skipped = !slots.some((s) => s.weekday === local.weekday && s.minute === local.hour * 60 + local.minute);
          if (!skipped) expect(isSlot(spec, next)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('placeQueued', () => {
  const now = monday9 - 60 * MINUTE;
  const wednesday = Date.UTC(2026, 9, 21, 5, 30);
  const friday = Date.UTC(2026, 9, 23, 13, 0);

  it('keeps posts in slots that still exist and fills the first free slots for new ones', () => {
    const placed = placeQueued(queue, [
      { id: 'a', slotAt: wednesday },
      { id: 'b', slotAt: null },
      { id: 'c', slotAt: null },
    ], now);
    expect(placed).toEqual([
      { id: 'a', slotAt: wednesday },
      { id: 'b', slotAt: monday9 },
      { id: 'c', slotAt: friday },
    ]);
  });

  it('does not repack: a gap left by a removed post stays empty', () => {
    const placed = placeQueued(queue, [{ id: 'a', slotAt: friday }], now);
    expect(placed).toEqual([{ id: 'a', slotAt: friday }]);
  });

  it('moves only the posts whose slot disappeared, in their previous order', () => {
    const withoutWednesday: QueueSpec = { timeZone: HCM, slots: queue.slots.filter((s) => s.weekday !== 3) };
    const nextMonday = monday9 + 7 * DAY;
    const placed = placeQueued(withoutWednesday, [
      { id: 'mon', slotAt: monday9 },
      { id: 'wed', slotAt: wednesday },
      { id: 'fri', slotAt: friday },
    ], now);
    expect(placed).toEqual([
      { id: 'mon', slotAt: monday9 },
      { id: 'wed', slotAt: nextMonday },
      { id: 'fri', slotAt: friday },
    ]);
  });

  it('moves posts whose slot is in the past', () => {
    const placed = placeQueued(queue, [{ id: 'late', slotAt: monday9 }], monday9 + MINUTE);
    expect(placed).toEqual([{ id: 'late', slotAt: wednesday }]);
  });

  it('gives every post a distinct slot after now', () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.constantFrom(monday9, wednesday, friday, monday9 + 3 * MINUTE), { nil: null }), { maxLength: 12 }), (slotAts) => {
        const posts = slotAts.map((slotAt, i) => ({ id: `p${i}`, slotAt }));
        const placed = placeQueued(queue, posts, now);
        const times = placed.map((p) => p.slotAt);
        expect(times.every((t) => t !== null && t > now && isSlot(queue, t))).toBe(true);
        expect(new Set(times).size).toBe(times.length);
        expect(placed.map((p) => p.id)).toEqual(posts.map((p) => p.id));
      }),
    );
  });
});

describe('retime', () => {
  it('keeps the local clock time when the queue moves to another zone', () => {
    const moved = retime(monday9, HCM, NY);
    expect(localTime(moved, NY)).toMatchObject({ year: 2026, month: 10, day: 19, hour: 9, minute: 0 });
  });
});
