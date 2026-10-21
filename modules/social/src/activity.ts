// Internal comments and the activity of a post (issue #582). Members comment on a post, or on one of its channels;
// a comment is never published and never part of what a reviewer approves. Its author may fix the text for a few
// minutes. The timeline puts the comments next to what happened to the post: created, edited, submitted, each review
// decision with its comment, scheduled, published or failed per channel. It reads the audit rows of the post's
// commands, the decisions and the channels' own state; nothing is written for it.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { AUTO_REPLY_STALE_MS, autoReplyCallsOf } from './auto-reply.ts';
import { REPOST_STALE_MS, repostCallsOf } from './repost.ts';
import { mentionsOf } from './domain/mentions.ts';
import { NOT_PUBLIC_NOTES } from './domain/channels.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const COMMENT_EDIT_MS = 15 * 60_000;
// The newest entries of a post's timeline that a read returns.
export const ACTIVITY_LIMIT = 500;

const zBody = z.string().trim().min(1).max(4000);

// The members of the org among the ones a comment mentions (#793), other than its author; anyone else is text.
async function mentionedMembers(ctx: CommandContext, body: string, author: string): Promise<string[]> {
  const ids = mentionsOf(body).filter((id) => id !== author);
  if (ids.length === 0) return [];
  const rows = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('user_id', 'in', ids).execute();
  const members = new Set(rows.map((r) => r.user_id));
  return ids.filter((id) => members.has(id));
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

export const commentAdd = defineCommand({
  name: 'social.post_comment.add',
  input: z.strictObject({ postId: zId, variantId: zId.optional(), body: zBody }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const post = await ctx.trx.selectFrom('crove_social.post').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.postId).executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    if (input.variantId) {
      const v = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.variantId)
        .where('post_id', '=', input.postId)
        .executeTakeFirst();
      if (!v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
    }
    const row = await ctx.trx
      .insertInto('crove_social.post_comment')
      .values({ org_id: ctx.orgId, post_id: input.postId, variant_id: input.variantId ?? null, author_user_id: userId, body: input.body, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    const mentioned = await mentionedMembers(ctx, input.body, userId);
    // The people mentioned hear of it once, as a mention, not as one more comment on the thread.
    await ctx.emit('social.post.commented', { post_id: input.postId, comment_id: row.id, ...(input.variantId ? { variant_id: input.variantId } : {}), ...(mentioned.length ? { mentioned } : {}) });
    if (mentioned.length) await ctx.emit('social.post.mentioned', { post_id: input.postId, comment_id: row.id, user_ids: mentioned });
    return { commentId: row.id };
  },
});

// Only the author, and only within COMMENT_EDIT_MS of writing it.
export const commentEdit = defineCommand({
  name: 'social.post_comment.edit',
  input: z.strictObject({ commentId: zId, body: zBody }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const c = await ctx.trx
      .selectFrom('crove_social.post_comment')
      .select(['id', 'post_id', 'author_user_id', 'created_at', 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.commentId)
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw new DomainError('COMMENT_NOT_FOUND', 404, 'Không tìm thấy bình luận này');
    if (c.author_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Chỉ người viết mới sửa được bình luận này');
    if (ctx.now.getTime() - c.created_at.getTime() > COMMENT_EDIT_MS) throw new DomainError('COMMENT_EDIT_CLOSED', 409, 'Đã quá thời gian sửa bình luận này');
    if (c.body !== input.body) {
      await ctx.trx.updateTable('crove_social.post_comment').set({ body: input.body, edited_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', c.id).execute();
      // Only members this comment never mentioned are told: not the ones in the text before, nor anyone told by an
      // earlier fix, so taking a mention out and back in tells nobody twice.
      const told = await sql<{ id: string }>`
        SELECT DISTINCT pg_catalog.jsonb_array_elements_text(payload -> 'user_ids') AS id FROM crove_kernel.outbox_event
        WHERE org_id = ${ctx.orgId} AND type = 'social.post.mentioned' AND created_at >= ${c.created_at} AND payload ->> 'comment_id' = ${c.id}`.execute(ctx.trx);
      const before = new Set([...mentionsOf(c.body), ...told.rows.map((r) => r.id)]);
      const added = (await mentionedMembers(ctx, input.body, userId)).filter((id) => !before.has(id));
      if (added.length) await ctx.emit('social.post.mentioned', { post_id: c.post_id, comment_id: c.id, user_ids: added });
    }
    return { commentId: c.id, postId: c.post_id };
  },
});

export const ACTIVITY_KINDS = [
  'created',
  'comment',
  'edited',
  'channels_added',
  'submitted',
  'decision',
  'scheduled',
  'rescheduled',
  'evergreen',
  'published',
  'failed',
  'cancelled',
  // The auto-reply on likes (#746): posted, or not (its code says why).
  'auto_replied',
  'auto_reply_failed',
  // The repost when a post takes off (#773): made, or not (its code says why).
  'reposted',
  'repost_failed',
  // Taken down from its platform (#860), by the member who asked, with their reason.
  'removed',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  // Who did it: a member by name (null name: no longer a member, or not a person).
  userId: string | null;
  name: string | null;
  // The channel it is about; null: the whole post.
  variantId: string | null;
  // A comment's text, or a reviewer's comment on a decision.
  body: string | null;
  decision: string | null;
  editedAt: string | null;
  // The viewer may still change this comment.
  editable: boolean;
  // A published channel's link, a failed channel's error code; on a published channel not public yet, its note:
  // SENT_TO_APP on a draft sent to the platform's app (#903), WORDPRESS_DRAFT or WORDPRESS_PENDING on a post the site
  // keeps unpublished (#981).
  url: string | null;
  code: string | null;
}

// The audited commands the timeline shows, by what they did. Decisions come from the decision rows, which carry the
// comment.
const AUDITED: Record<string, ActivityKind> = {
  'social.post.update': 'edited',
  'social.variant.update': 'edited',
  'social.post.add_channels': 'channels_added',
  'social.post.submit': 'submitted',
  'social.variant.schedule': 'scheduled',
  'social.variant.reschedule': 'rescheduled',
  'social.post.set_evergreen': 'evergreen',
};

export const postActivity = defineQuery({
  name: 'social.post.activity',
  input: z.object({ postId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<{ items: ActivityItem[]; more: boolean }> => {
    const post = await ctx.trx
      .selectFrom('crove_social.post')
      .select(['id', 'author_user_id', 'origin', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    const variants = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['id', 'status', 'published_at', 'external_url', 'error_code', 'updated_at', 'removed_at', 'removed_by', 'remove_reason'])
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', post.id)
      .execute();
    const variantIds = variants.map((v) => v.id);
    const [comments, decisions, audited] = await Promise.all([
      ctx.trx
        .selectFrom('crove_social.post_comment')
        .select(['id', 'variant_id', 'author_user_id', 'body', 'created_at', 'edited_at'])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', post.id)
        .orderBy('created_at', 'desc')
        .limit(ACTIVITY_LIMIT)
        .execute(),
      ctx.trx
        .selectFrom('crove_social.post_approval')
        .select(['id', 'variant_id', 'decision', 'comment', 'decided_by', 'created_at'])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', post.id)
        .orderBy('created_at', 'desc')
        .limit(ACTIVITY_LIMIT)
        .execute(),
      // From the post's creation on, so the scan stays on the org's audit rows of that time (audit_event_time_idx).
      sql<{ id: string; command: string; actor_id: string | null; actor_type: string; occurred_at: Date; target_type: string; target_id: string }>`
        SELECT id, command, actor_id, actor_type, occurred_at, target_type, target_id FROM crove_kernel.audit_event
        WHERE org_id = ${ctx.orgId}::uuid AND occurred_at >= ${post.created_at} AND outcome = 'ok'
          AND command = ANY(${Object.keys(AUDITED)}::text[])
          AND ((target_type = 'social.post' AND target_id = ${post.id}::uuid)
            OR (target_type = 'social.post_variant' AND target_id = ANY(${variantIds}::uuid[])))
        ORDER BY occurred_at DESC LIMIT ${ACTIVITY_LIMIT}`.execute(ctx.trx),
    ]);
    const keyed = await ctx.trx.selectFrom('crove_social.post_variant').select(['id', 'revision', 'attempt']).where('org_id', '=', ctx.orgId).where('post_id', '=', post.id).execute();
    const replies = await autoReplyCallsOf(ctx.trx, ctx.orgId, keyed);
    const reposts = await repostCallsOf(ctx.trx, ctx.orgId, keyed);
    const viewer = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const now = Date.now();
    const none = { userId: null, name: null, variantId: null, body: null, decision: null, editedAt: null, editable: false, url: null, code: null };
    const items: ActivityItem[] = [
      { ...none, id: `created:${post.id}`, kind: 'created', at: post.created_at.toISOString(), userId: post.author_user_id, code: post.origin === 'ai' ? 'ai' : null },
      ...comments.map((c) => ({
        ...none,
        id: c.id,
        kind: 'comment' as const,
        at: c.created_at.toISOString(),
        userId: c.author_user_id,
        variantId: c.variant_id,
        body: c.body,
        editedAt: c.edited_at?.toISOString() ?? null,
        editable: c.author_user_id === viewer && now - c.created_at.getTime() <= COMMENT_EDIT_MS,
      })),
      ...decisions.map((d) => ({ ...none, id: d.id, kind: 'decision' as const, at: d.created_at.toISOString(), userId: d.decided_by, variantId: d.variant_id, body: d.comment, decision: d.decision })),
      ...audited.rows.map((a) => ({
        ...none,
        id: a.id,
        kind: AUDITED[a.command] as ActivityKind,
        at: a.occurred_at.toISOString(),
        userId: a.actor_type === 'user' ? a.actor_id : null,
        variantId: a.target_type === 'social.post_variant' ? a.target_id : null,
      })),
      ...variants.flatMap((v): ActivityItem[] => {
        // A draft sent to the platform's app (#903) or kept on the site (#981) carries its note, so the timeline does not
        // call it out.
        if (v.status === 'published' && v.published_at) return [{ ...none, id: `published:${v.id}`, kind: 'published', at: v.published_at.toISOString(), variantId: v.id, url: v.external_url, code: v.error_code !== null && NOT_PUBLIC_NOTES.includes(v.error_code) ? v.error_code : null }];
        if (v.status === 'removed' && v.removed_at) {
          const removed: ActivityItem = { ...none, id: `removed:${v.id}`, kind: 'removed', at: v.removed_at.toISOString(), userId: v.removed_by, variantId: v.id, body: v.remove_reason };
          return v.published_at ? [{ ...none, id: `published:${v.id}`, kind: 'published', at: v.published_at.toISOString(), variantId: v.id }, removed] : [removed];
        }
        if (v.status === 'failed' || v.status === 'needs_attention') return [{ ...none, id: `failed:${v.id}`, kind: 'failed', at: v.updated_at.toISOString(), variantId: v.id, code: v.error_code }];
        if (v.status === 'cancelled') return [{ ...none, id: `cancelled:${v.id}`, kind: 'cancelled', at: v.updated_at.toISOString(), variantId: v.id }];
        return [];
      }),
      ...[...reposts].flatMap(([variantId, call]): ActivityItem[] =>
        call.state === 'started' && now - call.started_at.getTime() <= REPOST_STALE_MS
          ? []
          : [{ ...none, id: `repost:${variantId}`, kind: call.state === 'succeeded' ? 'reposted' : 'repost_failed', at: (call.finished_at ?? call.started_at).toISOString(), variantId, code: call.state === 'succeeded' ? null : call.state === 'started' ? 'OUTCOME_UNKNOWN' : (call.error_code ?? 'OUTCOME_UNKNOWN') }],
      ),
      ...[...replies].flatMap(([variantId, call]): ActivityItem[] =>
        // A call still on its way shows nothing yet; one that went quiet is unclear.
        call.state === 'started' && now - call.started_at.getTime() <= AUTO_REPLY_STALE_MS
          ? []
          : [{ ...none, id: `auto_reply:${variantId}`, kind: call.state === 'succeeded' ? 'auto_replied' : 'auto_reply_failed', at: (call.finished_at ?? call.started_at).toISOString(), variantId, code: call.state === 'succeeded' ? null : call.state === 'started' ? 'OUTCOME_UNKNOWN' : (call.error_code ?? 'OUTCOME_UNKNOWN') }],
      ),
    ];
    items.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const shown = items.slice(0, ACTIVITY_LIMIT);
    // Names of the people, while they are members (crove_kernel.member_profiles answers only members of the org).
    const ids = [...new Set(shown.map((i) => i.userId).filter((u): u is string => u !== null))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(ctx.trx);
      for (const r of rows) names.set(r.user_id, r.display_name ?? r.email);
    }
    return {
      items: shown.map((i) => ({ ...i, name: i.userId ? (names.get(i.userId) ?? null) : null })),
      more: items.length > ACTIVITY_LIMIT || comments.length === ACTIVITY_LIMIT || decisions.length === ACTIVITY_LIMIT || audited.rows.length === ACTIVITY_LIMIT,
    };
  },
});

export const activityCommands = [commentAdd, commentEdit];
export const activityQueries = [postActivity];
