import { describe, expect, it } from 'vitest';
import type { PublishedSample } from '@crove/mod-social/contract';
import { BEST_TIME_MIN_POSTS, channelBestTimes, knownZone, listedPosts, nextOccurrence, suggestBestTimes, takenTimes } from '../src/lib/social-best-time.ts';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';
const ms = (iso: string) => Date.parse(iso);
const iso = (n: number) => new Date(n).toISOString();
const slot = (weekday: number, hour: number, engagement = 10) => ({ weekday, hour, posts: 2, engagement });

describe('the next occurrence of a weekday and hour in a zone', () => {
  it('finds the slot later this week, today, or a week on in Asia/Ho_Chi_Minh', () => {
    // Wednesday 2026-10-21 10:00 in Ho Chi Minh City (UTC+7).
    const now = ms('2026-10-21T03:00:00Z');
    expect(iso(nextOccurrence(2, 20, HCM, now))).toBe('2026-10-27T13:00:00.000Z');
    expect(iso(nextOccurrence(3, 20, HCM, now))).toBe('2026-10-21T13:00:00.000Z');
    // The hour that is now counts from now on; an hour already gone this morning waits a week.
    expect(iso(nextOccurrence(3, 10, HCM, now))).toBe('2026-10-21T03:00:00.000Z');
    expect(iso(nextOccurrence(3, 9, HCM, now))).toBe('2026-10-28T02:00:00.000Z');
  });

  it('wraps from the end of the week to Monday', () => {
    // Sunday 2026-10-25 22:00 local.
    const now = ms('2026-10-25T15:00:00Z');
    expect(iso(nextOccurrence(1, 8, HCM, now))).toBe('2026-10-26T01:00:00.000Z');
    expect(iso(nextOccurrence(7, 21, HCM, now))).toBe('2026-11-01T14:00:00.000Z');
    // Local Sunday is still Saturday in UTC: the weekday is the zone's, not UTC's.
    expect(iso(nextOccurrence(7, 6, HCM, ms('2026-10-24T22:00:00Z')))).toBe('2026-10-24T23:00:00.000Z');
  });

  it('keeps the clock time across a DST change', () => {
    // Friday 2026-10-30 12:00 EDT; clocks go back on Sunday 2026-11-01.
    const now = ms('2026-10-30T16:00:00Z');
    expect(iso(nextOccurrence(5, 9, NY, now))).toBe('2026-11-06T14:00:00.000Z');
    expect(iso(nextOccurrence(1, 9, NY, now))).toBe('2026-11-02T14:00:00.000Z');
    // The repeated 01:00 is its first occurrence (still EDT).
    expect(iso(nextOccurrence(7, 1, NY, now))).toBe('2026-11-01T05:00:00.000Z');
    // 02:00 on 2027-03-14 does not exist: it lands just after the change, at 03:00 EDT.
    expect(iso(nextOccurrence(7, 2, NY, ms('2027-03-13T17:00:00Z')))).toBe('2027-03-14T07:00:00.000Z');
    expect(iso(nextOccurrence(1, 9, NY, ms('2027-03-13T17:00:00Z')))).toBe('2027-03-15T13:00:00.000Z');
  });
});

describe('best-time suggestions (#980)', () => {
  const now = ms('2026-10-21T03:00:00Z'); // Wednesday 10:00 local

  it('turns the ranked slots into upcoming times, best first, at most three', () => {
    const got = suggestBestTimes([slot(2, 20, 30), slot(3, 20, 20), slot(5, 8, 15), slot(6, 9, 5)], { timeZone: HCM, nowMs: now });
    expect(got.map((s) => iso(s.at))).toEqual(['2026-10-27T13:00:00.000Z', '2026-10-21T13:00:00.000Z', '2026-10-23T01:00:00.000Z']);
    expect(got[0]).toMatchObject({ weekday: 2, hour: 20, engagement: 30 });
  });

  it('skips a slot less than 15 minutes from now to the week after', () => {
    // The slot is right now: next week.
    expect(suggestBestTimes([slot(3, 10)], { timeZone: HCM, nowMs: now }).map((s) => iso(s.at))).toEqual(['2026-10-28T03:00:00.000Z']);
    // 10 minutes ahead is too close; exactly 15 is kept.
    expect(suggestBestTimes([slot(3, 10)], { timeZone: HCM, nowMs: now - 10 * 60_000 }).map((s) => iso(s.at))).toEqual(['2026-10-28T03:00:00.000Z']);
    expect(suggestBestTimes([slot(3, 10)], { timeZone: HCM, nowMs: now - 15 * 60_000 }).map((s) => iso(s.at))).toEqual(['2026-10-21T03:00:00.000Z']);
  });

  it('skips an hour another post of the channel takes', () => {
    const taken = [ms('2026-10-27T13:30:00Z'), ms('2026-11-03T13:00:00Z')];
    expect(suggestBestTimes([slot(2, 20)], { timeZone: HCM, nowMs: now, taken }).map((s) => iso(s.at))).toEqual(['2026-11-10T13:00:00.000Z']);
    // A post just before the hour does not take it.
    expect(suggestBestTimes([slot(2, 20)], { timeZone: HCM, nowMs: now, taken: [ms('2026-10-27T12:59:00Z')] }).map((s) => iso(s.at))).toEqual(['2026-10-27T13:00:00.000Z']);
  });

  it('gives a slot up when every week ahead is taken', () => {
    const taken = Array.from({ length: 8 }, (_, i) => ms('2026-10-27T13:00:00Z') + i * 7 * 86_400_000);
    expect(suggestBestTimes([slot(2, 20), slot(4, 9)], { timeZone: HCM, nowMs: now, taken }).map((s) => iso(s.at))).toEqual(['2026-10-22T02:00:00.000Z']);
  });

  it('never suggests the same instant twice', () => {
    // 02:00 and 03:00 on the spring-forward Sunday are the same instant.
    const got = suggestBestTimes([slot(7, 2), slot(7, 3)], { timeZone: NY, nowMs: ms('2027-03-13T17:00:00Z') });
    expect(got.map((s) => iso(s.at))).toEqual(['2027-03-14T07:00:00.000Z', '2027-03-21T07:00:00.000Z']);
  });
});

describe('a channel\'s history for the button', () => {
  // Posts at Tuesday 20:00 and Friday 08:00 local (UTC+7), in October 2026.
  const tue = (day: number) => `2026-10-${String(day).padStart(2, '0')}T13:00:00Z`;
  const fri = (day: number) => `2026-10-${String(day).padStart(2, '0')}T01:00:00Z`;
  const sample = (connectionId: string, publishedAt: string | null, reactions: number): PublishedSample => ({ connectionId, publishedAt, metrics: reactions >= 0 ? { reactions } : {} });

  it('needs five posts with metrics on the channel', () => {
    const four = [sample('a', tue(6), 10), sample('a', tue(13), 10), sample('a', fri(9), 1), sample('a', fri(16), 1), sample('a', tue(20), -1), sample('a', null, 5), sample('b', tue(6), 50)];
    expect(BEST_TIME_MIN_POSTS).toBe(5);
    expect(channelBestTimes(four, 'a', HCM)).toEqual({ state: 'few', posts: 4 });
    expect(channelBestTimes(four, 'z', HCM)).toEqual({ state: 'few', posts: 0 });
  });

  it('ranks the channel\'s own slots, in the zone given', () => {
    const rows = [sample('a', tue(6), 10), sample('a', tue(13), 20), sample('a', fri(9), 1), sample('a', fri(16), 3), sample('a', fri(23), 2), sample('b', fri(2), 500)];
    expect(channelBestTimes(rows, 'a', HCM)).toEqual({ state: 'ready', slots: [{ weekday: 2, hour: 20, posts: 2, engagement: 15 }, { weekday: 5, hour: 8, posts: 3, engagement: 2 }] });
    // The same posts read in UTC fall on other hours.
    expect(channelBestTimes(rows, 'a', 'UTC')).toMatchObject({ state: 'ready', slots: [{ weekday: 2, hour: 13 }, { weekday: 5, hour: 1 }] });
  });

  it('says when enough posts show no slot that stands out', () => {
    const scattered = [6, 7, 8, 9, 10].map((d) => sample('a', `2026-10-${String(d).padStart(2, '0')}T0${d - 5}:00:00Z`, 4));
    expect(channelBestTimes(scattered, 'a', HCM)).toEqual({ state: 'none' });
  });
});

describe('times other posts of the channel take', () => {
  const variant = (id: string, connectionId: string, status: string, effectiveAt: string | null) => ({ id, connectionId, status, effectiveAt });

  it('reads plain and paged list answers from the cache', () => {
    const a = { variants: [variant('v1', 'c1', 'scheduled', '2026-10-27T13:00:00Z')] };
    const b = { variants: [variant('v2', 'c1', 'publishing', '2026-10-28T13:00:00Z')] };
    expect(listedPosts([[a], { pages: [[b], 'junk'], pageParams: [] }, undefined, { nope: true }, [null, 3]])).toEqual([a, b]);
  });

  it('keeps the channel\'s posts that go out at a time, once each, without the one being scheduled', () => {
    const posts = [
      { variants: [variant('v1', 'c1', 'scheduled', '2026-10-27T13:00:00Z'), variant('v2', 'c2', 'scheduled', '2026-10-27T14:00:00Z')] },
      { variants: [variant('v3', 'c1', 'approved', '2026-10-28T13:00:00Z'), variant('v4', 'c1', 'published', '2026-10-01T13:00:00Z'), variant('v5', 'c1', 'processing', null)] },
      { variants: [variant('v1', 'c1', 'scheduled', '2026-10-27T13:00:00Z'), variant('v6', 'c1', 'scheduled', '2026-10-29T13:00:00Z')] },
    ];
    expect(takenTimes(posts, 'c1').map(iso)).toEqual(['2026-10-27T13:00:00.000Z', '2026-10-29T13:00:00.000Z']);
    expect(takenTimes(posts, 'c1', 'v6').map(iso)).toEqual(['2026-10-27T13:00:00.000Z']);
  });
});

describe('the zone the suggestions use', () => {
  it('falls back when the runtime does not know the zone', () => {
    expect(knownZone(HCM)).toBe(HCM);
    expect(knownZone('Mars/Olympus', HCM)).toBe(HCM);
    expect(knownZone(null)).toBe('UTC');
  });
});
