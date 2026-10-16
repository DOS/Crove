// Post and variant lifecycles (Social plan §3.2). Pure transition functions: each returns the next state or a
// refusal, never throws, so commands map refusals to domain errors and the property tests can drive them freely.

export const POST_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'cancelled',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const VARIANT_STATUSES = [
  'pending',
  'scheduled',
  'publishing',
  'processing',
  'published',
  'failed',
  'ambiguous',
  'needs_attention',
  'cancelled',
  'paused',
] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export type PostEvent =
  | { type: 'edit' }
  | { type: 'submit' }
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'schedule' }
  | { type: 'unschedule' }
  | { type: 'cancel' }
  | { type: 'start_publishing' }
  // A human retried a failed variant of a post that already has an outcome (a new attempt, same revision).
  | { type: 'resume_publishing' }
  // The post's outcome once publishing ends, from its variants (postOutcome).
  | { type: 'finish'; outcome: 'published' | 'partially_published' | 'failed' };

export type Refusal = { ok: false; code: 'INVALID_TRANSITION'; from: string; event: string };
export type Transition<S> = { ok: true; status: S } | Refusal;

const refuse = (from: string, event: string): Refusal => ({ ok: false, code: 'INVALID_TRANSITION', from, event });

// Editing content is allowed before publishing starts; it always lands in draft, because an approval covers one
// revision and its content hash (post_approval), not the post. A post with a variant in flight is never edited or
// cancelled: an edit then could restart a publish that already reached the platform.
const EDITABLE: ReadonlySet<PostStatus> = new Set(['draft', 'in_review', 'approved', 'scheduled', 'failed']);
const CANCELLABLE: ReadonlySet<PostStatus> = new Set(['draft', 'in_review', 'approved', 'scheduled']);

export function transitionPost(from: PostStatus, event: PostEvent): Transition<PostStatus> {
  const to = ((): PostStatus | null => {
    switch (event.type) {
      case 'edit':
        return EDITABLE.has(from) ? 'draft' : null;
      case 'submit':
        return from === 'draft' ? 'in_review' : null;
      case 'approve':
        return from === 'in_review' ? 'approved' : null;
      case 'reject':
        return from === 'in_review' ? 'draft' : null;
      case 'schedule':
        return from === 'approved' ? 'scheduled' : null;
      case 'unschedule':
        return from === 'scheduled' ? 'approved' : null;
      case 'cancel':
        return CANCELLABLE.has(from) ? 'cancelled' : null;
      case 'start_publishing':
        return from === 'scheduled' ? 'publishing' : null;
      case 'resume_publishing':
        return from === 'failed' || from === 'partially_published' ? 'publishing' : null;
      case 'finish':
        return from === 'publishing' ? event.outcome : null;
    }
  })();
  return to === null ? refuse(from, event.type) : { ok: true, status: to };
}

export function canEditPost(status: PostStatus): boolean {
  return EDITABLE.has(status);
}

export type VariantEvent =
  | { type: 'schedule' }
  | { type: 'unschedule' }
  | { type: 'cancel' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'start' }
  | { type: 'accepted' }
  | { type: 'pending' }
  | { type: 'rejected' }
  // The provider refused the call for a rate limit before anything was posted; it runs again at error_retry_at.
  | { type: 'rate_limited' }
  | { type: 'unknown' }
  // nextAction said 'manual': the outcome cannot be found out, a human decides.
  | { type: 'needs_human' }
  | { type: 'reconciled'; found: boolean }
  | { type: 'retry' }
  | { type: 'drop' };

// pending -> scheduled -> publishing -> published | processing | failed | ambiguous.
// ambiguous -> published (found) | needs_attention (not found, or nothing to ask); needs_attention -> scheduled (a
// human retries, as a new attempt) or cancelled (a human drops it). paused holds a variant whose channel lost its
// token or quota, before or instead of the call (the provider refused it); resume reschedules. A variant in
// processing was accepted by the provider, so it never pauses or reschedules: its status checks continue.
const VARIANT_TABLE: Readonly<Record<VariantEvent['type'], Partial<Record<VariantStatus, VariantStatus>>>> = {
  schedule: { pending: 'scheduled' },
  unschedule: { scheduled: 'pending', paused: 'pending' },
  cancel: { pending: 'cancelled', scheduled: 'cancelled', paused: 'cancelled' },
  pause: { scheduled: 'paused', publishing: 'paused' },
  resume: { paused: 'scheduled' },
  start: { scheduled: 'publishing' },
  accepted: { publishing: 'published', processing: 'published' },
  pending: { publishing: 'processing' },
  rejected: { publishing: 'failed', processing: 'failed' },
  rate_limited: { publishing: 'scheduled' },
  unknown: { publishing: 'ambiguous', processing: 'ambiguous' },
  needs_human: { publishing: 'needs_attention', ambiguous: 'needs_attention' },
  reconciled: {},
  retry: { needs_attention: 'scheduled', failed: 'scheduled' },
  drop: { needs_attention: 'cancelled' },
};

export function transitionVariant(from: VariantStatus, event: VariantEvent): Transition<VariantStatus> {
  if (event.type === 'reconciled') {
    if (from !== 'ambiguous') return refuse(from, event.type);
    return { ok: true, status: event.found ? 'published' : 'needs_attention' };
  }
  const to = VARIANT_TABLE[event.type][from];
  return to === undefined ? refuse(from, event.type) : { ok: true, status: to };
}

const FINAL_VARIANT: ReadonlySet<VariantStatus> = new Set(['published', 'failed', 'cancelled']);

// The post's outcome once every variant has one; null while any variant is still in flight or waiting on a human.
// Cancelled variants do not count: a post whose other variants all published is published.
export function postOutcome(variants: readonly VariantStatus[]): 'published' | 'partially_published' | 'failed' | null {
  if (variants.some((v) => !FINAL_VARIANT.has(v))) return null;
  const live = variants.filter((v) => v !== 'cancelled');
  const published = live.filter((v) => v === 'published').length;
  if (live.length === 0 || published === 0) return 'failed';
  return published === live.length ? 'published' : 'partially_published';
}
