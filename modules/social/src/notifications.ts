// In-app notifications (#637): what happened to a post, or to a channel, for the people it concerns. The worker turns
// an outbox event into one row per person (social.notification.dispatch, a system command that reads the event by id
// and never trusts the job): a post sent to review tells the owners and admins; a review decision tells the author; a
// channel that failed or needs attention tells the owners, the admins and the author; an expired channel tells the
// owners and admins; an internal comment or a client's answer tells the author and the people who commented before;
// an assignment tells the assignee, once for all the posts of a bulk assignment (#1062); a reminder of a post still
// waiting for review (#703) tells the owners and admins who have not approved its current content yet; a publishing
// hold put on or taken off (#946) tells the whole team; a
// channel's queue running low (#1079) tells the owners, admins and members, who can fill it; a post doing much better
// than usual (#1132) tells its author and its assignee, who can boost or reuse it. Never the person who acted, never a
// kind the person turned off, and only people who are members when it is written. Each member reads and marks only
// their own (a restrictive policy).
//
// Email (#579): the kinds someone must act on (a post to review, a decision, a failed or stuck post, an expired channel,
// a queue running low, a post doing much better than usual) also go out by email, one per notification, through the
// kernel's queued mail (the suppression
// list, the mail log), unless the member turned Social emails off. The mail names the post and links to it; nothing
// secret is in it. A deployment without mail records the mail as not sent and nothing fails.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { SOCIAL_NOTIFICATION_KINDS, type MemberRole, type SocialNotificationKind } from '@crove/db';
import { createMailMessage } from '@crove/kernel';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { approvalsInRound } from './domain/approval.ts';
import { decisionsOf } from './policy.ts';
import { channelScope, connectionInScope, postInScope, postsVisibleTo, usersInScope } from './channel-access.ts';
import { RATIO_LABEL } from './domain/outperform.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The newest notifications a read returns, and the unread count it reports at most.
export const NOTIFICATION_LIST_LIMIT = 30;
export const NOTIFICATION_UNREAD_CAP = 99;
// Read notifications stay this long; unread ones a while longer.
export const NOTIFICATION_READ_KEEP_DAYS = 30;
export const NOTIFICATION_KEEP_DAYS = 90;

// The events the worker sends to the dispatch.
export const NOTIFYING_EVENTS = [
  'social.post.submitted',
  'social.variant.decided',
  'social.variant.failed',
  'social.variant.needs_attention',
  // A planned takedown that did not happen (#861); a person's own failed ask shows on the post they were looking at.
  'social.variant.remove_failed',
  'kernel.channel.expired',
  'social.post.commented',
  'social.post.mentioned',
  'social.review.answered',
  'social.post.assigned',
  // A bulk assignment (#1062): one notification for all its posts.
  'social.post.bulk_assigned',
  'social.review.reminder',
  'social.feed.paused',
  // The org's publishing held and released (#946): the whole team is told.
  'social.publishing.held',
  'social.publishing.released',
  // A channel's queue ran low (#1079).
  'social.queue.low',
  // A post doing much better than usual (#1132).
  'social.variant.outperforming',
  // Not a notice: a member's links stop working when they lose the right to make them (#625).
  'kernel.member.removed',
  'kernel.member.role_changed',
] as const;

function requireUser(ctx: Pick<CommandContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

interface Plan {
  kind: SocialNotificationKind;
  users: string[];
  postId: string | null;
  connectionId: string | null;
  detail: Record<string, string>;
}

const zPostEvent = z.object({ post_id: zId });
const zVariantEvent = z.object({ post_id: zId, variant_id: zId });

async function deciders(ctx: CommandContext): Promise<string[]> {
  const rows = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('role', 'in', ['owner', 'admin']).execute();
  return rows.map((r) => r.user_id);
}

async function authorOf(ctx: CommandContext, postId: string): Promise<{ author: string | null } | null> {
  const p = await ctx.trx.selectFrom('crove_social.post').select('author_user_id').where('org_id', '=', ctx.orgId).where('id', '=', postId).executeTakeFirst();
  return p ? { author: p.author_user_id } : null;
}

// The author and everyone who commented on the post before.
async function threadOf(ctx: CommandContext, postId: string, author: string | null): Promise<string[]> {
  const rows = await ctx.trx.selectFrom('crove_social.post_comment').select('author_user_id').distinct().where('org_id', '=', ctx.orgId).where('post_id', '=', postId).execute();
  return [...(author ? [author] : []), ...rows.map((r) => r.author_user_id)];
}

// Who an event concerns, and what they are told; null: nobody.
async function planFor(ctx: CommandContext, type: string, payload: unknown): Promise<Plan | null> {
  const base = { connectionId: null, detail: {} };
  switch (type) {
    case 'social.post.submitted': {
      const e = zPostEvent.safeParse(payload);
      if (!e.success) return null;
      // Already decided (a one-step approval, a policy): nothing waits on a reviewer any more.
      const waiting = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', e.data.post_id)
        .where('status', '=', 'in_review')
        .executeTakeFirst();
      if (!waiting) return null;
      return { ...base, kind: 'review_requested', users: await deciders(ctx), postId: e.data.post_id };
    }
    case 'social.variant.decided': {
      const e = z.object({ post_id: zId, decision: z.enum(['approved', 'changes_requested', 'rejected']) }).safeParse(payload);
      if (!e.success) return null;
      const p = await authorOf(ctx, e.data.post_id);
      if (!p?.author) return null;
      return { ...base, kind: 'decided', users: [p.author], postId: e.data.post_id, detail: { decision: e.data.decision } };
    }
    case 'social.variant.failed':
    case 'social.variant.needs_attention': {
      const e = zVariantEvent.safeParse(payload);
      if (!e.success) return null;
      const p = await authorOf(ctx, e.data.post_id);
      if (!p) return null;
      const v = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select(['provider', 'channel_connection_id'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', e.data.variant_id)
        .executeTakeFirst();
      return {
        kind: type === 'social.variant.failed' ? 'failed' : 'needs_attention',
        users: [...(await deciders(ctx)), ...(p.author ? [p.author] : [])],
        postId: e.data.post_id,
        connectionId: v?.channel_connection_id ?? null,
        detail: v ? { provider: v.provider } : {},
      };
    }
    // A failed removal tells the owners and admins only when it was the planned takedown's (#861): nobody was watching
    // it. It counts as a failed post (kind failed, muted and mailed with it), worded as a removal.
    case 'social.variant.remove_failed': {
      const e = z.object({ post_id: zId, variant_id: zId, scheduled: z.literal(true) }).safeParse(payload);
      if (!e.success) return null;
      const v = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select(['provider', 'channel_connection_id', 'status'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', e.data.variant_id)
        .executeTakeFirst();
      // Gone, or removed since (a person asked again): nothing left to do.
      if (!v || v.status !== 'published') return null;
      return { kind: 'failed', users: await deciders(ctx), postId: e.data.post_id, connectionId: v.channel_connection_id, detail: { provider: v.provider, removal: 'scheduled' } };
    }
    case 'kernel.channel.expired': {
      const e = z.object({ connection_id: zId, provider: z.string().max(32) }).safeParse(payload);
      if (!e.success) return null;
      return { kind: 'channel_expired', users: await deciders(ctx), postId: null, connectionId: e.data.connection_id, detail: { provider: e.data.provider } };
    }
    case 'social.post.commented': {
      const e = zPostEvent.safeParse(payload);
      if (!e.success) return null;
      const p = await authorOf(ctx, e.data.post_id);
      if (!p) return null;
      // Those the comment mentions get a mention instead (#793).
      const mentioned = new Set(z.object({ mentioned: z.array(zId).max(50) }).safeParse(payload).data?.mentioned ?? []);
      return { ...base, kind: 'comment', users: (await threadOf(ctx, e.data.post_id, p.author)).filter((u) => !mentioned.has(u)), postId: e.data.post_id };
    }
    case 'social.post.mentioned': {
      const e = z.object({ post_id: zId, user_ids: z.array(zId).min(1).max(50) }).safeParse(payload);
      if (!e.success) return null;
      // Gone since (deleted): nothing to open.
      if (!(await authorOf(ctx, e.data.post_id))) return null;
      return { ...base, kind: 'mention', users: e.data.user_ids, postId: e.data.post_id };
    }
    case 'social.review.answered': {
      const e = z.object({ post_id: zId, feedback_id: zId }).safeParse(payload);
      if (!e.success) return null;
      const f = await ctx.trx
        .selectFrom('crove_social.review_feedback')
        .select(['reviewer_name', 'verdict'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', e.data.feedback_id)
        .where('post_id', '=', e.data.post_id)
        .executeTakeFirst();
      const p = await authorOf(ctx, e.data.post_id);
      if (!f || !p) return null;
      return { ...base, kind: 'client_answer', users: await threadOf(ctx, e.data.post_id, p.author), postId: e.data.post_id, detail: { verdict: f.verdict, name: f.reviewer_name } };
    }
    case 'social.post.assigned': {
      const e = z.object({ post_id: zId, assignee_user_id: zId.nullable(), bulk: z.literal(true).optional() }).safeParse(payload);
      // A post of a bulk assignment is told of with the others, by social.post.bulk_assigned.
      if (!e.success || !e.data.assignee_user_id || e.data.bulk) return null;
      // Gone since (deleted): nothing to open.
      if (!(await authorOf(ctx, e.data.post_id))) return null;
      return { ...base, kind: 'assigned', users: [e.data.assignee_user_id], postId: e.data.post_id };
    }
    // A bulk assignment (#1062): one notification of the posts the assignee may see (#1081) and that are still there; a
    // single post reads as a single assignment, several open the assignee's own posts (detail count).
    case 'social.post.bulk_assigned': {
      const e = z.object({ post_ids: z.array(zId).min(1).max(100), assignee_user_id: zId }).safeParse(payload);
      if (!e.success) return null;
      const there = await ctx.trx.selectFrom('crove_social.post').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', e.data.post_ids).execute();
      const ids = new Set(there.map((p) => p.id));
      const shown = await postsVisibleTo(
        ctx.trx,
        ctx.orgId,
        e.data.assignee_user_id,
        e.data.post_ids.filter((id) => ids.has(id)),
      );
      const [only] = shown;
      if (only === undefined) return null;
      return shown.length === 1
        ? { ...base, kind: 'assigned', users: [e.data.assignee_user_id], postId: only }
        : { ...base, kind: 'assigned', users: [e.data.assignee_user_id], postId: null, detail: { count: String(shown.length) } };
    }
    case 'social.feed.paused': {
      const e = z.object({ feed_id: zId }).safeParse(payload);
      if (!e.success) return null;
      const feed = await ctx.trx.selectFrom('crove_social.feed').select(['url', 'title']).where('org_id', '=', ctx.orgId).where('id', '=', e.data.feed_id).executeTakeFirst();
      if (!feed) return null;
      return { ...base, kind: 'feed_paused', users: await deciders(ctx), postId: null, detail: { feed: (feed.title ?? feed.url).slice(0, 300) } };
    }
    case 'social.publishing.held':
    case 'social.publishing.released': {
      const e = z.object({ hold_id: zId, held_too_long: z.number().int().min(0).optional() }).safeParse(payload);
      if (!e.success) return null;
      const hold = await ctx.trx.selectFrom('crove_social.publish_hold').select('reason').where('org_id', '=', ctx.orgId).where('id', '=', e.data.hold_id).executeTakeFirst();
      if (!hold) return null;
      const team = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).execute();
      const released = type === 'social.publishing.released';
      return {
        ...base,
        kind: 'publishing_hold',
        users: team.map((m) => m.user_id),
        postId: null,
        detail: { state: released ? 'released' : 'held', reason: [...hold.reason].slice(0, 300).join(''), ...(released ? { heldTooLong: String(e.data.held_too_long ?? 0) } : {}) },
      };
    }
    case 'social.queue.low': {
      const e = z
        .object({ queue_id: zId, low_days: z.number().int().min(1).max(30), posting_days: z.number().int().min(0).max(31), filled_days: z.number().int().min(0).max(31) })
        .safeParse(payload);
      if (!e.success) return null;
      // Filled again since, or the warning turned off: nothing to tell.
      const q = await ctx.trx.selectFrom('crove_social.queue').select(['channel_connection_id', 'low_days', 'low_alerted_at']).where('org_id', '=', ctx.orgId).where('id', '=', e.data.queue_id).executeTakeFirst();
      if (!q || q.low_days === null || q.low_alerted_at === null) return null;
      const team = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('role', 'in', ['owner', 'admin', 'member']).execute();
      return {
        kind: 'queue_low',
        users: team.map((m) => m.user_id),
        postId: null,
        connectionId: q.channel_connection_id,
        detail: { days: String(e.data.low_days), posting: String(e.data.posting_days), filled: String(e.data.filled_days) },
      };
    }
    // A post doing much better than usual (#1132): its author and assignee, while it is still out.
    case 'social.variant.outperforming': {
      const e = z
        .object({ post_id: zId, variant_id: zId, ratio: z.string().regex(RATIO_LABEL), reach_ratio: z.string().regex(RATIO_LABEL).nullable().optional() })
        .safeParse(payload);
      if (!e.success) return null;
      const v = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select(['provider', 'channel_connection_id', 'status'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', e.data.variant_id)
        .where('post_id', '=', e.data.post_id)
        .executeTakeFirst();
      // Removed since: nothing left to boost.
      if (!v || v.status !== 'published') return null;
      const p = await ctx.trx.selectFrom('crove_social.post').select(['author_user_id', 'assignee_user_id']).where('org_id', '=', ctx.orgId).where('id', '=', e.data.post_id).executeTakeFirst();
      if (!p) return null;
      return {
        kind: 'post_outperforming',
        users: [p.author_user_id, p.assignee_user_id].filter((u): u is string => u !== null),
        postId: e.data.post_id,
        connectionId: v.channel_connection_id,
        detail: { provider: v.provider, ratio: e.data.ratio, ...(e.data.reach_ratio ? { reach: e.data.reach_ratio } : {}) },
      };
    }
    case 'social.review.reminder': {
      const e = z.object({ post_id: zId, stage: z.enum(['waiting', 'due']), variant_ids: z.array(zId).min(1).max(100) }).safeParse(payload);
      if (!e.success) return null;
      // Still waiting: decided or edited since, there is nothing to remind of.
      const waiting = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select(['id', 'revision', 'content_hash'])
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', e.data.post_id)
        .where('id', 'in', e.data.variant_ids)
        .where('status', '=', 'in_review')
        .execute();
      if (waiting.length === 0) return null;
      // A reviewer who already approved the current content of every waiting channel has nothing left to do.
      const decisions = await decisionsOf(
        ctx.trx,
        ctx.orgId,
        waiting.map((v) => v.id),
      );
      const done = (user: string) => waiting.every((v) => approvalsInRound(decisions.get(v.id) ?? [], { revision: v.revision, contentHash: v.content_hash }).includes(user));
      const users = (await deciders(ctx)).filter((u) => !done(u));
      return { ...base, kind: 'review_reminder', users, postId: e.data.post_id, detail: { stage: e.data.stage } };
    }
    default:
      return null;
  }
}

// The kinds that also go out by email, and the template they use.
export const MAILED_KINDS: ReadonlySet<SocialNotificationKind> = new Set(['review_requested', 'decided', 'failed', 'needs_attention', 'channel_expired', 'mention', 'queue_low', 'post_outperforming']);
export const NOTIFICATION_MAIL_TEMPLATE = 'social.notification';

const oneLine = (text: string, max: number) => {
  const s = text.replace(/\s+/g, ' ').trim();
  return [...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s;
};

function subjectOf(kind: SocialNotificationKind, detail: Record<string, string>, post: string | null, channel: string | null): string {
  const about = post ? `: ${oneLine(post, 80)}` : '';
  switch (kind) {
    case 'review_requested':
      return `Có bài chờ duyệt${about}`;
    case 'decided':
      return `${detail.decision === 'approved' ? 'Bài của bạn đã được duyệt' : detail.decision === 'rejected' ? 'Bài của bạn bị từ chối' : 'Bài của bạn cần sửa'}${about}`;
    case 'failed':
      if (detail.removal === 'scheduled') return `Tự gỡ bài không thành công${channel ? ` trên ${oneLine(channel, 60)}` : ''}${about}`;
      return `Đăng bài không thành công${channel ? ` trên ${oneLine(channel, 60)}` : ''}${about}`;
    case 'needs_attention':
      return `Bài đăng cần bạn xử lý${channel ? ` trên ${oneLine(channel, 60)}` : ''}${about}`;
    case 'mention':
      return `Bạn được nhắc đến trong một bình luận${about}`;
    case 'queue_low':
      return `Hàng đợi của kênh ${channel ? oneLine(channel, 60) : 'mạng xã hội'} sắp hết bài`;
    case 'post_outperforming':
      return `Bài trên ${channel ? oneLine(channel, 60) : 'mạng xã hội'} đang được tương tác gấp ${(detail.ratio ?? '2').replace('.', ',')} lần mức thường lệ${about}`;
    default:
      return `Kênh ${channel ? oneLine(channel, 60) : 'mạng xã hội'} cần kết nối lại`;
  }
}

// One mail per new notification of a mailed kind, to members who did not turn Social emails off.
async function mailNotifications(ctx: CommandContext, plan: Plan, created: readonly { id: string; user_id: string }[]): Promise<number> {
  if (!MAILED_KINDS.has(plan.kind) || created.length === 0) return 0;
  const off = await ctx.trx
    .selectFrom('crove_social.notification_mail_off')
    .select('user_id')
    .where('org_id', '=', ctx.orgId)
    .where(
      'user_id',
      'in',
      created.map((c) => c.user_id),
    )
    .execute();
  const offSet = new Set(off.map((o) => o.user_id));
  const to = created.filter((c) => !offSet.has(c.user_id));
  if (to.length === 0) return 0;
  const { rows: people } = await sql<{ user_id: string; email: string | null }>`
    SELECT user_id, email FROM crove_kernel.member_emails(${to.map((c) => c.user_id)}::uuid[])`.execute(ctx.trx);
  const emails = new Map(people.filter((p) => p.email).map((p) => [p.user_id, p.email as string]));
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  if (!org) return 0;
  const post = plan.postId
    ? await ctx.trx.selectFrom('crove_social.post').select(['title', 'body']).where('org_id', '=', ctx.orgId).where('id', '=', plan.postId).executeTakeFirst()
    : undefined;
  const postText = post ? oneLine([...(post.title?.trim() || post.body || '')].slice(0, 400).join(''), 200) || null : null;
  const channel = plan.connectionId
    ? ((await ctx.trx.selectFrom('crove_kernel.channel_connection').select('display_name').where('org_id', '=', ctx.orgId).where('id', '=', plan.connectionId).executeTakeFirst())?.display_name ?? null)
    : null;
  // A queue running low links to a new post for its channel, to fill it.
  const path = plan.postId
    ? `/o/${org.slug}/social/${plan.postId}`
    : plan.kind === 'queue_low' && plan.connectionId
      ? `/o/${org.slug}/social/new?channel=${plan.connectionId}`
      : `/o/${org.slug}/social/channels`;
  const subject = subjectOf(plan.kind, plan.detail, postText, channel);
  let queued = 0;
  for (const c of to) {
    const email = emails.get(c.user_id);
    if (!email) continue;
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source: 'social.notification.dispatch',
      sourceId: c.id,
      templateKey: NOTIFICATION_MAIL_TEMPLATE,
      to: email,
      subject,
      payload: {
        kind: plan.kind,
        org: org.name,
        post: postText,
        channel,
        decision: plan.detail.decision ?? null,
        ...(plan.detail.removal ? { removal: plan.detail.removal } : {}),
        ...(plan.kind === 'queue_low' ? { days: plan.detail.days ?? null } : {}),
        ...(plan.kind === 'post_outperforming' ? { ratio: plan.detail.ratio ?? null, reach: plan.detail.reach ?? null } : {}),
        path,
      },
      status: 'queued',
    });
    if (mail.status === 'queued') queued++;
  }
  return queued;
}

export const notificationDispatch = defineCommand({
  name: 'social.notification.dispatch',
  input: z.object({ eventId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const event = await ctx.trx
      .selectFrom('crove_kernel.outbox_event')
      .select(['id', 'type', 'payload', 'actor_type', 'actor_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.eventId)
      .executeTakeFirst();
    if (!event) return { sent: 0, mailed: 0 };
    const plan = await planFor(ctx, event.type, event.payload);
    if (!plan) return { sent: 0, mailed: 0 };
    const actor = event.actor_type === 'user' || event.actor_type === null ? event.actor_id : null;
    const wanted = [...new Set(plan.users)].filter((u) => u !== actor);
    if (wanted.length === 0) return { sent: 0, mailed: 0 };
    // Members now, who have not turned this kind off.
    const { rows } = await sql<{ user_id: string }>`
      SELECT m.user_id FROM crove_kernel.tenant_member m
      WHERE m.org_id = ${ctx.orgId} AND m.user_id = ANY(${wanted}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM crove_social.notification_mute x WHERE x.org_id = m.org_id AND x.user_id = m.user_id AND x.kind = ${plan.kind})`.execute(ctx.trx);
    if (rows.length === 0) return { sent: 0, mailed: 0 };
    // A member limited to some channels (#1081) hears only of those and of the posts on them.
    const users = await usersInScope(
      ctx.trx,
      ctx.orgId,
      rows.map((r) => r.user_id),
      { postId: plan.postId, connectionId: plan.connectionId },
    );
    if (users.length === 0) return { sent: 0, mailed: 0 };
    const inserted = await ctx.trx
      .insertInto('crove_social.notification')
      .values(
        users.map((userId) => ({
          org_id: ctx.orgId,
          user_id: userId,
          kind: plan.kind,
          event_id: event.id,
          post_id: plan.postId,
          connection_id: plan.connectionId,
          actor_user_id: actor,
          detail: JSON.stringify(plan.detail),
          created_at: ctx.now,
        })),
      )
      .onConflict((oc) => oc.columns(['org_id', 'event_id', 'user_id']).doNothing())
      .returning(['id', 'user_id'])
      .execute();
    // Only the notifications this run wrote: a replayed event mails nobody twice.
    const mailed = await mailNotifications(ctx, plan, inserted);
    // A post's newest reminder replaces the ones before it.
    if (plan.kind === 'review_reminder' && plan.postId) {
      await sql`
        DELETE FROM crove_social.notification
        WHERE org_id = ${ctx.orgId} AND user_id = ANY(${users}::uuid[]) AND kind = 'review_reminder' AND post_id = ${plan.postId} AND event_id <> ${event.id}`.execute(ctx.trx);
    }
    // The recipients' old ones go.
    await sql`
      DELETE FROM crove_social.notification
      WHERE org_id = ${ctx.orgId} AND user_id = ANY(${users}::uuid[])
        AND (read_at < ${ctx.now}::timestamptz - make_interval(days => ${NOTIFICATION_READ_KEEP_DAYS}::int)
             OR created_at < ${ctx.now}::timestamptz - make_interval(days => ${NOTIFICATION_KEEP_DAYS}::int))`.execute(ctx.trx);
    return { sent: inserted.length, mailed };
  },
});

export interface NotificationItem {
  id: string;
  kind: SocialNotificationKind;
  postId: string | null;
  // The post's title or the start of its text, for the item's line.
  postText: string | null;
  connectionId: string | null;
  channel: string | null;
  // The member who acted, while a member.
  actorName: string | null;
  detail: Record<string, string>;
  createdAt: string;
  read: boolean;
}

// The viewer's newest notifications, how many are unread (up to NOTIFICATION_UNREAD_CAP + 1) and the kinds they
// turned off. A review reminder shows only while its post still has a channel in the round of review it was about; a
// low queue (#1079) only while its queue is still in the dip it was about.
const STILL_WAITING = sql`(n.kind <> 'review_reminder' OR EXISTS (
  SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = n.org_id AND v.post_id = n.post_id AND v.status = 'in_review'
    AND v.review_since <= n.created_at)) AND (n.kind <> 'queue_low' OR EXISTS (
  SELECT 1 FROM crove_social.queue q WHERE q.org_id = n.org_id AND q.channel_connection_id = n.connection_id
    AND q.low_alerted_at <= n.created_at))`;
export const notificationList = defineQuery({
  name: 'social.notification.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ items: NotificationItem[]; unread: number; muted: SocialNotificationKind[]; mailOff: boolean }> => {
    const me = requireUser(ctx);
    // What the viewer may see (#1081): a limited member's notifications of other channels, or of posts with none of
    // theirs, are left out (one written before the limit, say).
    const scope = await channelScope(ctx);
    const seen = sql`(n.connection_id IS NULL OR ${connectionInScope(scope, 'n.connection_id')}) AND (n.post_id IS NULL OR ${postInScope(scope, 'n.post_id', 'n.org_id')})`;
    const { rows } = await sql<{
      id: string;
      kind: SocialNotificationKind;
      post_id: string | null;
      post_text: string | null;
      connection_id: string | null;
      channel: string | null;
      actor_user_id: string | null;
      detail: Record<string, unknown>;
      created_at: Date;
      read_at: Date | null;
    }>`
      SELECT n.id, n.kind, n.post_id, n.connection_id, n.actor_user_id, n.detail, n.created_at, n.read_at,
             left(coalesce(nullif(p.title, ''), p.body), 140) AS post_text, c.display_name AS channel
      FROM crove_social.notification n
      LEFT JOIN crove_social.post p ON p.org_id = n.org_id AND p.id = n.post_id
      LEFT JOIN crove_kernel.channel_connection c ON c.org_id = n.org_id AND c.id = n.connection_id
      WHERE n.org_id = ${ctx.orgId} AND n.user_id = ${me} AND ${STILL_WAITING} AND ${seen}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${NOTIFICATION_LIST_LIMIT}`.execute(ctx.trx);
    const unread = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM crove_social.notification n WHERE n.org_id = ${ctx.orgId} AND n.user_id = ${me} AND n.read_at IS NULL AND ${STILL_WAITING} AND ${seen} LIMIT ${NOTIFICATION_UNREAD_CAP + 1}
      ) u`.execute(ctx.trx);
    const mailOff = await ctx.trx.selectFrom('crove_social.notification_mail_off').select('id').where('org_id', '=', ctx.orgId).where('user_id', '=', me).limit(1).executeTakeFirst();
    const muted = await ctx.trx.selectFrom('crove_social.notification_mute').select('kind').where('org_id', '=', ctx.orgId).where('user_id', '=', me).orderBy('kind').execute();
    const ids = [...new Set(rows.map((r) => r.actor_user_id).filter((u): u is string => u !== null))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(ctx.trx);
      for (const r of people) names.set(r.user_id, r.display_name ?? r.email);
    }
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        postId: r.post_id,
        postText: r.post_text,
        connectionId: r.connection_id,
        channel: r.channel,
        actorName: r.actor_user_id ? (names.get(r.actor_user_id) ?? null) : null,
        detail: Object.fromEntries(Object.entries(r.detail ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
        createdAt: r.created_at.toISOString(),
        read: r.read_at !== null,
      })),
      unread: unread.rows[0]?.n ?? 0,
      muted: muted.map((m) => m.kind),
      mailOff: mailOff !== undefined,
    };
  },
});

// Marks the viewer's own notifications read: the ones named, or all of them.
export const notificationRead = defineCommand({
  name: 'social.notification.read',
  input: z.union([z.strictObject({ ids: z.array(zId).min(1).max(100) }), z.strictObject({ all: z.literal(true) })]),
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input) => {
    const me = requireUser(ctx);
    let q = ctx.trx.updateTable('crove_social.notification').set({ read_at: ctx.now }).where('org_id', '=', ctx.orgId).where('user_id', '=', me).where('read_at', 'is', null);
    if ('ids' in input) q = q.where('id', 'in', input.ids);
    const done = await q.executeTakeFirst();
    return { read: Number(done.numUpdatedRows) };
  },
});

// Turns a kind of notification off, or back on, for the viewer.
export const notificationMute = defineCommand({
  name: 'social.notification.mute',
  input: z.strictObject({ kind: z.enum(SOCIAL_NOTIFICATION_KINDS), muted: z.boolean() }),
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input) => {
    const me = requireUser(ctx);
    if (input.muted) {
      await ctx.trx
        .insertInto('crove_social.notification_mute')
        .values({ org_id: ctx.orgId, user_id: me, kind: input.kind, created_at: ctx.now })
        .onConflict((oc) => oc.columns(['org_id', 'user_id', 'kind']).doNothing())
        .execute();
    } else {
      await ctx.trx.deleteFrom('crove_social.notification_mute').where('org_id', '=', ctx.orgId).where('user_id', '=', me).where('kind', '=', input.kind).execute();
    }
    return { kind: input.kind, muted: input.muted };
  },
});

// Turns the viewer's Social emails off in this org, or back on. The in-app notifications are not touched.
export const notificationMail = defineCommand({
  name: 'social.notification.mail',
  input: z.strictObject({ enabled: z.boolean() }),
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input) => {
    const me = requireUser(ctx);
    await ctx.trx.deleteFrom('crove_social.notification_mail_off').where('org_id', '=', ctx.orgId).where('user_id', '=', me).execute();
    if (!input.enabled) await ctx.trx.insertInto('crove_social.notification_mail_off').values({ org_id: ctx.orgId, user_id: me, created_at: ctx.now }).execute();
    return { enabled: input.enabled };
  },
});

export const notificationCommands = [notificationDispatch, notificationRead, notificationMute, notificationMail];
export const notificationQueries = [notificationList];
