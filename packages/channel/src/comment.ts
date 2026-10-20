// First comments (#587): an adapter's publish answer as a comment answer.
import type { CommentResult, PublishResult } from './index.ts';

// A comment is one call, never pending: a pending answer is not one the adapter can follow up.
export function commentResult(result: PublishResult): CommentResult {
  if (result.kind === 'accepted') return { kind: 'accepted', externalId: result.externalId };
  if (result.kind === 'rejected') return { kind: 'rejected', error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.message ? { message: result.message } : {}) };
  if (result.kind === 'pending') return { kind: 'unknown', code: 'PENDING' };
  return { kind: 'unknown', ...(result.code ? { code: result.code } : {}) };
}