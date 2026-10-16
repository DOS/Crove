// What a publish job may do next, from the external_call ledger and the adapter step's declared retry safety
// (Social plan §3.4). The visible provider call runs at most once unless the step is provably safe to repeat.

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
  | 'manual'; // a human decides (needs_attention)

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

// Deterministic key of one provider step of one variant revision (external_call.key). A new revision (an edit
// and a new approval) gets new keys; a retry of the same revision reuses them.
export function publishCallKey(variantId: string, revision: number, step: string): string {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(step)) throw new Error(`invalid publish step name: ${step}`);
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`invalid revision: ${revision}`);
  return `social.publish:${variantId}:${revision}:${step}`;
}

// pg-boss singleton key of the publish job: one job per variant revision in an org.
export function publishJobKey(orgId: string, variantId: string, revision: number): string {
  return `${orgId}:${variantId}:${revision}`;
}
