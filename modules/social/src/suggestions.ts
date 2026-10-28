// Suggested edits (#1236), as Planable's suggestions: a member who may comment on a post selects words of its own text,
// or of a channel's own text, and suggests other words; the suggestion is an internal comment (#582) with the quote,
// where it was, the words suggested and the hash of the text it was made against. A member who may edit the post accepts
// it or skips it.
//
// Rules the commands keep:
// - Suggesting is commenting: members and above, on a post and a channel they may use (#1081), never on a channel or a
//   post that went out (a published, removed or cancelled channel, or one being published). The quote must be the text
//   at that place when the suggestion is made, else 409 SUGGESTION_STALE (the page was not up to date). Its event and
//   mentions are a comment's.
// - Accepting goes through the ordinary edit: social.post.update for the post's text, social.variant.update for a
//   channel's own text, run as nested commands (their own audit rows, a new revision and content hash, a version of the
//   post, every changed channel back to draft so its approvals no longer count). The channels the edit changed that
//   were in review or approved before it are sent to review again (social.post.submit, nested; one that the submit
//   refuses, for example a text now too long for the channel, stays in draft). The accept names the revision of the
//   text the member saw (409 STALE_REVISION otherwise), and refuses a suggestion whose quote is no longer in the text
//   (409 SUGGESTION_OUTDATED; domain/suggestion.ts says where it still applies) and one on a text that went out (409
//   SUGGESTION_FROZEN). Nothing is ever applied to a text the member did not see.
// - Skipping closes it without a change: 'skipped', or 'outdated' when its quote was no longer in the text then.
// - A closed suggestion is resolved; social.post_comment.resolve and .reopen do not apply to suggestions.
import { z } from 'zod';
import { zId, zSocialSuggestion } from '@crove/kernel-contract';
import type { MemberRole, SocialSuggestField, SocialSuggestState } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { mentionedMembers } from './activity.ts';
import { refuseChannels, refusePostOutside } from './channel-access.ts';
import { channelFrozen, locateSuggestion, postFrozen, replaceRange, textHash, wholeCharacters } from './domain/suggestion.ts';
import { lockPost, lockVariants, type PostRow, type VariantRow } from './variants.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// The note that comes with a suggestion; empty is fine.
const zNote = z.string().trim().max(4000);

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

const frozenRefusal = () => new DomainError('SUGGESTION_FROZEN', 409, 'Bài đã đăng hoặc đang đăng trên kênh này nên không sửa theo đề xuất được');

export const commentSuggest = defineCommand({
  name: 'social.post_comment.suggest',
  input: z.strictObject({ postId: zId, variantId: zId.optional(), body: zNote.optional(), suggestion: zSocialSuggestion }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const s = input.suggestion;
    const post = await ctx.trx.selectFrom('crove_social.post').select(['id', 'body']).where('org_id', '=', ctx.orgId).where('id', '=', input.postId).executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    // As for any comment (#1081): a post and a channel the member may use.
    await refusePostOutside(ctx, post.id);
    const variants = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['id', 'channel_connection_id', 'body', 'status', 'content_frozen'])
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', post.id)
      .execute();
    const v = input.variantId ? variants.find((x) => x.id === input.variantId) : undefined;
    if (input.variantId && !v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
    if (v) await refuseChannels(ctx, [v.channel_connection_id]);
    let text: string;
    if (s.field === 'channel') {
      if (!v) throw new DomainError('SUGGESTION_NEEDS_CHANNEL', 422, 'Chọn kênh có nội dung riêng để đề xuất sửa');
      if (v.body === null) throw new DomainError('SUGGESTION_NO_OWN_TEXT', 422, 'Kênh này dùng nội dung chung: hãy đề xuất sửa trên nội dung chung');
      if (channelFrozen(v)) throw frozenRefusal();
      text = v.body;
    } else {
      if (postFrozen(variants)) throw frozenRefusal();
      text = post.body;
    }
    if (!wholeCharacters(s.quote) || !wholeCharacters(s.text)) throw new DomainError('VALIDATION', 422, 'Đoạn chọn bị cắt giữa một ký tự');
    if (text.slice(s.start, s.end) !== s.quote) throw new DomainError('SUGGESTION_STALE', 409, 'Nội dung đã đổi từ lúc bạn chọn đoạn này; hãy tải lại rồi chọn lại');
    const body = input.body ?? '';
    const row = await ctx.trx
      .insertInto('crove_social.post_comment')
      .values({
        org_id: ctx.orgId,
        post_id: post.id,
        variant_id: v?.id ?? null,
        author_user_id: userId,
        body,
        created_at: ctx.now,
        suggest_field: s.field,
        suggest_start: s.start,
        suggest_end: s.end,
        suggest_quote: s.quote,
        suggest_text: s.text,
        suggest_hash: textHash(text),
        suggest_state: 'open',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Told as a comment is: the post's author and its thread, the people mentioned in the note as a mention.
    const mentioned = await mentionedMembers(ctx, body, userId);
    await ctx.emit('social.post.commented', { post_id: post.id, comment_id: row.id, ...(v ? { variant_id: v.id } : {}), ...(mentioned.length ? { mentioned } : {}) });
    if (mentioned.length) await ctx.emit('social.post.mentioned', { post_id: post.id, comment_id: row.id, user_ids: mentioned });
    return { commentId: row.id };
  },
});

interface OpenSuggestion {
  id: string;
  post_id: string;
  variant_id: string | null;
  field: SocialSuggestField;
  start: number;
  end: number;
  quote: string;
  text: string;
}

// The suggestion and its post, both locked (the post first, as every edit locks it), on a post and a channel the member
// may use. Refuses a comment that is no suggestion and one already closed.
async function lockSuggestion(ctx: CommandContext, commentId: string): Promise<{ s: OpenSuggestion; post: PostRow }> {
  const found = await ctx.trx.selectFrom('crove_social.post_comment').select('post_id').where('org_id', '=', ctx.orgId).where('id', '=', commentId).executeTakeFirst();
  if (!found) throw new DomainError('COMMENT_NOT_FOUND', 404, 'Không tìm thấy bình luận này');
  const post = await lockPost(ctx.trx, ctx.orgId, found.post_id);
  const c = await ctx.trx
    .selectFrom('crove_social.post_comment')
    .select(['id', 'post_id', 'variant_id', 'suggest_field', 'suggest_start', 'suggest_end', 'suggest_quote', 'suggest_text', 'suggest_state'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', commentId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  await refusePostOutside(ctx, c.post_id);
  if (c.variant_id) {
    const v = await ctx.trx.selectFrom('crove_social.post_variant').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('id', '=', c.variant_id).executeTakeFirst();
    if (v) await refuseChannels(ctx, [v.channel_connection_id]);
  }
  if (c.suggest_field === null || c.suggest_start === null || c.suggest_end === null || c.suggest_quote === null || c.suggest_text === null) {
    throw new DomainError('NOT_A_SUGGESTION', 409, 'Bình luận này không phải đề xuất sửa');
  }
  if (c.suggest_state !== 'open') throw new DomainError('SUGGESTION_CLOSED', 409, 'Đề xuất này đã được xử lý', { state: c.suggest_state });
  return { post, s: { id: c.id, post_id: c.post_id, variant_id: c.variant_id, field: c.suggest_field, start: c.suggest_start, end: c.suggest_end, quote: c.suggest_quote, text: c.suggest_text } };
}

// The text a suggestion changes as it is now, with the revision an edit of it names; null when it is gone (a channel
// taken off the post, or one back on the post's text).
function currentText(s: OpenSuggestion, post: { body: string; revision: number }, variants: readonly VariantRow[]): { text: string; revision: number; variant: VariantRow | null } | null {
  if (s.field === 'post') return { text: post.body, revision: post.revision, variant: null };
  const v = s.variant_id ? variants.find((x) => x.id === s.variant_id) : undefined;
  if (!v || v.body === null) return null;
  return { text: v.body, revision: v.revision, variant: v };
}

async function close(ctx: CommandContext, s: OpenSuggestion, state: Exclude<SocialSuggestState, 'open'>, userId: string): Promise<void> {
  await ctx.trx.updateTable('crove_social.post_comment').set({ suggest_state: state, resolved_at: ctx.now, resolved_by: userId }).where('org_id', '=', ctx.orgId).where('id', '=', s.id).execute();
}

// The statuses from which an accepted change goes back to review by itself: the channel was being reviewed, or was
// approved already, and its approvals no longer count after the edit.
const BACK_TO_REVIEW: ReadonlySet<string> = new Set(['in_review', 'approved', 'scheduled', 'paused']);

export const commentAccept = defineCommand({
  name: 'social.post_comment.accept',
  // revision: of the text the member saw, the post's for a suggestion on the post's text, the channel's for one on its
  // own text (the timeline gives it).
  input: z.strictObject({ commentId: zId, revision: z.number().int().positive() }),
  // It may run social.post.submit nested, whose event alerts the org's team chat on Telegram or Discord, a third-party
  // provider (plan §4.7: a job with egress derives R2, through a nested run too; #1698).
  risk: 'R2',
  sideEffect: 'external',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post_comment', id: input.commentId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const { s, post } = await lockSuggestion(ctx, input.commentId);
    const variants = await lockVariants(ctx.trx, ctx.orgId, post.id);
    const now = currentText(s, post, variants);
    if (!now) throw new DomainError('SUGGESTION_OUTDATED', 409, 'Đoạn được đề xuất sửa không còn trong nội dung', { commentId: s.id });
    if (now.variant ? channelFrozen(now.variant) : postFrozen(variants)) throw frozenRefusal();
    if (now.revision !== input.revision) throw new DomainError('STALE_REVISION', 409, 'Nội dung đã được sửa ở nơi khác, hãy tải lại', { revision: now.revision });
    const at = locateSuggestion(now.text, s);
    if (!at) throw new DomainError('SUGGESTION_OUTDATED', 409, 'Đoạn được đề xuất sửa không còn trong nội dung', { commentId: s.id });
    const next = replaceRange(now.text, at, s.text);
    const before = new Map(variants.map((v) => [v.id, v.status]));
    // The ordinary edit, with its own checks (the channels the member may use, a channel being published) and audit.
    let changed: string[];
    if (now.variant) {
      const r = await ctx.run<{ changed: boolean }>('social.variant.update', { variantId: now.variant.id, revision: now.revision, body: next });
      changed = r.changed ? [now.variant.id] : [];
    } else {
      const r = await ctx.run<{ changedVariants: string[] }>('social.post.update', { postId: post.id, revision: now.revision, body: next });
      changed = r.changedVariants;
    }
    const back = changed.filter((id) => BACK_TO_REVIEW.has(before.get(id) ?? ''));
    let resubmitted: string[] = [];
    if (back.length > 0) {
      // A channel the submit refuses stays in draft, as after any edit; the change itself is kept.
      const r = await ctx.tryRun<{ submitted: string[] }>('social.post.submit', { postId: post.id, variantIds: back }, { recover: () => true });
      if (r.status === 'ok') resubmitted = r.value.submitted;
    }
    await close(ctx, s, 'accepted', userId);
    ctx.audit({ post_id: post.id, field: s.field, ...(s.variant_id ? { variant_id: s.variant_id } : {}), changed_variants: changed, resubmitted });
    return { commentId: s.id, postId: post.id, state: 'accepted' as const, changedVariants: changed, resubmitted };
  },
});

export const commentSkip = defineCommand({
  name: 'social.post_comment.skip',
  input: z.strictObject({ commentId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post_comment', id: input.commentId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const { s, post } = await lockSuggestion(ctx, input.commentId);
    const variants = await lockVariants(ctx.trx, ctx.orgId, s.post_id);
    const now = currentText(s, post, variants);
    const state = now && locateSuggestion(now.text, s) ? ('skipped' as const) : ('outdated' as const);
    await close(ctx, s, state, userId);
    ctx.audit({ post_id: s.post_id, field: s.field, state });
    return { commentId: s.id, postId: s.post_id, state, changedVariants: [] as string[], resubmitted: [] as string[] };
  },
});

export const suggestionCommands = [commentSuggest, commentAccept, commentSkip];
