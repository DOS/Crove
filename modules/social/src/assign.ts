// A post's assignee and due date (issue #640): who should move it along and by when. Owners, admins and the post's
// author set them; the assignee must be a member of the org. They are not content: no revision, no new review.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { refusePostOutside } from './channel-access.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export const postAssign = defineCommand({
  name: 'social.post.assign',
  input: z.strictObject({ postId: zId, assigneeUserId: zId.nullable(), dueAt: z.iso.datetime({ offset: true }).nullable() }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const userId = ctx.actor.userId;
    const post = await ctx.trx
      .selectFrom('crove_social.post')
      .select(['id', 'author_user_id', 'assignee_user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .forUpdate()
      .executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng');
    // Only a post the caller may see (#1081).
    await refusePostOutside(ctx, post.id);
    if (ctx.role !== 'owner' && ctx.role !== 'admin' && post.author_user_id !== userId) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người viết bài, chủ sở hữu hoặc quản trị viên mới giao được bài này');
    }
    // A new assignee must be a member; keeping one who has since left (to change only the due date) is allowed.
    if (input.assigneeUserId && input.assigneeUserId !== post.assignee_user_id) {
      // Only a member of the org (crove_kernel.member_profiles answers for members only).
      const { rows } = await sql<{ user_id: string }>`SELECT user_id FROM crove_kernel.member_profiles(${[input.assigneeUserId]}::uuid[])`.execute(ctx.trx);
      if (rows.length === 0) throw new DomainError('ASSIGNEE_NOT_MEMBER', 422, 'Người được giao không phải thành viên của tổ chức');
    }
    await ctx.trx
      .updateTable('crove_social.post')
      .set({ assignee_user_id: input.assigneeUserId, due_at: input.dueAt ? new Date(Date.parse(input.dueAt)) : null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', post.id)
      .execute();
    if (input.assigneeUserId && input.assigneeUserId !== post.assignee_user_id) {
      await ctx.emit('social.post.assigned', { post_id: post.id, assignee_user_id: input.assigneeUserId, by: userId });
    }
    return { postId: post.id, assigneeUserId: input.assigneeUserId, dueAt: input.dueAt };
  },
});

export const assignCommands = [postAssign];