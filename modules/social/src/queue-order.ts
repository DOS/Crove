// Reordering a channel's queue (#1020), as Buffer's "Shuffle queue" and "Move to top": social.queue.shuffle mixes the
// posts waiting in the queue (all of them, or those in a date range), social.queue.move_to_front puts one post first.
// Both only trade the slot times queued posts already hold, so the set of times stays the same and no slot is made or
// dropped (queue.ts). Owners and admins, as for moving a post's time (social.variant.reschedule), R2 and audited.
//
// A post moves only when it is scheduled in a slot after now with nothing else deciding its time:
// - in review, waiting for changes, a draft or paused on its channel, it keeps the slot it holds (the queue's rules);
// - one set for a time of its own or waiting out a rate limit (a fixed time) is not in the queue's order;
// - one already due is the publisher's, or waits out the org's publishing hold (#946), so it is held where it is;
// - a slot kept for a label (#745) goes only to posts with that label, and a post with a planned takedown (#861) takes
//   only a time its takedown still fits.
//
// Lock order: the publishing hold's lock shared (before any post, as the publish commands take it), the queue row,
// then the posts holding its slots (sorted), then their variants, as social.queue.set does. Two reorders of one queue
// run one after the other. Each move is written only while the variant still holds the time read under those locks
// (the expected-time guard of #956, for these commands): anything else refuses the whole command with STALE_REVISION.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { removeAtFit } from './domain/channels.ts';
import { moveToFront, shuffleTimes, slotLabel, type Holder } from './domain/queue.ts';
import { labelsOfPosts } from './labels.ts';
import { publishingHeld } from './publish-hold.ts';
import { SLOT_FREED, lockQueue, setVariant, settingsOf, type QueueState } from './variants.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
// The most posts one reorder moves; a longer queue is reordered a date range at a time.
export const MAX_REORDER = 1000;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

interface HolderRow {
  id: string;
  post_id: string;
  status: string;
  provider: string;
  settings: unknown;
  queue_slot_at: Date | null;
  scheduled_at: Date | null;
  error_retry_at: Date | null;
}

interface QueueHolder extends Holder {
  postId: string;
  provider: string;
  settings: Record<string, unknown>;
  labels: ReadonlySet<string>;
}

// The queue and every variant holding one of its slots, locked in the order above.
async function lockHolders(ctx: CommandContext, connectionId: string): Promise<{ queue: QueueState; rows: HolderRow[] }> {
  // The hold's lock first; its answer changes nothing here, since every variant it keeps is due and so stays put.
  await publishingHeld(ctx);
  const queue = await lockQueue(ctx.trx, ctx.orgId, connectionId);
  if (!queue) throw new DomainError('QUEUE_EMPTY', 409, 'Kênh này chưa có khung giờ đăng trong hàng đợi');
  // No new slot holder appears meanwhile: only schedule and social.queue.set assign slots, and both wait for the queue
  // row this command holds.
  const posts = await ctx.trx
    .selectFrom('crove_social.post_variant')
    .select('post_id')
    .distinct()
    .where('org_id', '=', ctx.orgId)
    .where('channel_connection_id', '=', connectionId)
    .where('queue_slot_at', 'is not', null)
    .where('status', 'not in', [...SLOT_FREED])
    .orderBy('post_id')
    .execute();
  if (posts.length === 0) return { queue, rows: [] };
  await ctx.trx
    .selectFrom('crove_social.post')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where(
      'id',
      'in',
      posts.map((p) => p.post_id),
    )
    .orderBy('id')
    .forUpdate()
    .execute();
  const rows = await ctx.trx
    .selectFrom('crove_social.post_variant')
    .select(['id', 'post_id', 'status', 'provider', 'settings', 'queue_slot_at', 'scheduled_at', 'error_retry_at'])
    .where('org_id', '=', ctx.orgId)
    .where('channel_connection_id', '=', connectionId)
    .where('queue_slot_at', 'is not', null)
    .where('status', 'not in', [...SLOT_FREED])
    .orderBy('queue_slot_at')
    .orderBy('id')
    .forUpdate()
    .execute();
  return { queue, rows };
}

// Why a holder keeps its time whatever the reorder does; null: it may move.
function stays(row: HolderRow, nowMs: number): string | null {
  if (row.status !== 'scheduled') return 'not_scheduled';
  if (row.scheduled_at !== null || row.error_retry_at !== null) return 'fixed_time';
  if ((row.queue_slot_at as Date).getTime() <= nowMs) return 'due';
  return null;
}

// The holders that may move, with what decides the times each may take. `within` narrows them to a range.
async function movable(ctx: CommandContext, queue: QueueState, rows: readonly HolderRow[], within: (at: number) => boolean) {
  const now = ctx.now.getTime();
  const candidates = rows.filter((r) => stays(r, now) === null && within((r.queue_slot_at as Date).getTime()));
  if (candidates.length > MAX_REORDER) {
    throw new DomainError('QUEUE_TOO_LONG', 422, `Mỗi lần chỉ sắp xếp lại được tối đa ${MAX_REORDER} bài; hãy chọn khoảng ngày ngắn hơn`, { limit: MAX_REORDER, actual: candidates.length });
  }
  const labelsOf = await labelsOfPosts(ctx.trx, ctx.orgId, [...new Set(candidates.map((r) => r.post_id))]);
  // Each time's slot label, read once: every time handed out is one of these.
  const labelAt = new Map(candidates.map((r) => [(r.queue_slot_at as Date).getTime(), slotLabel(queue.spec, (r.queue_slot_at as Date).getTime())]));
  const fits = (h: QueueHolder, at: number) => {
    const label = labelAt.get(at);
    if (label === undefined) return false;
    if (label !== null && !h.labels.has(label)) return false;
    return removeAtFit(h.provider, h.settings, new Date(at)) === null;
  };
  const holders = candidates
    .map(
      (r): QueueHolder => ({
        id: r.id,
        at: (r.queue_slot_at as Date).getTime(),
        postId: r.post_id,
        provider: r.provider,
        settings: settingsOf(r),
        labels: new Set((labelsOf.get(r.post_id) ?? []).map((l) => l.id)),
      }),
    )
    // A post that may not use the slot it holds (no longer a slot, its label taken off) waits for social.queue.set to
    // place it; a reorder leaves it there.
    .filter((h) => fits(h, h.at));
  return { holders, fits };
}

export interface QueueMove {
  variantId: string;
  postId: string;
  from: string;
  at: string;
}

// Writes the new times: every moved variant leaves its slot first, then takes its new one, so two posts trading slots
// never meet on the unique slot index. A variant whose time is no longer the one read refuses the whole command.
async function applyMoves(ctx: CommandContext, holders: readonly QueueHolder[], next: ReadonlyMap<string, number>): Promise<QueueMove[]> {
  const moves = holders.filter((h) => next.get(h.id) !== h.at).map((h) => ({ holder: h, at: next.get(h.id) as number }));
  for (const { holder } of moves) {
    const cleared = await ctx.trx
      .updateTable('crove_social.post_variant')
      .set({ queue_slot_at: null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', holder.id)
      .where('status', '=', 'scheduled')
      .where('queue_slot_at', '=', new Date(holder.at))
      .executeTakeFirst();
    if (cleared.numUpdatedRows !== 1n) {
      throw new DomainError('STALE_REVISION', 409, 'Hàng đợi vừa thay đổi ở nơi khác, hãy tải lại rồi thử lại', { variantId: holder.id });
    }
  }
  for (const { holder, at } of moves) await setVariant(ctx, holder.id, { queue_slot_at: new Date(at) });
  return moves
    .map(({ holder, at }) => ({ variantId: holder.id, postId: holder.postId, from: new Date(holder.at).toISOString(), at: new Date(at).toISOString() }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

const zInstant = z.iso.datetime({ offset: true });

export const queueShuffle = defineCommand({
  name: 'social.queue.shuffle',
  input: z
    .strictObject({ connectionId: zId, from: zInstant.optional(), to: zInstant.optional() })
    .refine((x) => !x.from || !x.to || Date.parse(x.from) < Date.parse(x.to), 'the range ends after it starts'),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { queue, rows } = await lockHolders(ctx, input.connectionId);
    const from = input.from ? Date.parse(input.from) : -Infinity;
    const to = input.to ? Date.parse(input.to) : Infinity;
    const { holders, fits } = await movable(ctx, queue, rows, (at) => at >= from && at <= to);
    const moved = await applyMoves(ctx, holders, shuffleTimes(holders, fits));
    ctx.audit({
      connection_id: input.connectionId,
      from: input.from ?? null,
      to: input.to ?? null,
      moved: moved.length,
      post_ids: moved.map((m) => m.postId),
      variant_ids: moved.map((m) => m.variantId),
    });
    return { queueId: queue.id, moved };
  },
});

export const queueMoveToFront = defineCommand({
  name: 'social.queue.move_to_front',
  // expectedAt: the slot time the person saw; the move is refused when the post's time changed since.
  input: z.strictObject({ variantId: zId, expectedAt: zInstant.optional() }),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const found = await ctx.trx.selectFrom('crove_social.post_variant').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('id', '=', input.variantId).executeTakeFirst();
    if (!found) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
    const { queue, rows } = await lockHolders(ctx, found.channel_connection_id);
    const row = rows.find((r) => r.id === input.variantId);
    if (input.expectedAt !== undefined && row?.queue_slot_at?.getTime() !== Date.parse(input.expectedAt)) {
      throw new DomainError('STALE_REVISION', 409, 'Giờ đăng của bài đã đổi sau khi bạn xem, hãy tải lại', { variantId: input.variantId });
    }
    if (!row || stays(row, ctx.now.getTime()) !== null) {
      throw new DomainError('VARIANT_STATE', 409, 'Chỉ đưa lên đầu được bài đã lên lịch và đang chờ khung giờ trong hàng đợi', { variantId: input.variantId, reason: row ? stays(row, ctx.now.getTime()) : 'not_queued' });
    }
    // Only the posts up to this one can move (each passed post goes one place later), so a long queue after it does not
    // count toward the limit.
    const targetAt = (row.queue_slot_at as Date).getTime();
    const { holders, fits } = await movable(ctx, queue, rows, (at) => at <= targetAt);
    if (!holders.some((h) => h.id === row.id)) {
      throw new DomainError('VARIANT_STATE', 409, 'Bài này không còn hợp với khung giờ đang giữ; hãy lưu lại hàng đợi để bài được xếp lại', { variantId: row.id, reason: 'misplaced' });
    }
    const moved = await applyMoves(ctx, holders, moveToFront(holders, row.id, fits));
    ctx.audit({
      connection_id: found.channel_connection_id,
      target_variant_id: row.id,
      moved: moved.length,
      post_ids: moved.map((m) => m.postId),
      variant_ids: moved.map((m) => m.variantId),
    });
    return { queueId: queue.id, moved };
  },
});

// The audited reorders, for the post's timeline (activity.ts): each one names the posts it moved.
export const QUEUE_ORDER_COMMANDS = [queueShuffle.name, queueMoveToFront.name];
export const queueOrderCommands = [queueShuffle, queueMoveToFront];

// How an audited reorder moved a variant, for its timeline: shuffled, put first, or moved one place later by another
// post put first.
export const reorderCode = (command: string, detail: { target_variant_id?: unknown }, variantId: string): 'shuffle' | 'front' | 'shifted' =>
  command === queueShuffle.name ? 'shuffle' : detail.target_variant_id === variantId ? 'front' : 'shifted';
