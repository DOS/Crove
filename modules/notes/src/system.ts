// The worker's notes commands (issue #1671, ADR-0037 §2 and §4): emptying the trash, and removing a former member's
// private notes 30 days after they left. The system context reads no private note, so both go through definers that
// delete by rule and answer a count, never text; the definers refuse every login but the worker's and every context
// but the org's system context.
import { sql } from 'kysely';
import { z } from 'zod';
import { NOTE_TRASH_DAYS, zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';

function assertSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ hệ thống mới thực hiện được việc này');
}

// The notes the daily sweep removes: in the trash for NOTE_TRASH_DAYS.
export const trashCutoff = (now: Date): Date => new Date(now.getTime() - NOTE_TRASH_DAYS * 86_400_000);

export const trashEmpty = defineCommand({
  name: 'notes.trash.empty',
  input: z.strictObject({}),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx): Promise<{ removed: number }> => {
    assertSystem(ctx);
    const before = trashCutoff(ctx.now);
    const { rows } = await sql<{ n: string }>`SELECT crove_notes.trash_empty(${before}::timestamptz) AS n`.execute(ctx.trx);
    const removed = Number(rows[0]?.n ?? 0);
    ctx.audit({ before: before.toISOString(), removed });
    return { removed };
  },
});

// Queued by the worker 30 days after kernel.member.removed (apps/kernel/src/notes-worker.ts), with that event's id. The
// definer removes nothing when the user is a member of the org again. A later removal of the same user (added back,
// then removed again) has a job of its own 30 days after it, so this one leaves the notes to it: outbox event ids are
// UUIDv7, ordered by time, and that later event is younger than 30 days, so still in the outbox (#997).
export const memberItemsPurge = defineCommand({
  name: 'notes.member_items.purge',
  input: z.strictObject({ userId: zId, eventId: zId }),
  risk: 'R3',
  sideEffect: 'irreversible',
  access: 'system',
  handler: async (ctx, input): Promise<{ removed: number }> => {
    assertSystem(ctx);
    const later = await ctx.trx
      .selectFrom('crove_kernel.outbox_event')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('type', '=', 'kernel.member.removed')
      .where('id', '>', input.eventId)
      .where(sql<string>`payload ->> 'userId'`, '=', input.userId)
      .executeTakeFirst();
    if (later) {
      ctx.audit({ userId: input.userId, eventId: input.eventId, removed: 0, laterEventId: later.id });
      return { removed: 0 };
    }
    const { rows } = await sql<{ n: string }>`SELECT crove_notes.member_items_purge(${input.userId}::uuid) AS n`.execute(ctx.trx);
    const removed = Number(rows[0]?.n ?? 0);
    ctx.audit({ userId: input.userId, eventId: input.eventId, removed });
    return { removed };
  },
});

export const systemCommands = [trashEmpty, memberItemsPurge];
