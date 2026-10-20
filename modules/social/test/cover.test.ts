// Video covers (#642): which channels take a frame or an image, the checks on a cover, and the cover in the hash a
// reviewer's approval binds to.
import { describe, expect, it } from 'vitest';
import { COVER_RULES, coverOf, type Provider } from '../src/domain/channels.ts';
import { validateVariant, type MediaItem } from '../src/domain/validate.ts';
import { hashOf } from '../src/variants.ts';

const video = (durationSeconds: number | null = 12.5): MediaItem => ({ kind: 'video', mime: 'video/mp4', sizeBytes: 5_000_000, durationSeconds });
const image: MediaItem = { kind: 'image', mime: 'image/jpeg', sizeBytes: 100_000, durationSeconds: null };
const FILE = '0190a000-0000-7000-8000-0000000000c1';
// Settings each channel needs anyway (TikTok's privacy level), so only the cover's issues show.
const needed = (provider: Provider): Record<string, unknown> => (provider === 'tiktok' ? { privacyLevel: 'SELF_ONLY' } : {});
const coverIssues = (provider: Provider, cover: unknown, media: readonly MediaItem[] = [video()]) =>
  validateVariant({ provider, body: 'Khai trương', title: provider === 'youtube' ? 'Khai trương' : null, media, settings: { ...needed(provider), cover } })
    .filter((i) => i.field === 'settings.cover')
    .map((i) => i.code);

describe('video covers (#642)', () => {
  it('reads a frame or an image, and nothing else', () => {
    expect(coverOf({ cover: { atMs: 0 } })).toEqual({ atMs: 0 });
    expect(coverOf({ cover: { fileId: FILE } })).toEqual({ fileId: FILE });
    expect(coverOf({})).toBeNull();
    for (const bad of [null, 'x', [], { atMs: -1 }, { atMs: 1.5 }, { atMs: '100' }, { fileId: '' }, { atMs: 1, fileId: FILE }, {}]) {
      expect(coverOf({ cover: bad })).toBeNull();
    }
  });

  it('takes a frame on Instagram and TikTok, an image on Instagram and YouTube', () => {
    expect(coverIssues('instagram', { atMs: 2000 })).toEqual([]);
    expect(coverIssues('instagram', { fileId: FILE })).toEqual([]);
    expect(coverIssues('tiktok', { atMs: 2000 })).toEqual([]);
    expect(coverIssues('youtube', { fileId: FILE })).toEqual([]);
  });

  it('says a cover is not supported where the adapter cannot send it', () => {
    // TikTok's direct post takes no uploaded image; YouTube's Data API cannot pick a frame.
    expect(coverIssues('tiktok', { fileId: FILE })).toEqual(['COVER_NOT_SUPPORTED']);
    expect(coverIssues('youtube', { atMs: 2000 })).toEqual(['COVER_NOT_SUPPORTED']);
    for (const provider of ['facebook_page', 'threads', 'x', 'linkedin'] as const) {
      expect(COVER_RULES[provider]).toBeUndefined();
      expect(coverIssues(provider, { atMs: 0 })).toEqual(['COVER_NOT_SUPPORTED']);
      expect(coverIssues(provider, { fileId: FILE })).toEqual(['COVER_NOT_SUPPORTED']);
    }
  });

  it('needs one video alone in the post', () => {
    expect(coverIssues('instagram', { atMs: 0 }, [image])).toEqual(['COVER_NEEDS_VIDEO']);
    expect(coverIssues('instagram', { atMs: 0 }, [video(), image])).toEqual(['COVER_NEEDS_VIDEO']);
    expect(coverIssues('instagram', { atMs: 0 }, [])).toEqual(['COVER_NEEDS_VIDEO']);
  });

  it('keeps a frame within the video when its length is known', () => {
    expect(coverIssues('tiktok', { atMs: 12_500 })).toEqual([]);
    const late = validateVariant({ provider: 'tiktok', body: 'x', title: null, media: [video(12.5)], settings: { privacyLevel: 'SELF_ONLY', cover: { atMs: 12_501 } } });
    expect(late).toContainEqual({ code: 'COVER_OUT_OF_RANGE', field: 'settings.cover', limit: 12_500, actual: 12_501 });
    // A video uploaded before durations were read: the platform decides.
    expect(coverIssues('tiktok', { atMs: 99_000 }, [video(null)])).toEqual([]);
  });

  it('flags a cover that is neither a frame nor an image', () => {
    expect(coverIssues('instagram', { atMs: -5 })).toEqual(['COVER_INVALID']);
    expect(coverIssues('instagram', null)).toEqual(['COVER_INVALID']);
  });

  it('changes the content hash, so an approval never covers another cover', () => {
    const post = { body: 'Khai trương', title: null, linkUrl: null, media: [] };
    const variant = (settings: Record<string, unknown>) => ({ channel_connection_id: '0190a000-0000-7000-8000-000000000001', provider: 'instagram', body: null, title: null, link_url: null, settings });
    const none = hashOf(post, variant({}));
    const frame = hashOf(post, variant({ cover: { atMs: 1000 } }));
    const later = hashOf(post, variant({ cover: { atMs: 2000 } }));
    const picture = hashOf(post, variant({ cover: { fileId: FILE } }));
    expect(new Set([none, frame, later, picture]).size).toBe(4);
    expect(hashOf(post, variant({ cover: { atMs: 1000 } }))).toBe(frame);
  });
});
