// Labels and the assignee on many posts at once (#1057), as Planable and Hootsuite Planner edit a month's posts in one
// go. Each command is one transaction: it locks every post it names in id order (as the queue reorders do), so two
// bulk edits, or a bulk edit and a single one, never wait on each other in a cycle; then each post goes through the
// single-post command (social.post.set_labels, social.post.assign) as a nested command, with that command's own
// checks, its own audit row (the post's timeline shows it) and, for an assignment, its own event, so the assignee is
// told of each post as for a single assignment. A post the caller may not change is left out with the reason, and
// the others go on; the answer names every post left out and why.
//
// Left out without trying: a post that is not there (or is another org's), one already published (every live channel
// out), and one the change would not change. A label edit that would put more than ten labels on a post leaves that
// post out too. A label to add that the org does not have, or an assignee who is not a member, refuses the whole
// command: nothing would be done the way the person asked.
import { sql } from 'kysely';
import { zSocialBulkAssign, zSocialBulkLabels, type SocialBulkSkipReason } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { MAX_LABELS_PER_POST } from './labels.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export interface BulkEditResult {
  done: string[];
  skipped: { postId: string; reason: SocialBulkSkipReason }[];
}

interface LockedPost {
  id: string;
  status: string;
  assignee_user_id: string | null;
  due_at: Date | null;
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// Every post named, locked in id order; the ones not found are simply missing from the map.
async function lockPosts(ctx: CommandContext, postIds: readonly string[]): Promise<Map<string, LockedPost>> {
  const rows = await ctx.trx
    .selectFrom('crove_social.post')
    .select(['id', 'status', 'assignee_user_id', 'due_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...postIds])
    .orderBy('id')
    .forUpdate()
    .execute();
  return new Map(rows.map((r) => [r.id, r]));
}

// The posts in the order they were locked (by id), so the nested commands run in that order too.
const byId = (postIds: readonly string[]) => [...postIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// The refusals of a nested command that leave only that post out: the caller may not change it. Anything else (a
// broken session, an agent's limits, a server error) fails the whole command.
// A post on channels a limited member may not use (#1081) is one of those.
const notAllowed = (refusal: DomainError) => refusal.code === 'FORBIDDEN' || refusal.code === 'CHANNEL_NOT_ALLOWED';

function audit(ctx: CommandContext, result: BulkEditResult, facts: Record<string, unknown>) {
  ctx.audit({
    ...facts,
    done: result.done.length,
    post_ids: result.done,
    skipped: result.skipped.map((s) => ({ post_id: s.postId, reason: s.reason })),
  });
}

export const postBulkLabels = defineCommand({
  name: 'social.post.bulk_labels',
  input: zSocialBulkLabels,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input): Promise<BulkEditResult> => {
    requireUser(ctx);
    const posts = await lockPosts(ctx, input.postIds);
    if (input.add.length > 0) {
      // Held until the commit, as social.post.set_labels does, so a label deleted meanwhile waits for this command.
      const found = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', input.add).forKeyShare().execute();
      if (found.length !== input.add.length) throw new DomainError('LABEL_NOT_FOUND', 404, 'Có nhãn không tồn tại hoặc đã bị xóa');
    }
    const ids = [...posts.keys()];
    const current = ids.length === 0 ? [] : await ctx.trx.selectFrom('crove_social.post_label').select(['post_id', 'label_id']).where('org_id', '=', ctx.orgId).where('post_id', 'in', ids).orderBy('created_at').orderBy('label_id').execute();
    const labelsOf = new Map<string, string[]>();
    for (const r of current) labelsOf.set(r.post_id, [...(labelsOf.get(r.post_id) ?? []), r.label_id]);
    const remove = new Set(input.remove);
    const result: BulkEditResult = { done: [], skipped: [] };
    for (const postId of byId(input.postIds)) {
      const post = posts.get(postId);
      if (!post) {
        result.skipped.push({ postId, reason: 'not_found' });
        continue;
      }
      if (post.status === 'published') {
        result.skipped.push({ postId, reason: 'published' });
        continue;
      }
      const have = labelsOf.get(postId) ?? [];
      const kept = have.filter((id) => !remove.has(id));
      const next = [...kept, ...input.add.filter((id) => !have.includes(id))];
      if (next.length === have.length && kept.length === have.length) {
        result.skipped.push({ postId, reason: 'unchanged' });
        continue;
      }
      if (next.length > MAX_LABELS_PER_POST) {
        result.skipped.push({ postId, reason: 'too_many_labels' });
        continue;
      }
      const attempt = await ctx.tryRun('social.post.set_labels', { postId, labelIds: next }, { recover: notAllowed });
      if (attempt.status === 'ok') result.done.push(postId);
      else result.skipped.push({ postId, reason: 'not_allowed' });
    }
    audit(ctx, result, { add: input.add, remove: input.remove });
    return result;
  },
});

export const postBulkAssign = defineCommand({
  name: 'social.post.bulk_assign',
  input: zSocialBulkAssign,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input): Promise<BulkEditResult> => {
    requireUser(ctx);
    const posts = await lockPosts(ctx, input.postIds);
    // Checked once for all the posts: a person who is not a member is never assigned anything (crove_kernel.member_profiles
    // answers for members of the org only).
    if (input.assigneeUserId) {
      const { rows } = await sql<{ user_id: string }>`SELECT user_id FROM crove_kernel.member_profiles(${[input.assigneeUserId]}::uuid[])`.execute(ctx.trx);
      if (rows.length === 0) throw new DomainError('ASSIGNEE_NOT_MEMBER', 422, 'Người được giao không phải thành viên của tổ chức');
    }
    const dueMs = input.dueAt ? Date.parse(input.dueAt) : null;
    const result: BulkEditResult = { done: [], skipped: [] };
    for (const postId of byId(input.postIds)) {
      const post = posts.get(postId);
      if (!post) {
        result.skipped.push({ postId, reason: 'not_found' });
        continue;
      }
      if (post.status === 'published') {
        result.skipped.push({ postId, reason: 'published' });
        continue;
      }
      // Left out, the due date stays each post's own.
      const due = input.dueAt === undefined ? (post.due_at?.toISOString() ?? null) : input.dueAt;
      const sameDue = input.dueAt === undefined || (post.due_at?.getTime() ?? null) === dueMs;
      if (post.assignee_user_id === input.assigneeUserId && sameDue) {
        result.skipped.push({ postId, reason: 'unchanged' });
        continue;
      }
      const attempt = await ctx.tryRun('social.post.assign', { postId, assigneeUserId: input.assigneeUserId, dueAt: due }, { recover: notAllowed });
      if (attempt.status === 'ok') result.done.push(postId);
      else result.skipped.push({ postId, reason: 'not_allowed' });
    }
    audit(ctx, result, { assignee_user_id: input.assigneeUserId, due_at: input.dueAt === undefined ? 'kept' : input.dueAt });
    return result;
  },
});

export const bulkEditCommands = [postBulkLabels, postBulkAssign];
