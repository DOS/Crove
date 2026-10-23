// A post that does much better than usual (#1132), as Sprout and Later point them out. A published variant's 24-hour
// capture (its first capture with counts taken at least 24 hours after it went out) is set against the latest counts of
// its channel's last OUTPERFORM_HISTORY published Crove posts before it: when its engagement is OUTPERFORM_RATIO times
// their median or more, the author and the assignee are told once. Engagement is engagementOf (reactions, comments,
// shares and saves), which every platform reports; reach is compared too when the post and enough of the posts before
// it report it, and shown with the notice, but it does not decide it. A channel with fewer than OUTPERFORM_MIN_HISTORY
// earlier posts with counts, or whose usual engagement is 0, has no "usual" to beat and tells nobody.
import { engagementOf, median } from './insights.ts';

// The capture the check looks at is the first one with counts at least this long after the post went out.
export const OUTPERFORM_AFTER_HOURS = 24;
// The channel's earlier posts the post is set against, newest first, and how many it needs at least.
export const OUTPERFORM_HISTORY = 30;
export const OUTPERFORM_MIN_HISTORY = 10;
// How many times the usual engagement a post must reach.
export const OUTPERFORM_RATIO = 2;
// The largest ratio a notice names; anything above shows as this.
export const OUTPERFORM_RATIO_CAP = 9999;

export interface Comparison {
  value: number;
  median: number;
  ratio: number;
}

export interface Outperformance {
  engagement: Comparison;
  // Null when the post, or too few of the posts before it, report reach, or their usual reach is 0.
  reach: Comparison | null;
}

const reachOf = (metrics: Readonly<Record<string, number>>): number | null => {
  const r = metrics.reach;
  return typeof r === 'number' && Number.isFinite(r) && r >= 0 ? r : null;
};

/**
 * How the post's counts compare with the channel's usual, or null when they are not at OUTPERFORM_RATIO times it.
 * earlier: the latest counts of the channel's posts before it, newest first; only the first OUTPERFORM_HISTORY with any
 * count are used, and an empty capture counts as none.
 */
export function outperformance(post: Readonly<Record<string, number>>, earlier: readonly Readonly<Record<string, number>>[]): Outperformance | null {
  if (Object.keys(post).length === 0) return null;
  const history = earlier.filter((m) => Object.keys(m).length > 0).slice(0, OUTPERFORM_HISTORY);
  if (history.length < OUTPERFORM_MIN_HISTORY) return null;
  const usual = median(history.map(engagementOf));
  if (!(usual > 0)) return null;
  const engagement = engagementOf(post);
  const ratio = engagement / usual;
  if (ratio < OUTPERFORM_RATIO) return null;
  let reach: Comparison | null = null;
  const own = reachOf(post);
  const reaches = history.map(reachOf).filter((r): r is number => r !== null);
  if (own !== null && reaches.length >= OUTPERFORM_MIN_HISTORY) {
    const usualReach = median(reaches);
    if (usualReach > 0) reach = { value: own, median: usualReach, ratio: own / usualReach };
  }
  return { engagement: { value: engagement, median: usual, ratio }, reach };
}

/**
 * A ratio as a notice names it: one decimal at most, rounded down (2.46 is "2.4", 2.0 is "2"), so it never claims more
 * than the counts show; capped at OUTPERFORM_RATIO_CAP.
 */
export function ratioLabel(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0';
  const tenths = Math.floor(Math.min(ratio, OUTPERFORM_RATIO_CAP) * 10 + 1e-9);
  return String(tenths / 10);
}

// What a notice's ratio may look like (the dispatch and the mail accept nothing else).
export const RATIO_LABEL = /^\d{1,4}(\.\d)?$/;
