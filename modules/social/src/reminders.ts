// Reminders for posts waiting for review (#703): a post whose review has waited 24 hours, or whose time is less than
// 24 hours away while it still waits, reminds its reviewers once per round of review (an in-app notification,
// review_reminder). The round starts when a variant goes into review (review_since, set by the database); a channel's
// review policy can turn the reminders off. The worker finds the posts due (review_reminders_due) and runs
// social.review.remind for each, which checks again under the post lock, marks the variants and emits the event the
// notification dispatch turns into one item per reviewer.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db } from '@crove/db';
import { DomainError, defineCommand, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { lockPost } from './variants.ts';

const ACTOR: SystemActor = { type: 'system', component: 'social.reminders' };
// How often the worker looks for reminders due, and how many posts it takes per pass.
export const REMINDER_SWEEP_MS = 15 * 60_000;
export const REMINDER_LIMIT = 200;
// A review that has waited this long is reminded; a post this close to its time is reminded again.
export const REMIND_AFTER_MS = 24 * 3_600_000;
export const REMIND_BEFORE_MS = 24 * 3_600_000;

export type ReminderStage = 'waiting' | 'due';

export interface ReminderVariant {
  reviewSince: Date | null;
  remindedWaitingAt: Date | null;
  remindedDueAt: Date | null;
  // The time it goes out at: its queue slot, its own time or the post's.
  at: Date | null;
}

// Which reminders a variant in review has due now; the same rule as review_reminders_due.
export function remindersDue(v: ReminderVariant, now: Date): { waiting: boolean; due: boolean } {
  if (!v.reviewSince) return { waiting: false, due: false };
  const since = v.reviewSince.getTime();
  const t = now.getTime();
  const waiting = v.remindedWaitingAt === null && since <= t - REMIND_AFTER_MS;
  const at = v.at?.getTime() ?? null;
  const due = v.remindedDueAt === null && at !== null && at > t && at <= t + REMIND_BEFORE_MS && since < at - REMIND_BEFORE_MS;
  return { waiting, due };
}

export const reviewRemind = defineCommand({
  name: 'social.review.remind',
  input: z.strictObject({ postId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input): Promise<{ stage: ReminderStage | null }> => {
    // Under the post lock, so a decision or an edit in flight is either seen or comes after.
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId).catch((error: unknown) => {
      if (error instanceof DomainError && error.code === 'POST_NOT_FOUND') return null;
      throw error;
    });
    if (!post) return { stage: null };
    const { rows } = await sql<{ id: string; review_since: Date | null; reminded_waiting_at: Date | null; reminded_due_at: Date | null; at: Date | null }>`
      SELECT v.id, v.review_since, v.reminded_waiting_at, v.reminded_due_at, coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) AS at
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      LEFT JOIN crove_social.channel_policy cp ON cp.org_id = v.org_id AND cp.channel_connection_id = v.channel_connection_id
      WHERE v.org_id = ${ctx.orgId} AND v.post_id = ${post.id} AND v.status = 'in_review' AND coalesce(cp.review_reminders, true)
      ORDER BY v.id`.execute(ctx.trx);
    const due = rows.map((r) => ({ id: r.id, ...remindersDue({ reviewSince: r.review_since, remindedWaitingAt: r.reminded_waiting_at, remindedDueAt: r.reminded_due_at, at: r.at }, ctx.now) }));
    const touched = due.filter((d) => d.waiting || d.due);
    if (touched.length === 0) return { stage: null };
    // One reminder at a time: the closer time says more than the wait.
    const stage: ReminderStage = touched.some((d) => d.due) ? 'due' : 'waiting';
    for (const d of touched) {
      await ctx.trx
        .updateTable('crove_social.post_variant')
        .set({ ...(d.waiting ? { reminded_waiting_at: ctx.now } : {}), ...(d.due ? { reminded_due_at: ctx.now } : {}) })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', d.id)
        .execute();
    }
    await ctx.emit('social.review.reminder', { post_id: post.id, stage, variant_ids: touched.map((d) => d.id) });
    return { stage };
  },
});

// One pass: each post with a reminder due gets it.
export async function sweepReminders(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; post_id: string }>`SELECT org_id, post_id FROM crove_social.review_reminders_due(${REMINDER_LIMIT}::int)`.execute(deps.workerDb);
  let sent = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ stage: ReminderStage | null }>('social.review.remind', { postId: row.post_id }, { actor: ACTOR, orgId: row.org_id });
      if (done.stage) sent += 1;
    } catch (error) {
      console.warn(`[social-reminders] post ${row.post_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
    }
  }
  return sent;
}

export const reminderCommands = [reviewRemind];
