// First comments (#587): an adapter's publish answer as a comment answer; and as a remove answer (#860).
import type { CommentResult, PublishResult, RemoveResult } from './index.ts';

// A comment is one call, never pending: a pending answer is not one the adapter can follow up.
export function commentResult(result: PublishResult): CommentResult {
  if (result.kind === 'accepted') return { kind: 'accepted', externalId: result.externalId };
  if (result.kind === 'rejected') return { kind: 'rejected', error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.message ? { message: result.message } : {}) };
  if (result.kind === 'pending') return { kind: 'unknown', code: 'PENDING' };
  return { kind: 'unknown', ...(result.code ? { code: result.code } : {}) };
}

// A removal is one call too; an accepted answer means the post is gone. A pending answer cannot be followed up.
export function removeResult(result: PublishResult): RemoveResult {
  if (result.kind === 'accepted') return { kind: 'removed' };
  if (result.kind === 'rejected') return { kind: 'rejected', error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.message ? { message: result.message } : {}), ...(result.retryAt ? { retryAt: result.retryAt } : {}) };
  if (result.kind === 'pending') return { kind: 'unknown', code: 'PENDING' };
  return { kind: 'unknown', ...(result.code ? { code: result.code } : {}) };
}
