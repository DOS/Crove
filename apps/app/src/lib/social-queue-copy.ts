// Copying a channel's queue to other channels (#1166): the slots, their content categories (#745) and the time zone
// replace each target's through `social.queue.set`. Before the copy the confirmation says, per target, how many of its
// queued posts that set places again; this runs the set's own placement (placeQueued, retime) over the target's posts
// as the post list answers them, so the count is the one the server reaches unless the queue changes meanwhile.
import { placeQueued, retime, type QueueSpec } from '@crove/mod-social/contract';

// The module's MOVABLE and SLOT_FREED (variants.ts): variants a queue edit may move, and those whose slot is free again.
const MOVABLE: ReadonlySet<string> = new Set(['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'paused']);
const SLOT_FREED: ReadonlySet<string> = new Set(['cancelled', 'published', 'failed', 'removed']);
// The most posts one list answer holds: a full answer may leave some queued posts out, so the count is a floor.
export const COPY_POSTS_LIMIT = 200;

export interface CopySlot {
  weekday: number;
  minute: number;
  label?: string;
  labelId?: string | null;
}

// The saved slots as `social.queue.set` takes them, the label and the content category kept.
export function copySlots(slots: readonly { weekday: number; minute: number; label?: string | null; labelId?: string | null; active?: boolean }[]): CopySlot[] {
  return slots
    .filter((s) => s.active !== false)
    .map((s) => ({ weekday: s.weekday, minute: s.minute, ...(s.label ? { label: s.label } : {}), ...(s.labelId ? { labelId: s.labelId } : {}) }));
}

interface ListedPost {
  labelIds?: readonly string[];
  variants: readonly { id: string; connectionId: string; status: string; queueSlotAt: string | null }[];
}

// How many of the target's queued posts the new queue places again: those `social.queue.set` would move, as it moves
// them. before: the target's queue now (null without one, which no post can be queued on).
export function replacedCount(posts: readonly ListedPost[], connectionId: string, before: QueueSpec | null, next: QueueSpec, nowMs: number): number {
  if (!before) return 0;
  const holders = new Map<string, { id: string; at: number; status: string; labelIds: readonly string[] }>();
  for (const p of posts) {
    for (const v of p.variants) {
      if (v.connectionId !== connectionId || !v.queueSlotAt || SLOT_FREED.has(v.status)) continue;
      const at = Date.parse(v.queueSlotAt);
      if (!Number.isNaN(at)) holders.set(v.id, { id: v.id, at, status: v.status, labelIds: p.labelIds ?? [] });
    }
  }
  // In-flight variants and ones already due keep their slot, and nobody else takes it.
  const movable = [...holders.values()].filter((h) => MOVABLE.has(h.status) && h.at > nowMs);
  const reserved = new Set([...holders.values()].filter((h) => !movable.includes(h)).map((h) => h.at));
  const zoneChanged = before.timeZone !== next.timeZone;
  const placed = placeQueued(
    next,
    movable.map((h) => ({ id: h.id, slotAt: zoneChanged ? retime(h.at, before.timeZone, next.timeZone) : h.at, labelIds: h.labelIds })),
    nowMs,
    reserved,
  );
  const was = new Map(movable.map((h) => [h.id, h.at]));
  return placed.filter((p) => p.slotAt !== was.get(p.id)).length;
}

export type CopyResult = { connectionId: string; ok: true; moved: number; unqueued: number } | { connectionId: string; ok: false; message: string };

// One `social.queue.set` per target, in order; a refusal is that target's result and the copy goes on to the next.
export async function copyQueue(
  targets: readonly string[],
  spec: { timeZone: string; slots: readonly CopySlot[] },
  set: (input: { connectionId: string; timeZone: string; slots: CopySlot[] }) => Promise<{ moved: readonly { at: string | null }[] }>,
  messageOf: (error: unknown) => string,
): Promise<CopyResult[]> {
  const out: CopyResult[] = [];
  for (const connectionId of targets) {
    try {
      const done = await set({ connectionId, timeZone: spec.timeZone, slots: [...spec.slots] });
      const unqueued = done.moved.filter((m) => m.at === null).length;
      out.push({ connectionId, ok: true, moved: done.moved.length - unqueued, unqueued });
    } catch (error) {
      out.push({ connectionId, ok: false, message: messageOf(error) });
    }
  }
  return out;
}
