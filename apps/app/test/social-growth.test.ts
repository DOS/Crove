import { describe, expect, it } from 'vitest';
import { engagementOf, growthOf, sparkline, topPosts } from '../src/lib/social-growth.ts';

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
