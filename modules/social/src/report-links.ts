// Client report links (issue #643). Owners and admins make an expiring, revocable link to a report of a period, on all
// channels or the ones they choose, for a client without an account: what went out, the totals of the latest counts,
// the counts per channel and the posts that did best. The token is shown once, to the person who made the link; the
// database keeps only its SHA-256. The public side is the migration's definer (report_link_view), which the HTTP edge
// calls with the token. The design is the client review link's (#589).
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

// 32 random bytes, base64url: the format report_link_view() accepts.
export const newReportToken = () => randomBytes(32).toString('base64url');
export const reportTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

const zInstant = z.iso.datetime({ offset: true });

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
  }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const start = new Date(input.periodStart);
    const end = new Date(input.periodEnd);
    if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > REPORT_PERIOD_MAX_DAYS * DAY_MS + DST_SLACK_MS) {
      throw new DomainError('REPORT_PERIOD_INVALID', 422, `Kỳ báo cáo phải kết thúc sau ngày bắt đầu và dài tối đa ${REPORT_PERIOD_MAX_DAYS} ngày`);
    }
    const ids = [...new Set(input.connectionIds ?? [])];
    if (ids.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
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
        period_start: start,
        period_end: end,
        connection_ids: ids,
        include_external: input.includeExternal === true,
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
  periodStart: string;
  periodEnd: string;
  connectionIds: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  includeExternal: boolean;
}

// The org's report links, newest first (never their tokens); the ones a schedule made per mail are not listed.
export const reportLinkList = defineQuery({
  name: 'social.report_link.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<ReportLinkView[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_social.report_link')
      .select(['id', 'title', 'period_start', 'period_end', 'connection_ids', 'created_by', 'created_at', 'expires_at', 'revoked_at', 'include_external'])
      .where('org_id', '=', ctx.orgId)
      .where('schedule_id', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      periodStart: r.period_start.toISOString(),
      periodEnd: r.period_end.toISOString(),
      connectionIds: r.connection_ids,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      revokedAt: r.revoked_at?.toISOString() ?? null,
      includeExternal: r.include_external,
    }));
  },
});

export const reportLinkCommands = [reportLinkCreate, reportLinkRevoke];
export const reportLinkQueries = [reportLinkList];
