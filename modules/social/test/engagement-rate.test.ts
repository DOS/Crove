import { describe, expect, it } from 'vitest';
import { comparableRate, engagementRate, engagementRateOf, engagementRatePercent, GOAL_ENGAGEMENT_COUNTS } from '../src/contract.ts';

describe('engagement rate (#1157)', () => {
  it('counts engagement as the client report and the goals do, over reach', () => {
    expect(GOAL_ENGAGEMENT_COUNTS).toEqual(['reactions', 'comments', 'shares', 'saves', 'clicks']);
    const rate = engagementRate({ reach: 2000, impressions: 5000, views: 9000, reactions: 40, comments: 10, shares: 5, saves: 4, clicks: 10, linkClicks: 99 });
    // 69 of 2000 people reached; impressions, views and Crove's link clicks take no part.
    expect(rate).toEqual({ rate: 69 / 2000, basis: 'reach', engagement: 69, denominator: 2000 });
    expect(rate && engagementRatePercent(rate)).toBe(3.45);
  });

  it('falls back to impressions where nothing reports reach', () => {
    expect(engagementRate({ impressions: 800, reactions: 6, comments: 2 })).toEqual({ rate: 0.01, basis: 'impressions', engagement: 8, denominator: 800 });
  });

  it('has no rate without reach or impressions, or without any engagement count', () => {
    expect(engagementRate({})).toBeNull();
    expect(engagementRate({ views: 500, reactions: 5 })).toBeNull();
    expect(engagementRate({ reach: 500 })).toBeNull();
  });

  it('never divides by zero: zero reach is no rate, never Infinity or NaN', () => {
    expect(engagementRate({ reach: 0, reactions: 5 })).toBeNull();
    expect(engagementRate({ reach: 0, reactions: 0 })).toBeNull();
    expect(engagementRate({ reach: 0, impressions: 0, comments: 1 })).toBeNull();
    expect(engagementRate({ reach: Number.NaN, reactions: 1 })).toBeNull();
    expect(engagementRate({ reach: Number.POSITIVE_INFINITY, reactions: 1 })).toBeNull();
    expect(engagementRate({ reach: 100, reactions: Number.POSITIVE_INFINITY })).toBeNull();
    expect(engagementRate({ reach: 100, reactions: 0 })).toEqual({ rate: 0, basis: 'reach', engagement: 0, denominator: 100 });
  });

  it('adds up several channels as a sum over a sum, from the ones that report the denominator', () => {
    const channels = [
      { reach: 100, reactions: 50 },
      { reach: 10_000, reactions: 100 },
      // Reports impressions only: left out of a rate over reach.
      { impressions: 50, reactions: 25 },
      // Nothing went out this period.
      {},
    ];
    // 150 / 10 100, not the mean of 50% and 1%.
    expect(engagementRateOf(channels)).toEqual({ rate: 150 / 10_100, basis: 'reach', engagement: 150, denominator: 10_100 });
    expect(engagementRatePercent(engagementRateOf(channels) as NonNullable<ReturnType<typeof engagementRateOf>>)).toBe(1.49);
    // Only channels without reach: over impressions, from the ones that report them.
    expect(engagementRateOf([{ impressions: 400, comments: 4 }, { impressions: 600, shares: 6 }, { views: 10, reactions: 9 }])).toMatchObject({ rate: 0.01, basis: 'impressions' });
    // A channel with zero reach adds nothing, and the others still make the rate.
    expect(engagementRateOf([{ reach: 0, reactions: 3 }, { reach: 300, reactions: 3 }])).toMatchObject({ rate: 0.01, basis: 'reach' });
    expect(engagementRateOf([])).toBeNull();
  });

  it('writes a percentage with two decimals at most', () => {
    expect(engagementRatePercent({ rate: 0.0345 })).toBe(3.45);
    expect(engagementRatePercent({ rate: 1 / 3 })).toBe(33.33);
    expect(engagementRatePercent({ rate: 0.1 })).toBe(10);
    expect(engagementRatePercent({ rate: 1.5 })).toBe(150);
  });

  it('compares a rate with the period before only over the same basis', () => {
    const reach = engagementRate({ reach: 100, reactions: 5 });
    const before = engagementRate({ reach: 200, reactions: 5 });
    const shown = engagementRate({ impressions: 100, reactions: 5 });
    expect(comparableRate(reach, before)).toBe(before);
    expect(comparableRate(reach, shown)).toBeNull();
    expect(comparableRate(null, before)).toBeNull();
    expect(comparableRate(reach, undefined)).toBeNull();
  });
});
