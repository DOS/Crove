// What the AI agents screens decide on their own (ADR-0029, issue #258): the chart as a tree, who may use which
// control, and how far a budget is spent. The server enforces every rule; these only hide what can never succeed.
import { z } from 'zod';
import type { Role } from './members.ts';
import { readSearch, type Defined } from './search.ts';

export interface ChartNode<P> {
  position: P;
  children: ChartNode<P>[];
}

// The positions as a tree under the owners. A position without reportsTo, or whose manager is not in the list, is a
// root (it reports to the owners). The database refuses reporting cycles; a position caught in one anyway is still
// shown once, as a root, so a bad row never hides part of the chart or loops.
export function chartTree<P extends { id: string; reportsTo: string | null }>(positions: readonly P[]): ChartNode<P>[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const children = new Map<string, P[]>();
  const roots: P[] = [];
  for (const p of positions) {
    if (p.reportsTo && p.reportsTo !== p.id && byId.has(p.reportsTo)) children.set(p.reportsTo, [...(children.get(p.reportsTo) ?? []), p]);
    else roots.push(p);
  }
  const placed = new Set<string>();
  const build = (p: P): ChartNode<P> => {
    placed.add(p.id);
    return { position: p, children: (children.get(p.id) ?? []).filter((c) => !placed.has(c.id)).map(build) };
  };
  const tree = roots.map(build);
  // Positions only reachable through a cycle.
  for (const p of positions) if (!placed.has(p.id)) tree.push(build(p));
  return tree;
}

// The agents a position's holder select offers: active, of a template whose role is the position's role (the server
// refuses any other, AGENT_ROLE_MISMATCH), and not holding another position (AGENT_ALREADY_PLACED). The agent that holds
// this very position stays in the list, so the select can show it. Until the templates are known no agent is offered.
export function holderCandidates<A extends { id: string; templateKey: string; status: string }>(
  position: { id: string; roleKey: string },
  agents: readonly A[],
  positions: ReadonlyArray<{ id: string; holder: { type: string; agentId?: string } | null }>,
  templateRoles: ReadonlyMap<string, string>,
): A[] {
  const placedElsewhere = new Set(
    positions.filter((p) => p.id !== position.id && p.holder?.type === 'agent' && p.holder.agentId).map((p) => p.holder?.agentId as string),
  );
  const here = positions.find((p) => p.id === position.id)?.holder;
  const holderHere = here?.type === 'agent' ? here.agentId : undefined;
  return agents.filter(
    (a) => a.id === holderHere || (a.status === 'active' && templateRoles.get(a.templateKey) === position.roleKey && !placedElsewhere.has(a.id)),
  );
}

// A position's legal entities (#1763): every entity ('*' alone) or some of the org's, by id, as the chart commands take
// them. The picker sends one only where the org has more than one entity; with a single entity the screen is as before.
export const EVERY_ENTITY = ['*'] as const;
export type LeScope = readonly string[];

export const isEveryEntity = (scope: LeScope): boolean => scope.includes('*');

// The most entities a position names one by one (the commands' limit); past it, every entity is the choice.
export const LE_SCOPE_MAX = 50;

// Some entities with `id` turned on or off, in the order of `entities` (the server keeps what it is sent). An id the
// list does not hold (an entity the reader cannot see) is kept, so a change never drops it unseen.
export function toggleScopeEntity(scope: LeScope, id: string, on: boolean, entities: ReadonlyArray<{ id: string }>): string[] {
  const chosen = new Set(isEveryEntity(scope) ? [] : scope);
  if (on) chosen.add(id);
  else chosen.delete(id);
  const listed = new Set(entities.map((e) => e.id));
  return [...entities.filter((e) => chosen.has(e.id)).map((e) => e.id), ...[...chosen].filter((c) => !listed.has(c))];
}

// What a new position starts with until the owner picks: the org's default entity, as the server gives it.
export function defaultScope(entities: ReadonlyArray<{ id: string; isDefault: boolean }>): string[] {
  const chosen = entities.find((e) => e.isDefault) ?? entities[0];
  return chosen ? [chosen.id] : [];
}

// The names of a scope's entities for display, in the order of `entities`; null for every entity. An id the reader
// cannot name (an entity they may not see) is left out.
export function scopeNames(scope: LeScope, entities: ReadonlyArray<{ id: string; name: string }>): string[] | null {
  if (isEveryEntity(scope)) return null;
  return entities.filter((e) => scope.includes(e.id)).map((e) => e.name);
}

export interface AgentPermissions {
  // Owners and admins: "Stop AI" is R1, never behind a second factor.
  stop: boolean;
  // Owners only (R3, fresh MFA): the chart, templates, agents, budgets, turning AI back on.
  manage: boolean;
  // Owners and admins read the budgets.
  budgets: boolean;
  // Owners, admins and members create tasks, comment and change their status.
  tasks: boolean;
}

export function agentPermissions(role: Role | null | undefined): AgentPermissions {
  return {
    stop: role === 'owner' || role === 'admin',
    manage: role === 'owner',
    budgets: role === 'owner' || role === 'admin',
    tasks: role === 'owner' || role === 'admin' || role === 'member',
  };
}

// A non-negative amount with up to 6 decimals, the budget limit the server accepts.
export function isBudgetAmount(value: string): boolean {
  return /^\d{1,12}(\.\d{1,6})?$/.test(value.trim());
}

// Amounts in millionths, exactly (never a JS number for money).
function micros(value: string): bigint {
  const [i = '0', f = ''] = value.trim().split('.');
  return BigInt(i || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}

export type BudgetState = 'ok' | 'warn' | 'spent';

// How far this month's spend is into a budget. spent: the spend reached the limit, so a hard-stop budget refuses every
// run it covers (the server's rule: spent >= limit). percent is for display only, rounded down, capped at 999.
export function budgetUsage(spent: string, limit: string, warnPercent: number): { percent: number; state: BudgetState } {
  const s = micros(spent);
  const l = micros(limit);
  const state: BudgetState = s >= l ? 'spent' : s * 100n >= l * BigInt(warnPercent) ? 'warn' : 'ok';
  const percent = l === 0n ? (s > 0n ? 999 : 100) : Number((s * 100n) / l > 999n ? 999n : (s * 100n) / l);
  return { percent, state };
}

// The most tasks one list answers (kernel.task.list), newest first.
export const TASK_LIST_LIMIT = 200;

export const TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
// Statuses a task can still move from.
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'waiting', 'in_review'];

// The tasks screen's tabs; open tasks are the default.
export const TASK_FILTERS = ['open', 'mine', 'all'] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

// ?filter= of the tasks screen (#1513), left out for the open tasks.
const zTasksSearch = z.object({ filter: z.enum(TASK_FILTERS).optional().catch(undefined) });
export type TasksSearch = Defined<z.output<typeof zTasksSearch>>;
export const parseTasksSearch = (search: Record<string, unknown>): TasksSearch => readSearch(zTasksSearch, search);

// The Social post a task is about (#1193): the content agent's tasks point at their post by their source ref, and the
// task page links to it. Anything else, or an id that is not a UUID, is none.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether a task was handed over from a member's own to-do (#1674); the to-do stays private, so no id is shown. */
export function fromTodo(sourceRef: unknown): boolean {
  return typeof sourceRef === 'object' && sourceRef !== null && (sourceRef as { type?: unknown }).type === 'notes.todo';
}

export function socialPostOf(sourceRef: unknown): string | null {
  if (typeof sourceRef !== 'object' || sourceRef === null) return null;
  const { type, id } = sourceRef as { type?: unknown; id?: unknown };
  return type === 'social.post' && typeof id === 'string' && UUID.test(id) ? id : null;
}
