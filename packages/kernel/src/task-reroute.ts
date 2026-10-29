// Open tasks a chart or role change would strand (#1799). A task of a legal entity is listed by its position's holder
// only while that holder reads the entity (#1762, #1788); a later change of the holder, of an agent seat's le_scope or
// of a person's roles can take that away. Every such command calls rerouteStrandedTasks after its change, in its own
// transaction: each open task of the given positions that the holder no longer reads goes to the entity-aware
// escalation target of #1788 (the nearest active position up the chart held by a person who reads the entity), else to
// the owners at the root (no position). The task keeps its entity, its parent and its history; a lease an agent held on
// it ends (an in-progress task starts again as todo); an activity row on the task (it takes the task's entity,
// b_legal_entity) and a notice to whoever now has it
// (kernel.task.rerouted, kernel.notification.dispatch) say where it went. The database answers which tasks and where
// (crove_kernel.task_stranded, for an owner's context: every calling command is the owner's).
import { sql } from 'kysely';
import type { CommandContext } from '@crove/kernel-runtime';

export interface ReroutedTask {
  taskId: string;
  fromPositionId: string;
  toPositionId: string | null;
}

// How many times the targets are locked and the answer read again before the move goes ahead with the last answer.
const TARGET_ROUNDS = 3;

export async function rerouteStrandedTasks(ctx: CommandContext, positionIds: readonly string[]): Promise<ReroutedTask[]> {
  const positions = [...new Set(positionIds)];
  if (positions.length === 0) return [];
  const stranded = async () =>
    (
      await sql<{ task_id: string; from_position_id: string; legal_entity_id: string; to_position_id: string | null }>`
        SELECT task_id, from_position_id, legal_entity_id, to_position_id FROM crove_kernel.task_stranded(${positions}::uuid[])`.execute(ctx.trx)
    ).rows;
  // A target keeps its holder and that holder's roles until this command commits: its seat and its holder's membership
  // are locked (FOR SHARE) before the answer is read again, so a concurrent kernel.position.assign or role change of
  // the target waits, then sees the moved task and re-routes it in turn. Seats in id order, then members in user order.
  const locked = new Set<string>();
  let rows = await stranded();
  for (let round = 0; round < TARGET_ROUNDS; round++) {
    const fresh = [...new Set(rows.flatMap((r) => (r.to_position_id && !locked.has(r.to_position_id) ? [r.to_position_id] : [])))].sort();
    if (fresh.length === 0) break;
    const seats = await ctx.trx
      .selectFrom('crove_kernel.position')
      .select(['id', 'holder_user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', fresh)
      .orderBy('id')
      .forShare()
      .execute();
    const holders = [...new Set(seats.flatMap((s) => (s.holder_user_id ? [s.holder_user_id] : [])))].sort();
    if (holders.length > 0) {
      await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('user_id', 'in', holders).orderBy('user_id').forShare().execute();
    }
    for (const id of fresh) locked.add(id);
    rows = await stranded();
  }
  const moved: ReroutedTask[] = [];
  for (const row of rows) {
    await ctx.trx
      .updateTable('crove_kernel.task')
      .set({
        assignee_position_id: row.to_position_id,
        status: sql`CASE WHEN status = 'in_progress' THEN 'todo' ELSE status END`,
        checkout_run_id: null,
        lock_expires_at: null,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.task_id)
      .execute();
    await ctx.activity(
      'kernel.task',
      row.task_id,
      'task.rerouted',
      row.to_position_id ? 'Chuyển việc lên cấp trên vì người giữ vị trí không còn xem được pháp nhân này' : 'Chuyển việc cho chủ sở hữu vì người giữ vị trí không còn xem được pháp nhân này',
    );
    await ctx.emit('kernel.task.rerouted', { taskId: row.task_id, fromPositionId: row.from_position_id, toPositionId: row.to_position_id });
    moved.push({ taskId: row.task_id, fromPositionId: row.from_position_id, toPositionId: row.to_position_id });
  }
  if (moved.length > 0) ctx.audit({ rerouted_tasks: moved.map((m) => ({ task: m.taskId, from: m.fromPositionId, to: m.toPositionId })) });
  return moved;
}

// The positions a person holds, for the role commands (their scope is what changes).
export async function positionsHeldBy(ctx: Pick<CommandContext, 'trx' | 'orgId'>, userId: string): Promise<string[]> {
  const rows = await ctx.trx.selectFrom('crove_kernel.position').select('id').where('org_id', '=', ctx.orgId).where('holder_user_id', '=', userId).execute();
  return rows.map((r) => r.id);
}
