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

/** The rate of a set of counts sets (posts, channels): reach first, impressions as the fallback; null without either. */
export function engagementRateOf(units: readonly Readonly<Record<string, number>>[]): EngagementRate | null {
  for (const basis of ENGAGEMENT_RATE_BASES) {
    let engagement = 0;
    let denominator = 0;
    for (const metrics of units) {
      const seen = metrics[basis];
      if (typeof seen !== 'number' || !Number.isFinite(seen) || seen <= 0) continue;
      const done = goalEngagement(metrics);
      if (done === null) continue;
      engagement += done;
      denominator += seen;
    }
    if (denominator > 0) {
      const rate = engagement / denominator;
      return Number.isFinite(rate) ? { rate, basis, engagement, denominator } : null;
    }
  }
  return null;
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
