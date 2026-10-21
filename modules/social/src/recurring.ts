// Recurring posts (#979, Publer's "Recurring", kept apart from evergreen recycling): a post repeats every 1 to 4 weeks
// on chosen weekdays at a local time, until a date or for a number of copies. Setting the rule on a post makes it the
// series (social.post.recurrence_set, for those who may write posts); the worker then makes each next copy through the
// repost path once the previous one is done, planned for its occurrence and sent to review, so a person approves and
// schedules every copy. One copy at a time: none is made while the last is still open (any channel of it not yet
// published, failed, cancelled or removed), nor while the org's publishing is held (#946).
//
// The series keeps its own state on the post: recurrence_last_at, the occurrence of the last copy (its phase: every
// second week stays every second week), recurrence_count, the copies of this run, and recurrence_next_at, the next
// occurrence as last computed, for the scan. An occurrence that went by while a copy waited is skipped, never made
// late; a series whose end came, or whose channels are all disconnected for good, ends (its rule is cleared, its
// count kept). A copy repeats what the series post went out with; to change the text, start a new series.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zSocialRecurrence } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { localDate, nextOccurrence, parseRecurrence, type Recurrence } from './domain/recurrence.ts';
import { repostCopy } from './evergreen.ts';
import { publishingHeld } from './publish-hold.ts';
import { lockPost } from './variants.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const RECURRING_SWEEP_MS = 60 * 60_000;
// How far ahead a copy is made: the week before its occurrence, so reviewers have the week. crove_social.recurring_due
// uses the same 7 days.
export const RECURRING_HORIZON_MS = 7 * 86_400_000;
const ACTOR: SystemActor = { type: 'system', component: 'social.recurring' };
// A copy's channel in one of these is done; any other status holds the next copy back.
export const COPY_DONE = ['published', 'failed', 'cancelled', 'removed'] as const;

interface SeriesRow {
  recurrence: unknown;
  recurrence_count: number;
  recurrence_last_at: Date | null;
  recurrence_source_id: string | null;
  evergreen_days: number | null;
  time_zone: string;
}

async function seriesOf(ctx: CommandContext, postId: string): Promise<SeriesRow> {
  return ctx.trx
    .selectFrom('crove_social.post')
    .select(['recurrence', 'recurrence_count', 'recurrence_last_at', 'recurrence_source_id', 'evergreen_days', 'time_zone'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', postId)
    .executeTakeFirstOrThrow();
}

function requireUser(ctx: CommandContext): void {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
}

export const postRecurrenceSet = defineCommand({
  name: 'social.post.recurrence_set',
  input: z.strictObject({ postId: zId, recurrence: zSocialRecurrence }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    await lockPost(ctx.trx, ctx.orgId, input.postId);
    const row = await seriesOf(ctx, input.postId);
    if (row.recurrence_source_id !== null) throw new DomainError('RECURRENCE_ON_COPY', 409, 'Bài này là một lần lặp của chuỗi khác; hãy đổi lịch lặp ở bài gốc của chuỗi');
    if (row.evergreen_days !== null) throw new DomainError('RECURRENCE_WITH_EVERGREEN', 409, 'Bài này đang tự đăng lại; hãy tắt tự đăng lại trước khi đặt lịch lặp');
    const rule: Recurrence = { ...input.recurrence, weekdays: [...input.recurrence.weekdays].sort((a, b) => a - b) };
    if (rule.until !== null && rule.until < localDate(ctx.now.getTime(), row.time_zone)) {
      throw new DomainError('RECURRENCE_UNTIL_PAST', 422, 'Ngày kết thúc đã qua');
    }
    // Editing a live rule keeps the copies counted so far; a new run (no rule before) counts from zero.
    const running = parseRecurrence(row.recurrence) !== null;
    const count = running ? row.recurrence_count : 0;
    if (rule.times !== null && rule.times <= count) {
      throw new DomainError('RECURRENCE_TIMES_REACHED', 422, `Chuỗi đã lặp ${count} lần; số lần phải lớn hơn thế`, { count });
    }
    await ctx.trx
      .updateTable('crove_social.post')
      // The next occurrence is computed again by the worker, from the last copy's occurrence.
      .set({ recurrence: JSON.stringify(rule), recurrence_count: count, recurrence_next_at: null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .execute();
    ctx.audit({ post_id: input.postId, recurrence: rule, count });
    return { postId: input.postId, recurrence: rule };
  },
});

export const postRecurrenceClear = defineCommand({
  name: 'social.post.recurrence_clear',
  input: z.strictObject({ postId: zId }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    await lockPost(ctx.trx, ctx.orgId, input.postId);
    // A copy already made stays as it is, for a person to approve or cancel.
    await ctx.trx
      .updateTable('crove_social.post')
      .set({ recurrence: null, recurrence_next_at: null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .execute();
    ctx.audit({ post_id: input.postId, recurrence: null });
    return { postId: input.postId };
  },
});

export type RecurringResult = { postId: string; at: string; ended: boolean } | { postId: null; reason: string };

// Ends the series: its rule is cleared, its count and last occurrence kept.
async function endSeries(ctx: CommandContext, postId: string, reason: string): Promise<RecurringResult> {
  await ctx.trx.updateTable('crove_social.post').set({ recurrence: null, recurrence_next_at: null, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', postId).execute();
  ctx.audit({ post_id: postId, recurrence: null, reason });
  return { postId: null, reason };
}

// The next copy of a series, when it is due: checked again here under the hold's shared lock and the post's lock, since
// the scan ran outside this transaction (another worker, or a person changing the rule, may have come first).
export const recurringNext = defineCommand({
  name: 'social.recurring.next',
  input: z.strictObject({ postId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input): Promise<RecurringResult> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    // No copy piles up for review while the org's publishing is held; the series is still due after the release.
    if (await publishingHeld(ctx)) return { postId: null, reason: 'held' };
    await lockPost(ctx.trx, ctx.orgId, input.postId);
    const row = await seriesOf(ctx, input.postId);
    const rule = parseRecurrence(row.recurrence);
    if (!rule) return { postId: null, reason: 'not_series' };
    if (rule.times !== null && row.recurrence_count >= rule.times) return endSeries(ctx, input.postId, 'times');
    const open = await ctx.trx
      .selectFrom('crove_social.post as c')
      .innerJoin('crove_social.post_variant as v', (j) => j.onRef('v.org_id', '=', 'c.org_id').onRef('v.post_id', '=', 'c.id'))
      .select('c.id')
      .where('c.org_id', '=', ctx.orgId)
      .where('c.recurrence_source_id', '=', input.postId)
      .where('v.status', 'not in', [...COPY_DONE])
      .executeTakeFirst();
    if (open) return { postId: null, reason: 'open_copy' };
    // Before the first copy, the series counts from the post's first publish.
    const first = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(({ fn }) => fn.min('published_at').as('at'))
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', input.postId)
      .where('status', '=', 'published')
      .executeTakeFirst();
    const firstAt = first?.at ? new Date(first.at as Date | string) : null;
    if (!firstAt) return { postId: null, reason: 'not_published' };
    const after = (row.recurrence_last_at ?? firstAt).getTime();
    const now = ctx.now.getTime();
    const next = nextOccurrence(rule, row.time_zone, after, now);
    if (next === null) return endSeries(ctx, input.postId, 'until');
    if (next > now + RECURRING_HORIZON_MS) {
      // Not due yet: the scan leaves it alone until a week before.
      await ctx.trx.updateTable('crove_social.post').set({ recurrence_next_at: new Date(next) }).where('org_id', '=', ctx.orgId).where('id', '=', input.postId).execute();
      return { postId: null, reason: 'not_due' };
    }
    const done = await repostCopy(ctx, input.postId, { submit: true, scheduledAt: new Date(next), recurrenceSourceId: input.postId });
    // A channel that is only expired may be reconnected: a later sweep tries again (an occurrence gone by meanwhile is
    // skipped).
    if (done === 'waiting') return { postId: null, reason: 'waiting' };
    if (done === 'gone') return endSeries(ctx, input.postId, 'no_connected_channel');
    const count = row.recurrence_count + 1;
    const following = nextOccurrence(rule, row.time_zone, next, now);
    const ended = (rule.times !== null && count >= rule.times) || following === null;
    await ctx.trx
      .updateTable('crove_social.post')
      .set({
        recurrence_count: count,
        recurrence_last_at: new Date(next),
        recurrence_next_at: ended ? null : new Date(following as number),
        ...(ended ? { recurrence: null } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .execute();
    ctx.audit({ series_id: input.postId, copy_id: done.postId, occurrence: new Date(next).toISOString(), count, ended });
    return { postId: done.postId, at: new Date(next).toISOString(), ended };
  },
});

export const recurringCommands = [postRecurrenceSet, postRecurrenceClear, recurringNext];

// One pass: the next copy of every series that is due, sent to review. Logs ids and codes only.
export async function sweepRecurring(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; post_id: string }>`SELECT org_id, post_id FROM crove_social.recurring_due(50::int)`.execute(deps.workerDb);
  let made = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<RecurringResult>('social.recurring.next', { postId: row.post_id }, { actor: ACTOR, orgId: row.org_id });
      if (done.postId) made += 1;
    } catch (error) {
      console.warn(`[social-recurring] post ${row.post_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    }
  }
  return made;
}
