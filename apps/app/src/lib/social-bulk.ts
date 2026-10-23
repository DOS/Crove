// Acting on many posts at once from the Social home lists (#635). Each post still goes through its own command, on
// what the list shows: one refused post does not stop the others, and the result says what was done and what was
// refused, with the reason. Sending drafts to review (#1178) works the same way, post by post.
import { SOCIAL_BULK_EDIT_MAX, SOCIAL_BULK_REPLACE_MAX, SOCIAL_REPLACE_FIND_MAX, SOCIAL_REPLACE_WITH_MAX, type SocialBulkSkipReason, type SocialReplaceField } from '@crove/kernel-contract';
import type { IssueCode } from '@crove/mod-social/contract';
import { localTime, zonedToEpoch } from '@crove/mod-social/contract';
import { CANCELLABLE } from './social.ts';
import { MAX_LABELS_PER_POST } from './social-labels.ts';

export type BulkAction = 'approve' | 'submit' | 'queue' | 'cancel' | 'move' | 'labels' | 'assign' | 'replace' | 'addChannel';
// The edits the server makes for many posts in one command: labels and the assignee (#1057), find and replace (#1144),
// a channel added (#1178).
export type EditAction = 'labels' | 'assign' | 'replace' | 'addChannel';
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
// What social.post.submit sends to review by default (#1178): drafts and channels sent back.
const SUBMITTABLE = ['draft', 'changes_requested', 'rejected'];

export type BulkRequest =
  | { action: 'approve'; postId: string; variants: { variantId: string; revision: number; contentHash: string }[] }
  | { action: 'submit'; postId: string }
  | { action: 'queue'; postId: string; variantIds: string[] }
  | { action: 'cancel'; postId: string; variantIds: string[] };

// The request for one post, or null when the post has nothing the action applies to.
export function bulkRequest(post: BulkPost, action: PostAction, canDecide: boolean): BulkRequest | null {
  if (action === 'approve') {
    if (!canDecide) return null;
    const variants = post.variants.filter((v) => v.status === 'in_review').map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
    return variants.length > 0 ? { action, postId: post.id, variants } : null;
  }
  // Members and above; the server sends the channels the member may use (#1081).
  if (action === 'submit') return post.variants.some((v) => SUBMITTABLE.includes(v.status)) ? { action, postId: post.id } : null;
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

// Drafts sent to review in bulk (#1178): runBulk's answer, with the posts the server refused for a reason the person
// can fix told apart: nothing left to send (NOTHING_TO_SUBMIT counts as nothing to do), channels that do not fit their
// rules yet (VARIANT_INVALID, with each channel's issues) and a blocked word (BANNED_WORDS, with the words).
export interface SubmitIssue {
  code: IssueCode;
  field: string;
  limit: number | null;
  actual: number | null;
}
export interface SubmitResult extends BulkResult {
  invalid: { postId: string; variants: { variantId: string; issues: SubmitIssue[] }[] }[];
  blocked: { postId: string; phrases: string[] }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function submitResult(result: BulkResult): SubmitResult {
  const out: SubmitResult = { done: result.done, skipped: [...result.skipped], refused: [], invalid: [], blocked: [] };
  for (const r of result.refused) {
    const e = isRecord(r.error) ? r.error : {};
    const variants = isRecord(e.data) && Array.isArray(e.data.variants) ? e.data.variants.filter(isRecord) : [];
    if (e.code === 'NOTHING_TO_SUBMIT') out.skipped.push(r.postId);
    else if (e.code === 'VARIANT_INVALID' && variants.length > 0) {
      out.invalid.push({
        postId: r.postId,
        variants: variants.map((v) => ({
          variantId: String(v.variantId ?? ''),
          issues: (Array.isArray(v.issues) ? v.issues.filter(isRecord) : []).map((i) => ({
            code: String(i.code ?? '') as IssueCode,
            field: String(i.field ?? ''),
            limit: typeof i.limit === 'number' ? i.limit : null,
            actual: typeof i.actual === 'number' ? i.actual : null,
          })),
        })),
      });
    } else if (e.code === 'BANNED_WORDS') {
      const words = variants.flatMap((v) => (Array.isArray(v.words) ? v.words.filter(isRecord) : []));
      out.blocked.push({ postId: r.postId, phrases: [...new Set(words.map((w) => w.phrase).filter((x): x is string => typeof x === 'string'))] });
    } else out.refused.push(r);
  }
  return out;
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
export function editBatches(postIds: readonly string[], size: number = BULK_EDIT_MAX): string[][] {
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
export async function runEdit(
  postIds: readonly string[],
  send: (postIds: string[]) => Promise<EditAnswer>,
  progress?: (done: number, total: number) => void,
  size: number = BULK_EDIT_MAX,
): Promise<EditResult> {
  const result: EditResult = { done: [], skipped: [], refused: [] };
  let sent = 0;
  for (const batch of editBatches(postIds, size)) {
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

// One channel added to the selected posts (#1178), in batches of up to SOCIAL_BULK_EDIT_MAX posts: the server's answer
// for each batch, and per channel added what its rules still miss.
export interface AddedChannel {
  postId: string;
  variantId: string;
  issues: SubmitIssue[];
}
export interface AddChannelResult extends EditResult {
  added: AddedChannel[];
}

export async function runAddChannel(
  postIds: readonly string[],
  send: (postIds: string[]) => Promise<EditAnswer & { added: { postId: string; variantId: string; issues: { code: string; field: string; limit: number | null; actual: number | null }[] }[] }>,
  progress?: (done: number, total: number) => void,
): Promise<AddChannelResult> {
  const added: AddedChannel[] = [];
  const result = await runEdit(
    postIds,
    async (batch) => {
      const answer = await send(batch);
      added.push(...answer.added.map((a) => ({ ...a, issues: a.issues.map((i) => ({ ...i, code: i.code as IssueCode })) })));
      return answer;
    },
    progress,
  );
  return { ...result, added };
}

// The channels added that already fit their rules, and those that need edits before review.
export const addedSummary = (added: readonly AddedChannel[]): { fits: number; needsEdits: number } => {
  const needsEdits = added.filter((a) => a.issues.length > 0).length;
  return { fits: added.length - needsEdits, needsEdits };
};

// Find and replace across the selected posts (#1144): the server previews, per post, where the text matches and why a
// post would be left out, then replaces in batches of up to SOCIAL_BULK_REPLACE_MAX posts. The pattern is plain text.
export const BULK_REPLACE_MAX = SOCIAL_BULK_REPLACE_MAX;
export const REPLACE_FIND_MAX = SOCIAL_REPLACE_FIND_MAX;
export const REPLACE_WITH_MAX = SOCIAL_REPLACE_WITH_MAX;

export interface ReplaceEdit {
  find: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export const validReplace = (edit: ReplaceEdit): boolean => edit.find.length > 0 && edit.find.length <= REPLACE_FIND_MAX && edit.replace.length <= REPLACE_WITH_MAX;

export interface ReplaceMatch {
  variantId: string | null;
  connectionId: string | null;
  field: SocialReplaceField;
  count: number;
  before: string;
  match: string;
  after: string;
}
export interface ReplacePreviewPost {
  postId: string;
  skip: SocialBulkSkipReason | null;
  matches: ReplaceMatch[];
}

// The preview of every post, batch after batch, in the order the server answers (by id within a batch).
export async function runReplacePreview(
  postIds: readonly string[],
  send: (postIds: string[]) => Promise<{ posts: ReplacePreviewPost[] }>,
  progress?: (done: number, total: number) => void,
): Promise<ReplacePreviewPost[]> {
  const out: ReplacePreviewPost[] = [];
  let sent = 0;
  for (const batch of editBatches(postIds, BULK_REPLACE_MAX)) {
    out.push(...(await send(batch)).posts);
    sent += batch.length;
    progress?.(sent, postIds.length);
  }
  return out;
}

// The posts that would change and their matches, and the posts left as they are.
export function previewSummary(posts: readonly ReplacePreviewPost[]): { changes: number; matches: number; skipped: number } {
  const changing = posts.filter((p) => p.skip === null);
  return { changes: changing.length, matches: changing.reduce((n, p) => n + p.matches.reduce((m, x) => m + x.count, 0), 0), skipped: posts.length - changing.length };
}

// What a preview was made for: another search, replacement, option or selection needs a new preview first.
export const replaceKey = (edit: ReplaceEdit, postIds: readonly string[]): string => JSON.stringify([edit.find, edit.replace, edit.caseSensitive, edit.wholeWord, [...postIds].sort()]);
