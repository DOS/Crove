// Monthly goals (#1056) in the app: the month before or after another, and the progress of a client report's goals,
// judged with the module's rules (goalProgress) at the moment the page shows them.
import { goalProgress, isMonthKey, type GoalMetric, type GoalProgress } from '@crove/mod-social/contract';

/** The month delta months from a YYYY-MM month. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = (y ?? 0) * 12 + ((m ?? 1) - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// The goals a one-month client report shows (its view definer's answer): the org's first, then each channel's;
// absent from a server without goals.
export interface ReportGoals {
  month: string;
  timeZone: string;
  groups: { channel: string | null; provider: string | null; items: { metric: GoalMetric; target: number; actual: number | null }[] }[];
}

export interface ReportGoalGroup {
  channel: string | null;
  provider: string | null;
  progress: GoalProgress[];
}

const METRICS = new Set<string>(['posts', 'reach', 'impressions', 'engagement', 'followersGained']);
const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The report's goals by scope, each judged at nowMs over the report's period; null for an answer without goals or in
 * another shape. An item in an unknown shape is left out.
 */
export function reportGoalGroups(goals: unknown, period: { periodStart: string; periodEnd: string }, nowMs: number): { month: string; groups: ReportGoalGroup[] } | null {
  const g = record(goals);
  if (!g || typeof g.month !== 'string' || !isMonthKey(g.month) || !Array.isArray(g.groups)) return null;
  const bounds = { start: Date.parse(period.periodStart), end: Date.parse(period.periodEnd) };
  if (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end)) return null;
  const groups: ReportGoalGroup[] = [];
  for (const raw of g.groups) {
    const group = record(raw);
    if (!group || !Array.isArray(group.items)) continue;
    const progress: GoalProgress[] = [];
    for (const rawItem of group.items) {
      const item = record(rawItem);
      if (!item || typeof item.metric !== 'string' || !METRICS.has(item.metric) || typeof item.target !== 'number' || !(item.target > 0)) continue;
      const actual = typeof item.actual === 'number' && Number.isFinite(item.actual) ? item.actual : null;
      progress.push(goalProgress({ metric: item.metric as GoalMetric, target: item.target, actual }, bounds, nowMs));
    }
    if (progress.length > 0) groups.push({ channel: typeof group.channel === 'string' ? group.channel : null, provider: typeof group.provider === 'string' ? group.provider : null, progress });
  }
  return groups.length === 0 ? null : { month: g.month, groups };
}
