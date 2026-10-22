// The client's approval as a review step (#770, research §5.2). On a channel with client approval, a variant whose team
// approvals are all in waits in review for the client's "Approved" on a review link (#589), given for the content as it
// is now; the client's "Needs changes" sends it back for changes. The client answers through the public definer, which
// records an outbox event; the worker then runs this command, which settles the post's waiting variants. An answer for
// content that changed since, or a comment, settles nothing.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { approvalsInRound } from './domain/approval.ts';
import { approvalsRequired, clientApprovalOn, clientVerdict, decisionsOf } from './policy.ts';
import { CLEAR_ERROR, POLICY_RAISED, approvedValues, base, lockPost, lockVariants, refreshPostStatus, setVariant, step } from './variants.ts';
import { bannedCheckerOf, isBlocked } from './banned-words.ts';

export const clientSettle = defineCommand({
  name: 'social.review.client_settle',
  input: z.strictObject({ eventId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const event = await ctx.trx.selectFrom('crove_kernel.outbox_event').select(['type', 'payload']).where('org_id', '=', ctx.orgId).where('id', '=', input.eventId).executeTakeFirst();
    const postId = (event?.payload as { post_id?: unknown } | undefined)?.post_id;
    if (event?.type !== 'social.review.answered' || typeof postId !== 'string') return { settled: [] as string[], verdict: null };
    const post = await lockPost(ctx.trx, ctx.orgId, postId).catch(() => null);
    if (!post) return { settled: [] as string[], verdict: null };
    const variants = (await lockVariants(ctx.trx, ctx.orgId, post.id)).filter((v) => v.status === 'in_review');
    const clientOn = await clientApprovalOn(ctx.trx, ctx.orgId, [...new Set(variants.map((v) => v.channel_connection_id))]);
    const waiting = variants.filter((v) => clientOn.has(v.channel_connection_id));
    if (waiting.length === 0) return { settled: [] as string[], verdict: null };
    const verdict = await clientVerdict(ctx.trx, ctx.orgId, post.id);
    if (!verdict) return { settled: [] as string[], verdict: null };
    const required = await approvalsRequired(ctx.trx, ctx.orgId, waiting.map((v) => v.channel_connection_id));
    const decisions = await decisionsOf(ctx.trx, ctx.orgId, waiting.map((v) => v.id));
    const settled: string[] = [];
    const scheduled: string[] = [];
    // The client's yes approves nothing that holds a blocked word (#1055), added since the team approved: it stays in
    // review, where the team sees the word.
    const banned = verdict === 'approved' ? await bannedCheckerOf(ctx.trx, ctx.orgId) : null;
    for (const v of waiting) {
      if (verdict === 'changes_requested') {
        // As a reviewer's request for changes does: it also ends a raised policy's hold on the variant.
        await setVariant(ctx, v.id, { status: step(v, { type: 'request_changes' }), ...(v.error_code === POLICY_RAISED ? CLEAR_ERROR : {}) });
        settled.push(v.id);
        continue;
      }
      // The client's yes completes a variant only once the team's approvals of this content are all in.
      const given = approvalsInRound(decisions.get(v.id) ?? [], { revision: v.revision, contentHash: v.content_hash });
      if (given.length < (required.get(v.channel_connection_id) ?? 1)) continue;
      if (banned && isBlocked(banned, base(post), v)) continue;
      const values = approvedValues(v, ctx.now);
      await setVariant(ctx, v.id, values);
      settled.push(v.id);
      if (values.status === 'scheduled') scheduled.push(v.id);
    }
    if (settled.length === 0) return { settled, verdict };
    await refreshPostStatus(ctx, post.id);
    ctx.audit({ post_id: post.id, verdict, variants: settled });
    await ctx.emit('social.variant.decided', { post_id: post.id, decision: verdict, variant_ids: settled, waiting_variant_ids: [], by: 'client' });
    if (scheduled.length > 0) await ctx.emit('social.variant.scheduled', { post_id: post.id, variant_ids: scheduled });
    return { settled, verdict };
  },
});

export const clientReviewCommands = [clientSettle];
