// Variant lifecycle and the post status derived from it (Social plan §3.2, revised after the schema comparison in
// docs/plan/social-research.md §5): each channel variant is reviewed, scheduled and published on its own, as in
// BrightBean and OpenPost; the post's status is a summary. Pure transition functions: each returns the next state or
// a refusal, never throws, so commands map refusals to domain errors and property tests can drive them freely.

export const VARIANT_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'rejected',
  'approved',
  'scheduled',
  'publishing',
  'processing',
  'published',
  'failed',
  'ambiguous',
  'needs_attention',
  'paused',
  'cancelled',
  // Taken down from its platform after it went out (#860).
  'removed',
] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export type VariantEvent =
  // Content changed (the variant's own overrides, or base content it inherits).
  | { type: 'edit' }
  | { type: 'submit' }
  // Review decisions (owners and admins).
  | { type: 'approve' }
  | { type: 'request_changes' }
  | { type: 'reject' }
  // The channel's review policy now asks for more approvals than the variant has: back to review, keeping its place in
  // the queue, until the missing approvals are given.
  | { type: 'regate' }
  | { type: 'schedule' }
  | { type: 'unschedule' }
  | { type: 'cancel' }
  // The channel lost its token or quota; resume reschedules.
  | { type: 'pause' }
  | { type: 'resume' }
  // Publishing (the publish and reconcile jobs).
  | { type: 'start' }
  | { type: 'accepted' }
  | { type: 'pending' }
  // The provider refused the post for good (bad request, permission).
  | { type: 'failed' }
  // The provider refused the call for a rate limit before anything was posted; it runs again at error_retry_at.
  | { type: 'rate_limited' }
  | { type: 'unknown' }
  // nextAction said 'manual': the outcome cannot be found out, a human decides.
  | { type: 'needs_human' }
  | { type: 'reconciled'; found: boolean }
  // A human's call on a failed or needs_attention variant: publish again, drop it, or confirm that it is on the
  // platform after all (they looked).
  | { type: 'retry' }
  | { type: 'drop' }
  | { type: 'confirm_published' }
  // The platform confirmed a person's removal of the published post (#860). The variant stays published while the
  // remove call is on its way or unclear: it is still up until the platform says otherwise, so there is no removing
  // status for a sweep, an edit or the post summary to handle, and a failed or unclear call leaves it as it was.
  | { type: 'removed' };

export type Refusal = { ok: false; code: 'INVALID_TRANSITION'; from: string; event: string };
export type Transition<S> = { ok: true; status: S } | Refusal;

const refuse = (from: string, event: string): Refusal => ({ ok: false, code: 'INVALID_TRANSITION', from, event });

// Content may change while nothing reached the platform: an edit always lands in draft, because an approval covers one
// revision and its content hash. Never while the variant is in flight or its outcome is unknown (an edit then could
// restart a publish that already reached the platform), and never once it is history.
const EDITABLE: ReadonlySet<VariantStatus> = new Set(['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'paused', 'failed']);
const CANCELLABLE: ReadonlySet<VariantStatus> = new Set(['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'paused', 'failed']);
// In flight, or waiting for a human to say what happened: a base edit that reaches such a variant is refused.
export const IN_FLIGHT: ReadonlySet<VariantStatus> = new Set(['publishing', 'processing', 'ambiguous', 'needs_attention']);
// History: their content is frozen (materialized) before base content changes.
export const FROZEN: ReadonlySet<VariantStatus> = new Set(['published', 'cancelled', 'removed']);

const TABLE: Readonly<Record<Exclude<VariantEvent['type'], 'edit' | 'cancel' | 'reconciled'>, Partial<Record<VariantStatus, VariantStatus>>>> = {
  submit: { draft: 'in_review', changes_requested: 'in_review', rejected: 'in_review' },
  approve: { in_review: 'approved' },
  request_changes: { in_review: 'changes_requested' },
  reject: { in_review: 'rejected' },
  regate: { approved: 'in_review', scheduled: 'in_review', paused: 'in_review' },
  schedule: { approved: 'scheduled' },
  unschedule: { scheduled: 'approved', paused: 'approved' },
  pause: { scheduled: 'paused', publishing: 'paused' },
  resume: { paused: 'scheduled' },
  start: { scheduled: 'publishing' },
  accepted: { publishing: 'published', processing: 'published' },
  pending: { publishing: 'processing' },
  failed: { publishing: 'failed', processing: 'failed' },
  rate_limited: { publishing: 'scheduled' },
  unknown: { publishing: 'ambiguous', processing: 'ambiguous' },
  needs_human: { publishing: 'needs_attention', ambiguous: 'needs_attention' },
  retry: { needs_attention: 'scheduled', failed: 'scheduled' },
  drop: { needs_attention: 'cancelled' },
  confirm_published: { needs_attention: 'published' },
  removed: { published: 'removed' },
};

export function transitionVariant(from: VariantStatus, event: VariantEvent): Transition<VariantStatus> {
  if (event.type === 'edit') return EDITABLE.has(from) ? { ok: true, status: 'draft' } : refuse(from, event.type);
  if (event.type === 'cancel') return CANCELLABLE.has(from) ? { ok: true, status: 'cancelled' } : refuse(from, event.type);
  if (event.type === 'reconciled') {
    if (from !== 'ambiguous') return refuse(from, event.type);
    return { ok: true, status: event.found ? 'published' : 'needs_attention' };
  }
  const to = TABLE[event.type][from];
  return to === undefined ? refuse(from, event.type) : { ok: true, status: to };
}

export function canEditVariant(status: VariantStatus): boolean {
  return EDITABLE.has(status);
}

// Events that send a variant back to scheduled after a publish began start a new publish attempt (fresh external_call
// keys): the earlier attempt's calls keep their outcome as history, and the next job calls the provider again. Each is
// safe: a rate limit or an expired token is a refusal before anything was posted, and a retry is a human's decision.
const NEW_ATTEMPT: ReadonlySet<VariantEvent['type']> = new Set(['rate_limited', 'resume', 'retry']);

export function startsNewAttempt(event: VariantEvent): boolean {
  return NEW_ATTEMPT.has(event.type);
}

const OUTCOME: ReadonlySet<VariantStatus> = new Set(['published', 'failed']);
const WAITING: ReadonlySet<VariantStatus> = new Set(['scheduled', 'paused']);

// The post's status from its variants' statuses. Cancelled and removed variants do not count, unless all are: such a
// post is cancelled. A removed channel is history like a cancelled one (nothing more happens to it, and it is not on
// the platform), so the post's status keeps describing what is live; the channel itself shows that it was removed.
export function postStatus(variants: readonly VariantStatus[]): PostStatus {
  if (variants.length === 0) return 'draft';
  const live = variants.filter((v) => v !== 'cancelled' && v !== 'removed');
  if (live.length === 0) return 'cancelled';
  if (live.some((v) => IN_FLIGHT.has(v))) return 'publishing';
  const published = live.filter((v) => v === 'published').length;
  if (live.every((v) => OUTCOME.has(v))) return published === live.length ? 'published' : published === 0 ? 'failed' : 'partially_published';
  if (published > 0) return 'partially_published';
  if (live.every((v) => WAITING.has(v) || OUTCOME.has(v))) return 'scheduled';
  return 'draft';
}
