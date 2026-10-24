// Monthly goals per org or channel (#1056), as Hootsuite Analytics has them: an agency puts its contract's counts
// ("12 posts and 50k reach a month") as targets for posts, reach, impressions, engagement and followers gained, for the
// whole org or one channel. Owners and admins set and remove them (social.goal.set, social.goal.remove, R1, audited);
// every member sees how the month stands (social.goal.progress): each count against its target, a linear projection
// to the end of the month and met or missed, in the goals' time zone. The client report of exactly one month shows the
// same goals (its view definer counts them), and the scheduled report mail carries one line of them.
//
// The counts are the Metrics tab's (periodTotals, the latest real answer of each post published in the month); a
// goal's engagement adds reactions, comments, shares, saves and clicks, as the client report does; followers gained is
// the last follower count of the month against the last one in the month before it (or the month's first), from the
// daily account snapshots, on the days (UTC) whose midday is in the month.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import {
  GOAL_DEFAULT_TIME_ZONE,
  GOAL_TARGET_MAX,
  goalEngagement,
  goalProgress,
  isMonthKey,
  monthBounds,
  monthKeyAt,
  monthOfPeriod,
  targetsOf,
  type GoalMetric,
  type GoalProgress,
  type GoalStatus,
} from './domain/goals.ts';
import { isValidTimeZone } from './domain/queue.ts';
import { storedZone } from './zones.ts';
import { periodTotals } from './metrics.ts';
import type { Trx } from './variants.ts';
import { channelScope, mayUse } from './channel-access.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
// Goal rows an org keeps at most: its own and its channels'.
export const GOALS_MAX = 100;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

const zTarget = z.number().int().min(1).max(GOAL_TARGET_MAX).nullable().optional();
const zTimeZone = z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone');
export const zGoalSet = z.strictObject({
  // null: the whole org.
  connectionId: zId.nullable(),
  targets: z.strictObject({ posts: zTarget, reach: zTarget, impressions: zTarget, engagement: zTarget, followersGained: zTarget }),
  // The zone months are counted in, for every goal of the org.
  timeZone: zTimeZone,
});

// One write at a time per org, so the zone stays the same on every row and the count holds until the commit.
const lockOrg = (ctx: CommandContext) => sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.goal:${ctx.orgId}`}))`.execute(ctx.trx);

// Sets the targets of a scope (the org, or one of its live channels); with none set, removes the scope's goals. The
// zone goes on every goal of the org.
export const goalSet = defineCommand({
  name: 'social.goal.set',
  input: zGoalSet,
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    if (input.connectionId !== null) {
      const found = await ctx.trx
        .selectFrom('crove_kernel.channel_connection')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .where('status', '<>', 'revoked')
        .executeTakeFirst();
      if (!found) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    }
    await lockOrg(ctx);
    // As PostgreSQL spells it (#1115), so the digest's zone rule finds it.
    const timeZone = await storedZone(ctx.trx, input.timeZone);
    // bigint columns take decimal strings.
    const count = (n: number | null | undefined) => (typeof n === 'number' ? String(n) : null);
    const values = {
      posts: count(input.targets.posts),
      reach: count(input.targets.reach),
      impressions: count(input.targets.impressions),
      engagement: count(input.targets.engagement),
      followers_gained: count(input.targets.followersGained),
    };
    const existing = await ctx.trx
      .selectFrom('crove_social.goal')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where((eb) => (input.connectionId === null ? eb('connection_id', 'is', null) : eb('connection_id', '=', input.connectionId)))
      .executeTakeFirst();
    const targets = targetsOf(input.targets);
    if (targets.length === 0) {
      if (existing) await ctx.trx.deleteFrom('crove_social.goal').where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
      ctx.audit({ connection_id: input.connectionId, removed: Boolean(existing) });
      return { goalId: existing?.id ?? null };
    }
    let goalId: string;
    if (existing) {
      await ctx.trx
        .updateTable('crove_social.goal')
        .set({ ...values, time_zone: timeZone, updated_by: userId, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
      goalId = existing.id;
    } else {
      const rows = await ctx.trx.selectFrom('crove_social.goal').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
      if (Number(rows.n) >= GOALS_MAX) throw new DomainError('GOAL_LIMIT', 409, `Mỗi tổ chức đặt tối đa ${GOALS_MAX} nhóm mục tiêu`);
      const row = await ctx.trx
        .insertInto('crove_social.goal')
        .values({ org_id: ctx.orgId, connection_id: input.connectionId, time_zone: timeZone, ...values, created_by: userId, created_at: ctx.now, updated_by: userId, updated_at: ctx.now })
        .returning('id')
        .executeTakeFirstOrThrow();
      goalId = row.id;
    }
    // Every goal of the org is counted in the same zone.
    await ctx.trx
      .updateTable('crove_social.goal')
      .set({ time_zone: timeZone, updated_by: userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('time_zone', '<>', timeZone)
      .execute();
    ctx.audit({ goal_id: goalId, connection_id: input.connectionId, time_zone: timeZone, targets: Object.fromEntries(targets.map((t) => [t.metric, t.target])) });
    return { goalId };
  },
});

export const goalRemove = defineCommand({
  name: 'social.goal.remove',
  input: z.strictObject({ connectionId: zId.nullable() }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const gone = await ctx.trx
      .deleteFrom('crove_social.goal')
      .where('org_id', '=', ctx.orgId)
      .where((eb) => (input.connectionId === null ? eb('connection_id', 'is', null) : eb('connection_id', '=', input.connectionId)))
      .returning('id')
      .executeTakeFirst();
    if (!gone) throw new DomainError('GOAL_NOT_FOUND', 404, 'Không tìm thấy mục tiêu này');
    ctx.audit({ goal_id: gone.id, connection_id: input.connectionId });
    return { goalId: gone.id };
  },
});

export interface GoalRow {
  id: string;
  connectionId: string | null;
  timeZone: string;
  targets: Record<GoalMetric, number | null>;
  updatedBy: string;
  updatedAt: string;
}

/** The org's goals: its own first, then its channels'. */
export async function goalsOf(trx: Trx, orgId: string): Promise<GoalRow[]> {
  const rows = await trx
    .selectFrom('crove_social.goal')
    .select(['id', 'connection_id', 'time_zone', 'posts', 'reach', 'impressions', 'engagement', 'followers_gained', 'updated_by', 'updated_at'])
    .where('org_id', '=', orgId)
    .orderBy(sql`connection_id IS NOT NULL`)
    .orderBy('created_at')
    .limit(GOALS_MAX)
    .execute();
  const n = (v: string | number | null) => (v === null ? null : Number(v));
  return rows.map((r) => ({
    id: r.id,
    connectionId: r.connection_id,
    timeZone: r.time_zone,
    targets: { posts: n(r.posts), reach: n(r.reach), impressions: n(r.impressions), engagement: n(r.engagement), followersGained: n(r.followers_gained) },
    updatedBy: r.updated_by,
    updatedAt: r.updated_at.toISOString(),
  }));
}

export type GoalActuals = Record<GoalMetric, number | null>;

/**
 * The counts goals are measured with in [start, end): the org's (every channel) and each channel's. A count a channel
 * never reported is null when it published something (a platform without reach, say) and 0 when it published nothing.
 */
export async function goalActuals(trx: Trx, orgId: string, start: Date, end: Date): Promise<{ org: GoalActuals; channels: Map<string, GoalActuals> }> {
  const totals = await periodTotals(trx, orgId, start, end);
  const followers = await followersGained(trx, orgId, start, end);
  const actualsOf = (posts: number, metrics: Readonly<Record<string, number>>, gained: number | null): GoalActuals => {
    const count = (name: string) => (Number.isFinite(metrics[name]) ? (metrics[name] as number) : posts === 0 ? 0 : null);
    const engagement = goalEngagement(metrics);
    return { posts, reach: count('reach'), impressions: count('impressions'), engagement: engagement ?? (posts === 0 ? 0 : null), followersGained: gained };
  };
  const channels = new Map<string, GoalActuals>();
  const ids = new Set([...totals.channels.map((c) => c.connectionId), ...followers.keys()]);
  for (const id of ids) {
    const c = totals.channels.find((x) => x.connectionId === id);
    channels.set(id, actualsOf(c?.posts ?? 0, c?.metrics ?? {}, followers.get(id) ?? null));
  }
  const gained = [...followers.values()];
  return { org: actualsOf(totals.posts, totals.metrics, gained.length === 0 ? null : gained.reduce((a, b) => a + b, 0)), channels };
}

// Followers gained per channel in [start, end): the last count of the period against the last one in the month before
// it (FOLLOWER_BASE_DAYS), or the period's first when there is none, so a channel counted again after a long gap does
// not credit the gap to this period. Days are UTC days, in the period when their midday is.
const FOLLOWER_BASE_DAYS = 31;
async function followersGained(trx: Trx, orgId: string, start: Date, end: Date): Promise<Map<string, number>> {
  const { rows } = await sql<{ conn: string; gained: string }>`
    WITH s AS (
      SELECT s.channel_connection_id AS conn, s.captured_on, s.followers, (s.captured_on + time '12:00') AT TIME ZONE 'UTC' AS midday
      FROM crove_social.account_snapshot s
      WHERE s.org_id = ${orgId} AND s.followers IS NOT NULL
        AND s.captured_on >= (${start}::timestamptz AT TIME ZONE 'UTC')::date - ${FOLLOWER_BASE_DAYS + 1}::int
        AND s.captured_on <= (${end}::timestamptz AT TIME ZONE 'UTC')::date
    ), inside AS (
      SELECT * FROM s WHERE s.midday >= ${start} AND s.midday < ${end}
    ), last AS (
      SELECT DISTINCT ON (conn) conn, followers FROM inside ORDER BY conn, captured_on DESC
    ), first AS (
      SELECT DISTINCT ON (conn) conn, followers FROM inside ORDER BY conn, captured_on
    ), before AS (
      SELECT DISTINCT ON (conn) conn, followers FROM s
      WHERE s.midday < ${start} AND s.midday >= ${start}::timestamptz - pg_catalog.make_interval(secs => ${FOLLOWER_BASE_DAYS * 86_400}::int)
      ORDER BY conn, captured_on DESC
    )
    SELECT last.conn, (last.followers - coalesce(before.followers, first.followers))::text AS gained
    FROM last JOIN first ON first.conn = last.conn LEFT JOIN before ON before.conn = last.conn`.execute(trx);
  return new Map(rows.map((r) => [r.conn, Number(r.gained)]));
}

export interface GoalView extends GoalRow {
  progress: GoalProgress[];
}

export interface GoalsProgressView {
  // The zone the org's goals are counted in; null before any is set (the month is then counted in the default zone).
  timeZone: string | null;
  month: string;
  periodStart: string;
  periodEnd: string;
  goals: GoalView[];
}

const zMonth = z.string().refine(isMonthKey, 'month is YYYY-MM');

// How the month (the current one by default) stands against the org's goals, for every member.
export const goalProgressQuery = defineQuery({
  name: 'social.goal.progress',
  input: z.object({ month: zMonth.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<GoalsProgressView> => {
    // A query has no clock of its own; the month and its progress are of this moment.
    const now = Date.now();
    const all = await goalsOf(ctx.trx, ctx.orgId);
    // A member limited to some channels (#1081) sees the goals of those channels only: the org's own goals count every
    // channel, so their progress would give away the others' numbers (as a report on some channels leaves them out).
    const scope = await channelScope(ctx);
    const rows = all.filter((g) => (g.connectionId === null ? scope === null : mayUse(scope, g.connectionId)));
    const stored = all[0]?.timeZone ?? null;
    const timeZone = stored !== null && isValidTimeZone(stored) ? stored : GOAL_DEFAULT_TIME_ZONE;
    const month = input.month ?? monthKeyAt(now, timeZone);
    const bounds = monthBounds(month, timeZone);
    if (!bounds) throw new DomainError('VALIDATION', 422, 'Tháng không hợp lệ');
    const view = { timeZone: stored, month, periodStart: new Date(bounds.start).toISOString(), periodEnd: new Date(bounds.end).toISOString() };
    if (rows.length === 0) return { ...view, goals: [] };
    const actuals = await goalActuals(ctx.trx, ctx.orgId, new Date(bounds.start), new Date(bounds.end));
    const none: GoalActuals = { posts: 0, reach: 0, impressions: 0, engagement: 0, followersGained: null };
    return {
      ...view,
      goals: rows.map((g) => {
        const a = g.connectionId === null ? actuals.org : (actuals.channels.get(g.connectionId) ?? none);
        return { ...g, progress: targetsOf(g.targets).map((t) => goalProgress({ ...t, actual: a[t.metric] }, bounds, now)) };
      }),
    };
  },
});

export interface ReportGoal {
  // The channel's name, null for the org's own goals.
  channel: string | null;
  metric: GoalMetric;
  target: number;
  actual: number | null;
  status: GoalStatus;
}

/**
 * The goals a report of [start, end) on some channels (none: every channel) shows, as the client report does: only
 * when the period is exactly one month in the goals' zone; the org's own goals only when it covers every channel, and
 * the goals of each channel it covers. null when there is nothing to show.
 */
export async function reportGoals(trx: Trx, orgId: string, start: Date, end: Date, connectionIds: readonly string[], nowMs: number): Promise<{ month: string; goals: ReportGoal[] } | null> {
  const rows = await goalsOf(trx, orgId);
  const zone = rows[0]?.timeZone;
  if (!zone || !isValidTimeZone(zone)) return null;
  const month = monthOfPeriod(start.getTime(), end.getTime(), zone);
  if (!month) return null;
  const all = connectionIds.length === 0;
  const shown = rows.filter((g) => (g.connectionId === null ? all : all || connectionIds.includes(g.connectionId)));
  if (shown.length === 0) return null;
  const ids = shown.flatMap((g) => (g.connectionId === null ? [] : [g.connectionId]));
  const names = new Map(
    ids.length === 0 ? [] : (await trx.selectFrom('crove_kernel.channel_connection').select(['id', 'display_name']).where('org_id', '=', orgId).where('id', 'in', ids).execute()).map((c) => [c.id, c.display_name] as const),
  );
  const actuals = await goalActuals(trx, orgId, start, end);
  const none: GoalActuals = { posts: 0, reach: 0, impressions: 0, engagement: 0, followersGained: null };
  const bounds = { start: start.getTime(), end: end.getTime() };
  const goals = shown.flatMap((g) => {
    const a = g.connectionId === null ? actuals.org : (actuals.channels.get(g.connectionId) ?? none);
    const channel = g.connectionId === null ? null : (names.get(g.connectionId) ?? null);
    return targetsOf(g.targets).map((t) => {
      const p = goalProgress({ ...t, actual: a[t.metric] }, bounds, nowMs);
      return { channel, metric: t.metric, target: t.target, actual: p.actual, status: p.status };
    });
  });
  return { month, goals };
}

export const goalCommands = [goalSet, goalRemove];
export const goalQueries = [goalProgressQuery];
