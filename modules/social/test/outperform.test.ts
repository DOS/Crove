// A post doing much better than usual (#1132): the median and ratio against the channel's earlier posts, and the
// ratio as a notice names it.
import { describe, expect, it } from 'vitest';
import { OUTPERFORM_HISTORY, OUTPERFORM_MIN_HISTORY, RATIO_LABEL, outperformance, ratioLabel } from '../src/index.ts';

// n earlier posts whose engagement (reactions alone here) is `each`, with an optional reach.
const posts = (n: number, each: number, reach?: number) => Array.from({ length: n }, () => ({ reactions: each, ...(reach === undefined ? {} : { reach }) }));

describe('outperformance (#1132)', () => {
  it('finds a post at twice the median engagement or more', () => {
    const found = outperformance({ reactions: 15, comments: 5 }, posts(10, 10));
    expect(found?.engagement).toEqual({ value: 20, median: 10, ratio: 2 });
    expect(outperformance({ reactions: 30 }, posts(10, 10))?.engagement.ratio).toBe(3);
  });

  it('finds nothing below twice the median', () => {
    expect(outperformance({ reactions: 15 }, posts(10, 10))).toBeNull();
    expect(outperformance({ reactions: 19 }, posts(10, 10))).toBeNull();
  });

  it('counts reactions, comments, shares and saves, never reach or views', () => {
    expect(outperformance({ reactions: 5, comments: 5, shares: 5, saves: 5 }, posts(10, 10))?.engagement.value).toBe(20);
    expect(outperformance({ reactions: 5, reach: 10_000, views: 10_000 }, posts(10, 10))).toBeNull();
  });

  it('uses the median, so one viral post before does not raise the bar', () => {
    const earlier = [{ reactions: 5000 }, ...posts(9, 10), { reactions: 10 }];
    expect(outperformance({ reactions: 20 }, earlier)?.engagement.median).toBe(10);
    // An even count: the middle two averaged (10 and 30).
    expect(outperformance({ reactions: 40 }, [...posts(5, 10), ...posts(5, 30)])?.engagement.median).toBe(20);
  });

  it(`needs ${OUTPERFORM_MIN_HISTORY} earlier posts with counts`, () => {
    expect(outperformance({ reactions: 100 }, posts(OUTPERFORM_MIN_HISTORY - 1, 10))).toBeNull();
    // Posts without a capture yet do not count.
    expect(outperformance({ reactions: 100 }, [...posts(OUTPERFORM_MIN_HISTORY - 1, 10), {}, {}])).toBeNull();
    expect(outperformance({ reactions: 100 }, posts(OUTPERFORM_MIN_HISTORY, 10))).not.toBeNull();
  });

  it(`uses the ${OUTPERFORM_HISTORY} newest only`, () => {
    // The 30 newest have a median of 100; the older ones would pull it down to 10.
    const earlier = [...posts(OUTPERFORM_HISTORY, 100), ...posts(50, 10)];
    expect(outperformance({ reactions: 150 }, earlier)).toBeNull();
    expect(outperformance({ reactions: 200 }, earlier)?.engagement.median).toBe(100);
  });

  it('has no usual to beat when the median is 0, or for a post with no counts', () => {
    expect(outperformance({ reactions: 50 }, posts(10, 0))).toBeNull();
    expect(outperformance({}, posts(10, 10))).toBeNull();
  });

  it('compares reach where the post and enough earlier posts report it, without letting it decide', () => {
    expect(outperformance({ reactions: 20, reach: 3000 }, posts(10, 10, 1000))?.reach).toEqual({ value: 3000, median: 1000, ratio: 3 });
    // Reach below the usual still shows, as the engagement decides.
    expect(outperformance({ reactions: 20, reach: 500 }, posts(10, 10, 1000))?.reach?.ratio).toBe(0.5);
    // The post reports none, too few earlier posts report it, or their usual reach is 0.
    expect(outperformance({ reactions: 20 }, posts(10, 10, 1000))?.reach).toBeNull();
    expect(outperformance({ reactions: 20, reach: 3000 }, [...posts(9, 10, 1000), ...posts(1, 10)])?.reach).toBeNull();
    expect(outperformance({ reactions: 20, reach: 3000 }, posts(10, 10, 0))?.reach).toBeNull();
  });
});

describe('ratio label (#1132)', () => {
  it('keeps one decimal, rounded down, and drops a trailing zero', () => {
    expect(ratioLabel(2)).toBe('2');
    expect(ratioLabel(2.46)).toBe('2.4');
    expect(ratioLabel(2.99)).toBe('2.9');
    expect(ratioLabel(20 / 7)).toBe('2.8');
    // Float error never rounds a whole step down.
    expect(ratioLabel(0.7 * 3)).toBe('2.1');
  });

  it('caps the ratio, and every label matches what the dispatch accepts', () => {
    expect(ratioLabel(123_456)).toBe('9999');
    expect(ratioLabel(Number.POSITIVE_INFINITY)).toBe('0');
    for (const r of [2, 2.05, 3.333, 12.5, 999.99, 9999, 1e9]) expect(ratioLabel(r)).toMatch(RATIO_LABEL);
  });
});
