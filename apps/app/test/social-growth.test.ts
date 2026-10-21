import { describe, expect, it } from 'vitest';
import { changeOf, engagementOf, growthOf, sparkline, topPosts } from '../src/lib/social-growth.ts';

describe('account growth (#645)', () => {
  it('gives the latest followers, the change over the window and the latest reach', () => {
    const points = [
      { day: '2026-10-01', followers: 1000, reach: 50 },
      { day: '2026-10-02', followers: null, reach: null },
      { day: '2026-10-03', followers: 1040, reach: null },
      { day: '2026-10-04', followers: 1030, reach: 80 },
    ];
    expect(growthOf(points)).toEqual({ latest: 1030, change: 30, reach: 80, days: 3 });
    expect(growthOf([{ day: '2026-10-04', followers: 5, reach: null }])).toEqual({ latest: 5, change: null, reach: null, days: 1 });
    expect(growthOf([])).toEqual({ latest: null, change: null, reach: null, days: 0 });
  });

  it('draws a line from the lowest to the highest value in the box', () => {
    expect(sparkline([1, 3, 2], 100, 20)).toBe('M0,20 L50,0 L100,10');
    expect(sparkline([5, 5], 10, 10)).toBe('M0,10 L10,10');
    expect(sparkline([7], 10, 10)).toBe('');
  });

  it('ranks posts by engagement, then by how many saw them, and leaves out posts nobody acted on', () => {
    const rows = [
      { id: 'a', metrics: { reactions: 10, views: 100 } },
      { id: 'b', metrics: { reactions: 4, comments: 6, views: 500 } },
      { id: 'c', metrics: { views: 9000 } },
      { id: 'd', metrics: { shares: 2, saves: 1, clicks: 1 } },
    ];
    expect(engagementOf(rows[1]?.metrics ?? {})).toBe(10);
    expect(topPosts(rows, 2).map((r) => r.id)).toEqual(['b', 'a']);
    expect(topPosts(rows, 5).map((r) => r.id)).toEqual(['b', 'a', 'd']);
  });
});

describe('change against the period before (#947)', () => {
  it('gives no change when the period before has no data or is zero', () => {
    expect(changeOf(120, null)).toBeNull();
    expect(changeOf(120, undefined)).toBeNull();
    expect(changeOf(120, 0)).toBeNull();
    expect(changeOf(0, 0)).toBeNull();
    expect(changeOf(null, null)).toBeNull();
    expect(changeOf(5, Number.NaN)).toBeNull();
  });

  it('goes up and down, and counts a missing count now as none', () => {
    expect(changeOf(112, 100)).toEqual({ percent: 12, direction: 'up' });
    expect(changeOf(75, 100)).toEqual({ percent: -25, direction: 'down' });
    expect(changeOf(0, 40)).toEqual({ percent: -100, direction: 'down' });
    expect(changeOf(undefined, 40)).toEqual({ percent: -100, direction: 'down' });
    expect(changeOf(300, 100)).toEqual({ percent: 200, direction: 'up' });
    expect(changeOf(100, 100)).toEqual({ percent: 0, direction: 'same' });
  });

  it('rounds to a whole percent from 10% up and to one decimal below, the same way both ways', () => {
    expect(changeOf(1123, 1000)).toEqual({ percent: 12, direction: 'up' });
    expect(changeOf(1125, 1000)).toEqual({ percent: 13, direction: 'up' });
    expect(changeOf(875, 1000)).toEqual({ percent: -13, direction: 'down' });
    expect(changeOf(1034, 1000)).toEqual({ percent: 3.4, direction: 'up' });
    expect(changeOf(966, 1000)).toEqual({ percent: -3.4, direction: 'down' });
    expect(changeOf(2, 3)).toEqual({ percent: -33, direction: 'down' });
    // Below a twentieth of a percent: no change, and no negative zero.
    const tiny = changeOf(99_999, 100_000);
    expect(tiny).toEqual({ percent: 0, direction: 'same' });
    expect(Object.is(tiny?.percent, -0)).toBe(false);
  });
});
