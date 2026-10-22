// Monthly goals (#1056), as Hootsuite Analytics sets them: an agency's contract counts ("12 posts and 50k reach a
// month") as targets for the whole org or one channel, and how a month stands against them. Pure, so the Metrics tab,
// the client report page and the report mail judge progress the same way.
//
// A month is a calendar month in the goals' time zone, from its first midnight to the next month's; its length in
// milliseconds is what it really lasts there (28 to 31 days, give or take an hour of daylight saving). The projection
// is linear: what came in so far, spread over the share of the month gone by.
import { localTime, zonedToEpoch } from './queue.ts';

export const GOAL_METRICS = ['posts', 'reach', 'impressions', 'engagement', 'followersGained'] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export type GoalTargets = { [K in GoalMetric]?: number | null | undefined };
// A target is a whole count from 1 to this.
export const GOAL_TARGET_MAX = 1_000_000_000_000;
// The zone goals are counted in until an owner or admin sets one.
export const GOAL_DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
// A goal's engagement adds up the counts the client report and the report mail call engagement: reactions, comments,
// shares, saves and the platform's own clicks (not Crove's short link clicks, which may count the same people).
export const GOAL_ENGAGEMENT_COUNTS = ['reactions', 'comments', 'shares', 'saves', 'clicks'] as const;

export type GoalStatus = 'met' | 'missed' | 'on_track' | 'behind' | 'no_data';

export interface GoalProgress {
  metric: GoalMetric;
  target: number;
  // null: no count for it in the month (a platform that does not report it, a channel without follower counts).
  actual: number | null;
  // The linear end-of-month projection while the month runs; the actual count once it is over; null before it starts
  // or without an actual count.
  projected: number | null;
  // actual / target (1 is the goal reached), null without an actual count.
  ratio: number | null;
  status: GoalStatus;
}

export interface MonthBounds {
  // YYYY-MM
  month: string;
  start: number;
  end: number;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const isMonthKey = (s: string) => MONTH.test(s);

/** The month (YYYY-MM) an instant falls in, in a zone. */
export function monthKeyAt(epochMs: number, timeZone: string): string {
  const l = localTime(epochMs, timeZone);
  return `${String(l.year).padStart(4, '0')}-${String(l.month).padStart(2, '0')}`;
}

/** From the first midnight of a month to the first of the next, in a zone; null for a malformed key. */
export function monthBounds(month: string, timeZone: string): MonthBounds | null {
  const m = MONTH.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const start = zonedToEpoch({ year, month: mon, day: 1, hour: 0, minute: 0 }, timeZone);
  const end = zonedToEpoch({ year: mon === 12 ? year + 1 : year, month: mon === 12 ? 1 : mon + 1, day: 1, hour: 0, minute: 0 }, timeZone);
  return { month, start, end };
}

/** The month a period covers when it is exactly one calendar month in the zone, else null. */
export function monthOfPeriod(startMs: number, endMs: number, timeZone: string): string | null {
  const month = monthKeyAt(startMs, timeZone);
  const b = monthBounds(month, timeZone);
  return b && b.start === startMs && b.end === endMs ? month : null;
}

/** The engagement of a set of counts, as a goal counts it; null when none of its counts is there. */
export function goalEngagement(metrics: Readonly<Record<string, number>>): number | null {
  const present = GOAL_ENGAGEMENT_COUNTS.filter((name) => Number.isFinite(metrics[name]));
  return present.length === 0 ? null : present.reduce((sum, name) => sum + (metrics[name] as number), 0);
}

/** The share of the month gone by at nowMs, from 0 (not started) to 1 (over). */
export function monthElapsed(bounds: Pick<MonthBounds, 'start' | 'end'>, nowMs: number): number {
  if (nowMs <= bounds.start) return 0;
  if (nowMs >= bounds.end) return 1;
  return (nowMs - bounds.start) / (bounds.end - bounds.start);
}

/**
 * How a goal stands at nowMs. A month that is over is met or missed; one under way is met as soon as the count reaches
 * the target, else on track when the linear projection reaches it and behind when it does not. Without a count it has
 * no data.
 */
export function goalProgress(goal: { metric: GoalMetric; target: number; actual: number | null }, bounds: Pick<MonthBounds, 'start' | 'end'>, nowMs: number): GoalProgress {
  const { metric, target, actual } = goal;
  if (actual === null || !Number.isFinite(actual)) return { metric, target, actual: null, projected: null, ratio: null, status: 'no_data' };
  const ratio = target > 0 ? actual / target : null;
  const elapsed = monthElapsed(bounds, nowMs);
  if (elapsed >= 1) return { metric, target, actual, projected: actual, ratio, status: actual >= target ? 'met' : 'missed' };
  // Before the month starts nothing is due yet.
  if (elapsed === 0) return { metric, target, actual, projected: null, ratio, status: actual >= target ? 'met' : 'on_track' };
  const projected = Math.round(actual / elapsed);
  return { metric, target, actual, projected, ratio, status: actual >= target ? 'met' : projected >= target ? 'on_track' : 'behind' };
}

/** The targets set, in GOAL_METRICS order. */
export function targetsOf(targets: GoalTargets): { metric: GoalMetric; target: number }[] {
  return GOAL_METRICS.flatMap((metric) => {
    const target = targets[metric];
    return typeof target === 'number' && target > 0 ? [{ metric, target }] : [];
  });
}

/** How many of the goals are met. */
export const goalsMet = (items: readonly Pick<GoalProgress, 'status'>[]) => items.filter((i) => i.status === 'met').length;
