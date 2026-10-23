// The review checklist (#1105) on the client: the settings form's draft and its checks, which mirror the command's
// (at most SOCIAL_REVIEW_CHECKS_MAX items in all, labels of 1 to SOCIAL_REVIEW_CHECK_LABEL_MAX characters, each item
// once per channel), and the review panel's ticks. The server decides: it refuses an approval without every item of
// the channel's list, and copies the labels from its own list.
import { SOCIAL_REVIEW_CHECKS_MAX, SOCIAL_REVIEW_CHECK_LABEL_MAX } from '@crove/kernel-contract';

export { SOCIAL_REVIEW_CHECKS_MAX, SOCIAL_REVIEW_CHECK_LABEL_MAX };

export interface CheckItem {
  id: string;
  // null: every channel.
  connectionId: string | null;
  position: number;
  label: string;
}

export interface DraftItem {
  key: string;
  connectionId: string | null;
  label: string;
}

/** A label as the command keeps it: NFC, white space collapsed, trimmed. */
export const normalizeLabel = (label: string): string => label.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** The label's length as the database counts it (characters, not UTF-16 units). */
export const labelLength = (label: string): number => [...normalizeLabel(label)].length;

export const draftOf = (items: readonly CheckItem[]): DraftItem[] => items.map((i) => ({ key: i.id, connectionId: i.connectionId, label: i.label }));

export type DraftProblem = 'empty' | 'tooLong' | 'duplicate' | 'tooMany';

/** Why the draft cannot be saved, or null. */
export function draftProblem(draft: readonly DraftItem[]): DraftProblem | null {
  if (draft.length > SOCIAL_REVIEW_CHECKS_MAX) return 'tooMany';
  if (draft.some((d) => normalizeLabel(d.label) === '')) return 'empty';
  if (draft.some((d) => labelLength(d.label) > SOCIAL_REVIEW_CHECK_LABEL_MAX)) return 'tooLong';
  const seen = new Set(draft.map((d) => `${d.connectionId ?? ''}\u0000${normalizeLabel(d.label)}`));
  return seen.size === draft.length ? null : 'duplicate';
}

/** The command's input for the draft. */
export const draftInput = (draft: readonly DraftItem[]) => ({ items: draft.map((d) => ({ connectionId: d.connectionId, label: normalizeLabel(d.label) })) });

/** Whether the draft says what the saved list says, in the same order. */
export function sameAsSaved(draft: readonly DraftItem[], saved: readonly CheckItem[]): boolean {
  return draft.length === saved.length && draft.every((d, i) => d.connectionId === saved[i]?.connectionId && normalizeLabel(d.label) === saved[i]?.label);
}

/** The draft with the item at `index` moved one place up (-1) or down (1); unchanged at either end. */
export function moveItem(draft: readonly DraftItem[], index: number, delta: -1 | 1): DraftItem[] {
  const to = index + delta;
  if (index < 0 || index >= draft.length || to < 0 || to >= draft.length) return [...draft];
  const next = [...draft];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as DraftItem);
  return next;
}

const byPosition = (a: CheckItem, b: CheckItem) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every item the channels' checklists hold, each once, in (position, id) order. */
export function checklistItems(variants: ReadonlyArray<{ checklist: readonly CheckItem[] }>): CheckItem[] {
  const byId = new Map<string, CheckItem>();
  for (const v of variants) for (const c of v.checklist) byId.set(c.id, c);
  return [...byId.values()].sort(byPosition);
}

/** The ticked ids an approval of this channel sends: the ticked items of its own checklist. */
export const checksFor = (variant: { checklist: readonly CheckItem[] }, ticked: ReadonlySet<string>): string[] => variant.checklist.filter((c) => ticked.has(c.id)).map((c) => c.id);

/** Whether every item of every channel's checklist is ticked. */
export const fullyTicked = (variants: ReadonlyArray<{ checklist: readonly CheckItem[] }>, ticked: ReadonlySet<string>): boolean => variants.every((v) => v.checklist.every((c) => ticked.has(c.id)));
