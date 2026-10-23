// Telling the author when a post does much better than usual (#1132). The metrics sweep runs
// social.metrics.check_outperforming, in the org's system context, right after it records a capture with counts of a
// variant that went out at least 24 hours ago, while the variant still waits to be weighed (social.metrics.target's
// outperformCheck, from pendingWeigh below). The check weighs the variant's 24-hour capture: its first capture with
// counts taken at least OUTPERFORM_AFTER_HOURS after it went out. It sets that capture against the latest counts of the
// channel's last OUTPERFORM_HISTORY published Crove variants before it (domain/outperform.ts). Left out on both sides:
// Stories (their counts are of another kind and last a day), the channel's posts published outside Crove
// (crove_social.external_post, never a variant) and the variant itself.
//
// Once: a successful check sets outperform_checked_at with a conditional update (only while null), whether the post
// is usual or not, and only the check whose update went in tells anyone; at OUTPERFORM_RATIO times the usual or more it
// also sets outperform_notified_at and emits social.variant.outperforming, which the notification dispatch turns into a
// post_outperforming notification for the post's author and assignee (in the app and by email, with mutes, Social mail
// off and the channels a limited member may use, #1081). So later captures run no check (and leave no audit row). A
// check that fails rolls back and leaves the marker unset: the next capture tries again, on the same 24-hour capture,
// for OUTPERFORM_RETRY_HOURS after it was taken. A 24-hour capture older than that is never weighed, so the posts that
// were already past theirs when this shipped tell nobody.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { postTypeOf } from '@crove/channel';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { OUTPERFORM_AFTER_HOURS, OUTPERFORM_HISTORY, OUTPERFORM_RETRY_HOURS, outperformance, ratioLabel } from './domain/outperform.ts';
import type { Trx } from './variants.ts';

export type OutperformState = 'notified' | 'usual' | 'skipped';

const HOUR = 3_600_000;

// The variant's 24-hour capture: its first capture with counts taken at least OUTPERFORM_AFTER_HOURS after it went out,
// and whether it was taken less than OUTPERFORM_RETRY_HOURS ago by the database's clock (recent: it may still be weighed).
export async function dayCapture(trx: Trx, orgId: string, variantId: string, publishedAt: Date): Promise<{ metrics: Record<string, number>; recent: boolean } | undefined> {
  const { rows } = await sql<{ metrics: Record<string, number>; recent: boolean }>`
    SELECT m.metrics, m.captured_at >= pg_catalog.now() - pg_catalog.make_interval(hours => ${OUTPERFORM_RETRY_HOURS}::int) AS recent
    FROM crove_social.metric_snapshot m
    WHERE m.org_id = ${orgId} AND m.variant_id = ${variantId} AND m.metrics <> '{}'::jsonb
      AND m.captured_at >= ${new Date(publishedAt.getTime() + OUTPERFORM_AFTER_HOURS * HOUR)}::timestamptz
    ORDER BY m.captured_at, m.id
    LIMIT 1`.execute(trx);
  const row = rows[0];
  return row ? { metrics: row.metrics, recent: row.recent } : undefined;
}

/**
 * Whether the variant still waits to be weighed: a published feed post or reel, not checked yet, whose 24-hour capture
 * is still to come or was taken less than OUTPERFORM_RETRY_HOURS ago. The sweep runs the check only then.
 */
export async function pendingWeigh(
  trx: Trx,
  orgId: string,
  v: { id: string; status: string; settings: unknown; published_at: Date | null; outperform_checked_at: Date | null },
): Promise<boolean> {
  if (v.status !== 'published' || !v.published_at || v.outperform_checked_at !== null) return false;
  if (postTypeOf((v.settings ?? {}) as Record<string, unknown>) === 'story') return false;
  const day = await dayCapture(trx, orgId, v.id, v.published_at);
  return !day || day.recent;
}

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
      .select(['id', 'post_id', 'channel_connection_id', 'status', 'settings', 'published_at', 'outperform_checked_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.variantId)
      .executeTakeFirst();
    if (!v || v.status !== 'published' || !v.published_at || v.outperform_checked_at !== null) return skipped;
    if (postTypeOf((v.settings ?? {}) as Record<string, unknown>) === 'story') return skipped;
    // No 24-hour capture yet (asked a moment early), or one too old to tell anyone about now: not weighed.
    const day = await dayCapture(ctx.trx, ctx.orgId, v.id, v.published_at);
    if (!day || !day.recent) return skipped;
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
      day.metrics,
      earlier.map((r) => r.metrics),
    );
    // Once: only the check that sets the marker counts, and only it tells anyone.
    const marked = await ctx.trx
      .updateTable('crove_social.post_variant')
      .set({ outperform_checked_at: ctx.now, ...(found ? { outperform_notified_at: ctx.now } : {}) })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', v.id)
      .where('outperform_checked_at', 'is', null)
      .where('status', '=', 'published')
      .returning('id')
      .executeTakeFirst();
    if (!marked) return skipped;
    if (!found) return { state: 'usual', ratio: null };
    const ratio = ratioLabel(found.engagement.ratio);
    await ctx.emit('social.variant.outperforming', {
      post_id: v.post_id,
      variant_id: v.id,
      connection_id: v.channel_connection_id,
      ratio,
      // Reach is named only when it is at least the usual: "0.5 times" would read as more.
      reach_ratio: found.reach && found.reach.ratio >= 1 ? ratioLabel(found.reach.ratio) : null,
    });
    return { state: 'notified', ratio };
  },
});

export const outperformingCommands = [metricsCheckOutperforming];
