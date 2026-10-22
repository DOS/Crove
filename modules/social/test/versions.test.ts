// The version history of a post (#1021): the numbers a save writes and prunes, when two snapshots are the same, how a
// stored version is read back, and what a channel showed in it.
import { describe, expect, it } from 'vitest';
import { MAX_VERSIONS_PER_POST, sameSnapshot, variantContent, versionMedia, versionNumbers, versionVariants, type VersionSnapshot, type VersionVariant } from '../src/domain/versions.ts';

const variant = (over: Partial<VersionVariant> = {}): VersionVariant => ({
  variantId: 'v1',
  connectionId: 'c1',
  provider: 'facebook',
  body: null,
  title: null,
  linkUrl: null,
  settings: {},
  media: null,
  contentFrozen: false,
  ...over,
});
const snapshot = (over: Partial<VersionSnapshot> = {}): VersionSnapshot => ({ body: 'Xin chào', title: null, linkUrl: null, media: [], variants: [variant()], ...over });

describe('version numbers', () => {
  it('keeps the content before the first save as number 1, then counts on', () => {
    expect(versionNumbers(null)).toEqual({ baseline: 1, next: 2, pruneUpTo: 0 });
    expect(versionNumbers(2)).toEqual({ baseline: null, next: 3, pruneUpTo: 0 });
  });

  it(`prunes so the newest ${MAX_VERSIONS_PER_POST} stay`, () => {
    expect(versionNumbers(MAX_VERSIONS_PER_POST - 1)).toEqual({ baseline: null, next: MAX_VERSIONS_PER_POST, pruneUpTo: 0 });
    expect(versionNumbers(MAX_VERSIONS_PER_POST)).toEqual({ baseline: null, next: MAX_VERSIONS_PER_POST + 1, pruneUpTo: 1 });
    const { next, pruneUpTo } = versionNumbers(120);
    expect(next - pruneUpTo).toBe(MAX_VERSIONS_PER_POST);
  });
});

describe('same snapshot', () => {
  it('ignores the order jsonb returns keys in', () => {
    expect(sameSnapshot(snapshot({ variants: [variant({ settings: { a: 1, b: { x: 1, y: 2 } } })] }), snapshot({ variants: [variant({ settings: { b: { y: 2, x: 1 }, a: 1 } })] }))).toBe(true);
  });

  it('sees a change of text, images, a channel override or inheriting again', () => {
    expect(sameSnapshot(snapshot(), snapshot({ body: 'Xin chào bạn' }))).toBe(false);
    expect(sameSnapshot(snapshot(), snapshot({ media: [{ fileId: 'f1', altText: null }] }))).toBe(false);
    expect(sameSnapshot(snapshot(), snapshot({ variants: [variant({ body: 'Xin chào' })] }))).toBe(false);
    expect(sameSnapshot(snapshot({ variants: [variant({ media: [] })] }), snapshot())).toBe(false);
  });
});

describe('reading a stored version', () => {
  it('drops entries without their ids and reads missing fields as empty', () => {
    expect(versionMedia([{ fileId: 'f1', altText: 'Ảnh' }, { fileId: 'f2' }, { altText: 'không có tệp' }, 'x'])).toEqual([
      { fileId: 'f1', altText: 'Ảnh' },
      { fileId: 'f2', altText: null },
    ]);
    expect(versionMedia(null)).toEqual([]);
    expect(versionVariants([{ variantId: 'v1', connectionId: 'c1', provider: 'zalo', body: 'Riêng', settings: [], media: [{ fileId: 'f1' }] }, { variantId: 'v2' }])).toEqual([
      variant({ provider: 'zalo', body: 'Riêng', media: [{ fileId: 'f1', altText: null }] }),
    ]);
  });
});

describe('what a channel showed in a version', () => {
  const version = { body: 'Chung', title: 'Tiêu đề', linkUrl: 'https://a.example', media: [{ fileId: 'f1', altText: null }] };

  it('inherits what it does not override', () => {
    expect(variantContent(version, variant({ body: 'Riêng', settings: { firstComment: 'Xem thêm' } }))).toEqual({
      body: 'Riêng',
      title: 'Tiêu đề',
      linkUrl: 'https://a.example',
      media: [{ fileId: 'f1', altText: null }],
      settings: { firstComment: 'Xem thêm' },
    });
    expect(variantContent(version, variant({ media: [] })).media).toEqual([]);
  });

  it('shows a frozen channel as it kept itself', () => {
    expect(variantContent(version, variant({ body: 'Đã đăng', contentFrozen: true }))).toEqual({ body: 'Đã đăng', title: null, linkUrl: null, media: [], settings: {} });
  });
});
