// The counts a Story reports besides a post's (#1082, the channel package's STORY_METRIC_NAMES), in the order the
// screens show them.
export const STORY_METRICS = ['replies', 'tapsForward', 'tapsBack', 'exits', 'nextStory', 'follows', 'profileVisits'] as const;
export type StoryMetric = (typeof STORY_METRICS)[number];

// The Story counts a capture holds, in order; a count the platform did not give is left out.
export function storyCounts(metrics: Readonly<Record<string, number>>): { name: StoryMetric; value: number }[] {
  return STORY_METRICS.filter((m) => typeof metrics[m] === 'number' && Number.isFinite(metrics[m])).map((m) => ({ name: m, value: metrics[m] as number }));
}

// A Reel's watch time (#1147, the channel package's REEL_METRIC_NAMES), in milliseconds, in the order the screens show
// it: the average time a play lasted, then the time it was played in all.
export const REEL_METRICS = ['avgWatchTimeMs', 'totalWatchTimeMs'] as const;
export type ReelMetric = (typeof REEL_METRICS)[number];

// The watch times a capture holds, in order; one the platform did not give is left out.
export function reelCounts(metrics: Readonly<Record<string, number>>): { name: ReelMetric; ms: number }[] {
  return REEL_METRICS.filter((m) => typeof metrics[m] === 'number' && Number.isFinite(metrics[m]) && (metrics[m] as number) >= 0).map((m) => ({ name: m, ms: metrics[m] as number }));
}

// The client report's Reels (#1151), read again: how many went out in the period and the median of their average watch
// time in milliseconds (null when none reports one); null when there is no Reel or the answer is not that shape.
export function reportReels(value: unknown): { posts: number; medianAvgWatchTimeMs: number | null } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { posts, medianAvgWatchTimeMs: median } = value as { posts?: unknown; medianAvgWatchTimeMs?: unknown };
  if (typeof posts !== 'number' || !Number.isInteger(posts) || posts <= 0) return null;
  return { posts, medianAvgWatchTimeMs: typeof median === 'number' && Number.isFinite(median) && median >= 0 ? median : null };
}

// Milliseconds as seconds with one decimal (12345 is 12.3).
export function watchSeconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

// A watch time in the unit that reads best, with one decimal: seconds under a minute, minutes under an hour, hours
// beyond (a Reel's total watch time grows with its plays).
export function watchDuration(ms: number): { unit: 'seconds' | 'minutes' | 'hours'; value: number } {
  if (ms < 60_000) return { unit: 'seconds', value: watchSeconds(ms) };
  if (ms < 3_600_000) return { unit: 'minutes', value: Math.round(ms / 6_000) / 10 };
  return { unit: 'hours', value: Math.round(ms / 360_000) / 10 };
}

// What works (#705): how a group's bar is drawn, and the weekday keys the strings use (1 is Monday).
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// A group's bar, in percent of the track: the channel's median sits at the middle (50%), twice it or more fills the
// track; no ratio (a channel median of 0) draws nothing.
export function barWidth(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.round((Math.min(ratio, 2) / 2) * 1000) / 10;
}
