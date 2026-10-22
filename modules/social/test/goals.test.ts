// Monthly goals (#1056): a month's bounds in the goals' time zone (28 to 31 days, daylight saving), whether a report
// period is exactly one month, and how a goal stands in a month under way and one that is over.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { goalEngagement, goalProgress, goalsMet, isMonthKey, monthBounds, monthElapsed, monthKeyAt, monthOfPeriod, targetsOf } from '../src/domain/goals.ts';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('the month of the goals, in their time zone', () => {
  it('starts and ends at local midnight', () => {
    const oct = monthBounds('2026-10', HCM);
    // Ho Chi Minh City is UTC+7 all year.
    expect(new Date(oct?.start as number).toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(new Date(oct?.end as number).toISOString()).toBe('2026-10-31T17:00:00.000Z');
    const dec = monthBounds('2026-12', HCM);
    expect(new Date(dec?.end as number).toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });

  it('lasts 28 to 31 days', () => {
    const days = (m: string) => {
      const b = monthBounds(m, HCM);
      return ((b?.end as number) - (b?.start as number)) / DAY;
    };
    expect(days('2027-02')).toBe(28);
    expect(days('2028-02')).toBe(29);
    expect(days('2026-04')).toBe(30);
    expect(days('2026-01')).toBe(31);
    expect(days('2100-02')).toBe(28);
  });

  it('follows daylight saving where the zone has it', () => {
    // New York moves its clocks forward on 8 March 2026 and back on 1 November 2026.
    const mar = monthBounds('2026-03', NY);
    expect(new Date(mar?.start as number).toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(new Date(mar?.end as number).toISOString()).toBe('2026-04-01T04:00:00.000Z');
    expect(((mar?.end as number) - (mar?.start as number)) / HOUR).toBe(31 * 24 - 1);
    const nov = monthBounds('2026-11', NY);
    expect(((nov?.end as number) - (nov?.start as number)) / HOUR).toBe(30 * 24 + 1);
  });

  it('puts an instant in the month of its zone, not of UTC', () => {
    // 31 October 18:00 UTC is already 1 November in Ho Chi Minh City.
    const at = Date.parse('2026-10-31T18:00:00Z');
    expect(monthKeyAt(at, HCM)).toBe('2026-11');
    expect(monthKeyAt(at, 'UTC')).toBe('2026-10');
    expect(monthKeyAt(Date.parse('2027-01-01T03:00:00Z'), NY)).toBe('2026-12');
  });

  it('reads only YYYY-MM keys', () => {
    expect(isMonthKey('2026-10')).toBe(true);
    expect(monthBounds('2026-13', HCM)).toBeNull();
    expect(monthBounds('2026-1', HCM)).toBeNull();
    expect(monthBounds('october', HCM)).toBeNull();
  });

  it('round-trips every month of a span of years in both zones', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2099 }), fc.integer({ min: 1, max: 12 }), fc.constantFrom(HCM, NY, 'UTC', 'Australia/Sydney'), (year, month, zone) => {
        const key = `${year}-${String(month).padStart(2, '0')}`;
        const b = monthBounds(key, zone);
        if (!b) return false;
        const days = (b.end - b.start) / DAY;
        return monthKeyAt(b.start, zone) === key && monthKeyAt(b.end - 1, zone) === key && monthKeyAt(b.end, zone) !== key && days >= 27.9 && days <= 31.1;
      }),
    );
  });
});

describe('a report period of exactly one month', () => {
  it('is the month from its first midnight to the next', () => {
    const oct = monthBounds('2026-10', HCM);
    expect(monthOfPeriod(oct?.start as number, oct?.end as number, HCM)).toBe('2026-10');
    const feb = monthBounds('2028-02', NY);
    expect(monthOfPeriod(feb?.start as number, feb?.end as number, NY)).toBe('2028-02');
  });

  it('is not a month in another zone, a day short or a day long, or 30 days', () => {
    const oct = monthBounds('2026-10', HCM);
    const start = oct?.start as number;
    const end = oct?.end as number;
    expect(monthOfPeriod(start, end, 'UTC')).toBeNull();
    expect(monthOfPeriod(start, end - DAY, HCM)).toBeNull();
    expect(monthOfPeriod(start, end + DAY, HCM)).toBeNull();
    expect(monthOfPeriod(start + DAY, end, HCM)).toBeNull();
    expect(monthOfPeriod(start, start + 30 * DAY, HCM)).toBeNull();
    // Two months are not one.
    expect(monthOfPeriod(start, monthBounds('2026-11', HCM)?.end as number, HCM)).toBeNull();
  });
});

describe('how a goal stands', () => {
  const oct = monthBounds('2026-10', HCM) as { start: number; end: number };
  const at = (day: number) => oct.start + day * DAY;

  it('projects a month under way linearly over its real length', () => {
    // Ten days of 31 gone, 4 posts: on course for 12.4, so 12 posts are on track and 13 behind.
    expect(monthElapsed(oct, at(10))).toBeCloseTo(10 / 31, 10);
    expect(goalProgress({ metric: 'posts', target: 12, actual: 4 }, oct, at(10))).toEqual({ metric: 'posts', target: 12, actual: 4, projected: 12, ratio: 4 / 12, status: 'on_track' });
    expect(goalProgress({ metric: 'posts', target: 13, actual: 4 }, oct, at(10)).status).toBe('behind');
    // Half of February 2027 (28 days) is 14 days.
    const feb = monthBounds('2027-02', HCM) as { start: number; end: number };
    expect(goalProgress({ metric: 'reach', target: 50_000, actual: 25_000 }, feb, feb.start + 14 * DAY)).toMatchObject({ projected: 50_000, status: 'on_track' });
    expect(goalProgress({ metric: 'reach', target: 50_000, actual: 24_999 }, feb, feb.start + 14 * DAY).status).toBe('behind');
  });

  it('is met as soon as the count reaches the target, before the month ends', () => {
    expect(goalProgress({ metric: 'engagement', target: 1000, actual: 1000 }, oct, at(3))).toMatchObject({ status: 'met', ratio: 1 });
    expect(goalProgress({ metric: 'engagement', target: 1000, actual: 1500 }, oct, at(3)).status).toBe('met');
  });

  it('is met or missed once the month is over, with no projection beyond the count', () => {
    expect(goalProgress({ metric: 'posts', target: 12, actual: 12 }, oct, oct.end)).toEqual({ metric: 'posts', target: 12, actual: 12, projected: 12, ratio: 1, status: 'met' });
    expect(goalProgress({ metric: 'posts', target: 12, actual: 11 }, oct, oct.end + DAY)).toMatchObject({ projected: 11, status: 'missed' });
    // A month's last millisecond is still under way.
    expect(goalProgress({ metric: 'posts', target: 12, actual: 11 }, oct, oct.end - 1).status).toBe('behind');
  });

  it('expects nothing before the month starts', () => {
    expect(goalProgress({ metric: 'posts', target: 12, actual: 0 }, oct, oct.start - HOUR)).toEqual({ metric: 'posts', target: 12, actual: 0, projected: null, ratio: 0, status: 'on_track' });
  });

  it('has no data without a count', () => {
    expect(goalProgress({ metric: 'followersGained', target: 100, actual: null }, oct, at(10))).toEqual({ metric: 'followersGained', target: 100, actual: null, projected: null, ratio: null, status: 'no_data' });
  });

  it('counts followers lost as a negative count', () => {
    expect(goalProgress({ metric: 'followersGained', target: 100, actual: -20 }, oct, oct.end)).toMatchObject({ status: 'missed', ratio: -0.2 });
  });

  it('counts how many are met', () => {
    const items = [goalProgress({ metric: 'posts', target: 1, actual: 1 }, oct, oct.end), goalProgress({ metric: 'reach', target: 10, actual: 1 }, oct, oct.end)];
    expect(goalsMet(items)).toBe(1);
  });
});

describe('targets and engagement', () => {
  it('lists the targets set, in a fixed order', () => {
    expect(targetsOf({ reach: 50_000, posts: 12, impressions: null })).toEqual([
      { metric: 'posts', target: 12 },
      { metric: 'reach', target: 50_000 },
    ]);
    expect(targetsOf({})).toEqual([]);
  });

  it('adds reactions, comments, shares, saves and clicks, and nothing else', () => {
    expect(goalEngagement({ reactions: 10, comments: 2, shares: 1, saves: 3, clicks: 4, reach: 1000, views: 50, linkClicks: 9 })).toBe(20);
    expect(goalEngagement({ reach: 1000 })).toBeNull();
    expect(goalEngagement({ comments: 0 })).toBe(0);
  });
});
