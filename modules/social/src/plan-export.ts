// The content plan for a client (#978): every channel post going out or gone out in a date range, as a CSV file an
// agency sends with the month's plan, or as rows for the app's print layout (PDF through the browser). A command, as
// social.metrics.export is, so every export leaves an audit row with its counts.
//
// The CSV starts with the CSV import's columns (#586, #1258), in its names and formats, so a client's edits go back in
// as drafts with their images, alt texts, first comment and labels: text, title, link, channels (the channel's name),
// time, media, alt, first_comment and labels. Then the plan's own columns: status, assignee and post_id. The file's
// format is domain/plan-csv.ts, which the app's import reads with.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { isValidTimeZone } from './domain/queue.ts';
import { labelsOfPosts } from './labels.ts';
import { connectionInScope, refuseChannels } from './channel-access.ts';
import { withSignature } from './domain/signature.ts';
import { firstCommentOf } from './domain/channels.ts';
import { PLAN_CSV_COLUMNS, plainMediaName, planCsv, planTime, type PlanMedia, type PlanRow } from './domain/plan-csv.ts';
import { effectiveMedia, type PostMedia } from './domain/approval.ts';
import { LIBRARY_MEDIA_TYPES } from './library.ts';
import { mediaOf, settingsOf, type Trx } from './variants.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const PLAN_EXPORT_MAX_ROWS = 500;
export const PLAN_EXPORT_MAX_DAYS = 92;
const DAY_MS = 86_400_000;
// Days picked in a zone with daylight saving can be an hour longer than 24 h, as for plan review links (#902).
const DST_SLACK_MS = 2 * 3_600_000;
export { PLAN_CSV_COLUMNS, planCsv, planTime, type PlanMedia, type PlanRow };

const zInstant = z.iso.datetime({ offset: true });

type MediaRow = { post_id: string; media: unknown; content_frozen: boolean };

// Each channel's images or video as the export writes them (#1258): the channel's own list, else the post's, each by
// its file's name when that name finds this file alone among the org's library files (as social.media.resolve looks
// names up, whatever the case), else by its id, so the import attaches the same files.
async function planMedia(trx: Trx, orgId: string, rows: readonly MediaRow[]): Promise<(r: MediaRow) => PlanMedia[]> {
  const postIds = [...new Set(rows.map((r) => r.post_id))];
  const shared = new Map<string, PostMedia[]>();
  if (postIds.length > 0) {
    const list = await trx
      .selectFrom('crove_social.post_media')
      .select(['post_id', 'file_id', 'alt_text'])
      .where('org_id', '=', orgId)
      .where('post_id', 'in', postIds)
      .orderBy('post_id')
      .orderBy('position')
      .execute();
    // Only what the reference and the alt text need: the rest of a PostMedia is not read here.
    for (const m of list) shared.set(m.post_id, [...(shared.get(m.post_id) ?? []), { fileId: m.file_id, generation: null, altText: m.alt_text, mime: '', sizeBytes: 0, durationMs: null, width: null, height: null }]);
  }
  const listOf = (r: MediaRow) => effectiveMedia(shared.get(r.post_id) ?? [], mediaOf(r.media), r.content_frozen);
  const fileIds = [...new Set(rows.flatMap((r) => listOf(r).map((m) => m.fileId)))];
  const refs = new Map<string, string>();
  if (fileIds.length > 0) {
    const key = sql<string>`lower(normalize(filename, NFC))`;
    const files = await trx.selectFrom('crove_kernel.file').select(['id', 'filename', key.as('name_key')]).where('org_id', '=', orgId).where('id', 'in', fileIds).execute();
    const names = [...new Set(files.map((f) => f.name_key))];
    const counts = await trx
      .selectFrom('crove_kernel.file')
      .select([key.as('name_key'), (eb) => eb.fn.countAll<string>().as('n')])
      .where('org_id', '=', orgId)
      .where('source', '=', 'social')
      .where('content_type', 'in', [...LIBRARY_MEDIA_TYPES])
      .where(sql<boolean>`lower(normalize(filename, NFC)) = ANY(${names}::text[])`)
      .groupBy(key)
      .execute();
    const many = new Set(counts.filter((c) => Number(c.n) > 1).map((c) => c.name_key));
    for (const f of files) refs.set(f.id, plainMediaName(f.filename) && !many.has(f.name_key) ? f.filename : f.id);
  }
  return (r) => listOf(r).map((m) => ({ ref: refs.get(m.fileId) ?? m.fileId, altText: m.altText }));
}

export const planExport = defineCommand({
  name: 'social.plan.export',
  input: z.strictObject({
    // The range [from, to): the app sends the local midnights of the first and the day after the last day picked.
    from: zInstant,
    to: zInstant,
    timeZone: z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone'),
    // Only these channels, and only posts with any of these labels; none: all.
    connectionIds: z.array(zId).min(1).max(50).optional(),
    labelIds: z.array(zId).min(1).max(20).optional(),
    // csv: the file; print: the rows for the print layout.
    format: z.enum(['csv', 'print']).optional(),
  }),
  risk: 'R1',
  sideEffect: 'none',
  access: MEMBERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > PLAN_EXPORT_MAX_DAYS * DAY_MS + DST_SLACK_MS) {
      throw new DomainError('PLAN_RANGE_INVALID', 422, `Khoảng ngày phải kết thúc sau ngày bắt đầu và dài tối đa ${PLAN_EXPORT_MAX_DAYS} ngày`);
    }
    const connections = [...new Set(input.connectionIds ?? [])];
    const labels = [...new Set(input.labelIds ?? [])];
    // A member limited to some channels (#1081) exports those only: a channel named outside them is refused, and
    // without a choice the others are left out.
    const scope = await refuseChannels(ctx, connections);
    // Every channel not cancelled with a time in the range, at the time the calendar shows it (social.post.list), of the
    // posts not archived (#1299).
    const { rows } = await sql<{
      variant_id: string;
      post_id: string;
      channel_connection_id: string;
      provider: string;
      status: string;
      display_name: string | null;
      body: string;
      settings: unknown;
      title: string | null;
      link_url: string | null;
      at: Date;
      assignee_user_id: string | null;
      media: unknown;
      content_frozen: boolean;
    }>`
      WITH v AS (
        SELECT v.id, v.post_id, v.channel_connection_id, v.provider, v.status, v.position, p.assignee_user_id, v.media, v.content_frozen,
               CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, p.body) END AS body, v.settings,
               CASE WHEN v.content_frozen THEN v.title ELSE coalesce(v.title, p.title) END AS title,
               CASE WHEN v.content_frozen THEN v.link_url ELSE coalesce(v.link_url, p.link_url) END AS link_url,
               CASE WHEN v.status IN ('published', 'removed') THEN v.published_at ELSE coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) END AS at
        FROM crove_social.post_variant v
        JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
        WHERE v.org_id = ${ctx.orgId}::uuid AND v.status <> 'cancelled' AND p.archived_at IS NULL
          ${connections.length > 0 ? sql`AND v.channel_connection_id = ANY(${connections}::uuid[])` : sql``}
          AND ${connectionInScope(scope, 'v.channel_connection_id')}
          ${labels.length > 0 ? sql`AND EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = ANY(${labels}::uuid[]))` : sql``}
      )
      SELECT v.id AS variant_id, v.post_id, v.channel_connection_id, v.provider, v.status, c.display_name, v.body, v.settings, v.title,
             v.link_url, v.at, v.assignee_user_id, v.media, v.content_frozen
      FROM v
      LEFT JOIN crove_kernel.channel_connection c ON c.org_id = ${ctx.orgId}::uuid AND c.id = v.channel_connection_id
      WHERE v.at >= ${from} AND v.at < ${to}
      ORDER BY v.at, v.post_id, v.position, v.id
      LIMIT ${PLAN_EXPORT_MAX_ROWS + 1}`.execute(ctx.trx);
    const truncated = rows.length > PLAN_EXPORT_MAX_ROWS;
    if (truncated) rows.length = PLAN_EXPORT_MAX_ROWS;
    const labelsOf = await labelsOfPosts(ctx.trx, ctx.orgId, [...new Set(rows.map((r) => r.post_id))]);
    // Names while they are members (crove_kernel.member_profiles answers only members of the org).
    const people = [...new Set(rows.map((r) => r.assignee_user_id).filter((id): id is string => id !== null))];
    const names = new Map<string, string>();
    if (people.length > 0) {
      const { rows: profiles } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${people}::uuid[])`.execute(ctx.trx);
      for (const p of profiles) names.set(p.user_id, p.display_name ?? p.email);
    }
    const mediaOfRow = await planMedia(ctx.trx, ctx.orgId, rows);
    const plan: PlanRow[] = rows.map((r) => ({
      postId: r.post_id,
      variantId: r.variant_id,
      connectionId: r.channel_connection_id,
      channel: r.display_name ?? r.provider,
      provider: r.provider,
      status: r.status,
      at: r.at.toISOString(),
      title: r.title,
      // The text as it goes out, with the channel's signature (#1190).
      body: withSignature(r.body, settingsOf(r)),
      linkUrl: r.link_url,
      media: mediaOfRow(r),
      firstComment: firstCommentOf(settingsOf(r)),
      labels: (labelsOf.get(r.post_id) ?? []).map((l) => l.name),
      assignee: r.assignee_user_id ? (names.get(r.assignee_user_id) ?? null) : null,
    }));
    const format = input.format ?? 'csv';
    // The counts only, never the rows (client content) nor which channels or labels were picked.
    ctx.audit({ format, days: Math.round((to.getTime() - from.getTime()) / DAY_MS), rows: plan.length, truncated, channels: connections.length, labels: labels.length });
    const month = planTime(input.from, input.timeZone).slice(0, 7);
    return {
      filename: `crove-ke-hoach-${month}.csv`,
      csv: format === 'csv' ? planCsv(plan, input.timeZone) : null,
      rows: format === 'print' ? plan : null,
      truncated,
    };
  },
});

export const planExportCommands = [planExport];
