// Reviewing Social posts by keyboard (#1221) in the app: which posts of the review list still wait for this reviewer
// (so "Duyệt và sang bài tiếp" never lands on one they cannot approve), the first checklist item left to tick (where A
// takes the focus instead of approving), the shortcuts listed in the review panel and the end of the list, in
// Vietnamese and in English. Rendered on the server.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search, children, className }: { to: string; params: Record<string, string>; search?: Record<string, string>; children: React.ReactNode; className?: string }) => (
    <a href={`${to.replace('$slug', params.slug ?? '')}${search ? `?${new URLSearchParams(search).toString()}` : ''}`} className={className}>
      {children}
    </a>
  ),
}));

const { NoneLeftToReview, ReviewKeysHint } = await import('../src/components/social-review-keys.tsx');
const { awaitsApprovalBy, firstUnticked } = await import('../src/lib/social-review-keys.ts');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const ME = 'u-me';
const variant = (status: string, approvedBy: string[] = [], fourEyes = false, required = 1) => ({ status, review: { approvedBy, fourEyes, required } });

describe('reviewing Social posts by keyboard (#1221)', () => {
  it('moves on only to posts with a channel in review this reviewer may still approve', () => {
    const post = (authorUserId: string | null, ...variants: ReturnType<typeof variant>[]) => ({ authorUserId, variants });
    expect(awaitsApprovalBy(post('u-writer', variant('in_review')), ME)).toBe(true);
    // Approved by this reviewer already, waiting for a second person.
    expect(awaitsApprovalBy(post('u-writer', variant('in_review', [ME], false, 2)), ME)).toBe(false);
    expect(awaitsApprovalBy(post('u-writer', variant('in_review', ['u-other'], false, 2)), ME)).toBe(true);
    // Every team approval in, waiting only for the client's (#770, #1230): nothing left for this reviewer.
    expect(awaitsApprovalBy(post('u-writer', variant('in_review', ['u-other'])), ME)).toBe(false);
    // Their own post on a four-eyes channel (#740); without four-eyes they may approve it.
    expect(awaitsApprovalBy(post(ME, variant('in_review', [], true)), ME)).toBe(false);
    expect(awaitsApprovalBy(post(ME, variant('in_review')), ME)).toBe(true);
    // One channel left to approve is enough; channels not in review do not count.
    expect(awaitsApprovalBy(post('u-writer', variant('in_review', [ME], false, 2), variant('in_review', ['u-other'], false, 2)), ME)).toBe(true);
    expect(awaitsApprovalBy(post('u-writer', variant('approved'), variant('changes_requested')), ME)).toBe(false);
    // Before the session is known, none.
    expect(awaitsApprovalBy(post('u-writer', variant('in_review')), undefined)).toBe(false);
  });

  it('finds the first checklist item left to tick', () => {
    const seen: string[] = [];
    const box = { focus: () => undefined };
    const root = { querySelector: (selector: string) => (seen.push(selector), box) } as unknown as ParentNode;
    expect(firstUnticked(root)).toBe(box);
    expect(seen).toEqual(['[role="checkbox"][aria-checked="false"]:not([aria-disabled="true"])']);
    expect(firstUnticked({ querySelector: () => null } as unknown as ParentNode)).toBeNull();
    expect(firstUnticked(null)).toBeNull();
  });

  it('lists the shortcuts in the review panel', () => {
    expect(text(render(<ReviewKeysHint />))).toBe(
      'Phím tắt: J hoặc N sang bài tiếp · K hoặc P về bài trước · A duyệt và sang bài tiếp (nếu còn mục kiểm tra chưa đánh dấu, A đưa bạn tới mục đó) · R viết lý do yêu cầu sửa. Phím tắt không có tác dụng khi bạn đang gõ chữ.',
    );
    expect(text(render(<ReviewKeysHint />, 'en'))).toBe(
      'Shortcuts: J or N next post · K or P previous post · A approve and open the next post (with checklist items left to tick, A takes you to the first one) · R write why changes are needed. Shortcuts do nothing while you type in a field.',
    );
  });

  it('says when no post is left to review, with the way back to the list', () => {
    const vi = render(<NoneLeftToReview slug="tiem-banh" />);
    expect(text(vi)).toBe('Hết bài chờ duyệt Không còn bài nào chờ bạn duyệt. Bài mới gửi duyệt sẽ hiện trong mục Cần duyệt. Về mục Cần duyệt');
    // Named once by its focus, not read again as a live status (#1230).
    expect(vi).toContain('role="region"');
    expect(vi).not.toContain('role="status"');
    expect(vi).toMatch(/aria-labelledby="([^"]+)".*id="\1"/);
    expect(vi).toContain('tabindex="-1"');
    expect(vi).toContain('href="/o/tiem-banh/social?tab=review"');
    expect(text(render(<NoneLeftToReview slug="tiem-banh" />, 'en'))).toBe(
      'No posts left to review No post is waiting for your approval. New posts sent for review show in the To review tab. Back to the review list',
    );
  });
});

describe('moving on through the review list (#1230)', () => {
  it('tells the page it opens once, and no other page', async () => {
    const { markReviewMove, takeReviewMove } = await import('../src/lib/social-review-keys.ts');
    markReviewMove('post-2');
    expect(takeReviewMove('post-3')).toBe(false);
    expect(takeReviewMove('post-2')).toBe(true);
    expect(takeReviewMove('post-2')).toBe(false);
  });
});
