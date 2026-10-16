// What the AI agents screens decide on their own (ADR-0029, issue #258): the chart as a tree, who may use which
// control, and how far a budget is spent. The server enforces every rule; these only hide what can never succeed.
import type { Role } from './members.ts';

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
