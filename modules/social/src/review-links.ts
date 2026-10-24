// Client review links (issue #589). Owners and admins make an expiring, revocable link to one post for a client
// without an account; the client sees each channel's preview and says "Approved", "Needs changes" or comments, with
// the name they type. That answer is a signal for the team, never one of a channel's approvals. The token is shown
// once, to the person who made the link; the database keeps only its SHA-256. The public side is the two definers of
// the migration (review_link_view, review_feedback_add), which the HTTP edge calls with the token. A plan link (#902)
// covers several posts, answered one by one (review_plan_feedback_add).
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { channelScope, postsInScope, refusePostOutside } from './channel-access.ts';
import { plainNote } from './report-links.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const REVIEW_LINK_MAX_DAYS = 30;
const DAY_MS = 86_400_000;

// 32 random bytes, base64url: the format review_link_by_token() accepts.
export const newReviewToken = () => randomBytes(32).toString('base64url');
export const reviewTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const REVIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

export const reviewLinkCreate = defineCommand({
  name: 'social.review_link.create',
  input: z.strictObject({ postId: zId, days: z.number().int().min(1).max(REVIEW_LINK_MAX_DAYS).optional() }),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const post = await ctx.trx.selectFrom('crove_social.post').select(['id', 'archived_at']).where('org_id', '=', ctx.orgId).where('id', '=', input.postId).executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    // Archiving revokes a post's links (#1299); an archived post gets none until it is restored.
    if (post.archived_at !== null) throw new DomainError('POST_ARCHIVED', 409, 'Bài này đã được lưu trữ; hãy khôi phục bài trước khi gửi khách duyệt');
    // Two links made at once count each other (#930), so the cap below holds.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_social.review_link:${ctx.orgId}:${post.id}`}, 0))`.execute(ctx.trx);
    const live = await ctx.trx
      .selectFrom('crove_social.review_link')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', post.id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', ctx.now)
      .executeTakeFirstOrThrow();
    if (Number(live.n) >= 10) throw new DomainError('REVIEW_LINK_LIMIT', 409, 'Bài này đã có 10 liên kết duyệt còn hạn; hãy thu hồi bớt');
    const token = newReviewToken();
    const expiresAt = new Date(ctx.now.getTime() + (input.days ?? 7) * DAY_MS);
    const { rows } = await sql<{ key: string }>`SELECT crove_social.review_content_key(${ctx.orgId}::uuid, ${post.id}::uuid) AS key`.execute(ctx.trx);
    const row = await ctx.trx
      .insertInto('crove_social.review_link')
      .values({ org_id: ctx.orgId, post_id: post.id, token_sha256: reviewTokenHash(token), content_key: rows[0]?.key ?? '', created_by: userId, created_at: ctx.now, expires_at: expiresAt })
      .returning('id')
      .executeTakeFirstOrThrow();
    // The token leaves only in this answer: the audit keeps the input, never the output.
    return { linkId: row.id, token, expiresAt: expiresAt.toISOString() };
  },
});

export const reviewLinkRevoke = defineCommand({
  name: 'social.review_link.revoke',
  input: z.strictObject({ linkId: zId }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const link = await ctx.trx
      .selectFrom('crove_social.review_link')
      .select(['id', 'post_id', 'revoked_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.linkId)
      .forUpdate()
      .executeTakeFirst();
    if (!link) throw new DomainError('REVIEW_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết duyệt này');
    if (link.revoked_at === null) {
      await ctx.trx.updateTable('crove_social.review_link').set({ revoked_at: ctx.now, revoked_by: userId }).where('org_id', '=', ctx.orgId).where('id', '=', link.id).execute();
    }
    // A plan link (#902) names no single post.
    return { linkId: link.id, postId: link.post_id };
  },
});

// A plan link (#902): one link for a content plan, the posts an owner or admin picked or those going out in a date
// range on the chosen channels. The set is frozen when the link is made, so a post added later never joins it; the
// client answers each post, and each answer settles that post exactly as a single-post link's answer would (the
// public definer review_plan_feedback_add writes the same row and event).
export const REVIEW_PLAN_POSTS_MAX = 50;
// Live plan links an org keeps at most.
export const REVIEW_PLAN_LINKS_MAX = 50;
export const REVIEW_PLAN_RANGE_MAX_DAYS = 92;
// The answers a plan link takes per post (review_plan_feedback_add refuses more).
export const REVIEW_PLAN_ANSWERS_PER_POST = 20;
// Days picked in a zone with daylight saving can be an hour longer than 24 h; the table's CHECK allows a day more.
const DST_SLACK_MS = 2 * 3_600_000;
// The channels a plan from a range takes: not yet out, and not cancelled.
const PLAN_STATUSES = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'paused'] as const;
const zInstant = z.iso.datetime({ offset: true });

// The order a plan shows its posts in: by the time each goes out, posts without one last, then as they were given.
export function planOrder(posts: readonly { id: string; at: Date | null }[]): string[] {
  return posts
    .map((p, i) => ({ id: p.id, at: p.at?.getTime() ?? null, i }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at === null ? 1 : b.at === null ? -1 : a.at - b.at || a.i - b.i))
    .map((p) => p.id);
}

export const reviewPlanCreate = defineCommand({
  name: 'social.review_link.create_plan',
  input: z.strictObject({
    // The posts picked in the posts list, or a date range [from, to) with the channels to take (none: all).
    postIds: z.array(zId).min(1).max(REVIEW_PLAN_POSTS_MAX).optional(),
    range: z.strictObject({ from: zInstant, to: zInstant, connectionIds: z.array(zId).min(1).max(50).optional() }).optional(),
    days: z.number().int().min(1).max(REVIEW_LINK_MAX_DAYS).optional(),
  }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    if ((input.postIds === undefined) === (input.range === undefined)) throw new DomainError('REVIEW_PLAN_INVALID', 422, 'Hãy chọn các bài hoặc một khoảng ngày cho kế hoạch');
    // Two plans made at once count each other (#930), so the cap below holds.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_social.review_link.plan:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    const live = await ctx.trx
      .selectFrom('crove_social.review_link')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('kind', '=', 'plan')
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', ctx.now)
      .executeTakeFirstOrThrow();
    if (Number(live.n) >= REVIEW_PLAN_LINKS_MAX) throw new DomainError('REVIEW_PLAN_LIMIT', 409, `Đã có ${REVIEW_PLAN_LINKS_MAX} liên kết duyệt kế hoạch còn hạn; hãy thu hồi bớt`);
    let postIds: string[];
    let range: { from: Date; to: Date } | null = null;
    if (input.postIds) {
      const ids = [...new Set(input.postIds)];
      const { rows } = await sql<{ id: string; status: string; archived: boolean; at: Date | null }>`
        SELECT p.id, p.status, p.archived_at IS NOT NULL AS archived,
          coalesce((SELECT pg_catalog.min(coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at)) FROM crove_social.post_variant v
                    WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status <> 'cancelled'), p.scheduled_at) AS at
        FROM crove_social.post p
        WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ANY(${ids}::uuid[])`.execute(ctx.trx);
      if (rows.length !== ids.length) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
      if (rows.some((r) => r.status === 'cancelled')) throw new DomainError('REVIEW_PLAN_POST_CANCELLED', 409, 'Có bài đã hủy trong các bài đã chọn; bài đã hủy không gửi khách duyệt được');
      if (rows.some((r) => r.archived)) throw new DomainError('POST_ARCHIVED', 409, 'Có bài đã lưu trữ trong các bài đã chọn; hãy khôi phục bài trước khi gửi khách duyệt');
      const byId = new Map(rows.map((r) => [r.id, r.at]));
      postIds = planOrder(ids.map((id) => ({ id, at: byId.get(id) ?? null })));
    } else {
      const r = input.range as { from: string; to: string; connectionIds?: string[] };
      const from = new Date(r.from);
      const to = new Date(r.to);
      if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > REVIEW_PLAN_RANGE_MAX_DAYS * DAY_MS + DST_SLACK_MS) {
        throw new DomainError('REVIEW_PLAN_RANGE_INVALID', 422, `Khoảng ngày phải kết thúc sau ngày bắt đầu và dài tối đa ${REVIEW_PLAN_RANGE_MAX_DAYS} ngày`);
      }
      const connections = [...new Set(r.connectionIds ?? [])];
      if (connections.length > 0) {
        const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', connections).execute();
        if (found.length !== connections.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
      }
      const at = sql`coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at)`;
      const { rows } = await sql<{ id: string }>`
        SELECT p.id FROM crove_social.post p
        JOIN crove_social.post_variant v ON v.org_id = p.org_id AND v.post_id = p.id
        WHERE p.org_id = ${ctx.orgId}::uuid AND p.status <> 'cancelled' AND p.archived_at IS NULL
          AND v.status = ANY(${[...PLAN_STATUSES]}::text[])
          ${connections.length > 0 ? sql`AND v.channel_connection_id = ANY(${connections}::uuid[])` : sql``}
          AND ${at} >= ${from} AND ${at} < ${to}
        GROUP BY p.id
        ORDER BY pg_catalog.min(${at}), p.id
        LIMIT ${REVIEW_PLAN_POSTS_MAX + 1}`.execute(ctx.trx);
      if (rows.length === 0) throw new DomainError('REVIEW_PLAN_EMPTY', 422, 'Không có bài nào sắp đăng trong khoảng ngày này');
      if (rows.length > REVIEW_PLAN_POSTS_MAX) {
        throw new DomainError('REVIEW_PLAN_TOO_MANY', 422, `Khoảng ngày này có hơn ${REVIEW_PLAN_POSTS_MAX} bài; hãy chọn khoảng ngắn hơn hoặc ít kênh hơn`);
      }
      postIds = rows.map((p) => p.id);
      range = { from, to };
    }
    const token = newReviewToken();
    const expiresAt = new Date(ctx.now.getTime() + (input.days ?? 7) * DAY_MS);
    const link = await ctx.trx
      .insertInto('crove_social.review_link')
      .values({
        org_id: ctx.orgId,
        kind: 'plan',
        post_id: null,
        plan_from: range?.from ?? null,
        plan_to: range?.to ?? null,
        token_sha256: reviewTokenHash(token),
        created_by: userId,
        created_at: ctx.now,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // The tenant role may not add a plan's posts (#930): the definer fills this new link once, in this order, with each
    // post's content key now, and refuses a link that has its posts already.
    await sql`SELECT crove_social.review_plan_posts_add(${link.id}::uuid, ${postIds}::uuid[])`.execute(ctx.trx);
    ctx.audit({ link_id: link.id, posts: postIds });
    // The token leaves only in this answer: the audit keeps the input and the posts, never the output.
    return { linkId: link.id, token, expiresAt: expiresAt.toISOString(), posts: postIds.length };
  },
});

// A member removed, or moved below admin (#625): the review and report links and the calendar feed (#862) they made
// stop working, as their pending invites do (kernel.member.remove and set_role revoke those in the same transaction).
// The worker runs this for kernel.member.removed and kernel.member.role_changed; the event is read from the outbox,
// never from the job. The role is read again here, so a member made admin again before this ran keeps their links.
export const linksRevokeForMember = defineCommand({
  name: 'social.links.revoke_for_member',
  input: z.strictObject({ eventId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới thực hiện được việc này');
    const event = await ctx.trx.selectFrom('crove_kernel.outbox_event').select(['type', 'payload', 'actor_type', 'actor_id']).where('org_id', '=', ctx.orgId).where('id', '=', input.eventId).executeTakeFirst();
    if (!event || (event.type !== 'kernel.member.removed' && event.type !== 'kernel.member.role_changed')) return { review: 0, report: 0, calendar: 0 };
    const data = z.object({ userId: zId }).safeParse(event.payload);
    if (!data.success) return { review: 0, report: 0, calendar: 0 };
    const userId = data.data.userId;
    const member = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).executeTakeFirst();
    if (member && (member.role === 'owner' || member.role === 'admin')) return { review: 0, report: 0, calendar: 0 };
    // Who took the right away; the member themself when the event names nobody.
    const by = event.actor_type === 'user' && event.actor_id ? event.actor_id : userId;
    const review = await ctx.trx
      .updateTable('crove_social.review_link')
      .set({ revoked_at: ctx.now, revoked_by: by })
      .where('org_id', '=', ctx.orgId)
      .where('created_by', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', ctx.now)
      .returning('id')
      .execute();
    const report = await ctx.trx
      .updateTable('crove_social.report_link')
      .set({ revoked_at: ctx.now, revoked_by: by })
      .where('org_id', '=', ctx.orgId)
      .where('created_by', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', ctx.now)
      .returning('id')
      .execute();
    const calendar = await ctx.trx
      .updateTable('crove_social.calendar_feed')
      .set({ revoked_at: ctx.now, revoked_by: by })
      .where('org_id', '=', ctx.orgId)
      .where('created_by', '=', userId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute();
    ctx.audit({ member: userId, review_links: review.map((r) => r.id), report_links: report.map((r) => r.id), calendar_feeds: calendar.map((r) => r.id) });
    return { review: review.length, report: report.length, calendar: calendar.length };
  },
});

// The answers one link takes (review_feedback_add refuses more, #589); the team sees how many are used (#626).
export const REVIEW_LINK_ANSWERS_MAX = 100;

export interface ReviewLinkView {
  id: string;
  // A link of this post alone, or of a plan this post is in (#902).
  kind: 'post' | 'plan';
  // The posts it covers: 1, or the plan's.
  posts: number;
  // Client answers on this post given through it, of answersMax (REVIEW_LINK_ANSWERS_MAX for the link, or
  // REVIEW_PLAN_ANSWERS_PER_POST for this post of a plan).
  answers: number;
  answersMax: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  // The post's content changed since the link was made.
  changed: boolean;
}
export interface ReviewFeedbackView {
  id: string;
  linkId: string;
  name: string;
  verdict: 'approved' | 'changes_requested' | 'comment';
  body: string | null;
  changed: boolean;
  createdAt: string;
  // The team's reply (#1301), which the client sees under their answer, or null.
  reply: ReviewReplyView | null;
}
export interface ReviewReplyView {
  body: string;
  // The member who wrote it last; the client's page never shows who.
  by: string;
  at: string;
}

export const reviewLinkList = defineQuery({
  name: 'social.review_link.list',
  input: z.object({ postId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<{ links: ReviewLinkView[]; feedback: ReviewFeedbackView[] }> => {
    // Nothing of a post a member limited to some channels may not see (#1081).
    if ((await postsInScope(ctx, await channelScope(ctx), [input.postId])).length === 0) return { links: [], feedback: [] };
    const [links, feedback, key, counts] = await Promise.all([
      // The post's own links and the plan links it is in (#902), with the content key each was made for.
      ctx.trx
        .selectFrom('crove_social.review_link as l')
        .leftJoin('crove_social.review_link_post as lp', (j) => j.onRef('lp.org_id', '=', 'l.org_id').onRef('lp.link_id', '=', 'l.id').on('lp.post_id', '=', input.postId))
        .select((eb) => [
          'l.id',
          'l.kind',
          'l.created_by',
          'l.created_at',
          'l.expires_at',
          'l.revoked_at',
          'l.content_key',
          'lp.content_key as plan_key',
          eb
            .selectFrom('crove_social.review_link_post as n')
            .select((e) => e.fn.countAll<string>().as('n'))
            .whereRef('n.org_id', '=', 'l.org_id')
            .whereRef('n.link_id', '=', 'l.id')
            .as('plan_posts'),
        ])
        .where('l.org_id', '=', ctx.orgId)
        .where((eb) => eb.or([eb('l.post_id', '=', input.postId), eb('lp.id', 'is not', null)]))
        .orderBy('l.created_at', 'desc')
        .limit(50)
        .execute(),
      ctx.trx
        .selectFrom('crove_social.review_feedback')
        .select(['id', 'link_id', 'reviewer_name', 'verdict', 'body', 'changed', 'created_at', 'reply_body', 'replied_by', 'replied_at'])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', input.postId)
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute(),
      sql<{ key: string }>`SELECT crove_social.review_content_key(${ctx.orgId}::uuid, ${input.postId}::uuid) AS key`.execute(ctx.trx),
      // Every answer counts, not only the 200 listed below.
      ctx.trx
        .selectFrom('crove_social.review_feedback')
        .select(['link_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', input.postId)
        .groupBy('link_id')
        .execute(),
    ]);
    const answers = new Map(counts.map((c) => [c.link_id, Number(c.n)]));
    const current = key.rows[0]?.key ?? '';
    return {
      links: links.map((l) => ({
        id: l.id,
        kind: l.kind,
        posts: l.kind === 'plan' ? Number(l.plan_posts ?? 0) : 1,
        answers: answers.get(l.id) ?? 0,
        answersMax: l.kind === 'plan' ? REVIEW_PLAN_ANSWERS_PER_POST : REVIEW_LINK_ANSWERS_MAX,
        createdBy: l.created_by,
        createdAt: l.created_at.toISOString(),
        expiresAt: l.expires_at.toISOString(),
        revokedAt: l.revoked_at?.toISOString() ?? null,
        changed: (l.kind === 'plan' ? (l.plan_key ?? '') : l.content_key) !== current,
      })),
      feedback: feedback.map((f) => ({
        id: f.id,
        linkId: f.link_id,
        name: f.reviewer_name,
        verdict: f.verdict,
        body: f.body,
        changed: f.changed,
        createdAt: f.created_at.toISOString(),
        reply: f.reply_body !== null && f.replied_by !== null && f.replied_at !== null ? { body: f.reply_body, by: f.replied_by, at: f.replied_at.toISOString() } : null,
      })),
    };
  },
});

export interface ReviewPlanLinkView {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  // The range it was made from; null for posts picked one by one.
  from: string | null;
  to: string | null;
  posts: number;
  // Posts the client said "Approved" or "Needs changes" to through it.
  answered: number;
  // Posts cancelled since the link was made, which the page shows as no longer in the plan.
  gone: number;
}

// The org's plan links (#902), newest first, never their tokens: how many posts each covers and how many the client
// answered.
export const reviewPlanList = defineQuery({
  name: 'social.review_link.list_plans',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<ReviewPlanLinkView[]> => {
    const { rows } = await sql<{
      id: string;
      created_by: string;
      created_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      plan_from: Date | null;
      plan_to: Date | null;
      posts: number;
      answered: number;
      gone: number;
    }>`
      SELECT l.id, l.created_by, l.created_at, l.expires_at, l.revoked_at, l.plan_from, l.plan_to,
        (SELECT pg_catalog.count(*)::int FROM crove_social.review_link_post lp WHERE lp.org_id = l.org_id AND lp.link_id = l.id) AS posts,
        (SELECT pg_catalog.count(DISTINCT f.post_id)::int FROM crove_social.review_feedback f
          WHERE f.org_id = l.org_id AND f.link_id = l.id AND f.verdict IN ('approved', 'changes_requested')) AS answered,
        (SELECT pg_catalog.count(*)::int FROM crove_social.review_link_post lp
          JOIN crove_social.post p ON p.org_id = lp.org_id AND p.id = lp.post_id
          WHERE lp.org_id = l.org_id AND lp.link_id = l.id AND p.status = 'cancelled') AS gone
      FROM crove_social.review_link l
      WHERE l.org_id = ${ctx.orgId}::uuid AND l.kind = 'plan'
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 100`.execute(ctx.trx);
    return rows.map((r) => ({
      id: r.id,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      revokedAt: r.revoked_at?.toISOString() ?? null,
      from: r.plan_from?.toISOString() ?? null,
      to: r.plan_to?.toISOString() ?? null,
      posts: r.posts,
      answered: r.answered,
      gone: r.gone,
    }));
  },
});

// The team's reply to a client's answer (#1301): plain text, as long as the client's own comment may be.
export const REVIEW_REPLY_MAX = 2000;
const zReply = z
  .string()
  .max(REVIEW_REPLY_MAX * 2)
  .transform(plainNote)
  .pipe(z.string().max(REVIEW_REPLY_MAX));

// One editable team reply under a client's answer on a review link (#1301), which the client sees on the link's page
// signed with the org's name. Members and above write, edit and clear it (an empty text clears it). It is a column of
// the answer, never a new answer, so the link's answer caps and the client's verdict are unchanged. A member limited
// to some channels replies only on posts with a channel of theirs (#1081).
export const reviewReply = defineCommand({
  name: 'social.review.reply',
  input: z.strictObject({ feedbackId: zId, body: zReply.nullable() }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.review_feedback', id: input.feedbackId }),
  handler: async (ctx, input): Promise<{ feedbackId: string; postId: string; reply: ReviewReplyView | null }> => {
    const userId = requireUser(ctx);
    const answer = await ctx.trx
      .selectFrom('crove_social.review_feedback')
      .select(['id', 'post_id', 'link_id', 'reply_body', 'replied_by', 'replied_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.feedbackId)
      .forUpdate()
      .executeTakeFirst();
    if (!answer) throw new DomainError('REVIEW_FEEDBACK_NOT_FOUND', 404, 'Không tìm thấy ý kiến này của khách');
    await refusePostOutside(ctx, answer.post_id);
    const body = input.body ? input.body : null;
    let row = { reply_body: answer.reply_body, replied_by: answer.replied_by, replied_at: answer.replied_at };
    if (body !== answer.reply_body) {
      // The guard trigger stamps replied_at with the database's time; the value set here is only a placeholder.
      row = await ctx.trx
        .updateTable('crove_social.review_feedback')
        .set({ reply_body: body, replied_by: body === null ? null : userId, replied_at: body === null ? null : ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', answer.id)
        .returning(['reply_body', 'replied_by', 'replied_at'])
        .executeTakeFirstOrThrow();
    }
    ctx.audit({ post_id: answer.post_id, link_id: answer.link_id, cleared: body === null });
    const reply = row.reply_body !== null && row.replied_by !== null && row.replied_at !== null ? { body: row.reply_body, by: row.replied_by, at: row.replied_at.toISOString() } : null;
    return { feedbackId: answer.id, postId: answer.post_id, reply };
  },
});

export const reviewLinkCommands = [reviewLinkCreate, reviewPlanCreate, reviewLinkRevoke, linksRevokeForMember, reviewReply];
export const reviewLinkQueries = [reviewLinkList, reviewPlanList];
