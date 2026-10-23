// Reviewing Social posts one after another (#1221): which posts of the review list still wait for this reviewer's
// approval, so "Duyệt và sang bài tiếp" never lands on a post they cannot approve, and the first checklist item left to
// tick, where the A shortcut takes the focus instead of approving. The server decides every approval.

type ReviewVariant = { status: string; review: { approvedBy: readonly string[]; fourEyes: boolean; required: number } };

/**
 * Whether a post has a channel in review this user may still approve: not one they approved already (a channel that
 * needs several approvals waits for another person then), nor, on their own post, one with four-eyes (#740), nor one
 * whose team approvals are all in and that waits only for the client's approval on a review link (#770, #1230).
 */
export function awaitsApprovalBy(post: { authorUserId: string | null; variants: readonly ReviewVariant[] }, userId: string | null | undefined): boolean {
  if (!userId) return false;
  const own = post.authorUserId === userId;
  return post.variants.some((v) => v.status === 'in_review' && v.review.approvedBy.length < v.review.required && !v.review.approvedBy.includes(userId) && !(own && v.review.fourEyes));
}

// The post the review shortcuts or *Duyệt và sang bài tiếp* just opened (#1230): set by the page before it moves on,
// taken once by the page of that post, which then takes the focus to its title and says which post it is.
let movedTo: string | null = null;

export function markReviewMove(postId: string): void {
  movedTo = postId;
}

/** Whether this post was just opened by moving on through the review list; true once. */
export function takeReviewMove(postId: string): boolean {
  if (movedTo !== postId) return false;
  movedTo = null;
  return true;
}

/** The first checklist tick box not ticked yet inside `root`, or null. */
export function firstUnticked(root: ParentNode | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[role="checkbox"][aria-checked="false"]:not([aria-disabled="true"])') ?? null;
}
