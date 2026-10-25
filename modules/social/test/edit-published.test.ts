// Correcting a published post's text (#1223): which channels and posts take an edit, where an edit stands, and the
// revision its call keys stay named by.
import { describe, expect, it } from 'vitest';
import { EDIT_READY, PROVIDERS, editRefusal } from '../src/domain/channels.ts';
import { callRevision, publishCallKey } from '../src/domain/publish.ts';
import { EDIT_STALE_MS, editState } from '../src/edit-published.ts';

describe('EDIT_READY and editRefusal (#1223)', () => {
  it('names the channels whose adapter edits, and refuses the rest as the issue lists them', () => {
    expect([...EDIT_READY].sort()).toEqual(['discord', 'facebook_page', 'linkedin', 'linkedin_page', 'mastodon', 'sandbox', 'telegram', 'zalo_oa']);
    for (const provider of ['instagram', 'threads', 'bluesky', 'x', 'tiktok', 'wordpress', 'youtube', 'pinterest', 'google_business']) {
      expect(editRefusal(provider, {}, [])).toBe('provider');
    }
    expect(editRefusal('myspace', {}, [])).toBe('provider');
    // Every provider is either ready or refused, none forgotten.
    for (const provider of PROVIDERS) expect(editRefusal(provider, {}, []) === null).toBe(EDIT_READY.has(provider));
  });

  it('refuses a poll, a Story or a Reel, a Facebook video and a Zalo video article, on a channel that edits', () => {
    expect(editRefusal('telegram', { poll: { options: ['Có', 'Không'] } }, [])).toBe('poll');
    expect(editRefusal('linkedin', { poll: { question: 'Bạn chọn?', options: ['A', 'B'] } }, [])).toBe('poll');
    expect(editRefusal('facebook_page', { postType: 'story' }, ['image'])).toBe('post_type');
    expect(editRefusal('facebook_page', { postType: 'reel' }, ['video'])).toBe('post_type');
    expect(editRefusal('facebook_page', {}, ['video'])).toBe('video');
    // A Zalo video article (#1429, #1430): its update needs the video_id, which Crove does not keep. An article of
    // images is corrected.
    expect(editRefusal('zalo_oa', {}, ['video'])).toBe('video');
    expect(editRefusal('zalo_oa', {}, ['image', 'image'])).toBeNull();
    // A video elsewhere keeps its text as a caption the edit reaches.
    expect(editRefusal('telegram', {}, ['video'])).toBeNull();
    expect(editRefusal('facebook_page', {}, ['image', 'image'])).toBeNull();
    expect(editRefusal('discord', { discord: { forum: true } }, [])).toBeNull();
  });
});

describe('editState (#1223)', () => {
  const asked = new Date('2026-10-23T10:00:00Z');
  const at = (ms: number) => new Date(asked.getTime() + ms);
  const call = (state: 'started' | 'succeeded' | 'failed' | 'ambiguous', startedAt: Date, error: string | null = null) => ({ key: 'k', state, external_ref: null, error_code: error, started_at: startedAt });

  it('is null without an edit, pending until its job calls, and failed when the job never ran', () => {
    expect(editState([], { edit_state: null, edit_requested_at: null }, asked)).toBeNull();
    expect(editState([], { edit_state: 'pending', edit_requested_at: asked }, at(1000))).toEqual({ state: 'pending', code: null });
    expect(editState([], { edit_state: 'pending', edit_requested_at: asked }, at(EDIT_STALE_MS + 1))).toEqual({ state: 'failed', code: 'EDIT_NOT_RUN' });
    // A call of an earlier ask is not this ask's.
    expect(editState([call('failed', at(-60_000), 'OLD')], { edit_state: 'pending', edit_requested_at: asked }, at(1000))).toEqual({ state: 'pending', code: null });
  });

  it('is pending while the call is on its way, unclear once it went quiet, and says why it failed', () => {
    expect(editState([call('started', at(10))], { edit_state: 'pending', edit_requested_at: asked }, at(1000))).toEqual({ state: 'pending', code: null });
    expect(editState([call('started', at(10))], { edit_state: 'pending', edit_requested_at: asked }, at(EDIT_STALE_MS + 100))).toEqual({ state: 'unknown', code: 'OUTCOME_UNKNOWN' });
    expect(editState([call('failed', at(10), 'TELEGRAM_CANNOT_EDIT')], { edit_state: 'failed', edit_requested_at: asked }, at(1000))).toEqual({ state: 'failed', code: 'TELEGRAM_CANNOT_EDIT' });
    expect(editState([call('ambiguous', at(10), 'TIMEOUT')], { edit_state: 'unknown', edit_requested_at: asked }, at(1000))).toEqual({ state: 'unknown', code: 'TIMEOUT' });
  });
});

describe('callRevision (#1223)', () => {
  it('names the calls of a published variant by the revision it went out under, whatever its revision became', () => {
    expect(callRevision({ revision: 1, published_revision: null })).toBe(1);
    expect(callRevision({ revision: 3, published_revision: 1 })).toBe(1);
    expect(publishCallKey('v1', callRevision({ revision: 3, published_revision: 1 }), 1, 'comment')).toBe('social.publish:v1:1:1:comment');
  });
});
