// Reminders of a post's due date for its assignee (#1359): one when the due date is less than 24 hours away, one when
// it has passed and the post is not out yet (an in-app notification, assignment_due, also mailed and pushed). Each
// goes once per due date and assignee: social.post.assign (single or bulk) clears the marks when either changes. None
// for a post that is out (published, partly published or going out), cancelled or archived (#1299), none for an
// assignee who left the org or whose account is disabled, and none of a post outside a limited assignee's channels
// (#1081). The worker finds the posts due (crove_social.assignment_reminders_due) and runs social.post.remind_due for
// each, which checks again under the post lock, sets the mark and emits the event the notification dispatch turns into
// the assignee's item.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db, SocialPostStatus } from '@crove/db';
import { DomainError, defineCommand, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { postsVisibleTo } from './channel-access.ts';

const ACTOR: SystemActor = { type: 'system', component: 'social.assign_reminders' };
// How many posts the worker takes per pass; it runs with the review reminders, every REMINDER_SWEEP_MS.
export const ASSIGNMENT_REMINDER_LIMIT = 200;
// A due date this close is reminded of once.
export const DUE_SOON_MS = 24 * 3_600_000;
// The posts still to be moved along: the same list as crove_social.assignment_reminders_due.
export const REMINDED_POST_STATUSES: readonly SocialPostStatus[] = ['draft', 'scheduled', 'failed'];

export type AssignmentReminderStage = 'soon' | 'overdue';

export interface AssignmentReminderState {
  dueAt: Date | null;
  soonRemindedAt: Date | null;
  overdueRemindedAt: Date | null;
}

// Which reminder a post's assignee has due now, if any; the same rule as assignment_reminders_due. One at a time: past
// the due date only the overdue one.
export function assignmentReminderDue(s: AssignmentReminderState, now: Date): AssignmentReminderStage | null {
  if (!s.dueAt) return null;
  const due = s.dueAt.getTime();
  const t = now.getTime();
  if (due <= t) return s.overdueRemindedAt === null ? 'overdue' : null;
  return s.soonRemindedAt === null && due <= t + DUE_SOON_MS ? 'soon' : null;
}

export const postRemindDue = defineCommand({
  name: 'social.post.remind_due',
  input: z.strictObject({ postId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input): Promise<{ stage: AssignmentReminderStage | null }> => {
    // Under the post lock, so an assignment, a publish or an archive in flight is either seen or comes after.
    const post = await ctx.trx
      .selectFrom('crove_social.post')
      .select(['id', 'status', 'archived_at', 'assignee_user_id', 'due_at', 'due_soon_reminded_at', 'overdue_reminded_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .forUpdate()
      .executeTakeFirst();
    if (!post?.assignee_user_id || !post.due_at || post.archived_at !== null || !REMINDED_POST_STATUSES.includes(post.status as SocialPostStatus)) return { stage: null };
    const stage = assignmentReminderDue({ dueAt: post.due_at, soonRemindedAt: post.due_soon_reminded_at, overdueRemindedAt: post.overdue_reminded_at }, ctx.now);
    if (!stage) return { stage: null };
    const assignee = post.assignee_user_id;
    // A member now, with an account that is not disabled (member_emails leaves the others out, #1115). The scan leaves
    // them out too, so nothing is marked and a returning member's reminder still comes.
    const { rows: active } = await sql<{ user_id: string }>`SELECT user_id FROM crove_kernel.member_emails(${[assignee]}::uuid[])`.execute(ctx.trx);
    if (active.length === 0) return { stage: null };
    // Marked whatever follows, so the scan moves past it.
    await ctx.trx
      .updateTable('crove_social.post')
      .set((eb) => ({
        due_soon_reminded_at: eb.fn.coalesce('due_soon_reminded_at', eb.val(ctx.now)),
        ...(stage === 'overdue' ? { overdue_reminded_at: ctx.now } : {}),
      }))
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', post.id)
      .execute();
    // A limited assignee (#1081) is reminded only of a post on one of their channels.
    if ((await postsVisibleTo(ctx.trx, ctx.orgId, assignee, [post.id])).length === 0) {
      ctx.audit({ post_id: post.id, stage, out_of_scope: true });
      return { stage: null };
    }
    await ctx.emit('social.post.due_reminder', { post_id: post.id, assignee_user_id: assignee, stage, due_at: post.due_at.toISOString() });
    return { stage };
  },
});

// One pass: each post with a reminder due gets it.
export async function sweepAssignmentReminders(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; post_id: string }>`SELECT org_id, post_id FROM crove_social.assignment_reminders_due(${ASSIGNMENT_REMINDER_LIMIT}::int)`.execute(deps.workerDb);
  let sent = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ stage: AssignmentReminderStage | null }>('social.post.remind_due', { postId: row.post_id }, { actor: ACTOR, orgId: row.org_id });
      if (done.stage) sent += 1;
    } catch (error) {
      console.warn(`[social-assign-reminders] post ${row.post_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    }
  }
  return sent;
}

export const assignReminderCommands = [postRemindDue];
