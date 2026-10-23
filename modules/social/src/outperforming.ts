// Telling the author when a post does much better than usual (#1132). The metrics sweep runs
// social.metrics.check_outperforming, in the org's system context, right after it records a capture with counts of a
// variant that went out at least 24 hours ago. The check looks at the variant's 24-hour capture (its first capture
// with counts taken at least OUTPERFORM_AFTER_HOURS after it went out), and only while that is still its only such
// capture, so a post is weighed once, at that moment, and posts that were already older when this shipped are never
// weighed. It sets the capture against the latest counts of the channel's last OUTPERFORM_HISTORY published Crove
// variants before it (domain/outperform.ts). Left out on both sides: Stories (their counts are of another kind and last
// a day), the channel's posts published outside Crove (crove_social.external_post, never a variant) and the variant
// itself. At OUTPERFORM_RATIO times the usual or more, it sets the once-only marker outperform_notified_at with a
// conditional update and emits social.variant.outperforming, which the notification dispatch turns into a
// post_outperforming notification for the post's author and assignee (in the app and by email, with mutes, Social mail
// off and the channels a limited member may use, #1081).
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { postTypeOf } from '@crove/channel';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { OUTPERFORM_AFTER_HOURS, OUTPERFORM_HISTORY, outperformance, ratioLabel } from './domain/outperform.ts';

export type OutperformState = 'notified' | 'usual' | 'skipped';

export const metricsCheckOutperforming = defineCommand({
  name: 'social.metrics.check_outperforming',
  input: z.strictObject({ variantId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<{ state: OutperformState; ratio: string | null }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const skipped = { state: 'skipped' as const, ratio: null };
    const v = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['id', 'post_id', 'channel_connection_id', 'status', 'settings', 'published_at', 'outperform_notified_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.variantId)
      .executeTakeFirst();
    if (!v || v.status !== 'published' || !v.published_at || v.outperform_notified_at !== null) return skipped;
    if (postTypeOf((v.settings ?? {}) as Record<string, unknown>) === 'story') return skipped;
    // The 24-hour capture, while it is the variant's only capture with counts from then on.
    const { rows: captures } = await sql<{ metrics: Record<string, number> }>`
      SELECT m.metrics FROM crove_social.metric_snapshot m
      WHERE m.org_id = ${ctx.orgId} AND m.variant_id = ${v.id} AND m.metrics <> '{}'::jsonb
        AND m.captured_at >= ${v.published_at}::timestamptz + pg_catalog.make_interval(hours => ${OUTPERFORM_AFTER_HOURS}::int)
      ORDER BY m.captured_at, m.id
      LIMIT 2`.execute(ctx.trx);
    if (captures.length !== 1 || !captures[0]) return skipped;
    // The channel's published Crove posts before it, newest first, with the latest counts of each.
    const { rows: earlier } = await sql<{ metrics: Record<string, number> }>`
      SELECT s.metrics FROM crove_social.post_variant e
      CROSS JOIN LATERAL (
        SELECT m.metrics FROM crove_social.metric_snapshot m
        WHERE m.org_id = e.org_id AND m.variant_id = e.id AND m.metrics <> '{}'::jsonb
        ORDER BY m.captured_at DESC, m.id DESC LIMIT 1
      ) s
      WHERE e.org_id = ${ctx.orgId} AND e.channel_connection_id = ${v.channel_connection_id} AND e.status = 'published'
        AND e.id <> ${v.id} AND e.published_at < ${v.published_at}::timestamptz
        AND coalesce(e.settings->>'postType', 'feed') <> 'story'
      ORDER BY e.published_at DESC, e.id DESC
      LIMIT ${OUTPERFORM_HISTORY}::int`.execute(ctx.trx);
    const found = outperformance(
      captures[0].metrics,
      earlier.map((r) => r.metrics),
    );
    if (!found) return { state: 'usual', ratio: null };
    const ratio = ratioLabel(found.engagement.ratio);
    // Once: only the check that sets the marker tells anyone.
    const marked = await ctx.trx
      .updateTable('crove_social.post_variant')
      .set({ outperform_notified_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', v.id)
      .where('outperform_notified_at', 'is', null)
      .where('status', '=', 'published')
      .returning('id')
      .executeTakeFirst();
    if (!marked) return skipped;
    await ctx.emit('social.variant.outperforming', {
      post_id: v.post_id,
      variant_id: v.id,
      connection_id: v.channel_connection_id,
      ratio,
      reach_ratio: found.reach ? ratioLabel(found.reach.ratio) : null,
    });
    return { state: 'notified', ratio };
  },
});

export const outperformingCommands = [metricsCheckOutperforming];
