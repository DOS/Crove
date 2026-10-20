// Review policy per channel (Social plan S9, issue #394): how many different people approve a variant for a channel
// before it may be scheduled. A channel without a policy needs one approval. Each approval binds the revision and
// content hash its reviewer saw (post_approval), and a person approves a variant's content once.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole, SocialVariantStatus } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { approvalsInRound } from './domain/approval.ts';
import { approvedValues, lockPost, lockVariants, refreshPostStatus, regateValues, setVariant, type Trx, type VariantRow } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const OWNERS: readonly MemberRole[] = ['owner'];
export const MAX_APPROVALS = 3;
// Variants a policy change re-checks: in review, or approved and not yet handed to the publisher.
const GATED: readonly SocialVariantStatus[] = ['in_review', 'approved', 'scheduled', 'paused'];

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

// The review decisions of variants, newest first, as approvalsInRound reads them. Newest by id: uuid_v7 takes the clock
// when the row is written, under the post lock, while created_at is the start of its transaction, which a decision
// that waited for the lock may share with an older one.
// The channels where an author may not approve their own post (four-eyes, #740).
export async function fourEyesOn(trx: Trx, orgId: string, connectionIds: readonly string[]): Promise<Set<string>> {
  if (connectionIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom('crove_social.channel_policy')
    .select('channel_connection_id')
    .where('org_id', '=', orgId)
    .where('channel_connection_id', 'in', [...connectionIds])
    .where('four_eyes', '=', true)
    .execute();
  return new Set(rows.map((r) => r.channel_connection_id));
}

export async function decisionsOf(trx: Trx, orgId: string, variantIds: readonly string[]) {
  const out = new Map<string, { decision: string; decidedBy: string; revision: number; contentHash: string }[]>();
  if (variantIds.length === 0) return out;
  const rows = await trx
    .selectFrom('crove_social.post_approval')
    .select(['variant_id', 'decision', 'decided_by', 'revision', 'content_hash'])
    .where('org_id', '=', orgId)
    .where('variant_id', 'in', [...variantIds])
    .orderBy('id', 'desc')
    .execute();
  for (const r of rows) out.set(r.variant_id, [...(out.get(r.variant_id) ?? []), { decision: r.decision, decidedBy: r.decided_by, revision: r.revision, contentHash: r.content_hash }]);
  return out;
}

// Whether a variant has fewer approvals of its current content than its channel's review policy asks for now.
export async function shortOfPolicy(trx: Trx, orgId: string, v: Pick<VariantRow, 'id' | 'channel_connection_id' | 'revision' | 'content_hash'>): Promise<boolean> {
  const required = (await approvalsRequired(trx, orgId, [v.channel_connection_id])).get(v.channel_connection_id) ?? 1;
  const decisions = (await decisionsOf(trx, orgId, [v.id])).get(v.id) ?? [];
  return approvalsInRound(decisions, { revision: v.revision, contentHash: v.content_hash }).length < required;
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
    // The new bar applies to every variant not yet handed to the publisher (#408): in review with enough approvals of
    // its current content, it is approved; approved, scheduled or paused with fewer, it goes back to review and keeps
    // its place in the queue until the missing approvals are given.
    const touched = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['post_id'])
      .distinct()
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .where('status', 'in', GATED)
      .orderBy('post_id')
      .execute();
    const approved: string[] = [];
    const regated: string[] = [];
    // Each post's changes reach the event consumers as a decision or a submission would, marked as made by the policy.
    const decided: { postId: string; variantIds: string[] }[] = [];
    const resubmitted: { postId: string; variantIds: string[] }[] = [];
    const backOnSchedule: { postId: string; variantIds: string[] }[] = [];
    for (const { post_id } of touched) {
      await lockPost(ctx.trx, ctx.orgId, post_id);
      const variants = (await lockVariants(ctx.trx, ctx.orgId, post_id)).filter((v) => v.channel_connection_id === input.connectionId && GATED.includes(v.status));
      const decisions = await decisionsOf(
        ctx.trx,
        ctx.orgId,
        variants.map((v) => v.id),
      );
      const up: string[] = [];
      const back: string[] = [];
      const rescheduled: string[] = [];
      for (const v of variants) {
        const given = approvalsInRound(decisions.get(v.id) ?? [], { revision: v.revision, contentHash: v.content_hash });
        if (v.status === 'in_review' && given.length >= input.approvalsRequired) {
          const values = approvedValues(v, ctx.now);
          await setVariant(ctx, v.id, values);
          up.push(v.id);
          if (values.status === 'scheduled') rescheduled.push(v.id);
        } else if (v.status !== 'in_review' && given.length < input.approvalsRequired) {
          await setVariant(ctx, v.id, regateValues(v));
          back.push(v.id);
        }
      }
      await refreshPostStatus(ctx, post_id);
      approved.push(...up);
      regated.push(...back);
      if (up.length > 0) decided.push({ postId: post_id, variantIds: up });
      if (back.length > 0) resubmitted.push({ postId: post_id, variantIds: back });
      if (rescheduled.length > 0) backOnSchedule.push({ postId: post_id, variantIds: rescheduled });
    }
    for (const d of decided) {
      await ctx.emit('social.variant.decided', { post_id: d.postId, decision: 'approved', variant_ids: d.variantIds, waiting_variant_ids: [], by_policy: true });
    }
    for (const r of resubmitted) await ctx.emit('social.post.submitted', { post_id: r.postId, variant_ids: r.variantIds, by_policy: true });
    for (const s of backOnSchedule) await ctx.emit('social.variant.scheduled', { post_id: s.postId, variant_ids: s.variantIds, by_policy: true });
    ctx.audit({ connection_id: input.connectionId, approvals_required: input.approvalsRequired, approved_variants: approved, regated_variants: regated });
    return { connectionId: input.connectionId, approvalsRequired: input.approvalsRequired, approved, regated };
  },
});

// Whether the channel's reviewers are reminded of posts waiting for review (#703); on unless turned off.
export const remindersSet = defineCommand({
  name: 'social.channel.set_reminders',
  input: z.strictObject({ connectionId: zId, reviewReminders: z.boolean() }),
  risk: 'R1',
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
    // A new policy row keeps the default of one approval.
    await ctx.trx
      .insertInto('crove_social.channel_policy')
      .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, review_reminders: input.reviewReminders, updated_by: userId })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id']).doUpdateSet({ review_reminders: input.reviewReminders, updated_by: userId, updated_at: ctx.now }))
      .execute();
    ctx.audit({ connection_id: input.connectionId, review_reminders: input.reviewReminders });
    return { connectionId: input.connectionId, reviewReminders: input.reviewReminders };
  },
});

// Four-eyes on a channel (#740): its posts are approved by someone other than their author. Owners only: turning it off
// weakens review. Posts already approved stay approved.
export const fourEyesSet = defineCommand({
  name: 'social.channel.set_four_eyes',
  input: z.strictObject({ connectionId: zId, fourEyes: z.boolean() }),
  risk: 'R2',
  access: OWNERS,
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
      .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, four_eyes: input.fourEyes, updated_by: userId })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id']).doUpdateSet({ four_eyes: input.fourEyes, updated_by: userId, updated_at: ctx.now }))
      .execute();
    ctx.audit({ connection_id: input.connectionId, four_eyes: input.fourEyes });
    return { connectionId: input.connectionId, fourEyes: input.fourEyes };
  },
});

// Whether the channel's posts send their link through Crove's short links (#706), to count clicks; off unless turned on.
// The link of a post that went out already stays as it went.
export const shortLinksSet = defineCommand({
  name: 'social.channel.set_short_links',
  input: z.strictObject({ connectionId: zId, shortLinks: z.boolean() }),
  risk: 'R1',
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
      .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, short_links: input.shortLinks, updated_by: userId })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id']).doUpdateSet({ short_links: input.shortLinks, updated_by: userId, updated_at: ctx.now }))
      .execute();
    ctx.audit({ connection_id: input.connectionId, short_links: input.shortLinks });
    return { connectionId: input.connectionId, shortLinks: input.shortLinks };
  },
});

export const policyList = defineQuery({
  name: 'social.channel.policies',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => {
    // A revoked connection's policy row stays (it can get no new posts) but is not shown (#408).
    const rows = await ctx.trx
      .selectFrom('crove_social.channel_policy as p')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'p.org_id').onRef('c.id', '=', 'p.channel_connection_id'))
      .select(['p.channel_connection_id', 'p.approvals_required', 'p.review_reminders', 'p.short_links', 'p.four_eyes', 'p.updated_by', 'p.updated_at'])
      .where('p.org_id', '=', ctx.orgId)
      .where('c.status', '<>', 'revoked')
      .orderBy('p.channel_connection_id')
      .execute();
    return rows.map((r) => ({ connectionId: r.channel_connection_id, approvalsRequired: r.approvals_required, reviewReminders: r.review_reminders, shortLinks: r.short_links, fourEyes: r.four_eyes, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() }));
  },
});

// Per connection, the variants waiting paused on it (an expired or disconnected channel, #577): they go out again
// once the channel is reconnected.
export const channelWaiting = defineQuery({
  name: 'social.channel.waiting',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => {
    const rows = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['channel_connection_id', (eb) => eb.fn.countAll<string>().as('paused')])
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'paused')
      .groupBy('channel_connection_id')
      .orderBy('channel_connection_id')
      .execute();
    return rows.map((r) => ({ connectionId: r.channel_connection_id, paused: Number(r.paused) }));
  },
});

export const policyCommands = [policySet, remindersSet, shortLinksSet, fourEyesSet];
export const policyQueries = [policyList, channelWaiting];
