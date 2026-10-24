// A warning when a channel's queue runs low (#1079), as Buffer's "your queue is running low". Owners and admins set
// low_days on a queue (social.queue.set); the worker's sweep pages through the queues that have it (queue_low_due:
// not paused, an active channel, an active org with no publishing hold) and runs social.queue.check_low for each, which
// checks the org, the hold, the queue and the channel again in its own transaction.
// The check measures the queue with queueRunway (domain/queue.ts): of the posting days in the next low_days days, how
// many have a post in one of their slots. When a posting day ahead is empty, it tells the team once: it sets the dip
// marker (low_alerted_at) with a conditional update and emits social.queue.low, which the notification dispatch turns
// into a queue_low notification (in the app and by email) for the owners, admins and members, who fill the queue. When
// every posting day ahead has a post again it clears the marker, so the team is told again only after a refill and a
// new dip.
//
// Lock order: the publishing hold's lock shared, then the queue row, as the schedule commands and social.queue.set take
// them: a post being queued is either seen or queued after the check.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db } from '@crove/db';
import { DomainError, defineCommand, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { queueRunway, type QueueSpec } from './domain/queue.ts';
import { publishingHeld } from './publish-hold.ts';
import { SLOT_FREED } from './variants.ts';

const ACTOR: SystemActor = { type: 'system', component: 'social.queue-low' };
// How often the worker measures the queues, and how many it reads per page of the scan.
export const QUEUE_LOW_SWEEP_MS = 60 * 60_000;
export const QUEUE_LOW_PAGE = 200;
// The most pages one pass reads (100,000 queues); the next pass starts from the first again.
export const QUEUE_LOW_MAX_PAGES = 500;
// The setting's bounds, as the column's CHECK.
export const QUEUE_LOW_DAYS_MIN = 1;
export const QUEUE_LOW_DAYS_MAX = 30;
const DAY = 86_400_000;

export type QueueLowState = 'alerted' | 'low' | 'cleared' | 'filled' | 'skipped';

export const queueCheckLow = defineCommand({
  name: 'social.queue.check_low',
  input: z.strictObject({ queueId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.queue', id: input.queueId }),
  handler: async (ctx, input): Promise<{ state: QueueLowState; postingDays: number; filledDays: number }> => {
    const none = { postingDays: 0, filledDays: 0 };
    // Closed or offboarding since the scan (#1095): nobody is told.
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('status').where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (org?.status !== 'active') return { state: 'skipped', ...none };
    // Held since the scan: nothing goes out, so nothing is missing yet.
    if (await publishingHeld(ctx)) return { state: 'skipped', ...none };
    const queue = await ctx.trx
      .selectFrom('crove_social.queue')
      .select(['id', 'channel_connection_id', 'time_zone', 'paused', 'low_days', 'low_alerted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.queueId)
      .forUpdate()
      .executeTakeFirst();
    if (!queue || queue.low_days === null || queue.paused) return { state: 'skipped', ...none };
    const channel = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('status').where('org_id', '=', ctx.orgId).where('id', '=', queue.channel_connection_id).executeTakeFirst();
    if (channel?.status !== 'active') return { state: 'skipped', ...none };
    const slots = await ctx.trx.selectFrom('crove_social.queue_slot').select(['weekday', 'minute', 'label_id']).where('org_id', '=', ctx.orgId).where('queue_id', '=', queue.id).where('active', '=', true).execute();
    const spec: QueueSpec = { timeZone: queue.time_zone, slots: slots.map((s) => ({ weekday: s.weekday, minute: s.minute, labelId: s.label_id })) };
    const now = ctx.now.getTime();
    const held = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select('queue_slot_at')
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', queue.channel_connection_id)
      .where('queue_slot_at', '>', ctx.now)
      .where('queue_slot_at', '<=', new Date(now + queue.low_days * DAY))
      .where('status', 'not in', [...SLOT_FREED])
      .execute();
    const runway = queueRunway(
      spec,
      held.map((h) => (h.queue_slot_at as Date).getTime()),
      now,
      queue.low_days,
    );
    const measured = { postingDays: runway.postingDays, filledDays: runway.filledDays };
    if (!runway.low) {
      if (queue.low_alerted_at === null) return { state: 'filled', ...measured };
      // Refilled: the next dip tells the team again.
      await ctx.trx.updateTable('crove_social.queue').set({ low_alerted_at: null }).where('org_id', '=', ctx.orgId).where('id', '=', queue.id).where('low_alerted_at', 'is not', null).execute();
      return { state: 'cleared', ...measured };
    }
    // Once per dip: only the check that sets the marker tells the team.
    const marked = await ctx.trx
      .updateTable('crove_social.queue')
      .set({ low_alerted_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', queue.id)
      .where('low_alerted_at', 'is', null)
      .where('low_days', 'is not', null)
      .where('paused', '=', false)
      .returning('id')
      .executeTakeFirst();
    if (!marked) return { state: 'low', ...measured };
    await ctx.emit('social.queue.low', { queue_id: queue.id, connection_id: queue.channel_connection_id, low_days: queue.low_days, posting_days: runway.postingDays, filled_days: runway.filledDays });
    return { state: 'alerted', ...measured };
  },
});

// One pass over every queue with the warning on; returns how many told their team.
export async function sweepQueueLow(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  let after = null as { org: string; id: string } | null;
  let alerted = 0;
  for (let page = 0; page < QUEUE_LOW_MAX_PAGES; page++) {
    const { rows } = await sql<{ org_id: string; queue_id: string }>`
      SELECT org_id, queue_id FROM crove_social.queue_low_due(${after?.org ?? null}::uuid, ${after?.id ?? null}::uuid, ${QUEUE_LOW_PAGE}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      try {
        const done = await deps.runtime.execute<{ state: QueueLowState }>('social.queue.check_low', { queueId: row.queue_id }, { actor: ACTOR, orgId: row.org_id });
        if (done.state === 'alerted') alerted += 1;
      } catch (error) {
        console.warn(`[social-queue-low] queue ${row.queue_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
      }
    }
    const last = rows.at(-1);
    if (rows.length < QUEUE_LOW_PAGE || !last) break;
    after = { org: last.org_id, id: last.queue_id };
  }
  return alerted;
}

export const queueLowCommands = [queueCheckLow];
