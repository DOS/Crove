// LinkedIn document posts (#1119): a PDF is a document, posted alone on LinkedIn and refused everywhere else before
// anything goes out; its title rule matches the adapter's.
import { describe, expect, it } from 'vitest';
import { LINKEDIN_DOCUMENT_MAX_BYTES, LINKEDIN_DOCUMENT_TITLE_MAX, linkedinDocumentTitleOf } from '@crove/channel';
import { SOCIAL_DOCUMENT_TYPES, SOCIAL_IMAGE_TYPES, SOCIAL_PHOTO_TYPES, zSocialMedia } from '@crove/kernel-contract';
import { CAPABILITIES, DOCUMENT_PROVIDERS, DOCUMENT_TITLE_MAX, PROVIDERS, documentTitleOf, mediaKindOf, validateVariant, type MediaItem, type Provider } from '../src/index.ts';
import { formatOf } from '../src/contract.ts';
import { mediaKind } from '../src/variants.ts';

const pdf = (sizeBytes = 2_000_000): MediaItem => ({ kind: 'document', mime: 'application/pdf', sizeBytes, durationSeconds: null });
const jpeg = (): MediaItem => ({ kind: 'image', mime: 'image/jpeg', sizeBytes: 100_000, durationSeconds: null });
const mp4 = (): MediaItem => ({ kind: 'video', mime: 'video/mp4', sizeBytes: 10_000_000, durationSeconds: 30 });
const codes = (provider: Provider, media: MediaItem[], settings: Record<string, unknown> = {}, title: string | null = null) =>
  validateVariant({ provider, body: 'Báo giá quý 4', title, media, settings }).map((i) => [i.code, i.field]);

describe('LinkedIn documents (#1119)', () => {
  it('reads a PDF as a document, and images and videos as before', () => {
    expect(mediaKindOf('application/pdf')).toBe('document');
    expect(mediaKind('application/pdf')).toBe('document');
    expect(mediaKind('image/webp')).toBe('image');
    expect(mediaKind('video/quicktime')).toBe('video');
    expect(formatOf(null, ['application/pdf'])).toBe('document');
    expect(formatOf(null, ['image/png'])).toBe('image');
    expect(formatOf(null, ['video/mp4'])).toBe('video');
  });

  it('takes one PDF on a LinkedIn member and Company Page, with or without a title', () => {
    for (const provider of ['linkedin', 'linkedin_page'] as const) {
      expect(codes(provider, [pdf()])).toEqual([]);
      expect(codes(provider, [pdf()], { linkedin: { documentTitle: 'Hồ sơ năng lực 2026' } })).toEqual([]);
      expect(codes(provider, [pdf(LINKEDIN_DOCUMENT_MAX_BYTES)])).toEqual([]);
    }
  });

  it('refuses a PDF on every other channel before publishing, with its own code', () => {
    const others = PROVIDERS.filter((p) => !DOCUMENT_PROVIDERS.has(p));
    expect(others.length).toBe(PROVIDERS.length - 2);
    for (const provider of others) {
      const found = validateVariant({ provider, body: 'Báo giá', title: 'Báo giá', media: [pdf()], settings: provider === 'tiktok' ? { privacyLevel: 'PUBLIC_TO_EVERYONE', tiktokMode: 'direct' } : {} });
      expect(found, provider).toContainEqual({ code: 'DOCUMENT_NOT_SUPPORTED', field: 'media.0', limit: null, actual: null });
      expect(found.some((i) => i.code === 'MEDIA_KIND_NOT_ALLOWED')).toBe(false);
    }
  });

  it('keeps a document alone in its post, and within LinkedIn size', () => {
    expect(codes('linkedin', [pdf(), jpeg()])).toEqual([['DOCUMENT_ALONE', 'media']]);
    expect(codes('linkedin', [mp4(), pdf()])).toEqual([['DOCUMENT_ALONE', 'media']]);
    expect(codes('linkedin_page', [pdf(), pdf()])).toEqual([['DOCUMENT_ALONE', 'media']]);
    expect(codes('linkedin', [pdf(LINKEDIN_DOCUMENT_MAX_BYTES + 1)])).toEqual([['DOCUMENT_TOO_LARGE', 'media.0']]);
    expect(CAPABILITIES.linkedin.media.maxDocumentBytes).toBe(LINKEDIN_DOCUMENT_MAX_BYTES);
    // A poll is the post's whole content, so a document beside one is refused as any media is.
    expect(codes('linkedin', [pdf()], { poll: { question: 'Gói nào?', options: ['A', 'B'] } })).toEqual([['POLL_WITH_MEDIA', 'settings.poll']]);
  });

  it('checks the document title like the adapter, and only on LinkedIn with a document', () => {
    expect(DOCUMENT_TITLE_MAX).toBe(LINKEDIN_DOCUMENT_TITLE_MAX);
    for (const value of [undefined, null, {}, { documentTitle: null }, { documentTitle: '' }, { documentTitle: '  ' }, { documentTitle: 'Bảng giá' }, { documentTitle: 'a'.repeat(58) }, { documentTitle: 'a'.repeat(59) }, { documentTitle: 7 }, 'x', ['x']]) {
      expect(documentTitleOf({ linkedin: value }), JSON.stringify(value)).toEqual(linkedinDocumentTitleOf({ linkedin: value }));
    }
    // Counted as LinkedIn counts: a Vietnamese letter typed with combining marks counts once.
    expect(documentTitleOf({ linkedin: { documentTitle: 'ệ'.normalize('NFD').repeat(58) } })).not.toBe('invalid');
    const tooLong = validateVariant({ provider: 'linkedin', body: 'x', title: null, media: [pdf()], settings: { linkedin: { documentTitle: 'a'.repeat(59) } } });
    expect(tooLong).toEqual([{ code: 'DOCUMENT_TITLE_INVALID', field: 'settings.linkedin.documentTitle', limit: 58, actual: 59 }]);
    expect(codes('linkedin', [pdf()], { linkedin: { documentTitle: '   ' } })).toEqual([['DOCUMENT_TITLE_INVALID', 'settings.linkedin.documentTitle']]);
    expect(codes('linkedin', [pdf()], { linkedin: 'Bảng giá' })).toEqual([['DOCUMENT_TITLE_INVALID', 'settings.linkedin.documentTitle']]);
    expect(codes('linkedin', [jpeg()], { linkedin: { documentTitle: 'Bảng giá' } })).toEqual([['DOCUMENT_TITLE_NEEDS_DOCUMENT', 'settings.linkedin.documentTitle']]);
    expect(codes('x', [jpeg()], { linkedin: { documentTitle: 'Bảng giá' } })).toEqual([['LINKEDIN_NOT_SUPPORTED', 'settings.linkedin']]);
  });

  it('takes PDFs in the library for posts, and keeps their names through the post contract', () => {
    expect(SOCIAL_IMAGE_TYPES).toEqual([...SOCIAL_PHOTO_TYPES, 'application/pdf']);
    expect(SOCIAL_DOCUMENT_TYPES).toEqual(['application/pdf']);
    expect(SOCIAL_PHOTO_TYPES.some((t) => t === 'application/pdf')).toBe(false);
    const media = { fileId: '00000000-0000-4000-8000-000000000001', altText: null, mime: 'application/pdf', sizeBytes: 1000, durationMs: null, width: null, height: null };
    expect(zSocialMedia.parse({ ...media, filename: 'bao-gia.pdf' }).filename).toBe('bao-gia.pdf');
    expect(zSocialMedia.parse(media)).toEqual(media);
  });

  it('leaves image and video posts on LinkedIn as they were', () => {
    expect(codes('linkedin', [jpeg(), jpeg()])).toEqual([]);
    expect(codes('linkedin', [mp4()])).toEqual([]);
    expect(codes('linkedin', [jpeg(), mp4()])).toEqual([['MEDIA_MIX_NOT_ALLOWED', 'media']]);
  });
});
