// Client report links (issue #643). Owners and admins make an expiring, revocable link to a report of a period, on all
// channels or the ones they choose, for a client without an account: what went out, the totals of the latest counts,
// the counts per channel and the posts that did best. The token is shown once, to the person who made the link; the
// database keeps only its SHA-256. The public side is the migration's definer (report_link_view), which the HTTP edge
// calls with the token. The design is the client review link's (#589). A link may carry the agency's note (#1056), and a
// report of exactly one month shows the org's monthly goals (goals.ts). A link may report on one label's posts only
// (#1159, a campaign recap; the page never shows the label's name), and may leave out who follows the channels (#1155).
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const REPORT_LINK_MAX_DAYS = 90;
export const REPORT_PERIOD_MAX_DAYS = 366;
// Live links an org keeps at most.
export const REPORT_LINK_LIMIT = 50;
const DAY_MS = 86_400_000;
// Days picked in a zone with daylight saving can be an hour longer than 24 h; the table's CHECK allows a day more.
const DST_SLACK_MS = 2 * 3_600_000;

/**
 * A report period's bounds in epoch milliseconds: it must end after it starts and last at most REPORT_PERIOD_MAX_DAYS
 * days, with DST_SLACK_MS for days picked in a zone with daylight saving. A time that does not parse (NaN) is refused
 * too, so an in-process caller that skipped the input schema cannot pass an Invalid Date on. Report links and the AI
 * summary of a period (#1237) check it the same way.
 */
export function reportPeriodBounds(periodStart: string, periodEnd: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(periodStart);
  const endMs = Date.parse(periodEnd);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs || endMs - startMs > REPORT_PERIOD_MAX_DAYS * DAY_MS + DST_SLACK_MS) {
    throw new DomainError('REPORT_PERIOD_INVALID', 422, `Kỳ báo cáo phải kết thúc sau ngày bắt đầu và dài tối đa ${REPORT_PERIOD_MAX_DAYS} ngày`);
  }
  return { startMs, endMs };
}

// 32 random bytes, base64url: the format report_link_view() accepts.
export const newReportToken = () => randomBytes(32).toString('base64url');
export const reportTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

const zInstant = z.iso.datetime({ offset: true });

export const REPORT_NOTE_MAX = 2000;
// Control characters other than tab and line feed, the line and paragraph separators, and the format characters that
// can hide or reorder text (zero width space and marks, bidirectional controls and isolates, the Arabic letter mark,
// the word joiner and invisible operators, tag characters, the byte order mark), by code point. The zero width joiner
// (U+200D) stays: emoji sequences need it.
const hidden = (c: number) =>
  c <= 0x08 ||
  (c >= 0x0b && c <= 0x1f) ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x061c ||
  c === 0x200b ||
  c === 0x200c ||
  c === 0x200e ||
  c === 0x200f ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2060 && c <= 0x2064) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0xfeff ||
  (c >= 0xe0000 && c <= 0xe007f);
/** The agency's note (#1056) as it is kept: plain text in NFC, line breaks as LF, without hidden characters, trimmed. */
export const plainNote = (text: string) =>
  [...text.normalize('NFC').replace(/\r\n?/g, '\n')]
    .filter((ch) => !hidden(ch.codePointAt(0) ?? 0))
    .join('')
    .trim();
// The note on a report: plain text the page shows as text; empty is no note.
export const zReportNote = z
  .string()
  .max(REPORT_NOTE_MAX * 2)
  .transform(plainNote)
  .pipe(z.string().max(REPORT_NOTE_MAX));

export const reportLinkCreate = defineCommand({
  name: 'social.report_link.create',
  input: z.strictObject({
    periodStart: zInstant,
    periodEnd: zInstant,
    connectionIds: z.array(zId).max(50).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    days: z.number().int().min(1).max(REPORT_LINK_MAX_DAYS).optional(),
    // Count the posts the channels published outside Crove (#1054); fixed for the link's life.
    includeExternal: z.boolean().optional(),
    note: zReportNote.optional(),
    // Only the posts with this label of the org (#1159), in both periods; no outside posts and no goals then.
    labelId: zId.optional(),
    // Show who follows the channels (#1155); on unless false.
    includeAudience: z.boolean().optional(),
  }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const bounds = reportPeriodBounds(input.periodStart, input.periodEnd);
    const start = new Date(bounds.startMs);
    const end = new Date(bounds.endMs);
    const ids = [...new Set(input.connectionIds ?? [])];
    if (ids.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    }
    if (input.labelId) {
      if (input.includeExternal === true) throw new DomainError('REPORT_LABEL_EXTERNAL', 422, 'Báo cáo theo nhãn không tính bài đăng ngoài');
      // Held until the commit, so the label cannot go between this check and the insert (its FK cascades to the link).
      const label = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.labelId).forShare().executeTakeFirst();
      if (!label) throw new DomainError('LABEL_NOT_FOUND', 404, 'Không tìm thấy nhãn này');
    }
    const live = await ctx.trx
      .selectFrom('crove_social.report_link')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', ctx.now)
      // The links a report schedule makes per mail (#704) are not the org's to count here.
      .where('schedule_id', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(live.n) >= REPORT_LINK_LIMIT) throw new DomainError('REPORT_LINK_LIMIT', 409, `Đã có ${REPORT_LINK_LIMIT} liên kết báo cáo còn hạn; hãy thu hồi bớt`);
    const token = newReportToken();
    const expiresAt = new Date(ctx.now.getTime() + (input.days ?? 30) * DAY_MS);
    const row = await ctx.trx
      .insertInto('crove_social.report_link')
      .values({
        org_id: ctx.orgId,
        token_sha256: reportTokenHash(token),
        title: input.title ?? null,
        note: input.note ? input.note : null,
        period_start: start,
        period_end: end,
        connection_ids: ids,
        include_external: input.includeExternal === true,
        label_id: input.labelId ?? null,
        include_audience: input.includeAudience !== false,
        created_by: userId,
        created_at: ctx.now,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // The token leaves only in this answer: the audit keeps the input, never the output.
    return { linkId: row.id, token, expiresAt: expiresAt.toISOString() };
  },
});

export const reportLinkRevoke = defineCommand({
  name: 'social.report_link.revoke',
  input: z.strictObject({ linkId: zId }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const link = await ctx.trx.selectFrom('crove_social.report_link').select(['id', 'revoked_at']).where('org_id', '=', ctx.orgId).where('id', '=', input.linkId).forUpdate().executeTakeFirst();
    if (!link) throw new DomainError('REPORT_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết báo cáo này');
    if (link.revoked_at === null) {
      await ctx.trx.updateTable('crove_social.report_link').set({ revoked_at: ctx.now, revoked_by: userId }).where('org_id', '=', ctx.orgId).where('id', '=', link.id).execute();
    }
    return { linkId: link.id };
  },
});

export interface ReportLinkView {
  id: string;
  title: string | null;
  note: string | null;
  periodStart: string;
  periodEnd: string;
  connectionIds: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  includeExternal: boolean;
  // The label the link reports on (#1159), or null for every post.
  labelId: string | null;
  includeAudience: boolean;
}

// The org's report links, newest first (never their tokens); the ones a schedule made per mail are not listed.
export const reportLinkList = defineQuery({
  name: 'social.report_link.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<ReportLinkView[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_social.report_link')
      .select(['id', 'title', 'note', 'period_start', 'period_end', 'connection_ids', 'created_by', 'created_at', 'expires_at', 'revoked_at', 'include_external', 'label_id', 'include_audience'])
      .where('org_id', '=', ctx.orgId)
      .where('schedule_id', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      note: r.note,
      periodStart: r.period_start.toISOString(),
      periodEnd: r.period_end.toISOString(),
      connectionIds: r.connection_ids,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      revokedAt: r.revoked_at?.toISOString() ?? null,
      includeExternal: r.include_external,
      labelId: r.label_id,
      includeAudience: r.include_audience,
    }));
  },
});

export const reportLinkCommands = [reportLinkCreate, reportLinkRevoke];
export const reportLinkQueries = [reportLinkList];
