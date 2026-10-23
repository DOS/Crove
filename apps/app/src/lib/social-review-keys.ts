// Reviewing Social posts one after another (#1221): which posts of the review list still wait for this reviewer's
// approval, so "Duyệt và sang bài tiếp" never lands on a post they cannot approve, and the first checklist item left to
// tick, where the A shortcut takes the focus instead of approving. The server decides every approval.

type ReviewVariant = { status: string; review: { approvedBy: readonly string[]; fourEyes: boolean } };

/**
 * Whether a post has a channel in review this user may still approve: not one they approved already (a channel that
 * needs several approvals waits for another person then), nor, on their own post, one with four-eyes (#740).
 */
export function awaitsApprovalBy(post: { authorUserId: string | null; variants: readonly ReviewVariant[] }, userId: string | null | undefined): boolean {
  if (!userId) return false;
  const own = post.authorUserId === userId;
  return post.variants.some((v) => v.status === 'in_review' && !v.review.approvedBy.includes(userId) && !(own && v.review.fourEyes));
}

/** The first checklist tick box not ticked yet inside `root`, or null. */
export function firstUnticked(root: ParentNode | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[role="checkbox"][aria-checked="false"]:not([aria-disabled="true"])') ?? null;
}
