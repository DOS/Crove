import { describe, expect, it } from 'vitest';
import { compactValue, diffMedia, diffSettings, diffText, reviewDiff, tokenize, type ReviewContent } from '../src/lib/social-review-diff.ts';

const content = (over: Partial<ReviewContent> = {}): ReviewContent => ({ body: 'Xin chào', title: null, linkUrl: null, media: [], settings: {}, ...over });
const img = (fileId: string, altText: string | null = null) => ({ fileId, altText, mime: 'image/jpeg' });

describe('what changed since the last review (#944)', () => {
  it('marks an inserted word, keeping the text around it', () => {
    expect(diffText('Khuyến mãi cuối tuần', 'Khuyến mãi lớn cuối tuần')).toEqual([
      { kind: 'same', text: 'Khuyến mãi ' },
      { kind: 'added', text: 'lớn ' },
      { kind: 'same', text: 'cuối tuần' },
    ]);
  });

  it('marks a deleted word', () => {
    expect(diffText('Giảm giá 50% hôm nay', 'Giảm giá hôm nay')).toEqual([
      { kind: 'same', text: 'Giảm giá ' },
      { kind: 'removed', text: '50% ' },
      { kind: 'same', text: 'hôm nay' },
    ]);
  });

  it('shows a replaced run as removed then added', () => {
    expect(diffText('a b c', 'a x y c')).toEqual([
      { kind: 'same', text: 'a ' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x y' },
      { kind: 'same', text: ' c' },
    ]);
  });

  it('keeps Vietnamese words whole, diacritics included, and treats a changed tone mark as a changed word', () => {
    expect(tokenize('Mừng Tết Nguyên Đán!')).toEqual(['Mừng', ' ', 'Tết', ' ', 'Nguyên', ' ', 'Đán', '!']);
    expect(diffText('Chúc mừng năm mới', 'Chúc mừng năm mời')).toEqual([
      { kind: 'same', text: 'Chúc mừng năm ' },
      { kind: 'removed', text: 'mới' },
      { kind: 'added', text: 'mời' },
    ]);
  });

  it('sees no change between composed and decomposed diacritics', () => {
    const composed = 'Tiếng Việt';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(tokenize(decomposed)).toEqual(['Tiếng', ' ', 'Việt'].map((w) => w.normalize('NFD')));
    expect(diffText(composed, decomposed)).toEqual([{ kind: 'same', text: composed }]);
  });

  it('keeps line breaks', () => {
    expect(diffText('Dòng một\nDòng hai', 'Dòng một\n\nDòng hai\nDòng ba')).toEqual([
      { kind: 'same', text: 'Dòng một\n' },
      { kind: 'added', text: '\n' },
      { kind: 'same', text: 'Dòng hai' },
      { kind: 'added', text: '\nDòng ba' },
    ]);
  });

  it('returns the text unchanged, and nothing for two empty texts', () => {
    expect(diffText('Không đổi gì', 'Không đổi gì')).toEqual([{ kind: 'same', text: 'Không đổi gì' }]);
    expect(diffText('', '')).toEqual([]);
    expect(reviewDiff(content(), content())).toBeNull();
  });

  it('handles a long text without building a huge table', () => {
    const long = Array.from({ length: 3000 }, (_, i) => `từ${i}`).join(' ');
    const other = Array.from({ length: 3000 }, (_, i) => `chữ${i}`).join(' ');
    const parts = diffText(long, other);
    expect(parts.filter((p) => p.kind === 'removed').map((p) => p.text).join('')).toContain('từ2999');
    expect(parts.filter((p) => p.kind === 'added').map((p) => p.text).join('')).toContain('chữ2999');
  });

  it('lists media added and removed, a new description and a new order', () => {
    expect(diffMedia([img('a'), img('b', 'Áo đỏ')], [img('b', 'Áo xanh'), img('c')])).toEqual({
      added: [img('c')],
      removed: [img('a')],
      altChanged: [{ fileId: 'b', mime: 'image/jpeg', before: 'Áo đỏ', after: 'Áo xanh' }],
      reordered: false,
    });
    expect(diffMedia([img('a'), img('b')], [img('b'), img('a')]).reordered).toBe(true);
    // An empty description and none are the same for a reader.
    expect(diffMedia([img('a', '')], [img('a', null)]).altChanged).toEqual([]);
  });

  it('lists the settings that changed with their old and new values, whatever the key order', () => {
    expect(diffSettings({ privacy: 'PUBLIC', utm: { source: 'fb', medium: 'social' }, cover: { atMs: 0 } }, { utm: { medium: 'social', source: 'fb' }, privacy: 'FRIENDS', firstComment: 'Xem thêm' })).toEqual([
      { key: 'cover', before: '{"atMs":0}', after: null },
      { key: 'firstComment', before: null, after: 'Xem thêm' },
      { key: 'privacy', before: 'PUBLIC', after: 'FRIENDS' },
    ]);
    expect(compactValue('x'.repeat(200))).toHaveLength(80);
  });

  it('puts the parts together, with null for a part that did not change', () => {
    const diff = reviewDiff(content({ title: 'Tiêu đề', linkUrl: 'https://a.example' }), content({ title: 'Tiêu đề mới', linkUrl: 'https://b.example', media: [img('a')] }));
    expect(diff).toMatchObject({ body: null, title: [{ kind: 'same', text: 'Tiêu đề' }, { kind: 'added', text: ' mới' }], link: { before: 'https://a.example', after: 'https://b.example' }, settings: [] });
    expect(diff?.media?.added).toEqual([img('a')]);
    // An empty link and none are the same.
    expect(reviewDiff(content({ linkUrl: '' }), content({ linkUrl: null }))).toBeNull();
  });
});
