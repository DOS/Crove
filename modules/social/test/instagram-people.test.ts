// Instagram collaborators and people tags (#796): what the composer may store, and on which posts.
import { describe, expect, it } from 'vitest';
import { instagramPeopleOf } from '../src/domain/channels.ts';
import { validateVariant, type MediaItem, type VariantDraft } from '../src/domain/validate.ts';

const image: MediaItem = { kind: 'image', mime: 'image/jpeg', sizeBytes: 100_000, durationSeconds: null };
const video: MediaItem = { kind: 'video', mime: 'video/mp4', sizeBytes: 1_000_000, durationSeconds: 20 };
const draft = (settings: Record<string, unknown>, media: MediaItem[] = [image]): VariantDraft => ({ provider: 'instagram', body: 'Bộ sưu tập mới', title: null, media, settings });
const codes = (v: VariantDraft) => validateVariant(v).map((i) => i.code);

describe('Instagram people (#796)', () => {
  it('reads usernames, once each, and tells a bad value apart', () => {
    expect(instagramPeopleOf({ collaborators: ['tiem.banh', 'tiem.banh', 'lan_anh'] }, 'collaborators')).toEqual(['tiem.banh', 'lan_anh']);
    expect(instagramPeopleOf({}, 'userTags')).toBeNull();
    expect(instagramPeopleOf({ userTags: ['Has Space'] }, 'userTags')).toBe('invalid');
    expect(instagramPeopleOf({ userTags: 'lan' }, 'userTags')).toBe('invalid');
  });

  it('takes up to 3 collaborators on feed posts and Reels, up to 20 tags on an image post, and neither on a Story', () => {
    expect(codes(draft({ collaborators: ['a', 'b', 'c'], userTags: ['d'] }))).toEqual([]);
    expect(codes(draft({ collaborators: ['a', 'b', 'c', 'd'] }))).toContain('IG_COLLABORATORS_INVALID');
    expect(codes(draft({ userTags: Array.from({ length: 21 }, (_, i) => `u${i}`) }))).toContain('IG_USER_TAGS_INVALID');
    expect(codes(draft({ collaborators: ['a'] }, [video]))).not.toContain('IG_TAGS_NOT_SUPPORTED');
    expect(codes(draft({ userTags: ['a'] }, [video]))).toContain('IG_TAGS_NOT_SUPPORTED');
    expect(codes(draft({ postType: 'story', collaborators: ['a'] }))).toContain('IG_TAGS_NOT_SUPPORTED');
  });
});
