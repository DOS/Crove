// The worker's notes commands (issue #1671, ADR-0037 §2 and §4): emptying the trash, removing a former member's
// private notes 30 days after they left, and a to-do's reminder (#1675). The system context reads no private note or
// to-do, so the first two go through definers that delete by rule and answer a count, never text; the definers refuse
// every login but the worker's and every context but the org's system context. The reminder gets ids and a time from
// the worker's claim (crove_notes.todo_reminders_claim) and writes a notification that holds none of the to-do's text.
import { sql } from 'kysely';
import { z } from 'zod';
import { notifyMembers } from '@crove/kernel';
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

// The notification kind of a to-do's reminder; members turn it off like any kind (#671).
export const TODO_DUE = 'notes.todo_due';

// The legal entity a member's notification goes under, so they see it (the notification's le_scope policy, #1280): the
// org's default (null) for a member whose context spans the org, else the first of the entities their assignments
// limit them to (enter_context's le_scope).
async function memberEntity(ctx: CommandContext, userId: string): Promise<string | null> {
  const { rows } = await sql<{ legal_entity_id: string | null }>`
    SELECT CASE
      WHEN m.role IN ('owner', 'admin') THEN NULL
      WHEN EXISTS (SELECT 1 FROM crove_kernel.role_assignment a WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.legal_entity_id IS NULL) THEN NULL
      ELSE (SELECT a.legal_entity_id FROM crove_kernel.role_assignment a WHERE a.org_id = m.org_id AND a.user_id = m.user_id ORDER BY a.legal_entity_id::text LIMIT 1)
    END AS legal_entity_id
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = ${ctx.orgId} AND m.user_id = ${userId}`.execute(ctx.trx);
  return rows[0]?.legal_entity_id ?? null;
}

// One reminder the worker claimed: a notification for the to-do's owner, once per to-do and reminder time (a replayed
// job writes nothing), with the to-do's id as its subject and no text (notes.md §3.6: "Bạn có 1 việc đến hạn"; the app
// shows the title only when the owner opens it). The owner gets nothing once they left the org or turned the kind off.
export const todoRemind = defineCommand({
  name: 'notes.todo.remind',
  input: z.strictObject({ todoId: zId, ownerUserId: zId, remindAt: z.iso.datetime({ offset: true }) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ sent: number }> => {
    assertSystem(ctx);
    const remindAt = new Date(input.remindAt).toISOString();
    const sent = await notifyMembers(ctx, {
      kind: TODO_DUE,
      users: [input.ownerUserId],
      key: `todo_due:${input.todoId}:${remindAt}`,
      subject: { type: 'notes.todo', id: input.todoId },
      legalEntityId: await memberEntity(ctx, input.ownerUserId),
    });
    ctx.audit({ todoId: input.todoId, remindAt, sent });
    return { sent };
  },
});

export const systemCommands = [trashEmpty, memberItemsPurge, todoRemind];
