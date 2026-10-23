// The version history panel (#1021): what restoring a version would change, per channel.
import { describe, expect, it } from 'vitest';
import { restorePreview, type CurrentChannel } from '../src/lib/social-post-versions.ts';
import type { ReviewContent } from '../src/lib/social-review-diff.ts';

const content = (over: Partial<ReviewContent> = {}): ReviewContent => ({ body: 'Xin chào', title: null, linkUrl: null, media: [], settings: {}, ...over });
const channel = (variantId: string, status: string, over: Partial<ReviewContent> = {}): CurrentChannel => ({ variantId, name: `Kênh ${variantId}`, status, content: content(over) });

describe('restoring a version (#1021)', () => {
  it('shows the change from the content now to the version, per channel that would change', () => {
    const preview = restorePreview([channel('a', 'approved', { body: 'Xin chào bạn' }), channel('b', 'draft')], [
      { variantId: 'a', content: content() },
      { variantId: 'b', content: content() },
    ]);
    expect(preview.kept).toBe(0);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]).toMatchObject({ variantId: 'a', name: 'Kênh a', diff: { body: [{ kind: 'same', text: 'Xin chào' }, { kind: 'removed', text: ' bạn' }] } });
  });

  it('counts channels that are history as kept and leaves out channels the version does not have', () => {
    const preview = restorePreview([channel('a', 'published', { body: 'Đã đăng' }), channel('b', 'cancelled'), channel('c', 'draft', { body: 'Mới thêm' })], [
      { variantId: 'a', content: content() },
      { variantId: 'b', content: content({ body: 'Khác' }) },
      { variantId: 'gone', content: content({ body: 'Kênh đã bỏ' }) },
    ]);
    expect(preview).toMatchObject({ changes: [], kept: 2 });
    // The published channel's text then is shown, never restored (#1223); a cancelled one's is not.
    expect(preview.history.map((c) => c.variantId)).toEqual(['a']);
  });

  it('shows what a published channel showed before its text was corrected on its platform (#1223)', () => {
    const preview = restorePreview([channel('a', 'published', { body: 'Giá 45.000đ' })], [{ variantId: 'a', content: content({ body: 'Giá 54.000đ' }) }]);
    expect(preview.changes).toEqual([]);
    expect(preview.history).toHaveLength(1);
    expect(preview.history[0]?.diff.body?.some((p) => p.kind === 'added' && p.text.includes('54'))).toBe(true);
    // The version that is the content now has nothing to show.
    expect(restorePreview([channel('a', 'published', { body: 'Giá 45.000đ' })], [{ variantId: 'a', content: content({ body: 'Giá 45.000đ' }) }]).history).toEqual([]);
  });
});
