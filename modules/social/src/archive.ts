// Archiving a post and bringing it back (#1299), as Planable archives a post and restores it: drafts from feeds, sheet
// imports, files and copies, and cancelled posts, leave the lists without being deleted. Nothing is ever deleted here.
//
// social.post.archive sets the post's archived_at and archived_by; social.post.restore clears them and nothing else, so
// the post comes back exactly as it was (its status, its channels and their states, its labels, its queue slots). An
// archived post is left out of every list, calendar, board, inbox and export (postFilterQuery and the scans that read
// posts), and the commands that would move it on refuse it (refuseArchived): it never goes out from where nobody sees
// it. Published posts that are archived stay in metrics and reports, which describe what went out.
//
// Who: members archive and restore their own posts (the author), owners and admins any post. A member limited to some
// channels (#1081) only a post wholly on theirs: archiving hides the post's every channel from everyone.
//
// Refused, so nothing in motion disappears: a channel scheduled or paused waiting to go out (unschedule it first), one
// going out or waiting for a person (publishing, processing, ambiguous, needs_attention), and a published channel whose
// takedown from its platform is on its way (a person's ask the platform has not answered yet, or a planned takedown,
// #861, that will still be asked for).
//
// Archiving also stops what would bring the post back on its own: its evergreen reposts and its repeat on weekdays are
// turned off (a restore leaves them off), and its open review links, of the post alone and of plans that include it,
// are revoked, so a client cannot answer for a post the team archived.
//
// The bulk commands take up to 100 posts, lock them in id order (as the other bulk edits do) and run the single
// command on each as a nested command, with its checks and its audit row; a post left out is named with the reason.
import { sql } from 'kysely';
import { zSocialBulkArchive, zSocialPostArchive, type SocialBulkSkipReason } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { REMOVE_READY, isProvider, removeAtFit, removeAtOf } from './domain/channels.ts';
import { IN_FLIGHT } from './domain/state.ts';
import { channelScope, postsInScope, refusePostWholly } from './channel-access.ts';
import { removeCallsOf, removeState } from './remove.ts';
import { lockPost, lockVariants, settingsOf, type VariantRow } from './variants.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// Waiting to go out at their time: unscheduled first, then archived.
const WAITING: ReadonlySet<string> = new Set(['scheduled', 'paused']);

export interface ArchiveResult {
  postId: string;
  // Whether the post is archived now, and whether this call changed it.
  archived: boolean;
  changed: boolean;
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The post locked, checked for the caller: there, wholly on their channels, and theirs unless they are an owner or an
// admin.
async function lockOwn(ctx: CommandContext, postId: string, userId: string) {
  const post = await lockPost(ctx.trx, ctx.orgId, postId);
  await refusePostWholly(ctx, postId);
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    const row = await ctx.trx.selectFrom('crove_social.post').select('author_user_id').where('org_id', '=', ctx.orgId).where('id', '=', postId).executeTakeFirstOrThrow();
    if (row.author_user_id !== userId) throw new DomainError('FORBIDDEN', 403, 'Thành viên chỉ lưu trữ hoặc khôi phục được bài mình viết; hãy nhờ chủ sở hữu hoặc quản trị viên');
  }
  return post;
}

// A published channel whose takedown is on its way: asked and not answered yet, or planned (#861) and still to be asked
// for by the worker's sweep (its time fits when the post went out, on a provider the worker removes from).
async function removing(ctx: CommandContext, variants: readonly VariantRow[]): Promise<string[]> {
  const published = variants.filter((v) => v.status === 'published');
  if (published.length === 0) return [];
  const asked = await ctx.trx
    .selectFrom('crove_social.post_variant')
    .select(['id', 'remove_requested_at'])
    .where('org_id', '=', ctx.orgId)
    .where(
      'id',
      'in',
      published.map((v) => v.id),
    )
    .execute();
  const askedAt = new Map(asked.map((r) => [r.id, r.remove_requested_at]));
  const calls = await removeCallsOf(ctx.trx, ctx.orgId, published);
  return published
    .filter((v) => {
      const at = askedAt.get(v.id) ?? null;
      if (at !== null) return removeState(calls.get(v.id) ?? [], at, ctx.now)?.state === 'pending';
      const settings = settingsOf(v);
      const planned = removeAtOf(settings);
      return planned !== null && planned !== 'invalid' && v.published_at !== null && isProvider(v.provider) && REMOVE_READY.has(v.provider) && removeAtFit(v.provider, settings, v.published_at) === null;
    })
    .map((v) => v.id);
}

export const postArchive = defineCommand({
  name: 'social.post.archive',
  input: zSocialPostArchive,
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input): Promise<ArchiveResult> => {
    const userId = requireUser(ctx);
    const post = await lockOwn(ctx, input.postId, userId);
    if (post.archived_at !== null) return { postId: post.id, archived: true, changed: false };
    const variants = await lockVariants(ctx.trx, ctx.orgId, post.id);
    const moving = variants.filter((v) => IN_FLIGHT.has(v.status)).map((v) => v.id);
    if (moving.length > 0) throw new DomainError('POST_ARCHIVE_IN_FLIGHT', 409, 'Bài có kênh đang đăng hoặc đang chờ người xử lý; hãy xử lý xong rồi lưu trữ', { variantIds: moving });
    const waiting = variants.filter((v) => WAITING.has(v.status)).map((v) => v.id);
    if (waiting.length > 0) throw new DomainError('POST_ARCHIVE_SCHEDULED', 409, 'Bài có kênh đã lên lịch đăng; hãy bỏ lịch đăng rồi lưu trữ', { variantIds: waiting });
    const takedown = await removing(ctx, variants);
    if (takedown.length > 0) throw new DomainError('POST_ARCHIVE_REMOVING', 409, 'Bài có kênh đang chờ gỡ khỏi nền tảng; hãy đợi gỡ xong rồi lưu trữ', { variantIds: takedown });
    const before = await ctx.trx.selectFrom('crove_social.post').select(['evergreen_days', 'recurrence']).where('org_id', '=', ctx.orgId).where('id', '=', post.id).executeTakeFirstOrThrow();
    await ctx.trx
      .updateTable('crove_social.post')
      .set({ archived_at: ctx.now, archived_by: userId, evergreen_days: null, recurrence: null, recurrence_next_at: null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', post.id)
      .execute();
    // The open review links of the post, and of every plan that includes it (#902): a plan link is the client's view of
    // its posts together, so it goes with any of them.
    const { rows: revoked } = await sql<{ id: string }>`
      UPDATE crove_social.review_link l SET revoked_at = ${ctx.now}, revoked_by = ${userId}::uuid
      WHERE l.org_id = ${ctx.orgId}::uuid AND l.revoked_at IS NULL AND l.expires_at > ${ctx.now}
        AND (l.post_id = ${post.id}::uuid
          OR EXISTS (SELECT 1 FROM crove_social.review_link_post lp WHERE lp.org_id = l.org_id AND lp.link_id = l.id AND lp.post_id = ${post.id}::uuid))
      RETURNING l.id`.execute(ctx.trx);
    // What it turned off, as it was before, and the links it revoked.
    ctx.audit({ post_id: post.id, evergreen_days: before.evergreen_days, recurrence_stopped: before.recurrence !== null, review_links: revoked.map((r) => r.id).sort() });
    return { postId: post.id, archived: true, changed: true };
  },
});

export const postRestore = defineCommand({
  name: 'social.post.restore',
  input: zSocialPostArchive,
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input): Promise<ArchiveResult> => {
    const userId = requireUser(ctx);
    const post = await lockOwn(ctx, input.postId, userId);
    if (post.archived_at === null) return { postId: post.id, archived: false, changed: false };
    // Nothing else changes: not its status, its channels, its labels, nor the time of its last change.
    await ctx.trx.updateTable('crove_social.post').set({ archived_at: null, archived_by: null }).where('org_id', '=', ctx.orgId).where('id', '=', post.id).execute();
    ctx.audit({ post_id: post.id, archived_at: post.archived_at.toISOString() });
    return { postId: post.id, archived: false, changed: true };
  },
});

// The refusals of the single command that leave only that post out.
const LEFT_OUT: Readonly<Partial<Record<string, SocialBulkSkipReason>>> = {
  FORBIDDEN: 'not_allowed',
  CHANNEL_NOT_ALLOWED: 'not_allowed',
  POST_NOT_FOUND: 'not_found',
  POST_ARCHIVE_IN_FLIGHT: 'in_flight',
  POST_ARCHIVE_SCHEDULED: 'scheduled',
  POST_ARCHIVE_REMOVING: 'removing',
};

export interface BulkArchiveResult {
  done: string[];
  skipped: { postId: string; reason: SocialBulkSkipReason }[];
}

function bulk(name: 'social.post.bulk_archive' | 'social.post.bulk_restore', single: 'social.post.archive' | 'social.post.restore') {
  return defineCommand({
    name,
    input: zSocialBulkArchive,
    risk: 'R1',
    access: MEMBERS,
    handler: async (ctx, input): Promise<BulkArchiveResult> => {
      requireUser(ctx);
      const ids = [...input.postIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // Every post named, locked in id order, so two bulk commands (or a bulk and a single one) never wait in a cycle.
      const found = await ctx.trx.selectFrom('crove_social.post').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ids).orderBy('id').forUpdate().execute();
      const there = new Set(found.map((r) => r.id));
      // A post outside a limited member's channels is not_allowed before anything else is said of it (#1099).
      const visible = new Set(await postsInScope(ctx, await channelScope(ctx), [...there]));
      const result: BulkArchiveResult = { done: [], skipped: [] };
      for (const postId of ids) {
        if (!there.has(postId)) {
          result.skipped.push({ postId, reason: 'not_found' });
          continue;
        }
        if (!visible.has(postId)) {
          result.skipped.push({ postId, reason: 'not_allowed' });
          continue;
        }
        const attempt = await ctx.tryRun<ArchiveResult>(single, { postId }, { recover: (refusal) => LEFT_OUT[refusal.code] !== undefined });
        if (attempt.status !== 'ok') result.skipped.push({ postId, reason: LEFT_OUT[attempt.refusal.code] ?? 'not_allowed' });
        else if (!attempt.value.changed) result.skipped.push({ postId, reason: 'unchanged' });
        else result.done.push(postId);
      }
      ctx.audit({ done: result.done.length, post_ids: result.done, skipped: result.skipped.map((s) => ({ post_id: s.postId, reason: s.reason })) });
      return result;
    },
  });
}

export const postBulkArchive = bulk('social.post.bulk_archive', 'social.post.archive');
export const postBulkRestore = bulk('social.post.bulk_restore', 'social.post.restore');

export const archiveCommands = [postArchive, postRestore, postBulkArchive, postBulkRestore];
