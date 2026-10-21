// The content plan for a client (#978): every channel post going out or gone out in a date range, as a CSV file an
// agency sends with the month's plan, or as rows for the app's print layout (PDF through the browser). A command, as
// social.metrics.export is, so every export leaves an audit row with its counts.
//
// The CSV starts with the CSV import's columns (#586), in its names and formats, so a client's edits stripped to them
// go back in as drafts: text, title, link, channels (the channel's name) and time ("YYYY-MM-DD HH:mm", local to the
// time zone asked for, which the app sends as the browser's, the zone the import reads times in). Then the plan's own
// columns: status, labels, assignee and post_id. Cells go through the metrics export's csvCell, so a cell a
// spreadsheet would run as a formula is written as text.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { isValidTimeZone, localTime } from './domain/queue.ts';
import { labelsOfPosts } from './labels.ts';
import { csvCell } from './metrics.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const PLAN_EXPORT_MAX_ROWS = 500;
export const PLAN_EXPORT_MAX_DAYS = 92;
const DAY_MS = 86_400_000;
// Days picked in a zone with daylight saving can be an hour longer than 24 h, as for plan review links (#902).
const DST_SLACK_MS = 2 * 3_600_000;
// The import template's columns first, in its names (apps/app/src/lib/social-import.ts IMPORT_COLUMNS).
export const PLAN_CSV_COLUMNS = ['text', 'title', 'link', 'channels', 'time', 'status', 'labels', 'assignee', 'post_id'] as const;

export interface PlanRow {
  postId: string;
  variantId: string;
  connectionId: string;
  channel: string;
  provider: string;
  status: string;
  // When it goes out (its slot, its schedule or the post's planned time) or went out, as an ISO instant.
  at: string;
  title: string | null;
  body: string;
  linkUrl: string | null;
  labels: string[];
  // The assignee's name while a member (#640), else null.
  assignee: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

// An instant as the import reads a time: "YYYY-MM-DD HH:mm" in the zone.
export function planTime(iso: string, timeZone: string): string {
  const l = localTime(Date.parse(iso), timeZone);
  return `${l.year}-${pad(l.month)}-${pad(l.day)} ${pad(l.hour)}:${pad(l.minute)}`;
}

// The rows as a CSV file: a byte order mark (so a spreadsheet opens Vietnamese text as UTF-8), the header, a line each.
export function planCsv(rows: readonly PlanRow[], timeZone: string): string {
  const lines = rows.map((r) =>
    // Label names joined by commas, not semicolons: the import guesses the separator from the first lines, and
    // semicolons there could tip it.
    [r.body, r.title, r.linkUrl, r.channel, planTime(r.at, timeZone), r.status, r.labels.join(', '), r.assignee, r.postId].map(csvCell).join(','),
  );
  return `\uFEFF${[PLAN_CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}

const zInstant = z.iso.datetime({ offset: true });

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
    // Every channel not cancelled with a time in the range, at the time the calendar shows it (social.post.list).
    const { rows } = await sql<{
      variant_id: string;
      post_id: string;
      channel_connection_id: string;
      provider: string;
      status: string;
      display_name: string | null;
      body: string;
      title: string | null;
      link_url: string | null;
      at: Date;
      assignee_user_id: string | null;
    }>`
      WITH v AS (
        SELECT v.id, v.post_id, v.channel_connection_id, v.provider, v.status, v.position, p.assignee_user_id,
               CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, p.body) END AS body,
               CASE WHEN v.content_frozen THEN v.title ELSE coalesce(v.title, p.title) END AS title,
               CASE WHEN v.content_frozen THEN v.link_url ELSE coalesce(v.link_url, p.link_url) END AS link_url,
               CASE WHEN v.status IN ('published', 'removed') THEN v.published_at ELSE coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) END AS at
        FROM crove_social.post_variant v
        JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
        WHERE v.org_id = ${ctx.orgId}::uuid AND v.status <> 'cancelled'
          ${connections.length > 0 ? sql`AND v.channel_connection_id = ANY(${connections}::uuid[])` : sql``}
          ${labels.length > 0 ? sql`AND EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = ANY(${labels}::uuid[]))` : sql``}
      )
      SELECT v.id AS variant_id, v.post_id, v.channel_connection_id, v.provider, v.status, c.display_name, v.body, v.title,
             v.link_url, v.at, v.assignee_user_id
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
    const plan: PlanRow[] = rows.map((r) => ({
      postId: r.post_id,
      variantId: r.variant_id,
      connectionId: r.channel_connection_id,
      channel: r.display_name ?? r.provider,
      provider: r.provider,
      status: r.status,
      at: r.at.toISOString(),
      title: r.title,
      body: r.body,
      linkUrl: r.link_url,
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
