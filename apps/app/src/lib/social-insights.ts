// The counts a Story reports besides a post's (#1082, the channel package's STORY_METRIC_NAMES), in the order the
// screens show them.
export const STORY_METRICS = ['replies', 'tapsForward', 'tapsBack', 'exits', 'nextStory', 'follows', 'profileVisits'] as const;
export type StoryMetric = (typeof STORY_METRICS)[number];

// The Story counts a capture holds, in order; a count the platform did not give is left out.
export function storyCounts(metrics: Readonly<Record<string, number>>): { name: StoryMetric; value: number }[] {
  return STORY_METRICS.filter((m) => typeof metrics[m] === 'number' && Number.isFinite(metrics[m])).map((m) => ({ name: m, value: metrics[m] as number }));
}

// What works (#705): how a group's bar is drawn, and the weekday keys the strings use (1 is Monday).
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// A group's bar, in percent of the track: the channel's median sits at the middle (50%), twice it or more fills the
// track; no ratio (a channel median of 0) draws nothing.
export function barWidth(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.round((Math.min(ratio, 2) / 2) * 1000) / 10;
}
