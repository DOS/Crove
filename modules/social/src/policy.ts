// Review policy per channel (Social plan S9, issue #394): how many different people approve a variant for a channel
// before it may be scheduled. A channel without a policy needs one approval. Each approval binds the revision and
// content hash its reviewer saw (post_approval), and a person approves a variant's content once.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { approvalsInRound } from './domain/approval.ts';
import { lockPost, lockVariants, refreshPostStatus, setVariant, step, type Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const MAX_APPROVALS = 3;

// The approvals each connection needs (1 for a connection without a policy).
export async function approvalsRequired(trx: Trx, orgId: string, connectionIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map(connectionIds.map((id) => [id, 1]));
  if (connectionIds.length === 0) return out;
  const rows = await trx
    .selectFrom('crove_social.channel_policy')
    .select(['channel_connection_id', 'approvals_required'])
    .where('org_id', '=', orgId)
    .where('channel_connection_id', 'in', [...connectionIds])
    .execute();
  for (const r of rows) out.set(r.channel_connection_id, r.approvals_required);
  return out;
}

// The review decisions of variants, newest first, as approvalsInRound reads them.
export async function decisionsOf(trx: Trx, orgId: string, variantIds: readonly string[]) {
  const out = new Map<string, { decision: string; decidedBy: string; revision: number; contentHash: string }[]>();
  if (variantIds.length === 0) return out;
  const rows = await trx
    .selectFrom('crove_social.post_approval')
    .select(['variant_id', 'decision', 'decided_by', 'revision', 'content_hash'])
    .where('org_id', '=', orgId)
    .where('variant_id', 'in', [...variantIds])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  for (const r of rows) out.set(r.variant_id, [...(out.get(r.variant_id) ?? []), { decision: r.decision, decidedBy: r.decided_by, revision: r.revision, contentHash: r.content_hash }]);
  return out;
}

export const policySet = defineCommand({
  name: 'social.channel.set_policy',
  input: z.strictObject({ connectionId: zId, approvalsRequired: z.number().int().min(1).max(MAX_APPROVALS) }),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const userId = ctx.actor.userId;
    const connection = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .where('status', '<>', 'revoked')
      .executeTakeFirst();
    if (!connection) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh này');
    await ctx.trx
      .insertInto('crove_social.channel_policy')
      .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, approvals_required: input.approvalsRequired, updated_by: userId })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id']).doUpdateSet({ approvals_required: input.approvalsRequired, updated_by: userId, updated_at: ctx.now }))
      .execute();
    // A lower bar may already be met: variants in review with enough approvals of their current content are approved.
    const waiting = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['post_id'])
      .distinct()
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .where('status', '=', 'in_review')
      .orderBy('post_id')
      .execute();
    const approved: string[] = [];
    for (const { post_id } of waiting) {
      await lockPost(ctx.trx, ctx.orgId, post_id);
      const variants = (await lockVariants(ctx.trx, ctx.orgId, post_id)).filter((v) => v.channel_connection_id === input.connectionId && v.status === 'in_review');
      const decisions = await decisionsOf(
        ctx.trx,
        ctx.orgId,
        variants.map((v) => v.id),
      );
      for (const v of variants) {
        const given = approvalsInRound(decisions.get(v.id) ?? [], { revision: v.revision, contentHash: v.content_hash });
        if (given.length < input.approvalsRequired) continue;
        await setVariant(ctx, v.id, { status: step(v, { type: 'approve' }) });
        approved.push(v.id);
      }
      await refreshPostStatus(ctx, post_id);
    }
    ctx.audit({ connection_id: input.connectionId, approvals_required: input.approvalsRequired, approved_variants: approved });
    return { connectionId: input.connectionId, approvalsRequired: input.approvalsRequired, approved };
  },
});

export const policyList = defineQuery({
  name: 'social.channel.policies',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => {
    const rows = await ctx.trx
      .selectFrom('crove_social.channel_policy')
      .select(['channel_connection_id', 'approvals_required', 'updated_by', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('channel_connection_id')
      .execute();
    return rows.map((r) => ({ connectionId: r.channel_connection_id, approvalsRequired: r.approvals_required, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() }));
  },
});

export const policyCommands = [policySet];
export const policyQueries = [policyList];
