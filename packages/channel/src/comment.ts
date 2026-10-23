// First comments (#587): an adapter's publish answer as a comment answer; and as a remove answer (#860) and an edit
// answer (#1223).
import type { CommentResult, EditResult, PublishResult, RemoveResult } from './index.ts';

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

// What an adapter answers for a post it cannot edit (a poll, a Story), with nothing sent (#1223).
export const EDIT_NOT_SUPPORTED = 'EDIT_NOT_SUPPORTED';

// An edit is one call too; an accepted answer means the platform shows the new text. A pending answer cannot be followed
// up, so it is unclear.
export function editResult(result: PublishResult): EditResult {
  if (result.kind === 'accepted') return { kind: 'edited' };
  if (result.kind === 'rejected') return { kind: 'rejected', error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.message ? { message: result.message } : {}) };
  if (result.kind === 'pending') return { kind: 'unknown', code: 'PENDING' };
  return { kind: 'unknown', ...(result.code ? { code: result.code } : {}) };
}
