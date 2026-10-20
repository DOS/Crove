// What works (#705): how a group's bar is drawn, and the weekday keys the strings use (1 is Monday).
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// A group's bar, in percent of the track: the channel's median sits at the middle (50%), twice it or more fills the
// track; no ratio (a channel median of 0) draws nothing.
export function barWidth(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.round((Math.min(ratio, 2) / 2) * 1000) / 10;
}
