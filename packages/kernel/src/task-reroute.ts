// Open tasks a chart or role change would strand (#1799). A task of a legal entity is listed by its position's holder
// only while that holder reads the entity (#1762, #1788); a later change of the holder, of an agent seat's le_scope or
// of a person's roles can take that away. Every such command calls rerouteStrandedTasks after its change, in its own
// transaction: each open task of the given positions that the holder no longer reads goes to the entity-aware
// escalation target of #1788 (the nearest active position up the chart held by a person who reads the entity), else to
// the owners at the root (no position). The task keeps its entity, its parent and its history; a lease an agent held on
// it ends (an in-progress task starts again as todo). The database moves them set-based and writes an activity row per
// task (crove_kernel.task_reroute: two statements whatever the count, its targets locked first, a deadlock retried
// once), so a narrowing never waits on how many tasks there are. One event per new holder and entity
// (kernel.task.rerouted) becomes one notice for whoever has them now (kernel.notification.dispatch).
import { sql } from 'kysely';
import type { CommandContext } from '@crove/kernel-runtime';

export interface ReroutedTask {
  taskId: string;
  fromPositionId: string;
  legalEntityId: string;
  toPositionId: string | null;
}

// The moved task ids an event carries at most; the notice counts what is still waiting there.
export const REROUTED_EVENT_TASKS = 200;

export async function rerouteStrandedTasks(ctx: CommandContext, positionIds: readonly string[]): Promise<ReroutedTask[]> {
  const positions = [...new Set(positionIds)];
  if (positions.length === 0) return [];
  const { rows } = await sql<{ task_id: string; from_position_id: string; legal_entity_id: string; to_position_id: string | null }>`
    SELECT task_id, from_position_id, legal_entity_id, to_position_id FROM crove_kernel.task_reroute(${positions}::uuid[])`.execute(ctx.trx);
  const moved = rows.map((r) => ({ taskId: r.task_id, fromPositionId: r.from_position_id, legalEntityId: r.legal_entity_id, toPositionId: r.to_position_id }));
  if (moved.length === 0) return moved;
  const groups = new Map<string, { toPositionId: string | null; legalEntityId: string; taskIds: string[] }>();
  for (const m of moved) {
    const key = `${m.toPositionId ?? 'owners'}:${m.legalEntityId}`;
    const group = groups.get(key) ?? { toPositionId: m.toPositionId, legalEntityId: m.legalEntityId, taskIds: [] };
    group.taskIds.push(m.taskId);
    groups.set(key, group);
  }
  for (const g of groups.values()) {
    await ctx.emit('kernel.task.rerouted', {
      toPositionId: g.toPositionId,
      legalEntityId: g.legalEntityId,
      count: g.taskIds.length,
      taskIds: g.taskIds.slice(0, REROUTED_EVENT_TASKS),
    });
  }
  ctx.audit({ rerouted: { tasks: moved.length, to: [...groups.values()].map((g) => ({ position: g.toPositionId, entity: g.legalEntityId, tasks: g.taskIds.length })) } });
  return moved;
}

// The positions a person holds, for the role commands (their scope is what changes).
export async function positionsHeldBy(ctx: Pick<CommandContext, 'trx' | 'orgId'>, userId: string): Promise<string[]> {
  const rows = await ctx.trx.selectFrom('crove_kernel.position').select('id').where('org_id', '=', ctx.orgId).where('holder_user_id', '=', userId).execute();
  return rows.map((r) => r.id);
}
