// Reviewing the AI Inbox quickly (issue #315): bulk approval in batches the server accepts, and keyboard shortcuts on
// a proposal. The server decides every approval; these only shape the requests and the keys.

// The most proposals one bulk approval takes (kernel.proposal.approve_many). A larger selection goes in several
// batches, each checked against the same step-up freshness rule (P11) when it arrives.
export const BULK_LIMIT = 50;

export function chunks<T>(items: readonly T[], size: number = BULK_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Whether a list row can be selected for bulk approval: a pending purchase with no failed check and no duplicate
// warning. A failed check needs the approver to confirm the original document one by one (acceptFailedChecks), which a
// bulk approval never does; a possible duplicate and a reversal (it voids a posted document) are reviewed one by one
// too. The server still decides each item (four-eyes, eligibility, revision) and refuses what it would refuse alone.
export function bulkSelectable(item: { status: string; failedChecks: number; kind: string; duplicateOf: string | null }, reversalKind: string): boolean {
  return item.status === 'pending' && item.failedChecks === 0 && item.duplicateOf === null && item.kind !== reversalKind;
}

// The roles that may approve proposals (kernel.proposal.approve and approve_many); the kernel checks again.
export function canApproveProposals(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface BulkItem {
  id: string;
  revision: number;
}

// One request of a bulk approval. Its idempotency key is fixed when the batches are planned, so a retry (after a
// step-up, or after a lost answer) repeats the same request and never approves twice.
export interface BulkBatch {
  items: BulkItem[];
  idempotencyKey: string;
}

export type BulkResult =
  | { id: string; outcome: 'approved' }
  | { id: string; outcome: 'refused'; code: string; rule: string | null };

export function planBatches(items: readonly BulkItem[], newKey: () => string = () => crypto.randomUUID()): BulkBatch[] {
  return chunks(items).map((batch) => ({ items: batch, idempotencyKey: newKey() }));
}

export interface BulkProgress {
  // Every batch's results so far, in order.
  results: BulkResult[];
  // The batch to send next: batches.length when all were sent.
  next: number;
  // Why the batch at `next` was not done (a stale step-up, a network failure), or null.
  error: unknown;
}

// Sends the batches from `progress.next` on, one at a time, and stops at the first that fails: the caller asks for a
// fresh step-up (or offers a retry) and resumes from there with the same batches.
export async function sendBatches(
  batches: readonly BulkBatch[],
  progress: Pick<BulkProgress, 'results' | 'next'>,
  send: (batch: BulkBatch) => Promise<{ results: BulkResult[] }>,
  onBatch?: (progress: BulkProgress) => void,
): Promise<BulkProgress> {
  let results = progress.results;
  for (let next = progress.next; next < batches.length; next += 1) {
    try {
      const answer = await send(batches[next] as BulkBatch);
      results = [...results, ...answer.results];
      onBatch?.({ results, next: next + 1, error: null });
    } catch (error) {
      return { results, next, error: error ?? new Error('bulk approval failed') };
    }
  }
  return { results, next: batches.length, error: null };
}

export type ReviewAction = 'next' | 'approve' | 'edit';

const KEYS: Readonly<Record<string, ReviewAction>> = { j: 'next', n: 'next', a: 'approve', e: 'edit' };

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target: EventTarget | null;
}

function editable(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// The review action a key press asks for: J or N the next pending proposal, A approve, E edit the accounts. Never
// while typing in a field, with a modifier (browser and system shortcuts), or for a held-down key.
export function reviewShortcut(event: KeyLike): ReviewAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented) return null;
  if (editable(event.target)) return null;
  return Object.hasOwn(KEYS, event.key.toLowerCase()) ? (KEYS[event.key.toLowerCase()] as ReviewAction) : null;
}

// The pending proposal after `current` in the list order, or the first other one when `current` is not in the list
// (it was just decided); null when none is left.
export function nextPendingId(items: ReadonlyArray<{ id: string }>, current: string): string | null {
  const at = items.findIndex((i) => i.id === current);
  if (at === -1) return items[0]?.id ?? null;
  return items[at + 1]?.id ?? null;
}
