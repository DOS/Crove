// The figures of a period for its AI summary (#1237): the Metrics tab's window (days) or a client report's period
// (periodStart, periodEnd), on the channels the caller may use (#1081) and the ones they chose, with a label's posts
// only, or with the posts published outside Crove. The totals are the tab's own (spanTotals), so the summary repeats
// the numbers and the engagement rate the tab and the report show; the goals are the report's (reportGoals), only for a
// period of exactly one month and never under a label. The API turns the answer into the writer's figures
// (periodSummaryInput); nothing is saved here.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { channelScope, refuseOutside } from './channel-access.ts';
import { GOAL_DEFAULT_TIME_ZONE, GOAL_ENGAGEMENT_COUNTS } from './domain/goals.ts';
import type { PeriodSummaryData, SummaryTotals } from './domain/period-summary.ts';
import { SUMMARY_TOP_MAX } from './domain/period-summary.ts';
import { isValidTimeZone, localTime } from './domain/queue.ts';
import { reportGoals } from './goals.ts';
import { channelKept, currentAndPrevious, inSpan, spanTotals, type Span, type SpanFilter } from './metrics.ts';
import { REPORT_PERIOD_MAX_DAYS } from './report-links.ts';
import type { Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DAY_MS = 86_400_000;
// Days picked in a zone with daylight saving can be an hour longer than 24 h, as for report links.
const DST_SLACK_MS = 2 * 3_600_000;
const zInstant = z.iso.datetime({ offset: true });

export const zSummaryFiguresInput = z
  .strictObject({
    days: z.number().int().min(1).max(365).optional(),
    periodStart: zInstant.optional(),
    periodEnd: zInstant.optional(),
    connectionIds: z.array(zId).max(50).optional(),
    labelId: zId.optional(),
    includeExternal: z.boolean().optional(),
    // The zone the period's dates are written in; the goals' default otherwise.
    timeZone: z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone').optional(),
  })
  .refine((i) => (i.days !== undefined) !== (i.periodStart !== undefined || i.periodEnd !== undefined) && (i.periodStart === undefined) === (i.periodEnd === undefined), 'days, or periodStart and periodEnd');

const dateIn = (epochMs: number, timeZone: string) => {
  const l = localTime(epochMs, timeZone);
  return `${String(l.year).padStart(4, '0')}-${String(l.month).padStart(2, '0')}-${String(l.day).padStart(2, '0')}`;
};
const summaryTotals = (t: SummaryTotals): SummaryTotals => ({ posts: t.posts, metrics: t.metrics, clicks: t.clicks, rateBases: t.rateBases });

export const summaryFigures = defineQuery({
  name: 'social.metrics.summary_figures',
  input: zSummaryFiguresInput,
  access: ALL,
  handler: async (ctx, input): Promise<PeriodSummaryData> => {
    const scope = await channelScope(ctx);
    const ids = [...new Set(input.connectionIds ?? [])];
    refuseOutside(scope, ids);
    if (ids.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    }
    if (input.labelId) {
      const label = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.labelId).executeTakeFirst();
      if (!label) throw new DomainError('LABEL_NOT_FOUND', 404, 'Không tìm thấy nhãn này');
    }
    const filter: SpanFilter = { labelId: input.labelId, external: input.includeExternal === true && !input.labelId, scope, connectionIds: ids };
    // A query has no clock of its own; a window ends now.
    const now = Date.now();
    let span: Span;
    let before: Span;
    let startMs: number;
    let endMs: number;
    if (input.days !== undefined) {
      span = { days: input.days, before: 0 };
      before = { days: input.days, before: input.days };
      endMs = now;
      startMs = now - input.days * DAY_MS;
    } else {
      startMs = Date.parse(input.periodStart as string);
      endMs = Date.parse(input.periodEnd as string);
      if (endMs <= startMs || endMs - startMs > REPORT_PERIOD_MAX_DAYS * DAY_MS + DST_SLACK_MS) {
        throw new DomainError('REPORT_PERIOD_INVALID', 422, `Kỳ báo cáo phải kết thúc sau ngày bắt đầu và dài tối đa ${REPORT_PERIOD_MAX_DAYS} ngày`);
      }
      span = { start: new Date(startMs), end: new Date(endMs) };
      before = { start: new Date(startMs - (endMs - startMs)), end: new Date(startMs) };
    }
    const totals = currentAndPrevious(await spanTotals(ctx.trx, ctx.orgId, span, filter), await spanTotals(ctx.trx, ctx.orgId, before, filter));
    const top = await topPosts(ctx.trx, ctx.orgId, span, filter);
    const conns = [...new Set([...totals.channels.map((c) => c.connectionId), ...top.map((p) => p.conn)])];
    const names = new Map(
      conns.length === 0 ? [] : (await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['id', 'display_name']).where('org_id', '=', ctx.orgId).where('id', 'in', conns).execute()).map((c) => [c.id, c.display_name] as const),
    );
    // The goals as the client report shows them: a period of exactly one month, no label; the org's own only when the
    // caller sees and chose every channel (a limited member gets their channels' goals only, as social.goal.progress).
    const goals =
      'start' in span && !input.labelId ? await reportGoals(ctx.trx, ctx.orgId, span.start, span.end, ids.length > 0 ? ids : scope === null ? [] : [...scope], now) : null;
    const zone = input.timeZone ?? GOAL_DEFAULT_TIME_ZONE;
    const length = endMs - startMs;
    return {
      dates: { from: dateIn(startMs, zone), to: dateIn(endMs - 1, zone), previousFrom: dateIn(startMs - length, zone), previousTo: dateIn(startMs - 1, zone) },
      days: input.days ?? Math.round(length / DAY_MS),
      current: summaryTotals(totals),
      previous: summaryTotals(totals.previous),
      channels: totals.channels.map((c) => ({ name: names.get(c.connectionId) ?? c.provider, provider: c.provider, current: summaryTotals(c) })),
      top: top.map((p) => ({ channel: names.get(p.conn) ?? p.provider, excerpt: p.body, metrics: p.metrics })),
      goals: goals ? goals.goals : null,
    };
  },
});

// The span's posts with the most engagement (reactions, comments, shares, saves and the platforms' clicks, as the
// client report ranks its top posts), then the most seen; only posts with a count of engagement.
async function topPosts(trx: Trx, orgId: string, span: Span, filter: SpanFilter): Promise<{ conn: string; provider: string; body: string; metrics: Record<string, number> }[]> {
  const labelled = filter.labelId
    ? sql`AND EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = ${filter.labelId}::uuid)`
    : sql``;
  const outside =
    filter.external && !filter.labelId
      ? sql`UNION ALL
        SELECT e.channel_connection_id, c.provider, e.excerpt, e.published_at, e.metrics FROM crove_social.external_post e
        JOIN crove_kernel.channel_connection c ON c.org_id = e.org_id AND c.id = e.channel_connection_id
        WHERE e.org_id = ${orgId} AND ${inSpan(span, 'e.published_at')} AND ${channelKept(filter, 'e.channel_connection_id')}
          AND NOT crove_social.external_post_is_crove(e.org_id, e.channel_connection_id, e.external_post_id, e.permalink)`
      : sql``;
  const { rows } = await sql<{ conn: string; provider: string; body: string | null; metrics: Record<string, number> }>`
    WITH v AS (
      SELECT v.channel_connection_id AS conn, v.provider, coalesce(v.body, p.body) AS body, v.published_at, coalesce(s.metrics, '{}'::jsonb) AS metrics
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      LEFT JOIN LATERAL (
        SELECT m.metrics FROM crove_social.metric_snapshot m
        WHERE m.org_id = v.org_id AND m.variant_id = v.id
        ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
      ) s ON true
      WHERE v.org_id = ${orgId} AND v.status = 'published' AND ${inSpan(span, 'v.published_at')} ${labelled} AND ${channelKept(filter, 'v.channel_connection_id')}
      ${outside}
    ), scored AS (
      SELECT v.*,
             (SELECT sum((e.value #>> '{}')::numeric) FROM jsonb_each(v.metrics) e WHERE jsonb_typeof(e.value) = 'number' AND e.key = ANY(${[...GOAL_ENGAGEMENT_COUNTS]}::text[])) AS engagement,
             (SELECT coalesce(sum((e.value #>> '{}')::numeric), 0) FROM jsonb_each(v.metrics) e WHERE jsonb_typeof(e.value) = 'number' AND e.key IN ('views', 'impressions', 'reach')) AS seen
      FROM v
    )
    SELECT conn, provider, body, metrics FROM scored WHERE engagement IS NOT NULL
    ORDER BY engagement DESC, seen DESC, published_at DESC
    LIMIT ${SUMMARY_TOP_MAX}`.execute(trx);
  return rows.map((r) => ({ conn: r.conn, provider: r.provider, body: r.body ?? '', metrics: Object.fromEntries(Object.entries(r.metrics ?? {}).filter(([, v]) => typeof v === 'number')) }));
}

export const periodSummaryQueries = [summaryFigures];
