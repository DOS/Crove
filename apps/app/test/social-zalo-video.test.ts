// Zalo OA video articles in the composer (#1429): the checks the composer runs as a video is added to a Zalo OA
// channel (one MP4 of up to 50 MB, a cover image, public storage for it), and the words it shows for them, in natural
// Vietnamese and in English.
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const config = vi.hoisted(() => ({ uploads: 'presigned' as 'presigned' | 'direct' }));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => config }));

const { draftIssues } = await import('../src/lib/social.ts');

const MB = 1024 * 1024;
const clip = (over: Partial<{ mime: string; sizeBytes: number }> = {}) => ({ mime: 'video/mp4', sizeBytes: 20 * MB, durationMs: 45_000, ...over });
const draft = (media: ReturnType<typeof clip>[], settings: Record<string, unknown> = { cover: { fileId: '00000000-0000-4000-8000-0000000000c1' } }) =>
  draftIssues('zalo_oa', { body: 'Mở bán bánh trung thu', title: 'Bánh trung thu 2026', media, settings }).map((i) => i.code);

describe('a video on a Zalo OA channel', () => {
  it('goes with a cover image on storage that hands out public links', () => {
    config.uploads = 'presigned';
    expect(draft([clip()])).toEqual([]);
  });

  it('is held back without a cover, as QuickTime, over 50 MB, or on local disk', () => {
    config.uploads = 'presigned';
    expect(draft([clip()], {})).toEqual(['COVER_REQUIRED']);
    expect(draft([clip({ mime: 'video/quicktime' })])).toEqual(['VIDEO_TYPE_NOT_ALLOWED']);
    expect(draft([clip({ sizeBytes: 50 * MB + 1 })])).toEqual(['VIDEO_TOO_LARGE']);
    config.uploads = 'direct';
    expect(draft([clip()])).toEqual(['MEDIA_NEEDS_PUBLIC_STORAGE']);
  });

  it('says the cover and size rules in Vietnamese and in English', () => {
    expect(viMessages.social.coverHint.zalo_oa).toBe(
      'Bài viết video trên Zalo OA bắt buộc có ảnh bìa tải lên (JPG hoặc PNG, tối đa 1 MB). Video phải là MP4, tối đa 50 MB, và máy chủ cần lưu tệp trên S3 để Zalo lấy được ảnh bìa.',
    );
    expect(en.social.coverHint.zalo_oa).toContain('MP4 of up to 50 MB');
    expect(viMessages.social.issues.COVER_REQUIRED).toContain('cần một ảnh bìa');
    expect(viMessages.social.issues.VIDEO_TYPE_NOT_ALLOWED).toContain('chỉ nhận video MP4');
    expect(en.social.issues.COVER_REQUIRED).toContain('needs a cover');
  });
});
