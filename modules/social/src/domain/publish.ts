// What a publish job may do next, from the external_call ledger and the adapter step's declared retry safety
// (Social plan §3.4). The visible provider call runs at most once per attempt unless the step is provably safe to
// repeat. A new attempt starts only when a human retries a failed or needs_attention variant.

// How a provider step behaves when repeated:
// - safe: nothing visible happens (for example creating an Instagram container);
// - idempotent: the provider dedupes a repeat (Bluesky's client-chosen record key);
// - reconcile_only: the provider can be asked whether it went through;
// - never: no way to ask; an unknown outcome goes to a human.
export type RetrySafety = 'safe' | 'idempotent' | 'reconcile_only' | 'never';

// crove_kernel.external_call state for this step's key; 'none' when no row exists yet.
export type CallState = 'none' | 'started' | 'succeeded' | 'failed' | 'ambiguous';

export type NextAction =
  | 'call' // make the provider call
  | 'done' // the step already has its outcome
  | 'reconcile' // ask the provider whether the earlier call went through
  | 'manual'; // a human decides: the variant goes to needs_attention

export function nextAction(state: CallState, safety: RetrySafety): NextAction {
  switch (state) {
    case 'none':
      return 'call';
    case 'succeeded':
    case 'failed':
      return 'done';
    case 'started':
    case 'ambiguous':
      if (safety === 'safe' || safety === 'idempotent') return 'call';
      return safety === 'reconcile_only' ? 'reconcile' : 'manual';
  }
}

const STEP = /^[a-z][a-z0-9_]{0,31}$/;
// Ids are UUIDs in practice; anything with the key separator would let two keys collide.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkParts(ids: readonly string[], revision: number, attempt: number): void {
  for (const id of ids) if (!ID.test(id)) throw new Error(`invalid id in publish key: ${id}`);
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`invalid revision: ${revision}`);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`invalid attempt: ${attempt}`);
}

// Deterministic key of one provider step of one attempt of a variant revision (external_call.key). A retry by the
// job reuses the key, so the ledger sees the earlier call; a human retry bumps the attempt and gets fresh keys; a
// new revision (an edit and a new approval) gets fresh keys too.
export function publishCallKey(variantId: string, revision: number, attempt: number, step: string): string {
  if (!STEP.test(step)) throw new Error(`invalid publish step name: ${step}`);
  checkParts([variantId], revision, attempt);
  return `social.publish:${variantId}:${revision}:${attempt}:${step}`;
}

// pg-boss singleton key of the publish job: one job per attempt of a variant revision in an org.
export function publishJobKey(orgId: string, variantId: string, revision: number, attempt: number): string {
  checkParts([orgId, variantId], revision, attempt);
  return `${orgId}:${variantId}:${revision}:${attempt}`;
}
