// Engagement rate (#1157), the headline number of an agency's report: engagement as the client report, the report mail
// and the goals count it (reactions, comments, shares, saves and the platform's clicks, goalEngagement) over reach;
// where nothing reports reach, over impressions, and the screens say so ("theo lượt hiển thị"). Pure, so the Metrics
// tab, the post page, What works, the client report page and the CSV export work it out the same way.
//
// A rate of several posts or channels is the sum of their engagement over the sum of the same denominator, from those
// that report it; never an average of their percentages, which would weigh a post seen by ten people like one seen by
// ten thousand. A post or channel counts towards a basis when it reports that denominator above 0 and at least one of
// the engagement counts. With neither basis there is no rate (null), and a screen shows "-": never Infinity or NaN.
import { goalEngagement } from './goals.ts';

export const ENGAGEMENT_RATE_BASES = ['reach', 'impressions'] as const;
export type EngagementRateBasis = (typeof ENGAGEMENT_RATE_BASES)[number];

export interface EngagementRate {
  // engagement / denominator, a finite fraction (0.0345 is 3.45%).
  rate: number;
  // What it is over: reach, or impressions where nothing counted reports reach.
  basis: EngagementRateBasis;
  engagement: number;
  denominator: number;
}

// What a rate is made of (#1164), per basis: the engagement and the denominator summed over the posts that report that
// denominator above 0 and at least one engagement count. A channel's or a period's totals sum each count over all its
// posts, so when some posts report reach and others do not (older captures, posts published outside Crove), the
// summed engagement holds posts the summed reach does not, and a rate from the totals reads high: rates come from these
// sums instead, which the totals query and the client report carry next to the plain sums.
export interface RateSums {
  engagement: number;
  denominator: number;
}
export type RateBases = { [B in EngagementRateBasis]?: RateSums | undefined };

/** The rate sums of a set of posts' counts: only the posts that report each denominator count towards it. */
export function rateBasesOf(posts: readonly Readonly<Record<string, number>>[]): RateBases {
  const out: RateBases = {};
  for (const basis of ENGAGEMENT_RATE_BASES) {
    let engagement = 0;
    let denominator = 0;
    for (const metrics of posts) {
      const seen = metrics[basis];
      if (typeof seen !== 'number' || !Number.isFinite(seen) || seen <= 0) continue;
      const done = goalEngagement(metrics);
      if (done === null) continue;
      engagement += done;
      denominator += seen;
    }
    if (denominator > 0) out[basis] = { engagement, denominator };
  }
  return out;
}

/** The sums of several units (channels, periods) added up, basis by basis. */
export function addRateBases(units: readonly (RateBases | null | undefined)[]): RateBases {
  const out: RateBases = {};
  for (const basis of ENGAGEMENT_RATE_BASES) {
    let engagement = 0;
    let denominator = 0;
    for (const unit of units) {
      const sums = unit?.[basis];
      if (!sums || !Number.isFinite(sums.denominator) || sums.denominator <= 0 || !Number.isFinite(sums.engagement)) continue;
      engagement += sums.engagement;
      denominator += sums.denominator;
    }
    if (denominator > 0) out[basis] = { engagement, denominator };
  }
  return out;
}

/** The rate of units' sums (channels' rateBases): reach first, impressions as the fallback; null without either. */
export function engagementRateOfBases(units: readonly (RateBases | null | undefined)[]): EngagementRate | null {
  const sums = addRateBases(units);
  for (const basis of ENGAGEMENT_RATE_BASES) {
    const s = sums[basis];
    if (!s) continue;
    const rate = s.engagement / s.denominator;
    return Number.isFinite(rate) ? { rate, basis, engagement: s.engagement, denominator: s.denominator } : null;
  }
  return null;
}

/** The rate of a set of posts' counts: reach first, impressions as the fallback; null without either. */
export function engagementRateOf(units: readonly Readonly<Record<string, number>>[]): EngagementRate | null {
  return engagementRateOfBases([rateBasesOf(units)]);
}

/** The rate of one post's or one channel's counts. */
export const engagementRate = (metrics: Readonly<Record<string, number>>): EngagementRate | null => engagementRateOf([metrics]);

/** The rate in percent with two decimals at most (3.45 for 0.0345), as the screens and the CSV file write it. */
export function engagementRatePercent(rate: Pick<EngagementRate, 'rate'>): number {
  return Math.round(rate.rate * 10_000) / 100;
}

/**
 * The previous rate to compare a rate with: only one over the same basis, since a rate over impressions against one
 * over reach says nothing about the change; null when either is missing.
 */
export function comparableRate(current: EngagementRate | null, previous: EngagementRate | null | undefined): EngagementRate | null {
  return current && previous && previous.basis === current.basis ? previous : null;
}
