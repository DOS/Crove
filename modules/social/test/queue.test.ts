// Posting queue slot math (issue #231): IANA zones, DST, and the keep-your-slot placement rules.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isSlot, isValidTimeZone, localTime, moveToFront, nextFreeSlot, openSlots, placeQueued, queueRunway, retime, shuffleTimes, slotRefusal, slotsBetween, zonedToEpoch, type Holder, type QueueSpec } from '../src/index.ts';

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

  it('takes zone names only, never an offset (#850)', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    for (const offset of ['+07:00', '-05:00', 'GMT+7', '']) expect(isValidTimeZone(offset), offset).toBe(false);
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

  it('keeps a slot of a content category for its label, and gives other posts the open slots (#745)', () => {
    const wednesday = Date.UTC(2026, 9, 21, 5, 30);
    const friday = Date.UTC(2026, 9, 23, 13, 0);
    const labelled: QueueSpec = { timeZone: HCM, slots: queue.slots.map((s) => (s.weekday === 3 ? { ...s, labelId: 'promo' } : s)) };
    // A promotion takes Wednesday, its own, though Monday is free and sooner.
    expect(nextFreeSlot(labelled, monday9 - MINUTE, new Set(), 366, new Set(['promo']))).toBe(wednesday);
    // Its own taken this week, it takes next week's: a category keeps its day.
    expect(nextFreeSlot(labelled, monday9 - MINUTE, new Set([wednesday]), 366, new Set(['promo']))).toBe(wednesday + 7 * DAY);
    // With no slot of its own within the horizon, it takes the first open one.
    expect(nextFreeSlot(labelled, monday9 - MINUTE, new Set([wednesday]), 1, new Set(['promo']))).toBe(monday9);
    // A post without the label never takes Wednesday.
    expect(nextFreeSlot(labelled, monday9 - MINUTE, new Set())).toBe(monday9);
    expect(nextFreeSlot(labelled, monday9 - MINUTE, new Set([monday9]), 366, new Set(['tips']))).toBe(friday);
    // Placing: a post holding a slot kept for a label it does not have moves to an open one.
    const placed = placeQueued(labelled, [{ id: 'a', slotAt: wednesday, labelIds: ['promo'] }, { id: 'b', slotAt: wednesday + 7 * DAY }], monday9 - MINUTE);
    expect(placed).toEqual([{ id: 'a', slotAt: wednesday }, { id: 'b', slotAt: monday9 }]);
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
          expect(isSlot(spec, next)).toBe(true);
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

  it('keeps a post placed in a slot that falls in a DST gap', () => {
    // Sunday 02:30 does not exist in New York on 2026-03-08; the slot instant is 03:30 EDT.
    const ny: QueueSpec = { timeZone: NY, slots: [{ weekday: 7, minute: 150 }] };
    const before = Date.UTC(2026, 2, 7, 12, 0);
    const [first] = placeQueued(ny, [{ id: 'a', slotAt: null }], before);
    expect(first?.slotAt).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(placeQueued(ny, [{ id: 'a', slotAt: first?.slotAt ?? null }], before)).toEqual([first]);
  });

  it('neither keeps nor takes a reserved slot', () => {
    const placed = placeQueued(queue, [
      { id: 'a', slotAt: monday9 },
      { id: 'b', slotAt: null },
    ], now, new Set([monday9]));
    expect(placed).toEqual([
      { id: 'a', slotAt: wednesday },
      { id: 'b', slotAt: friday },
    ]);
  });

  it('gives the shared slot to the lower id', () => {
    const placed = placeQueued(queue, [
      { id: 'b', slotAt: monday9 },
      { id: 'a', slotAt: monday9 },
    ], now);
    expect(placed).toEqual([
      { id: 'b', slotAt: wednesday },
      { id: 'a', slotAt: monday9 },
    ]);
  });

  it('is stable: placing an already placed queue changes nothing, in any zone', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(HCM, NY, 'Australia/Lord_Howe', 'Asia/Kathmandu'),
        fc.uniqueArray(fc.record({ weekday: fc.integer({ min: 1, max: 7 }), minute: fc.integer({ min: 0, max: 1439 }) }), {
          minLength: 1,
          maxLength: 5,
          selector: (s) => `${s.weekday}:${s.minute}`,
        }),
        // Around the 2026 DST changes of New York (March, November) and Lord Howe (April, October).
        fc.constantFrom(Date.UTC(2026, 2, 6), Date.UTC(2026, 3, 3), Date.UTC(2026, 9, 2), Date.UTC(2026, 9, 30)),
        fc.integer({ min: 1, max: 8 }),
        (tz, slots, nowMs, n) => {
          const spec: QueueSpec = { timeZone: tz, slots };
          const placed = placeQueued(spec, Array.from({ length: n }, (_, i) => ({ id: `p${i}`, slotAt: null })), nowMs);
          expect(placeQueued(spec, placed, nowMs)).toEqual(placed);
          const times = placed.map((p) => p.slotAt);
          expect(new Set(times).size).toBe(n);
          expect(times.every((t) => t !== null && t > nowMs && isSlot(spec, t))).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
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


// Reordering a queue (#1020): posts trade the times they hold.
describe('queue reordering', () => {
  // A seeded generator, so a shuffle is the same on every run.
  const seeded = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  type P = Holder & { labels: string[] };
  // Times 1..n hours; a time's label from the map, open otherwise.
  const holders = (n: number, labels: Record<string, string[]> = {}): P[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, at: (i + 1) * 3_600_000, labels: labels[`p${i}`] ?? [] }));
  const fitsWith = (kept: Record<number, string>) => (h: P, at: number) => {
    const label = kept[at];
    return label === undefined || h.labels.includes(label);
  };
  const sameTimes = (before: readonly P[], after: Map<string, number>) => {
    expect([...after.values()].sort((a, b) => a - b)).toEqual(before.map((h) => h.at).sort((a, b) => a - b));
    expect(new Set(after.values()).size).toBe(before.length);
  };

  it('moves every post to another time when no slot is kept, and repeats with the same random', () => {
    const list = holders(6);
    const once = shuffleTimes(list, () => true, seeded(7));
    sameTimes(list, once);
    for (const h of list) expect(once.get(h.id)).not.toBe(h.at);
    expect(shuffleTimes(list, () => true, seeded(7))).toEqual(once);
    expect(shuffleTimes(list, () => true, seeded(8))).not.toEqual(once);
  });

  it('gives a kept slot only to posts with its label', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 2, max: 12 }), (seed, n) => {
        // Every third time is kept for "promo"; the posts holding them have the label, and so do some others.
        const kept: Record<number, string> = {};
        const labels: Record<string, string[]> = {};
        for (let i = 0; i < n; i++) {
          if (i % 3 === 0) kept[(i + 1) * 3_600_000] = 'promo';
          if (i % 3 === 0 || i % 4 === 1) labels[`p${i}`] = ['promo'];
        }
        const list = holders(n, labels);
        const fits = fitsWith(kept);
        const after = shuffleTimes(list, fits, seeded(seed));
        sameTimes(list, after);
        for (const h of list) expect(fits(h, after.get(h.id) as number)).toBe(true);
      }),
    );
  });

  it('draws again when the kept slots refused every trade of a pass (#1412)', () => {
    // p1 holds the kept slot; p0 and p2 may not take it, so only p0 and p2 can trade.
    const list = holders(3, { p1: ['promo'] });
    const fits = fitsWith({ 7_200_000: 'promo' });
    // The first pass pairs p2 with p1 and then p1 with p0, both refused; the second pairs p2 with p0.
    const draws = [0.9, 0.5, 0.1, 0.5];
    let k = 0;
    const after = shuffleTimes(list, fits, () => draws[k++ % draws.length] as number);
    expect(after).toEqual(new Map([['p0', 10_800_000], ['p1', 7_200_000], ['p2', 3_600_000]]));
    // Nobody may trade at all: the order stays, and the passes stop.
    expect(shuffleTimes(holders(2, { p1: ['promo'] }), fitsWith({ 7_200_000: 'promo' }), () => 0)).toEqual(new Map([['p0', 3_600_000], ['p1', 7_200_000]]));
  });

  it('keeps a lone post and an empty list as they are', () => {
    expect(shuffleTimes([], () => true)).toEqual(new Map());
    expect(shuffleTimes(holders(1), () => true)).toEqual(new Map([['p0', 3_600_000]]));
  });

  it('puts a post first and moves the posts it passes one place later', () => {
    const list = holders(4);
    const after = moveToFront(list, 'p2', () => true);
    expect(Object.fromEntries(after)).toEqual({ p2: 3_600_000, p0: 7_200_000, p1: 10_800_000, p3: 14_400_000 });
    // Already first: nothing moves.
    expect(moveToFront(list, 'p0', () => true)).toEqual(new Map(list.map((h) => [h.id, h.at])));
    // Not one of them: nothing moves.
    expect(moveToFront(list, 'nobody', () => true)).toEqual(new Map(list.map((h) => [h.id, h.at])));
  });

  it('passes by the posts and slots kept for a label the moving post lacks', () => {
    // 1h is kept for "promo" and held by a promo post; the post at 4h has no label.
    const list = holders(4, { p0: ['promo'] });
    const fits = fitsWith({ 3_600_000: 'promo' });
    const after = moveToFront(list, 'p3', fits);
    expect(Object.fromEntries(after)).toEqual({ p0: 3_600_000, p3: 7_200_000, p1: 10_800_000, p2: 14_400_000 });
    sameTimes(list, after);
    // A post that may not take the moving post's time stays where it is: p0 (no label) cannot take the promo slot at 2h.
    const passing = moveToFront(holders(3, { p1: ['promo'], p2: ['promo'] }), 'p2', fitsWith({ 7_200_000: 'promo' }));
    expect(Object.fromEntries(passing)).toEqual({ p0: 3_600_000, p2: 7_200_000, p1: 10_800_000 });
  });

  it('never hands out a time a post may not take', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), fc.integer({ min: 0, max: 9 }), fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }), (n, pick, promo) => {
        const kept: Record<number, string> = {};
        const labels: Record<string, string[]> = {};
        for (let i = 0; i < n; i++) {
          if (promo[i]) {
            kept[(i + 1) * 3_600_000] = 'promo';
            labels[`p${i}`] = ['promo'];
          }
        }
        const list = holders(n, labels);
        const fits = fitsWith(kept);
        const target = `p${pick % n}`;
        const after = moveToFront(list, target, fits);
        sameTimes(list, after);
        for (const h of list) expect(fits(h, after.get(h.id) as number)).toBe(true);
        expect(after.get(target) as number).toBeLessThanOrEqual(list[pick % n]?.at as number);
      }),
    );
  });
});

describe('queueRunway: how far ahead a queue is filled (#1079)', () => {
  // Monday 2026-11-02 08:00 in Ho Chi Minh City (UTC+7).
  const now = Date.UTC(2026, 10, 2, 1, 0);
  const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 7, minute);
  const daily: QueueSpec = { timeZone: HCM, slots: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute: 9 * 60 })) };

  it('counts the posting days ahead and those with a post', () => {
    expect(queueRunway(daily, [], now, 3)).toEqual({ postingDays: 3, filledDays: 0, low: true });
    expect(queueRunway(daily, [at(2, 9), at(3, 9), at(4, 9)], now, 3)).toEqual({ postingDays: 3, filledDays: 3, low: false });
    // A gap in the middle is low too.
    expect(queueRunway(daily, [at(2, 9), at(4, 9)], now, 3)).toEqual({ postingDays: 3, filledDays: 2, low: true });
  });

  it('never counts a day without a slot, and a queue without slots is never low', () => {
    // Mondays, Wednesdays and Fridays only: a week ahead has three posting days.
    expect(queueRunway(queue, [at(2, 9), at(4, 12, 30), at(6, 20)], now, 7)).toEqual({ postingDays: 3, filledDays: 3, low: false });
    expect(queueRunway({ timeZone: HCM, slots: [] }, [], now, 7)).toEqual({ postingDays: 0, filledDays: 0, low: false });
  });

  it('looks only at the window after now, by local day', () => {
    // Today's slot has passed (9:00 at 10:00): the window starts tomorrow.
    const later = Date.UTC(2026, 10, 2, 3, 0);
    expect(queueRunway(daily, [at(3, 9)], later, 1)).toEqual({ postingDays: 1, filledDays: 1, low: false });
    // A post after the window, or before now, fills nothing.
    expect(queueRunway(daily, [at(2, 9), at(9, 9)], now, 1)).toEqual({ postingDays: 1, filledDays: 1, low: false });
    expect(queueRunway(daily, [at(1, 9)], now, 1)).toEqual({ postingDays: 1, filledDays: 0, low: true });
  });
});

describe('open slots on the calendar (#1158)', () => {
  // Every day at 02:30 and 09:00, New York time, around the 2026-03-08 forward change (02:00 EST to 03:00 EDT); Monday's
  // 09:00 is kept for promotions.
  const ny: QueueSpec = { timeZone: NY, slots: [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => [{ weekday, minute: 150 }, { weekday, minute: 540, labelId: weekday === 1 ? 'promo' : null }]) };
  const from = Date.UTC(2026, 2, 7, 0, 0);
  const to = Date.UTC(2026, 2, 10, 0, 0);
  const sunday9 = Date.UTC(2026, 2, 8, 13, 0); // 09:00 EDT

  it('lists the slots no post holds across a DST change, each at its local clock time', () => {
    const open = openSlots(ny, from, to, new Set([sunday9]), 500);
    expect(open.map((s) => s.at)).toEqual([
      Date.UTC(2026, 2, 7, 7, 30), // Saturday 02:30 EST
      Date.UTC(2026, 2, 7, 14, 0), // Saturday 09:00 EST
      Date.UTC(2026, 2, 8, 7, 30), // Sunday 02:30 does not exist: 03:30 EDT, just after the change
      Date.UTC(2026, 2, 9, 6, 30), // Monday 02:30 EDT
      Date.UTC(2026, 2, 9, 13, 0), // Monday 09:00 EDT, kept for promotions
    ]);
    expect(open.filter((s) => localTime(s.at, NY).hour === 9).map((s) => localTime(s.at, NY).minute)).toEqual([0, 0]);
    expect(open.map((s) => s.labelId)).toEqual([null, null, null, null, 'promo']);
    // At most `limit`, the first ones; an empty queue or range has none.
    expect(openSlots(ny, from, to, new Set(), 2).map((s) => s.at)).toEqual([Date.UTC(2026, 2, 7, 7, 30), Date.UTC(2026, 2, 7, 14, 0)]);
    expect(openSlots({ timeZone: NY, slots: [] }, from, to, new Set(), 500)).toEqual([]);
    expect(openSlots(ny, to, from, new Set(), 500)).toEqual([]);
  });

  it('lists a repeated time of a backward change once, at its first occurrence', () => {
    // 2026-11-01 01:30 happens twice in New York; the slot is the first one (EDT, UTC-4).
    const night: QueueSpec = { timeZone: NY, slots: [{ weekday: 7, minute: 90 }] };
    expect(openSlots(night, Date.UTC(2026, 10, 1, 0, 0), Date.UTC(2026, 10, 2, 0, 0), new Set(), 500).map((s) => s.at)).toEqual([Date.UTC(2026, 10, 1, 5, 30)]);
  });

  it('takes exactly an open slot of the queue, after now, that the post may use', () => {
    const none = new Set<string>();
    expect(slotRefusal(ny, Date.UTC(2026, 2, 8, 7, 30), from, new Set(), none)).toBeNull();
    // 01:30 EST on the day of the change is no slot, nor is a time off the minute or past the horizon.
    expect(slotRefusal(ny, Date.UTC(2026, 2, 8, 6, 30), from, new Set(), none)).toBe('not_in_queue');
    expect(slotRefusal(ny, Date.UTC(2026, 2, 8, 7, 30) + 1000, from, new Set(), none)).toBe('not_in_queue');
    expect(slotRefusal(ny, Date.UTC(2026, 2, 7, 14, 0) + 400 * DAY, from, new Set(), none)).toBe('not_in_queue');
    expect(slotRefusal(ny, Date.UTC(2026, 2, 7, 14, 0), Date.UTC(2026, 2, 7, 14, 0), new Set(), none)).toBe('past');
    expect(slotRefusal(ny, sunday9, from, new Set([sunday9]), none)).toBe('taken');
    // A slot kept for a label goes only to a post with it.
    const monday9 = Date.UTC(2026, 2, 9, 13, 0);
    expect(slotRefusal(ny, monday9, from, new Set(), none)).toBe('label');
    expect(slotRefusal(ny, monday9, from, new Set(), new Set(['promo']))).toBeNull();
  });
});
