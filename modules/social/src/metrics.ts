// Metrics of published posts (Social plan S8, issue #238). The worker asks each platform how a published variant is
// doing every few hours for 30 days after it went out, and keeps every answer as an append-only snapshot; the
// analytics screen shows the latest one per variant. Counts are normalized (channel METRIC_NAMES); a count a platform
// does not report is absent, never zero.
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { METRIC_NAMES, POST_METRIC_NAMES, STORY_METRIC_NAMES, postTypeOf, type PostType, type Publisher } from '@crove/channel';
import type { Db } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import type { Trx } from './variants.ts';
import { labelsOfPosts } from './labels.ts';
import { formatOf, whatWorks, type ChannelInsights, type InsightSample } from './domain/insights.ts';
import { isValidTimeZone } from './domain/queue.ts';
import { runAutoReply } from './auto-reply.ts';
import { runRepost } from './repost.ts';
import { autoReplyOf, repostRuleOf } from './domain/channels.ts';
import { csvCell } from './domain/csv.ts';
import { STORY_EXPIRED_KEY, STORY_FINAL_KEY, storyCapture } from './domain/story-metrics.ts';
import { channelScope, connectionInScope, type ChannelScope } from './channel-access.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// How often a published variant is asked again, and how far back the summary looks by default.
export const METRICS_INTERVAL_SECONDS = 6 * 3600;
export const METRICS_SWEEP_MS = 15 * 60_000;
const METRICS_LIMIT = 200;
// A pass asks a few platforms at once (#397): at most METRICS_CONCURRENCY variants in flight, METRICS_PER_PROVIDER on
// one platform, so a slow platform cannot hold the pass and none is asked many things at once.
const METRICS_CONCURRENCY = 6;
const METRICS_PER_PROVIDER = 2;
const ACTOR: SystemActor = { type: 'system', component: 'social.metrics' };

const zCount = z.number().int().min(0).max(1e12);
const zMetrics = z.partialRecord(z.enum(METRIC_NAMES), zCount);
const zExtra = z.record(z.string().max(100), z.json()).refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 8192, 'extra over 8 KiB');

// The capture a moment falls in: one per 6 hours, so a sweep that runs twice in a bucket records once.
export function captureKey(at: Date): string {
  const hour = Math.floor(at.getUTCHours() / 6) * 6;
  return `${at.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}`;
}

export const metricsRecord = defineCommand({
  name: 'social.metrics.record',
  input: z.strictObject({ variantId: zId, captureKey: z.string().min(1).max(100), metrics: zMetrics, extra: zExtra.optional() }),
  risk: 'R0',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const inserted = await ctx.trx
      .insertInto('crove_social.metric_snapshot')
      .values({ org_id: ctx.orgId, variant_id: input.variantId, capture_key: input.captureKey, metrics: JSON.stringify(input.metrics), extra: input.extra ? JSON.stringify(input.extra) : null })
      .onConflict((oc) => oc.columns(['org_id', 'variant_id', 'capture_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return { recorded: Boolean(inserted) };
  },
});

// What the sweep needs to ask a platform about a variant: its connection and the platform's id of the post.
export const metricsTarget = defineQuery({
  name: 'social.metrics.target',
  input: z.strictObject({ variantId: zId }),
  access: 'system',
  handler: async (ctx, input) => {
    const row = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['channel_connection_id', 'external_post_id', 'provider', 'status', 'settings', 'published_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.variantId)
      .executeTakeFirst();
    if (!row || row.status !== 'published' || !row.external_post_id) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy bài đã đăng này');
    const reply = autoReplyOf((row.settings ?? {}) as Record<string, unknown>);
    const repostOf = (s: unknown) => {
      const rule = repostRuleOf((s ?? {}) as Record<string, unknown>);
      return rule && rule !== 'invalid' ? rule : null;
    };
    // The like count that sets off the variant's auto-reply (#746), so the sweep begins one only when it is reached; its
    // post type and publish time, so a Story is asked for its own metrics and captured before it expires (#1082).
    return {
      connectionId: row.channel_connection_id,
      externalPostId: row.external_post_id,
      provider: row.provider,
      autoReplyLikes: reply && reply !== 'invalid' ? reply.likes : null,
      repost: repostOf(row.settings),
      postType: postTypeOf((row.settings ?? {}) as Record<string, unknown>),
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
    };
  },
});

export interface MetricsRow {
  variantId: string;
  postId: string;
  provider: string;
  connectionId: string;
  excerpt: string;
  publishedAt: string | null;
  externalUrl: string | null;
  metrics: Record<string, number>;
  capturedAt: string | null;
  // Clicks on its short link (#706); null when it went out without one.
  clicks: number | null;
}

// The latest snapshot of each variant published in the window, newest first; or of one post's published channels,
// whenever they went out (#578, the post screen). labelId: only posts with that label (#639). A member limited to some
// channels (#1081) sees those only, here and in the totals, the export and the insights.
export const metricsSummary = defineQuery({
  name: 'social.metrics.summary',
  input: z.object({ days: z.number().int().min(1).max(365).optional(), postId: zId.optional(), labelId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<MetricsRow[]> => (await latestMetrics(ctx.trx, ctx.orgId, input, SUMMARY_LIMIT, await channelScope(ctx))).map(({ text: _text, ...row }) => row),
});

// What the screens show at most, and what one export holds at most (it says when it was cut).
const SUMMARY_LIMIT = 500;

// A window's totals: how many variants went out, the sum of each count, and the clicks on their short links (null
// when none went out with one).
export interface MetricsTotals {
  posts: number;
  metrics: Record<string, number>;
  clicks: number | null;
}
export interface ChannelTotals extends MetricsTotals {
  connectionId: string;
  provider: string;
}
export interface WindowTotals extends MetricsTotals {
  channels: ChannelTotals[];
}

// The window's totals (#397), summed in SQL over every published channel, not only the rows the summary lists: the
// last real answer of each, and the clicks on its short links (null when no channel sent links through them); also
// per channel. previous (#947): the same for the window of the same length just before, so a screen can show the
// change. Both list every channel with posts in either window (0 posts and no counts in the one it did not post in),
// in the same order (most posts now, then most before), so the channels add up to both windows' totals.
// includeExternal (#1054): the posts each channel published outside Crove count too, in both windows; they carry no
// label, so a label filter leaves them out. Without it the totals are Crove's posts alone, as before.
export const metricsTotals = defineQuery({
  name: 'social.metrics.totals',
  input: z.object({ days: z.number().int().min(1).max(365).optional(), labelId: zId.optional(), includeExternal: z.boolean().optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<WindowTotals & { previous: WindowTotals }> => {
    const days = input.days ?? 30;
    const external = input.includeExternal === true && !input.labelId;
    const scope = await channelScope(ctx);
    const current = await windowTotals(ctx.trx, ctx.orgId, days, 0, input.labelId, external, scope);
    const previous = await windowTotals(ctx.trx, ctx.orgId, days, days, input.labelId, external, scope);
    const now = new Map(current.channels.map((c) => [c.connectionId, c] as const));
    const before = new Map(previous.channels.map((c) => [c.connectionId, c] as const));
    const none = (c: ChannelTotals): ChannelTotals => ({ connectionId: c.connectionId, provider: c.provider, posts: 0, metrics: {}, clicks: null });
    const ids = [...new Set([...now.keys(), ...before.keys()])].sort(
      (a, b) => (now.get(b)?.posts ?? 0) - (now.get(a)?.posts ?? 0) || (before.get(b)?.posts ?? 0) - (before.get(a)?.posts ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
    );
    const union = (own: Map<string, ChannelTotals>, other: Map<string, ChannelTotals>) => ids.map((id) => own.get(id) ?? none(other.get(id) as ChannelTotals));
    return { ...current, channels: union(now, before), previous: { ...previous, channels: union(before, now) } };
  },
});

// The totals of the variants published in the days-long window that ends `before` days ago (0: now, open-ended);
// external: with the channels' posts published outside Crove in the same window (their latest real counts, no clicks),
// leaving out the ones that are Crove's own (crove_social.external_post_is_crove).
async function windowTotals(trx: Trx, orgId: string, days: number, before: number, labelId: string | undefined, external = false, scope: ChannelScope = null): Promise<WindowTotals> {
  const labelled = labelId
    ? sql`AND EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = ${labelId}::uuid)`
    : sql``;
  const end = sql`pg_catalog.now() - pg_catalog.make_interval(days => ${before}::int)`;
  const ends = before === 0 ? sql`` : sql`AND v.published_at <= ${end}`;
  // A window before now counts its posts' short link clicks up to its end only, on the days (UTC) whose midday is in
  // it, as the client report does; the later clicks belong to the windows after it. A post's clicks all come after it
  // went out, so the start needs no bound.
  const clickedBy = before === 0 ? sql`` : sql`AND (c.day + time '12:00') AT TIME ZONE 'UTC' <= ${end}`;
  const outside = external
    ? sql`e.published_at > pg_catalog.now() - pg_catalog.make_interval(days => ${days + before}::int) ${before === 0 ? sql`` : sql`AND e.published_at <= ${end}`} AND ${connectionInScope(scope, 'e.channel_connection_id')}`
    : undefined;
  return totalsWhere(trx, orgId, sql`v.published_at > pg_catalog.now() - pg_catalog.make_interval(days => ${days + before}::int) ${ends} ${labelled} AND ${connectionInScope(scope, 'v.channel_connection_id')}`, clickedBy, outside);
}

/**
 * The totals of the variants published in [start, end), as the window totals add them up: the goals of a month
 * (#1056) count with these. Short link clicks up to the end only, on the days (UTC) whose midday is before it.
 */
export function periodTotals(trx: Trx, orgId: string, start: Date, end: Date): Promise<WindowTotals> {
  return totalsWhere(trx, orgId, sql`v.published_at >= ${start} AND v.published_at < ${end}`, sql`AND (c.day + time '12:00') AT TIME ZONE 'UTC' < ${end}`);
}

// outsidePublished (#1054): when given, the channels' posts published outside Crove whose time it takes (as e) count
// too, with their latest real counts and no clicks; without it the SQL is Crove's posts alone, as before.
async function totalsWhere(trx: Trx, orgId: string, published: RawBuilder<unknown>, clickedBy: RawBuilder<unknown>, outsidePublished?: RawBuilder<unknown>): Promise<WindowTotals> {
  const outside = outsidePublished
    ? sql`, x AS (
      SELECT e.channel_connection_id AS conn, c.provider, e.metrics FROM crove_social.external_post e
      JOIN crove_kernel.channel_connection c ON c.org_id = e.org_id AND c.id = e.channel_connection_id
      WHERE e.org_id = ${orgId} AND ${outsidePublished}
        AND NOT crove_social.external_post_is_crove(e.org_id, e.channel_connection_id, e.external_post_id, e.permalink)
    )`
    : sql``;
  const outsideCounts = outsidePublished ? sql`UNION ALL SELECT x.conn, x.metrics FROM x WHERE x.metrics <> '{}'::jsonb` : sql``;
  const posted = outsidePublished ? sql`(SELECT v.conn, v.provider FROM v UNION ALL SELECT x.conn, x.provider FROM x) v` : sql`v`;
  const { rows } = await sql<{ conn: string; provider: string; posts: string; metrics: Record<string, number>; clicks: string | null }>`
    WITH v AS (
      SELECT v.org_id, v.id, v.channel_connection_id AS conn, v.provider FROM crove_social.post_variant v
      WHERE v.org_id = ${orgId} AND v.status = 'published' AND ${published}
    )${outside}, latest AS (
      SELECT v.conn, s.metrics FROM v CROSS JOIN LATERAL (
        SELECT m.metrics FROM crove_social.metric_snapshot m
        WHERE m.org_id = v.org_id AND m.variant_id = v.id
        ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
      ) s
      ${outsideCounts}
    ), sums AS (
      SELECT latest.conn, e.key, sum((e.value #>> '{}')::numeric) AS total FROM latest, jsonb_each(latest.metrics) e
      WHERE jsonb_typeof(e.value) = 'number' GROUP BY latest.conn, e.key
    ), clicks AS (
      SELECT v.conn, coalesce(sum(c.clicks), 0) AS clicks FROM v
      JOIN crove_social.short_link l ON l.org_id = v.org_id AND l.variant_id = v.id
      LEFT JOIN crove_social.short_link_click c ON c.org_id = l.org_id AND c.short_link_id = l.id ${clickedBy}
      GROUP BY v.conn
    )
    SELECT v.conn, min(v.provider) AS provider, count(*) AS posts,
           (SELECT coalesce(jsonb_object_agg(s.key, s.total), '{}'::jsonb) FROM sums s WHERE s.conn = v.conn) AS metrics,
           (SELECT k.clicks FROM clicks k WHERE k.conn = v.conn) AS clicks
    FROM ${posted} GROUP BY v.conn
    ORDER BY count(*) DESC, v.conn`.execute(trx);
  const channels: ChannelTotals[] = rows.map((r) => {
    const metrics: Record<string, number> = {};
    for (const [name, value] of Object.entries(r.metrics ?? {})) metrics[name] = Number(value);
    return { connectionId: r.conn, provider: r.provider, posts: Number(r.posts), metrics, clicks: r.clicks === null ? null : Number(r.clicks) };
  });
  // The window's totals are the sums of its channels' (counts, never money).
  const metrics: Record<string, number> = {};
  for (const c of channels) for (const [name, value] of Object.entries(c.metrics)) metrics[name] = (metrics[name] ?? 0) + value;
  const linked = channels.filter((c) => c.clicks !== null);
  return { posts: channels.reduce((sum, c) => sum + c.posts, 0), metrics, clicks: linked.length === 0 ? null : linked.reduce((sum, c) => sum + (c.clicks ?? 0), 0), channels };
}
export const EXPORT_LIMIT = 10_000;

interface MetricsFilter {
  days?: number | undefined;
  postId?: string | undefined;
  labelId?: string | undefined;
}

async function latestMetrics(trx: Trx, orgId: string, input: MetricsFilter, limit: number, scope: ChannelScope): Promise<(MetricsRow & { text: string })[]> {
  const days = input.days ?? 30;
  const window = input.postId ? sql`v.post_id = ${input.postId}::uuid` : sql`v.published_at > pg_catalog.now() - pg_catalog.make_interval(days => ${days}::int)`;
  const labelled = input.labelId
    ? sql`AND EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = ${input.labelId}::uuid)`
    : sql``;
  const { rows } = await sql<{
    variant_id: string;
    post_id: string;
    provider: string;
    channel_connection_id: string;
    body: string;
    published_at: Date | null;
    external_url: string | null;
    metrics: Record<string, number> | null;
    captured_at: Date | null;
    clicks: string | null;
  }>`
    SELECT v.id AS variant_id, v.post_id, v.provider, v.channel_connection_id, coalesce(v.body, p.body) AS body,
           v.published_at, v.external_url, s.metrics, s.captured_at,
           (SELECT CASE WHEN count(l.id) = 0 THEN NULL ELSE coalesce(sum(c.clicks), 0) END FROM crove_social.short_link l
            LEFT JOIN crove_social.short_link_click c ON c.org_id = l.org_id AND c.short_link_id = l.id
            WHERE l.org_id = v.org_id AND l.variant_id = v.id) AS clicks
    FROM crove_social.post_variant v
    JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
    LEFT JOIN LATERAL (
      SELECT m.metrics, m.captured_at FROM crove_social.metric_snapshot m
      WHERE m.org_id = v.org_id AND m.variant_id = v.id
      -- The last real answer; an empty snapshot (a failed try, a gone post) only when there is nothing else.
      ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
    ) s ON true
    WHERE v.org_id = ${orgId} AND v.status = 'published' AND ${window} ${labelled} AND ${connectionInScope(scope, 'v.channel_connection_id')}
    ORDER BY v.published_at DESC
    LIMIT ${limit}`.execute(trx);
  return rows.map((r) => ({
    variantId: r.variant_id,
    postId: r.post_id,
    provider: r.provider,
    connectionId: r.channel_connection_id,
    excerpt: r.body.replace(/\s+/g, ' ').trim().slice(0, 160),
    text: r.body,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    externalUrl: r.external_url,
    metrics: r.metrics ?? {},
    capturedAt: r.captured_at ? r.captured_at.toISOString() : null,
    clicks: r.clicks === null ? null : Number(r.clicks),
  }));
}

// A cell as a spreadsheet reads it (domain/csv.ts, which the app shares through the contract).
export { csvCell };

// labelNames: each post's label names (#639), written as one cell joined by "; ". The Story counts (#1082) come last,
// so the columns a sheet already reads keep their places.
export function metricsCsv(rows: readonly (MetricsRow & { text?: string })[], channelNames: ReadonlyMap<string, string>, labelNames: ReadonlyMap<string, readonly string[]> = new Map()): string {
  const head = ['post_id', 'channel', 'provider', 'published_at', 'url', 'text', 'labels', ...POST_METRIC_NAMES, 'captured_at', ...STORY_METRIC_NAMES];
  const lines = rows.map((r) =>
    [r.postId, channelNames.get(r.connectionId) ?? '', r.provider, r.publishedAt, r.externalUrl, r.text ?? r.excerpt, (labelNames.get(r.postId) ?? []).join('; '), ...POST_METRIC_NAMES.map((m) => r.metrics[m] ?? null), r.capturedAt, ...STORY_METRIC_NAMES.map((m) => r.metrics[m] ?? null)]
      .map(csvCell)
      .join(','),
  );
  // A byte order mark, so a spreadsheet opens Vietnamese text as UTF-8.
  return `﻿${[head.join(','), ...lines].join('\r\n')}\r\n`;
}

// The window's metrics as a CSV file (#578): one row per published channel with its latest counts and its post's
// labels; labelId: only posts with that label (#639). A command, so every export leaves an audit row.
export const metricsExport = defineCommand({
  name: 'social.metrics.export',
  input: z.strictObject({ days: z.number().int().min(1).max(365), labelId: zId.optional() }),
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const rows = await latestMetrics(ctx.trx, ctx.orgId, { days: input.days, labelId: input.labelId }, EXPORT_LIMIT + 1, await channelScope(ctx));
    const truncated = rows.length > EXPORT_LIMIT;
    if (truncated) rows.length = EXPORT_LIMIT;
    const ids = [...new Set(rows.map((r) => r.connectionId))];
    const names = new Map(
      ids.length === 0
        ? []
        : (await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['id', 'display_name']).where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute()).map((c) => [c.id, c.display_name] as const),
    );
    const labels = await labelsOfPosts(ctx.trx, ctx.orgId, [...new Set(rows.map((r) => r.postId))]);
    const labelNames = new Map([...labels].map(([postId, list]) => [postId, list.map((l) => l.name)] as const));
    ctx.audit({ days: input.days, rows: rows.length, truncated, ...(input.labelId ? { labelId: input.labelId } : {}) });
    return { filename: `social-metrics-${input.days}d-${ctx.now.toISOString().slice(0, 10)}.csv`, csv: metricsCsv(rows, names, labelNames), truncated };
  },
});

// What works (#705): each channel's posts of the window against its own median, by label, format, weekday, hour (in
// the viewer's time zone) and hashtag, with its best and worst posts. From the latest capture of each published
// variant, at most INSIGHT_LIMIT of them, newest first.
export const INSIGHT_LIMIT = 2000;
export interface InsightPost {
  variantId: string;
  postId: string;
  excerpt: string;
  publishedAt: string | null;
  externalUrl: string | null;
  engagement: number;
}
export interface ChannelInsightsView extends Omit<ChannelInsights, 'best' | 'worst'> {
  provider: string;
  best: InsightPost[];
  worst: InsightPost[];
}
export const metricsInsights = defineQuery({
  name: 'social.metrics.insights',
  input: z.object({ days: z.number().int().min(1).max(365), labelId: zId.optional(), timeZone: z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone') }),
  access: ALL,
  handler: async (ctx, input): Promise<{ channels: ChannelInsightsView[]; truncated: boolean }> => {
    const labelled = input.labelId
      ? sql`AND EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = ${input.labelId}::uuid)`
      : sql``;
    const { rows } = await sql<{
      variant_id: string;
      post_id: string;
      provider: string;
      channel_connection_id: string;
      body: string;
      published_at: Date | null;
      external_url: string | null;
      post_type: string | null;
      media_types: string[] | null;
      label_ids: string[] | null;
      metrics: Record<string, number> | null;
    }>`
      SELECT v.id AS variant_id, v.post_id, v.provider, v.channel_connection_id, coalesce(v.body, p.body) AS body,
             v.published_at, v.external_url, v.settings->>'postType' AS post_type,
             CASE WHEN jsonb_typeof(v.media) = 'array' THEN (
               SELECT array_agg(f.content_type ORDER BY x.n) FROM jsonb_array_elements(v.media) WITH ORDINALITY x(e, n)
               JOIN crove_kernel.file f ON f.org_id = v.org_id AND f.id::text = x.e->>'fileId'
             ) ELSE (
               SELECT array_agg(f.content_type ORDER BY m.position) FROM crove_social.post_media m
               JOIN crove_kernel.file f ON f.org_id = m.org_id AND f.id = m.file_id
               WHERE m.org_id = v.org_id AND m.post_id = v.post_id
             ) END AS media_types,
             (SELECT array_agg(pl.label_id) FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id) AS label_ids,
             s.metrics
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      LEFT JOIN LATERAL (
        SELECT m.metrics FROM crove_social.metric_snapshot m
        WHERE m.org_id = v.org_id AND m.variant_id = v.id
        ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
      ) s ON true
      WHERE v.org_id = ${ctx.orgId} AND v.status = 'published'
        AND v.published_at > pg_catalog.now() - pg_catalog.make_interval(days => ${input.days}::int) ${labelled}
        AND ${connectionInScope(await channelScope(ctx), 'v.channel_connection_id')}
      ORDER BY v.published_at DESC
      LIMIT ${INSIGHT_LIMIT + 1}`.execute(ctx.trx);
    const kept = rows.slice(0, INSIGHT_LIMIT);
    const samples: InsightSample[] = kept.map((r) => ({
      variantId: r.variant_id,
      connectionId: r.channel_connection_id,
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      metrics: r.metrics ?? {},
      text: r.body,
      labelIds: r.label_ids ?? [],
      format: formatOf(r.post_type, r.media_types ?? []),
    }));
    const byId = new Map(kept.map((r) => [r.variant_id, r]));
    const view = (p: { variantId: string; engagement: number }): InsightPost => {
      const r = byId.get(p.variantId);
      return {
        variantId: p.variantId,
        postId: r?.post_id ?? '',
        excerpt: (r?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
        publishedAt: r?.published_at ? r.published_at.toISOString() : null,
        externalUrl: r?.external_url ?? null,
        engagement: p.engagement,
      };
    };
    const providers = new Map(kept.map((r) => [r.channel_connection_id, r.provider]));
    const channels = whatWorks(samples, input.timeZone).map((c) => ({ ...c, provider: providers.get(c.connectionId) ?? '', best: c.best.map(view), worst: c.worst.map(view) }));
    return { channels, truncated: rows.length > INSIGHT_LIMIT };
  },
});

export const metricsCommands = [metricsRecord, metricsExport];
export const metricsQueries = [metricsTarget, metricsSummary, metricsTotals, metricsInsights];

interface MetricsTarget {
  connectionId: string;
  externalPostId: string;
  autoReplyLikes: number | null;
  repost: { likes: number | null; afterHours: number | null } | null;
  postType: PostType | null;
  publishedAt: string | null;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export interface MetricsDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  publishers: Readonly<Record<string, Publisher>>;
  now?: () => Date;
}

// One pass over the variants due for a capture. Every try leaves a snapshot of its capture: the answer, an empty one
// for a platform that did not answer or refused the token (asked again next capture), or one marked gone for a post
// the platform no longer has (never asked again). A Story (#1082) follows storyCapture: it waits rather than take a
// capture that would push the next one past its end, takes a final capture in its last hours (a try with no answer
// is not kept, so the next pass tries again while there is time), and is marked gone and expired once its insights
// are over, without asking the platform.
export async function sweepMetrics(deps: MetricsDeps): Promise<{ recorded: number; skipped: number }> {
  const providers = Object.entries(deps.publishers).filter(([, p]) => typeof p.metrics === 'function').map(([id]) => id);
  const out = { recorded: 0, skipped: 0 };
  if (providers.length === 0) return out;
  const { rows } = await sql<{ org_id: string; variant_id: string; provider: string }>`
    SELECT org_id, variant_id, provider FROM crove_social.metrics_due(${METRICS_LIMIT}::int, ${providers}::text[], ${METRICS_INTERVAL_SECONDS}::int)`.execute(deps.workerDb);
  const now = deps.now?.() ?? new Date();
  const key = captureKey(now);
  await eachBounded(rows, async (row) => {
    const publisher = deps.publishers[row.provider];
    try {
      const options = { actor: ACTOR, orgId: row.org_id };
      const target = await deps.runtime.query<MetricsTarget>('social.metrics.target', { variantId: row.variant_id }, options);
      const story = target.postType === 'story' && target.publishedAt ? storyCapture(new Date(target.publishedAt), now, METRICS_INTERVAL_SECONDS * 1000) : null;
      if (story === 'wait') return;
      if (story === 'expired') {
        await deps.runtime.execute('social.metrics.record', { variantId: row.variant_id, captureKey: STORY_EXPIRED_KEY, metrics: {}, extra: { gone: true, expired: true } }, options);
        out.skipped += 1;
        return;
      }
      const captureKeyOf = story === 'final' ? STORY_FINAL_KEY : key;
      const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.connectionId }, options);
      const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: row.org_id, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
      const asked = { externalAccountId: sealed.externalAccountId, secret, externalId: target.externalPostId };
      const result = await publisher?.metrics?.(target.postType && target.postType !== 'feed' ? { ...asked, postType: target.postType } : asked);
      if (story === 'final' && !result) {
        out.skipped += 1;
        return;
      }
      // A failed try is kept as an empty snapshot of this capture, so the variant waits for the next capture like the
      // others instead of being asked again every pass; the summary shows the last real answer.
      const input = !result
        ? { metrics: {}, extra: { error: 'no_answer' } }
        : 'refused' in result
          ? { metrics: {}, extra: result.refused === 'gone' ? { gone: true } : { error: result.refused } }
          : { metrics: result.metrics, ...(result.extra ? { extra: result.extra } : {}) };
      if (!result || 'refused' in result) out.skipped += 1;
      const done = await deps.runtime.execute<{ recorded: boolean }>('social.metrics.record', { variantId: row.variant_id, captureKey: captureKeyOf, ...input }, options);
      if (done.recorded && result && !('refused' in result)) out.recorded += 1;
      // The count may set off the variant's auto-reply (#746); its failure never touches the metrics.
      const likes = result && !('refused' in result) ? result.metrics.reactions : undefined;
      // And its repost rule (#773): a like count or a delay, checked by the command against the post's time.
      if (publisher && target.repost && (target.repost.afterHours !== null || (likes !== undefined && target.repost.likes !== null && likes >= target.repost.likes))) {
        await runRepost(deps, row.org_id, row.variant_id, publisher, { externalAccountId: sealed.externalAccountId, secret }, likes ?? null).catch((error: unknown) =>
          console.warn(`[social-repost] variant ${row.variant_id.slice(0, 8)}`, error instanceof Error ? error.message : error),
        );
      }
      if (publisher && likes !== undefined && target.autoReplyLikes !== null && likes >= target.autoReplyLikes) {
        await runAutoReply(deps, row.org_id, row.variant_id, publisher, { externalAccountId: sealed.externalAccountId, secret }, likes).catch((error: unknown) =>
          console.warn(`[social-auto-reply] variant ${row.variant_id.slice(0, 8)}`, error instanceof Error ? error.message : error),
        );
      }
    } catch (error) {
      // A connection whose owner left, or a credential that will not open: nothing to read; the publish path reports it.
      if (!(error instanceof DomainError)) console.warn(`[social-metrics] variant ${row.variant_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
      out.skipped += 1;
    }
  });
  return out;
}

// Runs each row, METRICS_CONCURRENCY at a time and METRICS_PER_PROVIDER at a time per platform, in the scan's order
// otherwise. run never throws: each row catches its own failure.
export async function eachBounded<T extends { provider: string }>(rows: readonly T[], run: (row: T) => Promise<void>): Promise<void> {
  const waiting = [...rows];
  const busy = new Map<string, number>();
  const running = new Set<Promise<void>>();
  while (waiting.length > 0 || running.size > 0) {
    const next = running.size < METRICS_CONCURRENCY ? waiting.findIndex((r) => (busy.get(r.provider) ?? 0) < METRICS_PER_PROVIDER) : -1;
    if (next === -1) {
      await Promise.race(running);
      continue;
    }
    const row = waiting.splice(next, 1)[0] as T;
    busy.set(row.provider, (busy.get(row.provider) ?? 0) + 1);
    const task: Promise<void> = run(row).finally(() => {
      busy.set(row.provider, (busy.get(row.provider) ?? 1) - 1);
      running.delete(task);
    });
    running.add(task);
  }
}
