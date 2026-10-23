import { describe, expect, it } from 'vitest';
import { bestTimes, engagementOf, formatOf, hashtagsOf, median, whatWorks, type InsightSample, type PublishedSample } from '../src/domain/insights.ts';

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

  it('falls back to UTC for a zone the runtime does not know', () => {
    const samples = Array.from({ length: 5 }, (_, i) => post('c3', at(13 + 7 * (i % 2), 12), 10));
    expect(bestTimes(samples, 'Not/AZone').get('c3')?.[0]).toMatchObject({ weekday: 2, hour: 12 });
  });

  it('counts reactions, comments, shares and saves, not views', () => {
    expect(engagementOf({ reactions: 3, comments: 2, shares: 1, saves: 4, views: 1000, impressions: 5000 })).toBe(10);
  });
});

describe('what works (#705)', () => {
  const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, 5 + day, hour, 0)).toISOString(); // 2026-10-05 is a Monday
  const post = (variantId: string, engagement: number, over: Partial<InsightSample> = {}): InsightSample => ({
    variantId,
    connectionId: 'c1',
    publishedAt: at(0, 9),
    metrics: { reactions: engagement },
    text: '',
    labelIds: [],
    format: 'text',
    ...over,
  });

  it('reads hashtags the Vietnamese way, each once', () => {
    expect(hashtagsOf('Khai trương #ĂnUống #ănuống, #cafe_sang và email a#b #2026 #')).toEqual(['ănuống', 'cafe_sang']);
    expect(hashtagsOf('Ne\u0301t #Đà_Lạt')).toEqual(['đà_lạt']);
  });

  it('tells a format from the post type and the media', () => {
    expect(formatOf(null, [])).toBe('text');
    expect(formatOf(undefined, ['image/jpeg'])).toBe('image');
    expect(formatOf(null, ['video/mp4'])).toBe('video');
    expect(formatOf(null, ['image/jpeg', 'video/mp4'])).toBe('carousel');
    expect(formatOf('story', ['image/jpeg'])).toBe('story');
    expect(formatOf('reel', ['video/mp4'])).toBe('reel');
  });

  it('compares groups with the channel median, best and worst first', () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const samples = [
      post('v1', 10, { labelIds: ['sale'], format: 'image', text: '#giamgia', publishedAt: at(0, 9) }),
      post('v2', 30, { labelIds: ['sale'], format: 'image', text: '#giamgia #moi', publishedAt: at(0, 9) }),
      post('v3', 20, { format: 'video', text: '#giamgia', publishedAt: at(2, 20) }),
      post('v4', 2, { format: 'text', publishedAt: at(2, 20) }),
      post('v5', 4, { format: 'text', publishedAt: at(5, 12) }),
      post('v6', 6, { format: 'text', publishedAt: at(5, 12) }),
      // Not captured yet: left out.
      post('v7', 0, { metrics: {} }),
      post('w1', 50, { connectionId: 'c2' }),
    ];
    const [c1, c2] = whatWorks(samples, 'UTC', { top: 2 });
    expect(c1).toMatchObject({ connectionId: 'c1', posts: 6, median: 8 });
    expect(c1?.best).toEqual([
      { variantId: 'v2', engagement: 30 },
      { variantId: 'v3', engagement: 20 },
    ]);
    expect(c1?.worst).toEqual([
      { variantId: 'v4', engagement: 2 },
      { variantId: 'v5', engagement: 4 },
    ]);
    expect(c1?.byLabel).toEqual([{ key: 'sale', posts: 2, median: 20, ratio: 2.5 }]);
    expect(c1?.byFormat.map((g) => [g.key, g.posts, g.median])).toEqual([
      // A tie goes to the group with more posts.
      ['image', 2, 20],
      ['video', 1, 20],
      ['text', 3, 4],
    ]);
    // Monday 9:00, Wednesday 20:00, Saturday 12:00 in UTC.
    expect(c1?.byWeekday.map((g) => g.key)).toEqual(['1', '3', '6']);
    expect(c1?.byHour.map((g) => g.key)).toEqual(['9', '20', '12']);
    expect(c1?.byHashtag).toEqual([{ key: 'giamgia', posts: 3, median: 20, ratio: 2.5 }]);
    // Too few posts for a worst list; a channel median of 0 has no ratios.
    expect(c2).toMatchObject({ connectionId: 'c2', posts: 1, best: [{ variantId: 'w1', engagement: 50 }], worst: [] });
    expect(whatWorks([post('z', 0)], 'UTC')[0]?.byFormat).toEqual([{ key: 'text', posts: 1, median: 0, ratio: null }]);
  });

  it('gives a channel and each group its engagement rate, a sum over the posts that report reach (#1157)', () => {
    const samples = [
      post('a', 10, { format: 'image', metrics: { reach: 100, reactions: 10 } }),
      post('b', 20, { format: 'image', metrics: { reach: 1900, reactions: 20, clicks: 10 } }),
      // No reach: left out of a rate over reach.
      post('c', 30, { format: 'image', metrics: { impressions: 30, reactions: 30 } }),
      post('d', 5, { format: 'text', metrics: { impressions: 500, reactions: 5 } }),
      post('e', 5, { format: 'video', metrics: { views: 50, reactions: 5 } }),
    ];
    const [c] = whatWorks(samples, 'UTC');
    // 40 / 2000 for the channel and its images, not the mean of 10% and 1.6%.
    expect(c?.rate).toEqual({ rate: 0.02, basis: 'reach', engagement: 40, denominator: 2000 });
    const byFormat = new Map(c?.byFormat.map((g) => [g.key, g.rate]));
    expect(byFormat.get('image')).toEqual({ rate: 0.02, basis: 'reach', engagement: 40, denominator: 2000 });
    expect(byFormat.get('text')).toEqual({ rate: 0.01, basis: 'impressions', engagement: 5, denominator: 500 });
    // Neither reach nor impressions: no rate at all.
    expect(c?.byFormat.find((g) => g.key === 'video')).not.toHaveProperty('rate');
  });

  it("gives the Reels the median of their average watch time, from the Reels that report one (#1147)", () => {
    const reel = (id: string, avgWatchTimeMs?: number) => post(id, 10, { format: 'reel', metrics: { reactions: 10, ...(avgWatchTimeMs === undefined ? {} : { avgWatchTimeMs }) } });
    const [c] = whatWorks([reel('r1', 12300), reel('r2', 8000), reel('r3', 15000), reel('r4'), post('i1', 10, { format: 'image' })], 'UTC');
    expect(c?.byFormat).toEqual([
      { key: 'reel', posts: 4, median: 10, ratio: 1, avgWatchTimeMs: 12300 },
      { key: 'image', posts: 1, median: 10, ratio: 1 },
    ]);
  });
});
