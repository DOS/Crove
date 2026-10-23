// The Social board (#1022): the posts of the Social home's list, in a column per status, and the moves a person may
// make between columns by drag or keyboard. Each legal move is one existing command; any other drop is refused here,
// with its reason, and never reaches the server. Who may approve what (four-eyes, several approvals, the client's
// approval) is still the server's call: a refusal it gives is shown as it is.
import type { VariantStatus } from './social.ts';

export const BOARD_COLUMNS = ['draft', 'in_review', 'approved', 'scheduled', 'published', 'failed'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

// The column of each channel status. A channel sent back for changes or rejected waits on its writer again, so it is a
// draft; a channel on its way out (publishing, the platform processing it, its outcome being checked) or held by its
// channel (paused) still counts as scheduled. Cancelled and removed channels are history and place nothing.
const VARIANT_COLUMN: Readonly<Record<VariantStatus, BoardColumn | null>> = {
  draft: 'draft',
  changes_requested: 'draft',
  rejected: 'draft',
  in_review: 'in_review',
  approved: 'approved',
  scheduled: 'scheduled',
  paused: 'scheduled',
  publishing: 'scheduled',
  processing: 'scheduled',
  ambiguous: 'scheduled',
  published: 'published',
  failed: 'failed',
  needs_attention: 'failed',
  cancelled: null,
  removed: null,
};

export function variantColumn(status: string): BoardColumn | null {
  return Object.hasOwn(VARIANT_COLUMN, status) ? VARIANT_COLUMN[status as VariantStatus] : null;
}

// The column of a post, from its channels: one that failed or needs a person puts the post under Failed; one in review
// puts it under In review, as the Review list counts it; otherwise the least advanced channel decides, so a post half
// published stays where its remaining channels are. A post with no channel is a draft; one whose channels were all
// cancelled or removed is not on the board.
export function postColumn(variants: readonly { status: string }[]): BoardColumn | null {
  if (variants.length === 0) return 'draft';
  const columns = variants.map((v) => variantColumn(v.status)).filter((c): c is BoardColumn => c !== null);
  if (columns.length === 0) return null;
  if (columns.includes('failed')) return 'failed';
  if (columns.includes('in_review')) return 'in_review';
  return BOARD_COLUMNS.find((c) => columns.includes(c)) ?? null;
}

// The moves a drop may make, each the command of the same name elsewhere in the app:
// submit: social.post.submit (Send for review), members and above;
// approve: social.variant.decide with approved, owners and admins; four-eyes and multi-step approval are the server's;
// request_changes: social.variant.decide with changes_requested (back to draft), owners and admins;
// schedule: social.variant.schedule, at the post's planned time or in each channel's queue, owners and admins;
// unschedule: social.variant.unschedule (back to approved), owners and admins.
export type BoardMove = 'submit' | 'approve' | 'request_changes' | 'schedule' | 'unschedule';

export const MOVE_COMMAND: Readonly<Record<BoardMove, string>> = {
  submit: 'social.post.submit',
  approve: 'social.variant.decide',
  request_changes: 'social.variant.decide',
  schedule: 'social.variant.schedule',
  unschedule: 'social.variant.unschedule',
};

const DECIDERS_ONLY: ReadonlySet<BoardMove> = new Set(['approve', 'request_changes', 'schedule', 'unschedule']);

// Why a drop is refused before any call (social.board.refused.*).
export type BoardRefusal =
  // The viewer may only look.
  | 'readonly'
  // Only owners and admins approve, ask for changes, schedule and unschedule.
  | 'admins'
  // A draft goes to review before it is approved or scheduled.
  | 'notReviewed'
  // A post in review is approved before it is scheduled.
  | 'notApproved'
  // An approved or scheduled post goes back to draft by an edit of its content, which needs a new approval.
  | 'editToDraft'
  // An approved or scheduled post was reviewed already; an edit sends it back.
  | 'alreadyApproved'
  // Crove publishes at the scheduled time; nobody marks a post published by hand.
  | 'toPublished'
  // Only a platform's refusal puts a post under Failed.
  | 'toFailed'
  // A published post is history; reposting or removing it is on its page.
  | 'fromPublished'
  // A failed channel is retried or cancelled on the post's page.
  | 'fromFailed'
  // None of the post's channels is in the state the move needs (a channel on its way out, say).
  | 'nothing'
  // A channel in review has a review checklist (#1105), which is ticked on the post's page.
  | 'checklist';

// From one column to another: the move, or why not. Same-column drops are no move at all (null).
const MOVES: Readonly<Record<BoardColumn, Partial<Record<BoardColumn, BoardMove | BoardRefusal>>>> = {
  draft: { in_review: 'submit', approved: 'notReviewed', scheduled: 'notReviewed' },
  in_review: { draft: 'request_changes', approved: 'approve', scheduled: 'notApproved' },
  approved: { draft: 'editToDraft', in_review: 'alreadyApproved', scheduled: 'schedule' },
  scheduled: { draft: 'editToDraft', in_review: 'alreadyApproved', approved: 'unschedule' },
  published: {},
  failed: {},
};

const isMove = (x: BoardMove | BoardRefusal): x is BoardMove => x in MOVE_COMMAND;

export type MoveCheck = { ok: true; move: BoardMove } | { ok: false; reason: BoardRefusal };

// Whether a post may go from one column to another for this viewer (canWrite: member and above; canDecide: owner or
// admin). null: the same column, nothing to do.
export function checkMove(from: BoardColumn, to: BoardColumn, who: { canWrite: boolean; canDecide: boolean }): MoveCheck | null {
  if (from === to) return null;
  if (!who.canWrite) return { ok: false, reason: 'readonly' };
  const entry = from === 'published' ? 'fromPublished' : from === 'failed' ? 'fromFailed' : to === 'published' ? 'toPublished' : to === 'failed' ? 'toFailed' : MOVES[from][to];
  if (entry === undefined) return { ok: false, reason: 'nothing' };
  if (!isMove(entry)) return { ok: false, reason: entry };
  if (DECIDERS_ONLY.has(entry) && !who.canDecide) return { ok: false, reason: 'admins' };
  return { ok: true, move: entry };
}

// The legal moves from a column for this viewer, for the card's buttons: each with the column it leads to.
export function movesFrom(from: BoardColumn, who: { canWrite: boolean; canDecide: boolean }): { move: BoardMove; to: BoardColumn }[] {
  const out: { move: BoardMove; to: BoardColumn }[] = [];
  for (const to of BOARD_COLUMNS) {
    const check = checkMove(from, to, who);
    if (check?.ok) out.push({ move: check.move, to });
  }
  return out;
}

// The next column left or right, for the keyboard (the arrow keys move a card one column); null past either end.
export function adjacentColumn(from: BoardColumn, step: -1 | 1): BoardColumn | null {
  return BOARD_COLUMNS[BOARD_COLUMNS.indexOf(from) + step] ?? null;
}

export interface BoardVariant {
  id: string;
  status: string;
  revision: number;
  contentHash: string;
  // The review checklist of its channel (#1105); absent or empty without one.
  checklist?: readonly unknown[];
}

// Whether approving the post needs the review checklist (#1105) ticked, which the board cannot do: some channel in
// review has items.
export const needsChecklist = (post: BoardPost): boolean => post.variants.some((v) => v.status === 'in_review' && (v.checklist?.length ?? 0) > 0);
export interface BoardPost {
  id: string;
  // The post's planned time, if any: a drop on Scheduled uses it when it is still ahead, else the channels' queues.
  scheduledAt: string | null;
  variants: readonly BoardVariant[];
}

export type BoardRequest =
  | { move: 'submit'; postId: string }
  | { move: 'approve' | 'request_changes'; postId: string; variants: { variantId: string; revision: number; contentHash: string }[] }
  | { move: 'schedule'; postId: string; variantIds: string[]; queue: boolean }
  | { move: 'unschedule'; variantIds: string[] };

// The request a move sends for a post, from what the board shows; null when no channel of the post is in the state
// the move needs. Each names the revision and content the viewer saw, so a post changed meanwhile is refused as stale.
export function boardRequest(post: BoardPost, move: BoardMove, now: number): BoardRequest | null {
  const having = (...statuses: string[]) => post.variants.filter((v) => statuses.includes(v.status));
  switch (move) {
    case 'submit':
      // The server sends every channel that can go: drafts, and those sent back or rejected.
      return having('draft', 'changes_requested', 'rejected').length > 0 ? { move, postId: post.id } : null;
    case 'approve':
    case 'request_changes': {
      const variants = having('in_review').map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
      return variants.length > 0 ? { move, postId: post.id, variants } : null;
    }
    case 'schedule': {
      const variantIds = having('approved').map((v) => v.id);
      const planned = post.scheduledAt !== null && Date.parse(post.scheduledAt) > now;
      return variantIds.length > 0 ? { move, postId: post.id, variantIds, queue: !planned } : null;
    }
    case 'unschedule': {
      const variantIds = having('scheduled', 'paused').map((v) => v.id);
      return variantIds.length > 0 ? { move, variantIds } : null;
    }
  }
}

// The calls a request is sent through: the app's client, or a fake in tests.
export interface BoardApi {
  submit: (input: { postId: string }) => Promise<unknown>;
  decide: (input: { postId: string; decision: 'approved' | 'changes_requested'; variants: { variantId: string; revision: number; contentHash: string }[] }) => Promise<unknown>;
  schedule: (input: { postId: string; variantIds: string[]; queue?: true }) => Promise<unknown>;
  unschedule: (input: { variantIds: string[] }) => Promise<unknown>;
}

// What the server answered, for the announcement: waiting lists the channels an approval left in review (another
// approval or the client's is still needed).
export interface BoardOutcome {
  move: BoardMove;
  waiting: number;
}

export async function sendBoardRequest(request: BoardRequest, api: BoardApi): Promise<BoardOutcome> {
  switch (request.move) {
    case 'submit':
      await api.submit({ postId: request.postId });
      return { move: request.move, waiting: 0 };
    case 'approve':
    case 'request_changes': {
      const answer = await api.decide({ postId: request.postId, decision: request.move === 'approve' ? 'approved' : 'changes_requested', variants: request.variants });
      const waiting = (answer as { waiting?: unknown } | null)?.waiting;
      return { move: request.move, waiting: Array.isArray(waiting) ? waiting.length : 0 };
    }
    case 'schedule':
      // Without queue, the server schedules at the post's planned time.
      await api.schedule({ postId: request.postId, variantIds: request.variantIds, ...(request.queue ? { queue: true as const } : {}) });
      return { move: request.move, waiting: 0 };
    case 'unschedule':
      await api.unschedule({ variantIds: request.variantIds });
      return { move: request.move, waiting: 0 };
  }
}
