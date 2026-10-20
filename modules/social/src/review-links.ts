// Client review links (issue #589). Owners and admins make an expiring, revocable link to one post for a client
// without an account; the client sees each channel's preview and says "Approved", "Needs changes" or comments, with
// the name they type. That answer is a signal for the team, never one of a channel's approvals. The token is shown
// once, to the person who made the link; the database keeps only its SHA-256. The public side is the two definers of
// the migration (review_link_view, review_feedback_add), which the HTTP edge calls with the token.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
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
    const post = await ctx.trx.selectFrom('crove_social.post').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.postId).executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
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
    return { linkId: link.id, postId: link.post_id };
  },
});

// A member removed, or moved below admin (#625): the review and report links they made stop working, as their pending
// invites do (kernel.member.remove and set_role revoke those in the same transaction). The worker runs this for
// kernel.member.removed and kernel.member.role_changed; the event is read from the outbox, never from the job. The
// role is read again here, so a member made admin again before this ran keeps their links.
export const linksRevokeForMember = defineCommand({
  name: 'social.links.revoke_for_member',
  input: z.strictObject({ eventId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới thực hiện được việc này');
    const event = await ctx.trx.selectFrom('crove_kernel.outbox_event').select(['type', 'payload', 'actor_type', 'actor_id']).where('org_id', '=', ctx.orgId).where('id', '=', input.eventId).executeTakeFirst();
    if (!event || (event.type !== 'kernel.member.removed' && event.type !== 'kernel.member.role_changed')) return { review: 0, report: 0 };
    const data = z.object({ userId: zId }).safeParse(event.payload);
    if (!data.success) return { review: 0, report: 0 };
    const userId = data.data.userId;
    const member = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).executeTakeFirst();
    if (member && (member.role === 'owner' || member.role === 'admin')) return { review: 0, report: 0 };
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
    ctx.audit({ member: userId, review_links: review.map((r) => r.id), report_links: report.map((r) => r.id) });
    return { review: review.length, report: report.length };
  },
});

export interface ReviewLinkView {
  id: string;
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
}

export const reviewLinkList = defineQuery({
  name: 'social.review_link.list',
  input: z.object({ postId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<{ links: ReviewLinkView[]; feedback: ReviewFeedbackView[] }> => {
    const [links, feedback, key] = await Promise.all([
      ctx.trx
        .selectFrom('crove_social.review_link')
        .select(['id', 'created_by', 'created_at', 'expires_at', 'revoked_at', 'content_key'])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', input.postId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute(),
      ctx.trx
        .selectFrom('crove_social.review_feedback')
        .select(['id', 'link_id', 'reviewer_name', 'verdict', 'body', 'changed', 'created_at'])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', input.postId)
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute(),
      sql<{ key: string }>`SELECT crove_social.review_content_key(${ctx.orgId}::uuid, ${input.postId}::uuid) AS key`.execute(ctx.trx),
    ]);
    const current = key.rows[0]?.key ?? '';
    return {
      links: links.map((l) => ({
        id: l.id,
        createdBy: l.created_by,
        createdAt: l.created_at.toISOString(),
        expiresAt: l.expires_at.toISOString(),
        revokedAt: l.revoked_at?.toISOString() ?? null,
        changed: l.content_key !== current,
      })),
      feedback: feedback.map((f) => ({
        id: f.id,
        linkId: f.link_id,
        name: f.reviewer_name,
        verdict: f.verdict,
        body: f.body,
        changed: f.changed,
        createdAt: f.created_at.toISOString(),
      })),
    };
  },
});

export const reviewLinkCommands = [reviewLinkCreate, reviewLinkRevoke, linksRevokeForMember];
export const reviewLinkQueries = [reviewLinkList];
