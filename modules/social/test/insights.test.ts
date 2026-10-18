import { describe, expect, it } from 'vitest';
import { bestTimes, engagementOf, type PublishedSample } from '../src/domain/insights.ts';

// 2026-10-13 is a Tuesday; 12:00 UTC is 19:00 in Ho Chi Minh City.
const at = (day: number, hourUtc: number) => new Date(Date.UTC(2026, 9, day, hourUtc, 15)).toISOString();
const post = (connectionId: string, publishedAt: string, reactions: number, extra: Record<string, number> = {}): PublishedSample => ({ connectionId, publishedAt, metrics: { reactions, ...extra } });

describe('bestTimes', () => {
  it('ranks a channel’s weekday and hour slots by average engagement, in the viewer’s time zone', () => {
    const samples = [
      // Tuesdays at 19:00 local: strong.
      post('c1', at(13, 12), 40, { comments: 10 }),
      post('c1', at(20, 12), 60),
      // Mondays at 08:00 local (01:00 UTC): weaker.
      post('c1', at(12, 1), 10),
      post('c1', at(19, 1), 20),
      // A slot with one post is not ranked.
      post('c1', at(14, 5), 500),
    ];
    expect(bestTimes(samples, 'Asia/Ho_Chi_Minh').get('c1')).toEqual([
      { weekday: 2, hour: 19, posts: 2, engagement: 55 },
      { weekday: 1, hour: 8, posts: 2, engagement: 15 },
    ]);
    // In UTC the same posts fall on other hours.
    expect(bestTimes(samples, 'UTC').get('c1')?.[0]).toMatchObject({ weekday: 2, hour: 12 });
  });

  it('suggests nothing for a channel with too few captured posts, and ignores posts without metrics', () => {
    const few = [post('c2', at(13, 12), 40), post('c2', at(20, 12), 60), { connectionId: 'c2', publishedAt: at(27, 12), metrics: {} }];
    expect(bestTimes(few, 'UTC').has('c2')).toBe(false);
    expect(bestTimes(few, 'UTC', { minPostsPerChannel: 2 }).get('c2')).toEqual([{ weekday: 2, hour: 12, posts: 2, engagement: 50 }]);
  });

  it('counts reactions, comments, shares and saves, not views', () => {
    expect(engagementOf({ reactions: 3, comments: 2, shares: 1, saves: 4, views: 1000, impressions: 5000 })).toBe(10);
  });
});
