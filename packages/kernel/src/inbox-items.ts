// Inbox items the system raises (#1720, plan §4.9 "pg-boss contract"): crove_kernel.inbox_item, one row per org, kind
// and key. The only kind today is kernel.job.dead_lettered: a job of the org that failed its last retry.
//
// The worker raises it: the dead letter queue's job (apps/kernel/src/dead-letter.ts) runs kernel.job.dead_letter in the
// system context of the job's org, with the queue the job failed on, its id and how many retries it had. Nothing of
// the job's data or its error reaches the item, so an item tells the org only that some work of a given kind failed.
// The same failed job raises one item however often its dead letter is taken (the key is the job's id).
//
// Owners and admins see the open items in the Inbox (kernel.inbox.raised) and dismiss them (kernel.inbox.dismiss); members
// and viewers get an empty list, as with the Social work in the Inbox (#771). A database policy keeps member contexts
// from raising one.
import { z } from 'zod';
import { tableWrite, zId, type RaisedInboxItem } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { kernelManifest } from './manifest.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
export const DEAD_LETTERED = 'kernel.job.dead_lettered';
// The most open items the Inbox lists; the total counts them all.
export const RAISED_ITEMS_MAX = 50;
// A pg-boss queue name as the kernel names its queues (jobs-schema.ts).
const QUEUE_NAME = /^[a-z][a-z0-9_.-]{0,99}$/;

const zDeadLetterDetail = z.object({ queue: z.string().regex(QUEUE_NAME), jobId: zId, retries: z.number().int().min(0) });

// The worker's command for a job of the org that failed its last retry.
export const jobDeadLetter = defineCommand({
  name: 'kernel.job.dead_letter',
  input: z.strictObject({ queue: z.string().regex(QUEUE_NAME), jobId: zId, retries: z.number().int().min(0).max(1_000_000) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [tableWrite(kernelManifest.tables, 'crove_kernel', 'inbox_item', ['org_id', 'kind', 'dedupe_key', 'detail', 'raised_at'])],
  handler: async (ctx, input) => {
    const detail = { queue: input.queue, jobId: input.jobId, retries: input.retries } satisfies z.infer<typeof zDeadLetterDetail>;
    const row = await ctx.trx
      .insertInto('crove_kernel.inbox_item')
      .values({ org_id: ctx.orgId, kind: DEAD_LETTERED, dedupe_key: `job:${input.jobId}`, detail: JSON.stringify(detail), raised_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'kind', 'dedupe_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    ctx.audit({ queue: input.queue, job: input.jobId, raised: row !== undefined });
    return { raised: row !== undefined, itemId: row?.id ?? null };
  },
});

// An owner or admin dismisses an open item; an item already dismissed stays as it was.
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
      items.push({ id: row.id, kind: DEAD_LETTERED, queue: detail.data.queue, jobId: detail.data.jobId, retries: detail.data.retries, raisedAt: row.raised_at.toISOString() });
    }
    return { items, total: Number(total) };
  },
});

export const inboxItemCommands = [jobDeadLetter, inboxDismiss];
export const inboxItemQueries = [inboxRaised];
