// Inbox items the system raises (#1720, plan §4.9 "pg-boss contract"): crove_kernel.inbox_item, one open row per org,
// kind and key. The only kind today is kernel.job.dead_lettered: work of the org that failed its last retry.
//
// The worker raises it: the dead letter queue's job (apps/kernel/src/dead-letter.ts) runs kernel.job.dead_letter in the
// system context of the job's org, with the queue the job failed on, its id and how many retries it had. Nothing of
// the job's data or its error reaches the item, so an item tells the org only that some work of a given kind failed.
// One open item per queue and day in Vietnam counts that day's failures (#1747): a job that keeps failing raises one
// item, not one per failure. A new day, or a failure after the item was dismissed, raises a new one. The worker takes
// each dead letter with its job's id as the idempotency key, so the same copy taken twice counts once.
//
// Owners and admins see the open items in the Inbox (kernel.inbox.raised) and dismiss them (kernel.inbox.dismiss); members
// and viewers get an empty list, as with the Social work in the Inbox (#771). Database policies keep member contexts
// from raising one, and a dismissal names the context's own user. The daily retention run prunes items dismissed
// INBOX_ITEM_DISMISSED_KEEP_DAYS ago, and any raised INBOX_ITEM_KEEP_DAYS ago (kernel.inbox.prune).
import { sql } from 'kysely';
import { z } from 'zod';
import { tableWrite, vietnamToday, zId, type RaisedInboxItem } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { kernelManifest } from './manifest.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
export const DEAD_LETTERED = 'kernel.job.dead_lettered';
// The most open items the Inbox lists; the total counts them all.
export const RAISED_ITEMS_MAX = 50;
// How long an item stays: 30 days after it was dismissed, 90 after it was raised whatever happened to it (as read and
// unread notifications do). The failed jobs themselves stay where the prober counts them.
export const INBOX_ITEM_DISMISSED_KEEP_DAYS = 30;
export const INBOX_ITEM_KEEP_DAYS = 90;
// A pg-boss queue name as the kernel names its queues (jobs-schema.ts).
const QUEUE_NAME = /^[a-z][a-z0-9_.-]{0,99}$/;
const DAY_MS = 86_400_000;

// failures and lastAt came with the grouping (#1747): an item raised before it counts one failure, at its raise time.
const zDeadLetterDetail = z.object({
  queue: z.string().regex(QUEUE_NAME),
  jobId: zId,
  retries: z.number().int().min(0),
  failures: z.number().int().min(1).default(1),
  lastAt: z.iso.datetime({ offset: true }).optional(),
});

// The key of the open item a failure of `queue` on `now` counts on: one per queue and day in Vietnam.
export function deadLetterKey(queue: string, now: Date): string {
  return `queue:${queue}:${vietnamToday(now)}`;
}

// The cut-offs of the daily prune at `now`.
export function inboxPruneCutoffs(now: Date): { dismissedBefore: Date; raisedBefore: Date } {
  return {
    dismissedBefore: new Date(now.getTime() - INBOX_ITEM_DISMISSED_KEEP_DAYS * DAY_MS),
    raisedBefore: new Date(now.getTime() - INBOX_ITEM_KEEP_DAYS * DAY_MS),
  };
}

// The worker's command for a job of the org that failed its last retry: a new item for its queue and day, or one more
// failure on the open one.
export const jobDeadLetter = defineCommand({
  name: 'kernel.job.dead_letter',
  input: z.strictObject({ queue: z.string().regex(QUEUE_NAME), jobId: zId, retries: z.number().int().min(0).max(1_000_000) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [tableWrite(kernelManifest.tables, 'crove_kernel', 'inbox_item', ['org_id', 'kind', 'dedupe_key', 'detail', 'raised_at'])],
  handler: async (ctx, input) => {
    const lastAt = ctx.now.toISOString();
    const detail = { queue: input.queue, jobId: input.jobId, retries: input.retries, failures: 1, lastAt } satisfies z.input<typeof zDeadLetterDetail>;
    const row = await ctx.trx
      .insertInto('crove_kernel.inbox_item')
      .values({ org_id: ctx.orgId, kind: DEAD_LETTERED, dedupe_key: deadLetterKey(input.queue, ctx.now), detail: JSON.stringify(detail), raised_at: ctx.now })
      // The open item of the queue and day (inbox_item_open_once): the latest job, and one more failure.
      .onConflict((oc) =>
        oc
          .columns(['org_id', 'kind', 'dedupe_key'])
          .where('dismissed_at', 'is', null)
          .doUpdateSet({
            detail: sql<string>`pg_catalog.jsonb_build_object(
              'queue', ${input.queue}::text, 'jobId', ${input.jobId}::text, 'retries', ${input.retries}::integer,
              'failures', COALESCE((crove_kernel.inbox_item.detail ->> 'failures')::integer, 1) + 1, 'lastAt', ${lastAt}::text)`,
          }),
      )
      .returning(['id', sql<number>`(detail ->> 'failures')::integer`.as('failures')])
      .executeTakeFirstOrThrow();
    const raised = row.failures === 1;
    ctx.audit({ queue: input.queue, job: input.jobId, raised, failures: row.failures });
    return { raised, itemId: row.id, failures: row.failures };
  },
});

// An owner or admin dismisses an open item; an item already dismissed stays as it was. The database ties
// dismissed_by to the context's user (inbox_item_dismiss).
export const inboxDismiss = defineCommand({
  name: 'kernel.inbox.dismiss',
  input: z.strictObject({ id: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  target: (input) => ({ type: 'kernel.inbox_item', id: input.id }),
  writes: [tableWrite(kernelManifest.tables, 'crove_kernel', 'inbox_item', ['dismissed_at', 'dismissed_by'])],
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const done = await ctx.trx
      .updateTable('crove_kernel.inbox_item')
      .set({ dismissed_at: ctx.now, dismissed_by: ctx.actor.userId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .where('dismissed_at', 'is', null)
      .executeTakeFirst();
    if (Number(done.numUpdatedRows) === 0) {
      const exists = await ctx.trx.selectFrom('crove_kernel.inbox_item').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
      if (!exists) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy mục này trong hộp thư');
    }
    return { ok: true as const };
  },
});

// The daily retention run, in the system context of each org crove_kernel.inbox_item_prune_due names: the items
// dismissed INBOX_ITEM_DISMISSED_KEEP_DAYS ago and those raised INBOX_ITEM_KEEP_DAYS ago go.
export const inboxPrune = defineCommand({
  name: 'kernel.inbox.prune',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [tableWrite(kernelManifest.tables, 'crove_kernel', 'inbox_item', ['org_id', 'id', 'kind', 'dedupe_key', 'detail', 'raised_at', 'dismissed_at', 'dismissed_by'])],
  handler: async (ctx): Promise<{ removed: number }> => {
    const { dismissedBefore, raisedBefore } = inboxPruneCutoffs(ctx.now);
    const done = await ctx.trx
      .deleteFrom('crove_kernel.inbox_item')
      .where('org_id', '=', ctx.orgId)
      .where((eb) => eb.or([eb('dismissed_at', '<', dismissedBefore), eb('raised_at', '<', raisedBefore)]))
      .executeTakeFirst();
    const removed = Number(done.numDeletedRows);
    ctx.audit({ dismissedBefore: dismissedBefore.toISOString(), raisedBefore: raisedBefore.toISOString(), removed });
    return { removed };
  },
});

// The org's open items, newest first, for owners and admins.
export const inboxRaised = defineQuery({
  name: 'kernel.inbox.raised',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ items: RaisedInboxItem[]; total: number }> => {
    if (ctx.actor.type !== 'user' || (ctx.role !== 'owner' && ctx.role !== 'admin')) return { items: [], total: 0 };
    const open = ctx.trx.selectFrom('crove_kernel.inbox_item').where('org_id', '=', ctx.orgId).where('kind', '=', DEAD_LETTERED).where('dismissed_at', 'is', null);
    const rows = await open.select(['id', 'kind', 'detail', 'raised_at']).orderBy('raised_at', 'desc').orderBy('id', 'desc').limit(RAISED_ITEMS_MAX).execute();
    const { total } = await open.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const items: RaisedInboxItem[] = [];
    for (const row of rows) {
      const detail = zDeadLetterDetail.safeParse(row.detail);
      // Written by kernel.job.dead_letter alone, from checked input; a row that does not parse is left out.
      if (!detail.success) continue;
      const raisedAt = row.raised_at.toISOString();
      items.push({
        id: row.id,
        kind: DEAD_LETTERED,
        queue: detail.data.queue,
        jobId: detail.data.jobId,
        retries: detail.data.retries,
        failures: detail.data.failures,
        raisedAt,
        lastAt: detail.data.lastAt ?? raisedAt,
      });
    }
    return { items, total: Number(total) };
  },
});

export const inboxItemCommands = [jobDeadLetter, inboxDismiss, inboxPrune];
export const inboxItemQueries = [inboxRaised];
