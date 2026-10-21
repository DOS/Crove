// Acting on many posts at once from the Social home lists (#635). Each post still goes through its own command, on
// what the list shows: one refused post does not stop the others, and the result says what was done and what was
// refused, with the reason.
import { localTime, zonedToEpoch } from '@crove/mod-social/contract';
import { CANCELLABLE } from './social.ts';

export type BulkAction = 'approve' | 'queue' | 'cancel' | 'move';
// The actions that send one command per post; a move sends one per channel (runMove).
export type PostAction = Exclude<BulkAction, 'move'>;

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
