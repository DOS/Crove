// Account growth on the Metrics tab (#645): each channel's followers over the window, as a number, its change and a
// small line; and the posts of the window that did best.

export interface GrowthPoint {
  day: string;
  followers: number | null;
  reach: number | null;
}

// The latest followers, how many more (or fewer) than at the first snapshot of the window, and the latest reach.
export function growthOf(points: readonly GrowthPoint[]): { latest: number | null; change: number | null; reach: number | null; days: number } {
  const counted = points.filter((p) => p.followers !== null);
  const first = counted[0]?.followers ?? null;
  const latest = counted.at(-1)?.followers ?? null;
  const reach = [...points].reverse().find((p) => p.reach !== null)?.reach ?? null;
  return { latest, change: first === null || latest === null || counted.length < 2 ? null : latest - first, reach, days: counted.length };
}

// An SVG path for the values in a width x height box, the lowest at the bottom; empty for fewer than two values.
export function sparkline(values: readonly number[], width: number, height: number): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = Math.round(i * step * 10) / 10;
      const y = Math.round((height - ((v - min) / span) * height) * 10) / 10;
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

export type ChangeDirection = 'up' | 'down' | 'same';

// A count against the same count of the period just before (#947), in percent: a whole number from 10% up, one
// decimal below, so a small change does not read as 0%. null when the period before has no data or is zero (no
// percentage of nothing); a count missing now while it had one before is 0 now.
export function changeOf(current: number | null | undefined, previous: number | null | undefined): { percent: number; direction: ChangeDirection } | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) return null;
  const now = current === null || current === undefined || !Number.isFinite(current) ? 0 : current;
  const raw = ((now - previous) / Math.abs(previous)) * 100;
  // Half away from zero, the same way up and down; no sign on no change.
  const size = Math.abs(raw) >= 10 ? Math.round(Math.abs(raw)) : Math.round(Math.abs(raw) * 10) / 10;
  const percent = size === 0 ? 0 : Math.sign(raw) * size;
  return { percent, direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'same' };
}

// Reactions, comments, shares, saves and clicks: what a person did with a post.
export function engagementOf(metrics: Readonly<Record<string, number | undefined>>): number {
  return ['reactions', 'comments', 'shares', 'saves', 'clicks'].reduce((sum, k) => sum + (metrics[k] ?? 0), 0);
}

// The n posts with the most engagement, the most seen first among equals; none without any.
export function topPosts<T extends { metrics: Readonly<Record<string, number | undefined>> }>(rows: readonly T[], n: number): T[] {
  const seen = (m: Readonly<Record<string, number | undefined>>) => (m.views ?? 0) + (m.impressions ?? 0) + (m.reach ?? 0);
  return rows
    .filter((r) => engagementOf(r.metrics) > 0)
    .sort((a, b) => engagementOf(b.metrics) - engagementOf(a.metrics) || seen(b.metrics) - seen(a.metrics))
    .slice(0, n);
}
