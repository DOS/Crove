// Acting on many posts at once from the Social home lists (#635). Each post still goes through its own command, on
// what the list shows: one refused post does not stop the others, and the result says what was done and what was
// refused, with the reason.
import { CANCELLABLE } from './social.ts';

export type BulkAction = 'approve' | 'queue' | 'cancel';

export interface BulkVariant {
  id: string;
  status: string;
  revision: number;
  contentHash: string;
}
export interface BulkPost {
  id: string;
  variants: readonly BulkVariant[];
}

// Owners and admins approve, schedule and cancel anything; members cancel what nobody approved yet.
const SIGNED_OFF = ['approved', 'scheduled', 'paused'];

export type BulkRequest =
  | { action: 'approve'; postId: string; variants: { variantId: string; revision: number; contentHash: string }[] }
  | { action: 'queue'; postId: string; variantIds: string[] }
  | { action: 'cancel'; postId: string; variantIds: string[] };

// The request for one post, or null when the post has nothing the action applies to.
export function bulkRequest(post: BulkPost, action: BulkAction, canDecide: boolean): BulkRequest | null {
  if (action === 'approve') {
    if (!canDecide) return null;
    const variants = post.variants.filter((v) => v.status === 'in_review').map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
    return variants.length > 0 ? { action, postId: post.id, variants } : null;
  }
  if (action === 'queue') {
    if (!canDecide) return null;
    const variantIds = post.variants.filter((v) => v.status === 'approved').map((v) => v.id);
    return variantIds.length > 0 ? { action, postId: post.id, variantIds } : null;
  }
  const variantIds = post.variants.filter((v) => (CANCELLABLE as readonly string[]).includes(v.status) && (canDecide || !SIGNED_OFF.includes(v.status))).map((v) => v.id);
  return variantIds.length > 0 ? { action, postId: post.id, variantIds } : null;
}

export interface BulkResult {
  done: string[];
  skipped: string[];
  refused: { postId: string; error: unknown }[];
}

// Runs the requests one after another (each a command with its own checks), never stopping at a refusal.
export async function runBulk(posts: readonly BulkPost[], action: BulkAction, canDecide: boolean, send: (request: BulkRequest) => Promise<unknown>): Promise<BulkResult> {
  const result: BulkResult = { done: [], skipped: [], refused: [] };
  for (const post of posts) {
    const request = bulkRequest(post, action, canDecide);
    if (!request) {
      result.skipped.push(post.id);
      continue;
    }
    try {
      await send(request);
      result.done.push(post.id);
    } catch (error) {
      result.refused.push({ postId: post.id, error });
    }
  }
  return result;
}
