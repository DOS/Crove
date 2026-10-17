// Metrics of published posts (Social plan S8, issue #238). The worker asks each platform how a published variant is
// doing every few hours for 30 days after it went out, and keeps every answer as an append-only snapshot; the
// analytics screen shows the latest one per variant. Counts are normalized (channel METRIC_NAMES); a count a platform
// does not report is absent, never zero.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { METRIC_NAMES, type Publisher } from '@crove/channel';
import type { Db } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// How often a published variant is asked again, and how far back the summary looks by default.
export const METRICS_INTERVAL_SECONDS = 6 * 3600;
export const METRICS_SWEEP_MS = 15 * 60_000;
const METRICS_LIMIT = 200;
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
      .select(['channel_connection_id', 'external_post_id', 'provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.variantId)
      .executeTakeFirst();
    if (!row || row.status !== 'published' || !row.external_post_id) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy bài đã đăng này');
    return { connectionId: row.channel_connection_id, externalPostId: row.external_post_id, provider: row.provider };
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
}

// The latest snapshot of each variant published in the window, newest first.
export const metricsSummary = defineQuery({
  name: 'social.metrics.summary',
  input: z.object({ days: z.number().int().min(1).max(365).optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<MetricsRow[]> => {
    const days = input.days ?? 30;
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
    }>`
      SELECT v.id AS variant_id, v.post_id, v.provider, v.channel_connection_id, coalesce(v.body, p.body) AS body,
             v.published_at, v.external_url, s.metrics, s.captured_at
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      LEFT JOIN LATERAL (
        SELECT m.metrics, m.captured_at FROM crove_social.metric_snapshot m
        WHERE m.org_id = v.org_id AND m.variant_id = v.id
        -- The last real answer; an empty snapshot (a failed try, a gone post) only when there is nothing else.
        ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
      ) s ON true
      WHERE v.org_id = ${ctx.orgId} AND v.status = 'published'
        AND v.published_at > pg_catalog.now() - pg_catalog.make_interval(days => ${days}::int)
      ORDER BY v.published_at DESC
      LIMIT 500`.execute(ctx.trx);
    return rows.map((r) => ({
      variantId: r.variant_id,
      postId: r.post_id,
      provider: r.provider,
      connectionId: r.channel_connection_id,
      excerpt: r.body.replace(/\s+/g, ' ').trim().slice(0, 160),
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      externalUrl: r.external_url,
      metrics: r.metrics ?? {},
      capturedAt: r.captured_at ? r.captured_at.toISOString() : null,
    }));
  },
});

export const metricsCommands = [metricsRecord];
export const metricsQueries = [metricsTarget, metricsSummary];

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
// the platform no longer has (never asked again).
export async function sweepMetrics(deps: MetricsDeps): Promise<{ recorded: number; skipped: number }> {
  const providers = Object.entries(deps.publishers).filter(([, p]) => typeof p.metrics === 'function').map(([id]) => id);
  const out = { recorded: 0, skipped: 0 };
  if (providers.length === 0) return out;
  const { rows } = await sql<{ org_id: string; variant_id: string; provider: string }>`
    SELECT org_id, variant_id, provider FROM crove_social.metrics_due(${METRICS_LIMIT}::int, ${providers}::text[], ${METRICS_INTERVAL_SECONDS}::int)`.execute(deps.workerDb);
  const key = captureKey(deps.now?.() ?? new Date());
  for (const row of rows) {
    const publisher = deps.publishers[row.provider];
    try {
      const options = { actor: ACTOR, orgId: row.org_id };
      const target = await deps.runtime.query<{ connectionId: string; externalPostId: string }>('social.metrics.target', { variantId: row.variant_id }, options);
      const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.connectionId }, options);
      const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: row.org_id, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
      const result = await publisher?.metrics?.({ externalAccountId: sealed.externalAccountId, secret, externalId: target.externalPostId });
      // A failed try is kept as an empty snapshot of this capture, so the variant waits for the next capture like the
      // others instead of being asked again every pass; the summary shows the last real answer.
      const input = !result
        ? { metrics: {}, extra: { error: 'no_answer' } }
        : 'refused' in result
          ? { metrics: {}, extra: result.refused === 'gone' ? { gone: true } : { error: result.refused } }
          : { metrics: result.metrics, ...(result.extra ? { extra: result.extra } : {}) };
      if (!result || 'refused' in result) out.skipped += 1;
      const done = await deps.runtime.execute<{ recorded: boolean }>('social.metrics.record', { variantId: row.variant_id, captureKey: key, ...input }, options);
      if (done.recorded && result && !('refused' in result)) out.recorded += 1;
    } catch (error) {
      // A connection whose owner left, or a credential that will not open: nothing to read; the publish path reports it.
      if (!(error instanceof DomainError)) console.warn(`[social-metrics] variant ${row.variant_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
      out.skipped += 1;
    }
  }
  return out;
}
