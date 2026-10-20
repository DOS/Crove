// In-app notifications (#637): what happened to a post, or to a channel, for the people it concerns. The worker turns
// an outbox event into one row per person (social.notification.dispatch, a system command that reads the event by id
// and never trusts the job): a post sent to review tells the owners and admins; a review decision tells the author; a
// channel that failed or needs attention tells the owners, the admins and the author; an expired channel tells the
// owners and admins; an internal comment or a client's answer tells the author and the people who commented before;
// an assignment tells the assignee; a reminder of a post still waiting for review (#703) tells the owners and admins who
// have not approved its current content yet. Never the person who acted, never a kind the person turned off, and only people
// who are members when it is written. Each member reads and marks only their own (a restrictive policy).
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { SOCIAL_NOTIFICATION_KINDS, type MemberRole, type SocialNotificationKind } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { approvalsInRound } from './domain/approval.ts';
import { decisionsOf } from './policy.ts';

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
  'kernel.channel.expired',
  'social.post.commented',
  'social.review.answered',
  'social.post.assigned',
  'social.review.reminder',
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
      return { ...base, kind: 'comment', users: await threadOf(ctx, e.data.post_id, p.author), postId: e.data.post_id };
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
      const e = z.object({ post_id: zId, assignee_user_id: zId.nullable() }).safeParse(payload);
      if (!e.success || !e.data.assignee_user_id) return null;
      // Gone since (deleted): nothing to open.
      if (!(await authorOf(ctx, e.data.post_id))) return null;
      return { ...base, kind: 'assigned', users: [e.data.assignee_user_id], postId: e.data.post_id };
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
    if (!event) return { sent: 0 };
    const plan = await planFor(ctx, event.type, event.payload);
    if (!plan) return { sent: 0 };
    const actor = event.actor_type === 'user' || event.actor_type === null ? event.actor_id : null;
    const wanted = [...new Set(plan.users)].filter((u) => u !== actor);
    if (wanted.length === 0) return { sent: 0 };
    // Members now, who have not turned this kind off.
    const { rows } = await sql<{ user_id: string }>`
      SELECT m.user_id FROM crove_kernel.tenant_member m
      WHERE m.org_id = ${ctx.orgId} AND m.user_id = ANY(${wanted}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM crove_social.notification_mute x WHERE x.org_id = m.org_id AND x.user_id = m.user_id AND x.kind = ${plan.kind})`.execute(ctx.trx);
    if (rows.length === 0) return { sent: 0 };
    const users = rows.map((r) => r.user_id);
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
      .returning('id')
      .execute();
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
    return { sent: inserted.length };
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
// turned off. A review reminder shows only while its post still has a channel in the round of review it was about.
const STILL_WAITING = sql`(n.kind <> 'review_reminder' OR EXISTS (
  SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = n.org_id AND v.post_id = n.post_id AND v.status = 'in_review'
    AND v.review_since <= n.created_at))`;
export const notificationList = defineQuery({
  name: 'social.notification.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ items: NotificationItem[]; unread: number; muted: SocialNotificationKind[] }> => {
    const me = requireUser(ctx);
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
      WHERE n.org_id = ${ctx.orgId} AND n.user_id = ${me} AND ${STILL_WAITING}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${NOTIFICATION_LIST_LIMIT}`.execute(ctx.trx);
    const unread = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM crove_social.notification n WHERE n.org_id = ${ctx.orgId} AND n.user_id = ${me} AND n.read_at IS NULL AND ${STILL_WAITING} LIMIT ${NOTIFICATION_UNREAD_CAP + 1}
      ) u`.execute(ctx.trx);
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

export const notificationCommands = [notificationDispatch, notificationRead, notificationMute];
export const notificationQueries = [notificationList];
