// Internal comments and the activity of a post (issue #582). Members comment on a post, or on one of its channels;
// a comment is never published and never part of what a reviewer approves. Its author may fix the text for a few
// minutes. The timeline puts the comments next to what happened to the post: created, edited, submitted, each review
// decision with its comment, scheduled, published or failed per channel. It reads the audit rows of the post's
// commands, the decisions and the channels' own state; nothing is written for it. A comment may be pinned (#1180) to a
// spot on one of the post's images or a moment in one of its videos, or suggest an edit of the text (#1236,
// suggestions.ts).
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zSocialCommentPin } from '@crove/kernel-contract';
import type { MemberRole, SocialSuggestField, SocialSuggestState } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { AUTO_REPLY_STALE_MS, autoReplyCallsOf } from './auto-reply.ts';
import { REPOST_STALE_MS, repostCallsOf } from './repost.ts';
import { EDIT_STALE_MS, editCallsOf } from './edit-published.ts';
import { mentionsOf } from './domain/mentions.ts';
import { NOT_PUBLIC_NOTES } from './domain/channels.ts';
import { QUEUE_ORDER_COMMANDS, reorderCode } from './queue-order.ts';
import { channelScope, connectionInScope, postsInScope, refuseChannels, refusePostOutside, type ChannelScope } from './channel-access.ts';
import { mediaOf, type Trx } from './variants.ts';
import { tickedOf, type TickedCheck } from './review-checklist.ts';
import { channelFrozen, contextOf, locateSuggestion, postFrozen } from './domain/suggestion.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const COMMENT_EDIT_MS = 15 * 60_000;
// The newest entries of a post's timeline that a read returns.
export const ACTIVITY_LIMIT = 500;

const zBody = z.string().trim().min(1).max(4000);
// A pin (#1180): a spot on an image, x and y in 0..1 of its width and height from the top left, or a moment in a video
// (at most a day in, as the table's CHECK).
type PinInput = z.infer<typeof zSocialCommentPin>;

// The members of the org among the ones a comment mentions (#793), other than its author; anyone else is text.
export async function mentionedMembers(ctx: CommandContext, body: string, author: string): Promise<string[]> {
  const ids = mentionsOf(body).filter((id) => id !== author);
  if (ids.length === 0) return [];
  const rows = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('user_id', 'in', ids).execute();
  const members = new Set(rows.map((r) => r.user_id));
  return ids.filter((id) => members.has(id));
}

// A pin names a file among the post's media, or the comment's channel's own media, as they are now; an image for a
// spot and a video for a moment. Anything else, another org's file included, is the same refusal.
async function checkPin(ctx: CommandContext, postId: string, channelMedia: unknown, pin: PinInput): Promise<void> {
  const notInPost = () => new DomainError('PIN_FILE_NOT_IN_POST', 422, 'Ảnh hoặc video được ghim không thuộc bài đăng hay kênh này');
  const inPost = await ctx.trx.selectFrom('crove_social.post_media').select('file_id').where('org_id', '=', ctx.orgId).where('post_id', '=', postId).where('file_id', '=', pin.fileId).executeTakeFirst();
  if (!inPost && !(mediaOf(channelMedia) ?? []).some((m) => m.fileId === pin.fileId)) throw notInPost();
  const file = await ctx.trx.selectFrom('crove_kernel.file').select('content_type').where('org_id', '=', ctx.orgId).where('id', '=', pin.fileId).executeTakeFirst();
  if (!file) throw notInPost();
  if ('atSeconds' in pin ? !file.content_type.startsWith('video/') : !file.content_type.startsWith('image/')) {
    throw new DomainError('PIN_KIND_MISMATCH', 422, 'Ghim một vị trí trên ảnh, hoặc một thời điểm trên video');
  }
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

export const commentAdd = defineCommand({
  name: 'social.post_comment.add',
  input: z.strictObject({ postId: zId, variantId: zId.optional(), body: zBody, pin: zSocialCommentPin.optional() }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const post = await ctx.trx.selectFrom('crove_social.post').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.postId).executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    // A member limited to some channels (#1081) comments on the posts and the channels they may use.
    await refusePostOutside(ctx, post.id);
    let channelMedia: unknown = null;
    if (input.variantId) {
      const v = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select(['id', 'channel_connection_id', 'media'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.variantId)
        .where('post_id', '=', input.postId)
        .executeTakeFirst();
      if (!v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
      await refuseChannels(ctx, [v.channel_connection_id]);
      channelMedia = v.media;
    }
    const pin = input.pin ?? null;
    if (pin) await checkPin(ctx, post.id, channelMedia, pin);
    const row = await ctx.trx
      .insertInto('crove_social.post_comment')
      .values({
        org_id: ctx.orgId,
        post_id: input.postId,
        variant_id: input.variantId ?? null,
        author_user_id: userId,
        body: input.body,
        created_at: ctx.now,
        file_id: pin?.fileId ?? null,
        pin_x: pin && 'x' in pin ? pin.x : null,
        pin_y: pin && 'y' in pin ? pin.y : null,
        pin_seconds: pin && 'atSeconds' in pin ? pin.atSeconds : null,
      })
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
      .select(['id', 'post_id', 'variant_id', 'author_user_id', 'created_at', 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.commentId)
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw new DomainError('COMMENT_NOT_FOUND', 404, 'Không tìm thấy bình luận này');
    if (c.author_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Chỉ người viết mới sửa được bình luận này');
    // Not on a post or a channel the author may no longer use (#1081).
    await refusePostOutside(ctx, c.post_id);
    if (c.variant_id) {
      const v = await ctx.trx.selectFrom('crove_social.post_variant').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('id', '=', c.variant_id).executeTakeFirst();
      if (v) await refuseChannels(ctx, [v.channel_connection_id]);
    }
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

// Resolving a comment (#1168) marks a requested change as dealt with; reopening takes that back. Who may: the comment's
// author, the post's author or assignee, and owners and admins, on a post and a channel they may use (#1081), as for
// adding one. The text and the edit window stay as they are; resolving a resolved comment (or reopening an open one)
// changes nothing.
async function setResolved(ctx: CommandContext, commentId: string, resolved: boolean) {
  const userId = requireUser(ctx);
  const c = await ctx.trx
    .selectFrom('crove_social.post_comment')
    .select(['id', 'post_id', 'variant_id', 'author_user_id', 'resolved_at', 'resolved_by', 'suggest_state'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', commentId)
    .forUpdate()
    .executeTakeFirst();
  if (!c) throw new DomainError('COMMENT_NOT_FOUND', 404, 'Không tìm thấy bình luận này');
  const post = await ctx.trx.selectFrom('crove_social.post').select(['author_user_id', 'assignee_user_id']).where('org_id', '=', ctx.orgId).where('id', '=', c.post_id).executeTakeFirstOrThrow();
  await refusePostOutside(ctx, c.post_id);
  if (c.variant_id) {
    const v = await ctx.trx.selectFrom('crove_social.post_variant').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('id', '=', c.variant_id).executeTakeFirst();
    if (v) await refuseChannels(ctx, [v.channel_connection_id]);
  }
  // A suggested edit (#1236) is closed by accepting or skipping it, never resolved or reopened by hand.
  if (c.suggest_state !== null) throw new DomainError('SUGGESTION_NOT_RESOLVABLE', 409, 'Đề xuất sửa được đóng bằng Nhận hoặc Bỏ qua');
  const may = ctx.role === 'owner' || ctx.role === 'admin' || [c.author_user_id, post.author_user_id, post.assignee_user_id].includes(userId);
  if (!may) throw new DomainError('FORBIDDEN', 403, 'Chỉ người viết bình luận, người viết hoặc người phụ trách bài, chủ sở hữu hoặc quản trị viên mới đánh dấu được bình luận này');
  let at = c.resolved_at;
  let by = c.resolved_by;
  if (resolved !== (c.resolved_at !== null)) {
    at = resolved ? ctx.now : null;
    by = resolved ? userId : null;
    await ctx.trx.updateTable('crove_social.post_comment').set({ resolved_at: at, resolved_by: by }).where('org_id', '=', ctx.orgId).where('id', '=', c.id).execute();
  }
  ctx.audit({ post_id: c.post_id, changed: at !== c.resolved_at });
  return { commentId: c.id, postId: c.post_id, resolvedAt: at?.toISOString() ?? null, resolvedBy: by };
}

export const commentResolve = defineCommand({
  name: 'social.post_comment.resolve',
  input: z.strictObject({ commentId: zId }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post_comment', id: input.commentId }),
  handler: (ctx, input) => setResolved(ctx, input.commentId, true),
});

export const commentReopen = defineCommand({
  name: 'social.post_comment.reopen',
  input: z.strictObject({ commentId: zId }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post_comment', id: input.commentId }),
  handler: (ctx, input) => setResolved(ctx, input.commentId, false),
});

// The comments not resolved yet of each of these posts (#1168), as the caller may see them: on the whole post, or on
// a channel they may use (#1081). One grouped count, for a page of posts at a time.
export async function openCommentsOf(trx: Trx, orgId: string, scope: ChannelScope, postIds: readonly string[]): Promise<Map<string, number>> {
  if (postIds.length === 0) return new Map();
  let q = trx
    .selectFrom('crove_social.post_comment as c')
    .select(['c.post_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('c.org_id', '=', orgId)
    .where('c.post_id', 'in', [...new Set(postIds)])
    .where('c.resolved_at', 'is', null);
  if (scope !== null) {
    q = q.where((eb) =>
      eb.or([
        eb('c.variant_id', 'is', null),
        eb.exists(
          eb
            .selectFrom('crove_social.post_variant as v')
            .select(sql`1`.as('one'))
            .whereRef('v.org_id', '=', 'c.org_id')
            .whereRef('v.id', '=', 'c.variant_id')
            .where(connectionInScope(scope, 'v.channel_connection_id')),
        ),
      ]),
    );
  }
  const rows = await q.groupBy('c.post_id').execute();
  return new Map(rows.map((r) => [r.post_id, Number(r.n)]));
}

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
  // The post's repeat on weekdays (#979) set, changed or turned off.
  'recurrence',
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
  // A correction of the published text (#1223): asked for by a member, confirmed by the platform, or not (its code
  // says why, OUTCOME_UNKNOWN when unclear).
  'live_edit',
  'live_edited',
  'live_edit_failed',
  // Moved in its channel's queue (#1020); its code says how: shuffle, front (put first) or shifted (one place later).
  'queue_moved',
  // An earlier version saved again as a new edit (#1021).
  'restored',
  // Its labels changed, or who it is assigned to or its due date (#1057), one post at a time or many at once.
  'labeled',
  'assigned',
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
  // On an approval: the review checklist items the reviewer ticked (#1105); null otherwise or without a checklist.
  checklist: TickedCheck[] | null;
  // On a resolved comment (#1168): when, by whom and their name (null name: no longer a member); null while it is open.
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  // The viewer may resolve or reopen this comment.
  resolvable: boolean;
  // On a pinned comment (#1180): where; null otherwise.
  pin: CommentPin | null;
  // On a suggested edit (#1236): what it changes and where it stands; null otherwise.
  suggestion: CommentSuggestion | null;
}

// A suggested edit (#1236) as the timeline shows it. On an open one: outdated, its words are no longer in the text (it
// cannot be accepted); frozen, the text went out; before and after, the words around it in the text now; revision, the
// text's revision an accept names (null when the text is gone). decidable: the viewer may accept or skip it.
export interface CommentSuggestion {
  field: SocialSuggestField;
  quote: string;
  text: string;
  state: SocialSuggestState;
  outdated: boolean;
  frozen: boolean;
  before: string;
  after: string;
  revision: number | null;
  decidable: boolean;
}

// A comment's pin (#1180): the file by id, as the post's media are given (its bytes through GET /api/files/:id), its
// type and name, the spot (x, y) on an image or the moment (atSeconds) in a video, and whether the file is still among
// the post's or its channels' media (current false: the pin is on an earlier image).
export interface CommentPin {
  fileId: string;
  mime: string;
  filename: string;
  x: number | null;
  y: number | null;
  atSeconds: number | null;
  current: boolean;
}

// The audited commands the timeline shows, by what they did. Decisions come from the decision rows, which carry the
// comment.
const AUDITED: Record<string, ActivityKind> = {
  'social.post.update': 'edited',
  'social.variant.update': 'edited',
  'social.post.restore_version': 'restored',
  'social.post.add_channels': 'channels_added',
  'social.post.submit': 'submitted',
  'social.variant.schedule': 'scheduled',
  'social.variant.reschedule': 'rescheduled',
  'social.post.set_evergreen': 'evergreen',
  'social.post.recurrence_set': 'recurrence',
  'social.post.recurrence_clear': 'recurrence',
  // A bulk edit (#1057) runs these once per post, so each post's timeline shows its own change.
  'social.post.set_labels': 'labeled',
  'social.post.assign': 'assigned',
  'social.variant.edit_published': 'live_edit',
};

export const postActivity = defineQuery({
  name: 'social.post.activity',
  input: z.object({ postId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<{ items: ActivityItem[]; more: boolean }> => {
    const post = await ctx.trx
      .selectFrom('crove_social.post')
      .select(['id', 'author_user_id', 'assignee_user_id', 'origin', 'created_at', 'body', 'revision'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    // A member limited to some channels (#1081) reads the timeline of a post they may see, without the other channels.
    const scope = await channelScope(ctx);
    if ((await postsInScope(ctx, scope, [post.id])).length === 0) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    const variants = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['id', 'status', 'published_at', 'external_url', 'error_code', 'updated_at', 'removed_at', 'removed_by', 'remove_reason', 'media', 'body', 'revision', 'content_frozen'])
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', post.id)
      .where(connectionInScope(scope, 'channel_connection_id'))
      .execute();
    const variantIds = variants.map((v) => v.id);
    const [comments, decisions, audited, reorders] = await Promise.all([
      ctx.trx
        .selectFrom('crove_social.post_comment')
        .select(['id', 'variant_id', 'author_user_id', 'body', 'created_at', 'edited_at', 'resolved_at', 'resolved_by', 'file_id', 'pin_x', 'pin_y', 'pin_seconds', 'suggest_field', 'suggest_start', 'suggest_end', 'suggest_quote', 'suggest_text', 'suggest_state'])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', post.id)
        .orderBy('created_at', 'desc')
        .limit(ACTIVITY_LIMIT)
        .execute(),
      ctx.trx
        .selectFrom('crove_social.post_approval')
        .select(['id', 'variant_id', 'decision', 'comment', 'decided_by', 'created_at', 'checklist'])
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
      // A queue reorder (#1020) is audited once for its channel, naming every post it moved.
      sql<{ id: string; command: string; actor_id: string | null; actor_type: string; occurred_at: Date; detail: { variant_ids?: unknown; target_variant_id?: unknown } }>`
        SELECT id, command, actor_id, actor_type, occurred_at, detail FROM crove_kernel.audit_event
        WHERE org_id = ${ctx.orgId}::uuid AND occurred_at >= ${post.created_at} AND outcome = 'ok'
          AND command = ANY(${QUEUE_ORDER_COMMANDS}::text[])
          AND detail -> 'post_ids' @> pg_catalog.jsonb_build_array(${post.id}::text)
        ORDER BY occurred_at DESC LIMIT ${ACTIVITY_LIMIT}`.execute(ctx.trx),
    ]);
    // The files the comments are pinned to (#1180), and those the post and the channels the caller may see use now.
    const pinned = [...new Set(comments.flatMap((c) => (c.file_id ? [c.file_id] : [])))];
    const pinFiles = new Map<string, { mime: string; filename: string }>();
    const current = new Set<string>();
    if (pinned.length > 0) {
      const files = await ctx.trx.selectFrom('crove_kernel.file').select(['id', 'content_type', 'filename']).where('org_id', '=', ctx.orgId).where('id', 'in', pinned).execute();
      for (const f of files) pinFiles.set(f.id, { mime: f.content_type, filename: f.filename });
      const used = await ctx.trx.selectFrom('crove_social.post_media').select('file_id').where('org_id', '=', ctx.orgId).where('post_id', '=', post.id).execute();
      for (const m of used) current.add(m.file_id);
      for (const v of variants) for (const m of mediaOf(v.media) ?? []) current.add(m.fileId);
    }
    const pinOf = (c: { file_id: string | null; pin_x: number | null; pin_y: number | null; pin_seconds: number | null }): CommentPin | null => {
      if (!c.file_id) return null;
      const f = pinFiles.get(c.file_id);
      return { fileId: c.file_id, mime: f?.mime ?? '', filename: f?.filename ?? '', x: c.pin_x, y: c.pin_y, atSeconds: c.pin_seconds, current: current.has(c.file_id) };
    };
    // A suggested edit (#1236), against the text it changes as it is now: the post's own, or its channel's own (a
    // channel the caller may not use is left out below with its comments).
    const suggestionOf = (c: (typeof comments)[number]): CommentSuggestion | null => {
      if (c.suggest_field === null || c.suggest_state === null || c.suggest_quote === null || c.suggest_text === null || c.suggest_start === null || c.suggest_end === null) return null;
      const v = c.suggest_field === 'channel' ? variants.find((x) => x.id === c.variant_id) : undefined;
      const current = c.suggest_field === 'post' ? { text: post.body, revision: post.revision } : v && v.body !== null ? { text: v.body, revision: v.revision } : null;
      const open = c.suggest_state === 'open';
      const at = open && current ? locateSuggestion(current.text, { start: c.suggest_start, end: c.suggest_end, quote: c.suggest_quote }) : null;
      const around = at && current ? contextOf(current.text, at) : { before: '', after: '' };
      const frozen = c.suggest_field === 'post' ? postFrozen(variants) : v ? channelFrozen(v) : false;
      return {
        field: c.suggest_field,
        quote: c.suggest_quote,
        text: c.suggest_text,
        state: c.suggest_state,
        outdated: open && at === null,
        frozen: open && frozen,
        ...around,
        revision: open ? (current?.revision ?? null) : null,
        decidable: open && writer,
      };
    };
    const keyed = await ctx.trx.selectFrom('crove_social.post_variant').select(['id', 'revision', 'published_revision', 'attempt']).where('org_id', '=', ctx.orgId).where('post_id', '=', post.id).where(connectionInScope(scope, 'channel_connection_id')).execute();
    const replies = await autoReplyCallsOf(ctx.trx, ctx.orgId, keyed);
    const reposts = await repostCallsOf(ctx.trx, ctx.orgId, keyed);
    const edits = await editCallsOf(ctx.trx, ctx.orgId, keyed);
    const viewer = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const now = Date.now();
    const none = { userId: null, name: null, variantId: null, body: null, decision: null, editedAt: null, editable: false, url: null, code: null, checklist: null, resolvedAt: null, resolvedBy: null, resolvedByName: null, resolvable: false, pin: null, suggestion: null };
    // As social.post_comment.resolve decides it; a viewer never writes.
    const writer = viewer !== null && ctx.role !== null && MEMBERS.includes(ctx.role);
    const resolver = writer && (ctx.role === 'owner' || ctx.role === 'admin' || viewer === post.author_user_id || viewer === post.assignee_user_id);
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
        resolvedAt: c.resolved_at?.toISOString() ?? null,
        resolvedBy: c.resolved_by,
        resolvable: c.suggest_state === null && (resolver || (writer && c.author_user_id === viewer)),
        pin: pinOf(c),
        suggestion: suggestionOf(c),
      })),
      ...decisions.map((d) => ({ ...none, id: d.id, kind: 'decision' as const, at: d.created_at.toISOString(), userId: d.decided_by, variantId: d.variant_id, body: d.comment, decision: d.decision, checklist: tickedOf(d.checklist) })),
      ...audited.rows.map((a) => ({
        ...none,
        id: a.id,
        kind: AUDITED[a.command] as ActivityKind,
        at: a.occurred_at.toISOString(),
        userId: a.actor_type === 'user' ? a.actor_id : null,
        variantId: a.target_type === 'social.post_variant' ? a.target_id : null,
      })),
      ...reorders.rows.flatMap((a): ActivityItem[] => {
        const moved = Array.isArray(a.detail.variant_ids) ? a.detail.variant_ids : [];
        const variantId = variantIds.find((id) => moved.includes(id));
        if (!variantId) return [];
        return [{ ...none, id: a.id, kind: 'queue_moved', at: a.occurred_at.toISOString(), userId: a.actor_type === 'user' ? a.actor_id : null, variantId, code: reorderCode(a.command, a.detail, variantId) }];
      }),
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
      // Each edit call's answer (#1223); one still on its way shows nothing yet, one that went quiet is unclear.
      ...[...edits].flatMap(([variantId, calls]) =>
        calls.flatMap((call): ActivityItem[] =>
          call.state === 'started' && now - call.started_at.getTime() <= EDIT_STALE_MS
            ? []
            : [{ ...none, id: `edit:${call.key}`, kind: call.state === 'succeeded' ? 'live_edited' : 'live_edit_failed', at: (call.finished_at ?? call.started_at).toISOString(), variantId, code: call.state === 'succeeded' ? null : call.state === 'failed' ? call.error_code : (call.error_code ?? 'OUTCOME_UNKNOWN') }],
        ),
      ),
      ...[...replies].flatMap(([variantId, call]): ActivityItem[] =>
        // A call still on its way shows nothing yet; one that went quiet is unclear.
        call.state === 'started' && now - call.started_at.getTime() <= AUTO_REPLY_STALE_MS
          ? []
          : [{ ...none, id: `auto_reply:${variantId}`, kind: call.state === 'succeeded' ? 'auto_replied' : 'auto_reply_failed', at: (call.finished_at ?? call.started_at).toISOString(), variantId, code: call.state === 'succeeded' ? null : call.state === 'started' ? 'OUTCOME_UNKNOWN' : (call.error_code ?? 'OUTCOME_UNKNOWN') }],
      ),
    ];
    // Entries about a channel the caller may not use are left out; the whole post's stay.
    const visible = new Set(variantIds);
    const kept = scope === null ? items : items.filter((i) => i.variantId === null || visible.has(i.variantId));
    kept.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const shown = kept.slice(0, ACTIVITY_LIMIT);
    // Names of the people, while they are members (crove_kernel.member_profiles answers only members of the org).
    const ids = [...new Set(shown.flatMap((i) => [i.userId, i.resolvedBy]).filter((u): u is string => u !== null))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(ctx.trx);
      for (const r of rows) names.set(r.user_id, r.display_name ?? r.email);
    }
    return {
      items: shown.map((i) => ({ ...i, name: i.userId ? (names.get(i.userId) ?? null) : null, resolvedByName: i.resolvedBy ? (names.get(i.resolvedBy) ?? null) : null })),
      more: kept.length > ACTIVITY_LIMIT || comments.length === ACTIVITY_LIMIT || decisions.length === ACTIVITY_LIMIT || audited.rows.length === ACTIVITY_LIMIT || reorders.rows.length === ACTIVITY_LIMIT,
    };
  },
});

export const activityCommands = [commentAdd, commentEdit, commentResolve, commentReopen];
export const activityQueries = [postActivity];
