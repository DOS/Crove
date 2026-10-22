// Acting on many posts at once from the Social home lists (#635). Each post still goes through its own command, on
// what the list shows: one refused post does not stop the others, and the result says what was done and what was
// refused, with the reason.
import { SOCIAL_BULK_EDIT_MAX, type SocialBulkSkipReason } from '@crove/kernel-contract';
import { localTime, zonedToEpoch } from '@crove/mod-social/contract';
import { CANCELLABLE } from './social.ts';
import { MAX_LABELS_PER_POST } from './social-labels.ts';

export type BulkAction = 'approve' | 'queue' | 'cancel' | 'move' | 'labels' | 'assign';
// The edits the server makes for many posts in one command (#1057): labels and the assignee.
export type EditAction = 'labels' | 'assign';
// The actions that send one command per post; a move sends one per channel (runMove).
export type PostAction = Exclude<BulkAction, 'move' | EditAction>;

export interface BulkVariant {
  id: string;
  connectionId: string;
  status: string;
  revision: number;
  contentHash: string;
  // When it goes out (a retry time, else its queue slot, else its own time, else the post's), and its queue slot.
  effectiveAt: string | null;
  queueSlotAt: string | null;
}
export interface BulkPost {
  id: string;
  // The post's IANA time zone: a move by days keeps the local clock time there.
  timeZone: string;
  variants: readonly BulkVariant[];
}

// Owners and admins approve, schedule and cancel anything; members cancel what nobody approved yet.
const SIGNED_OFF = ['approved', 'scheduled', 'paused'];

export type BulkRequest =
  | { action: 'approve'; postId: string; variants: { variantId: string; revision: number; contentHash: string }[] }
  | { action: 'queue'; postId: string; variantIds: string[] }
  | { action: 'cancel'; postId: string; variantIds: string[] };

// The request for one post, or null when the post has nothing the action applies to.
export function bulkRequest(post: BulkPost, action: PostAction, canDecide: boolean): BulkRequest | null {
  if (action === 'approve') {
    if (!canDecide) return null;
    const variants = post.variants.filter((v) => v.status === 'in_review').map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
    return variants.length > 0 ? { action, postId: post.id, variants } : null;
  }
  if (action === 'queue') {
    if (!canDecide) return null;
    const variantIds = post.variants.filter((v) => v.status === 'approved').map((v) => v.id);
    return variantIds.length > 0 ? { action, postId: post.id, variantIds } : null;
  }
  const variantIds = post.variants.filter((v) => (CANCELLABLE as readonly string[]).includes(v.status) && (canDecide || !SIGNED_OFF.includes(v.status))).map((v) => v.id);
  return variantIds.length > 0 ? { action, postId: post.id, variantIds } : null;
}

export interface BulkResult {
  done: string[];
  skipped: string[];
  refused: { postId: string; error: unknown }[];
}

// Runs the requests one after another (each a command with its own checks), never stopping at a refusal.
export async function runBulk(posts: readonly BulkPost[], action: PostAction, canDecide: boolean, send: (request: BulkRequest) => Promise<unknown>): Promise<BulkResult> {
  const result: BulkResult = { done: [], skipped: [], refused: [] };
  for (const post of posts) {
    const request = bulkRequest(post, action, canDecide);
    if (!request) {
      result.skipped.push(post.id);
      continue;
    }
    try {
      await send(request);
      result.done.push(post.id);
    } catch (error) {
      result.refused.push({ postId: post.id, error });
    }
  }
  return result;
}

// Moving the selected posts by days or hours (#945): each channel scheduled at a time moves by the same amount through
// social.variant.reschedule (owners and admins), its approvals kept as on the calendar's drag.
export type MoveUnit = 'days' | 'hours';
// amount is a whole number, negative to move earlier.
export interface BulkMove {
  amount: number;
  unit: MoveUnit;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// The largest move the form offers, in either unit.
export const MOVE_MAX = 999;

export function validMove(move: BulkMove): boolean {
  return Number.isInteger(move.amount) && move.amount !== 0 && Math.abs(move.amount) <= MOVE_MAX;
}

// The instant moved by the amount. Hours are exact; days keep the local clock time in the zone, so 09:00 stays 09:00
// across a daylight-saving or offset change (a time the change skips lands just after it, as the queues do).
export function shiftTime(atMs: number, move: BulkMove, timeZone: string): number {
  if (move.unit === 'hours') return atMs + move.amount * HOUR;
  const local = localTime(atMs, timeZone);
  // Calendar day arithmetic on day numbers only, no zone involved.
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day + move.amount));
  const moved = zonedToEpoch({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: local.hour, minute: local.minute }, timeZone);
  // localTime reads to the minute; the seconds the time had come back.
  return moved + (atMs - Math.floor(atMs / MINUTE) * MINUTE);
}

// Why a channel is left as it is: it waits on a queue slot (the queue places it), it is out or going out, it was
// cancelled, or it has no time of its own yet.
export type MoveSkip = 'queue' | 'published' | 'cancelled' | 'unscheduled';
const OUT = new Set(['publishing', 'processing', 'published', 'ambiguous', 'removed']);

export interface MovePlan {
  postId: string;
  moves: { variantId: string; at: string }[];
  skipped: { variantId: string; reason: MoveSkip }[];
}

// Each channel moves from the time the lists and the calendar show for it (effectiveAt).
export function planMove(post: BulkPost, move: BulkMove): MovePlan {
  const plan: MovePlan = { postId: post.id, moves: [], skipped: [] };
  for (const v of post.variants) {
    const skip: MoveSkip | null =
      v.status === 'cancelled' ? 'cancelled' : OUT.has(v.status) ? 'published' : v.status !== 'scheduled' || !v.effectiveAt ? 'unscheduled' : v.queueSlotAt ? 'queue' : null;
    if (skip) plan.skipped.push({ variantId: v.id, reason: skip });
    else plan.moves.push({ variantId: v.id, at: new Date(shiftTime(Date.parse(v.effectiveAt as string), move, post.timeZone)).toISOString() });
  }
  return plan;
}

export interface MovePostResult {
  postId: string;
  moved: { variantId: string; at: string }[];
  skipped: { variantId: string; reason: MoveSkip }[];
  refused: { variantId: string; error: unknown }[];
}

// One channel after another, as runBulk goes post by post: a refusal stops neither the post's other channels nor the
// other posts. progress counts the posts finished.
export async function runMove(
  posts: readonly BulkPost[],
  move: BulkMove,
  send: (request: { variantId: string; at: string }) => Promise<unknown>,
  progress?: (done: number, total: number) => void,
): Promise<MovePostResult[]> {
  const results: MovePostResult[] = [];
  for (const post of posts) {
    const plan = planMove(post, move);
    const result: MovePostResult = { postId: post.id, moved: [], skipped: plan.skipped, refused: [] };
    for (const m of plan.moves) {
      try {
        await send(m);
        result.moved.push(m);
      } catch (error) {
        result.refused.push({ variantId: m.variantId, error });
      }
    }
    results.push(result);
    progress?.(results.length, posts.length);
  }
  return results;
}

// The counts the result line shows: posts with a channel moved, posts with nothing to move, posts with a refusal.
export function moveSummary(results: readonly MovePostResult[]): { done: number; skipped: number; refused: number; channels: number } {
  return {
    done: results.filter((r) => r.moved.length > 0).length,
    skipped: results.filter((r) => r.moved.length === 0 && r.refused.length === 0).length,
    refused: results.filter((r) => r.refused.length > 0).length,
    channels: results.reduce((n, r) => n + r.moved.length, 0),
  };
}

// Labels and the assignee on many posts at once (#1057): one command per batch of up to SOCIAL_BULK_EDIT_MAX posts,
// each batch one transaction on the server, which answers with the posts it changed and each post it left out and why.
export const BULK_EDIT_MAX = SOCIAL_BULK_EDIT_MAX;

export interface LabelEdit {
  add: string[];
  remove: string[];
}

// A label picked to add, or to take off: picking it on one side drops it from the other, and picking it again unpicks it.
export function toggleEditLabel(edit: LabelEdit, side: keyof LabelEdit, labelId: string): LabelEdit {
  const drop = (ids: readonly string[]) => ids.filter((id) => id !== labelId);
  const flip = (ids: readonly string[]) => (ids.includes(labelId) ? drop(ids) : [...ids, labelId]);
  return side === 'add' ? { add: flip(edit.add), remove: drop(edit.remove) } : { add: drop(edit.add), remove: flip(edit.remove) };
}

// Something to do, each label once on one side, and no more than a post may carry.
export function validLabelEdit(edit: LabelEdit): boolean {
  if (edit.add.length + edit.remove.length === 0) return false;
  if (edit.add.length > MAX_LABELS_PER_POST || edit.remove.length > MAX_LABELS_PER_POST) return false;
  const all = [...edit.add, ...edit.remove];
  return new Set(all).size === all.length;
}

// The due date of an assignment: each post keeps its own, all get none, or all get this one.
export type DueEdit = { mode: 'keep' } | { mode: 'clear' } | { mode: 'set'; at: string | null };
export interface AssignEdit {
  assigneeUserId: string | null;
  due: DueEdit;
}

// The command's input apart from the posts, or null while a due date to set is missing.
export function assignInput(edit: AssignEdit): { assigneeUserId: string | null; dueAt?: string | null } | null {
  if (edit.due.mode === 'keep') return { assigneeUserId: edit.assigneeUserId };
  if (edit.due.mode === 'clear') return { assigneeUserId: edit.assigneeUserId, dueAt: null };
  return edit.due.at ? { assigneeUserId: edit.assigneeUserId, dueAt: edit.due.at } : null;
}

// The selection in batches the server takes, in the order shown.
export function editBatches(postIds: readonly string[], size = BULK_EDIT_MAX): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < postIds.length; i += size) out.push(postIds.slice(i, i + size));
  return out;
}

export interface EditAnswer {
  done: string[];
  skipped: { postId: string; reason: SocialBulkSkipReason }[];
}
export interface EditResult extends EditAnswer {
  // The posts of a batch the server refused as a whole (an assignee who left, a label deleted meanwhile), with why.
  refused: { postId: string; error: unknown }[];
}

// One batch after another; a batch refused as a whole does not stop the next, as runBulk goes on past a refusal.
// progress counts the posts sent.
export async function runEdit(postIds: readonly string[], send: (postIds: string[]) => Promise<EditAnswer>, progress?: (done: number, total: number) => void): Promise<EditResult> {
  const result: EditResult = { done: [], skipped: [], refused: [] };
  let sent = 0;
  for (const batch of editBatches(postIds)) {
    try {
      const answer = await send(batch);
      result.done.push(...answer.done);
      result.skipped.push(...answer.skipped);
    } catch (error) {
      result.refused.push(...batch.map((postId) => ({ postId, error })));
    }
    sent += batch.length;
    progress?.(sent, postIds.length);
  }
  return result;
}
