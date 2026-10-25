// TikTok posts whose public id comes later (#1475): which published variants wait for it, how often they are asked
// about, and when the asking stops.
import { describe, expect, it } from 'vitest';
import { POSTED_IN_APP, SENT_TO_APP, TIKTOK_NO_POST_ID, WORDPRESS_DRAFT, lateIdNextCheck, lateIdOver, lateIdStopped, lateIdWait, publishedNote } from '../src/contract.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = new Date('2026-10-20T08:00:00Z');
const variant = (over: Record<string, unknown> = {}) => ({
  provider: 'tiktok',
  status: 'published',
  settings: { privacyLevel: 'PUBLIC_TO_EVERYONE' } as Record<string, unknown>,
  external_post_id: 'v_pub_file~v2-1.123' as string | null,
  error_code: null as string | null,
  published_at: at as Date | null,
  ...over,
});

describe('lateIdWait', () => {
  it('waits on a public direct post known by its publish_id, and on an inbox draft not posted yet', () => {
    expect(lateIdWait(variant())).toBe('no_id');
    expect(lateIdWait(variant({ settings: { tiktokMode: 'inbox' }, external_post_id: null, error_code: SENT_TO_APP }))).toBe('sent_to_app');
    // An inbox draft the creator posted with no public id yet is known by its publish_id, as a direct post is.
    expect(lateIdWait(variant({ settings: { tiktokMode: 'inbox' } }))).toBe('no_id');
  });

  it('never waits on a private or friends-only post, a post with its id, a stopped one, or another channel', () => {
    expect(lateIdWait(variant({ settings: { privacyLevel: 'SELF_ONLY' } }))).toBeNull();
    expect(lateIdWait(variant({ settings: { privacyLevel: 'MUTUAL_FOLLOW_FRIENDS' } }))).toBeNull();
    expect(lateIdWait(variant({ settings: { privacyLevel: 'FOLLOWER_OF_CREATOR' } }))).toBeNull();
    expect(lateIdWait(variant({ settings: { tiktokMode: 'other', privacyLevel: 'PUBLIC_TO_EVERYONE' } }))).toBeNull();
    expect(lateIdWait(variant({ external_post_id: '7300000000000000001' }))).toBeNull();
    expect(lateIdWait(variant({ error_code: TIKTOK_NO_POST_ID }))).toBeNull();
    expect(lateIdWait(variant({ external_post_id: null }))).toBeNull();
    expect(lateIdWait(variant({ status: 'removed' }))).toBeNull();
    expect(lateIdWait(variant({ provider: 'youtube' }))).toBeNull();
    expect(lateIdWait(variant({ published_at: null }))).toBeNull();
  });
});

describe('the asking schedule', () => {
  it('asks hourly on the first day, every 6 hours after, and never past the 7 days', () => {
    expect(lateIdNextCheck(at, new Date(at.getTime() + 10 * 60_000))).toEqual(new Date(at.getTime() + 10 * 60_000 + HOUR));
    expect(lateIdNextCheck(at, new Date(at.getTime() + DAY + 1))).toEqual(new Date(at.getTime() + DAY + 1 + 6 * HOUR));
    expect(lateIdNextCheck(at, new Date(at.getTime() + 7 * DAY - HOUR))).toEqual(new Date(at.getTime() + 7 * DAY));
    expect(lateIdOver(at, new Date(at.getTime() + 7 * DAY - 1))).toBe(false);
    expect(lateIdOver(at, new Date(at.getTime() + 7 * DAY))).toBe(true);
    expect(lateIdStopped(at).getTime()).toBeGreaterThan(at.getTime() + 8 * DAY);
  });
});

describe('publishedNote', () => {
  it('names a post never given its id and a draft posted in the app, and keeps the notes of posts not public yet', () => {
    expect(publishedNote(variant({ error_code: TIKTOK_NO_POST_ID }))).toBe(TIKTOK_NO_POST_ID);
    expect(publishedNote(variant({ settings: { tiktokMode: 'inbox' } }))).toBe(POSTED_IN_APP);
    expect(publishedNote(variant({ settings: { tiktokMode: 'inbox' }, error_code: SENT_TO_APP }))).toBe(SENT_TO_APP);
    expect(publishedNote(variant({ provider: 'wordpress', error_code: WORDPRESS_DRAFT }))).toBe(WORDPRESS_DRAFT);
    expect(publishedNote(variant())).toBeNull();
    expect(publishedNote(variant({ error_code: 'SOMETHING_ELSE' }))).toBeNull();
  });
});
