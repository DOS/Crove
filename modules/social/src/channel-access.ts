// Which channels a member may use (issue #1081), as Hootsuite, Sprout and Publer let an admin give a freelancer or a
// client's editor some social accounts only. Every Social command and query that touches a variant or a channel asks
// this one helper; nothing else decides it.
//
// Rules:
// - A member or viewer with any row in crove_social.channel_access is limited to the channels of those rows; one with
//   none uses every channel. Any row counts, whatever the status of its connection: a revoked or expired connection
//   still limits, so revoking a limited member's only channel never widens them to every channel.
// - Owners and admins are never limited, whatever rows exist (a role change needs no cleanup). Neither are agents and
//   the system: the limits are a member's.
// - Commands refuse a channel the member may not use with 403 CHANNEL_NOT_ALLOWED: creating, editing, submitting,
//   approving, scheduling, publishing, removing or commenting on a variant there, and acting on a post that has no
//   variant on a channel they may use. A command that acts on a post's variants by default (submit, schedule) acts on
//   the ones the member may use. An edit of a post's shared content that would change a variant on another channel is
//   refused: the member cannot see that variant.
// - Queries hide what the member may not use: a post with no variant on their channels is not shown (a single read
//   answers POST_NOT_FOUND), a post with some shows only those variants, and metrics, insights, exports, the
//   calendar, activity and notifications leave the other channels out.
// - Owners and admins replace a member's list with social.channel_access.set; an empty list lifts the limit. The
//   database keeps the rows org-wide under RLS, and crove_tenant may insert and delete them, so the command's role check
//   is what keeps a limited member from changing their own list or anyone's.
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { zSocialChannelAccessSet } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import type { Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

// null: every channel. Otherwise the connections the member may use (never empty: no rows means not limited).
export type ChannelScope = ReadonlySet<string> | null;

type ScopeContext = Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role'>;

// The rows of a member, whatever their role: what the list says, not whether it applies.
async function listOf(trx: Trx, orgId: string, userId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('crove_social.channel_access')
    .select('channel_connection_id')
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .orderBy('channel_connection_id')
    .execute();
  return rows.map((r) => r.channel_connection_id);
}

// The channels the caller may use. Read in the caller's transaction each time (a list changed by an earlier command
// of the same transaction counts).
export async function channelScope(ctx: ScopeContext): Promise<ChannelScope> {
  if (ctx.actor.type !== 'user') return null;
  if (ctx.role === 'owner' || ctx.role === 'admin') return null;
  const ids = await listOf(ctx.trx, ctx.orgId, ctx.actor.userId);
  return ids.length === 0 ? null : new Set(ids);
}

export const mayUse = (scope: ChannelScope, connectionId: string): boolean => scope === null || scope.has(connectionId);

// The rows among these whose channel the caller may use.
export const inScope = <T extends { channel_connection_id: string }>(scope: ChannelScope, rows: readonly T[]): T[] => (scope === null ? [...rows] : rows.filter((r) => scope.has(r.channel_connection_id)));

export function channelNotAllowed(connectionIds: readonly string[]): DomainError {
  return new DomainError('CHANNEL_NOT_ALLOWED', 403, 'Bạn không được dùng kênh này; hãy nhờ chủ sở hữu hoặc quản trị viên mở thêm kênh cho bạn', { connectionIds });
}

// Refuses when any of these channels is one the caller may not use.
export function refuseOutside(scope: ChannelScope, connectionIds: Iterable<string>): void {
  if (scope === null) return;
  const outside = [...new Set(connectionIds)].filter((id) => !scope.has(id)).sort();
  if (outside.length > 0) throw channelNotAllowed(outside);
}

export async function refuseChannels(ctx: ScopeContext, connectionIds: Iterable<string>): Promise<ChannelScope> {
  const scope = await channelScope(ctx);
  refuseOutside(scope, connectionIds);
  return scope;
}

// A command on a whole post (its labels, its assignee, a comment, a copy): the post must have a variant on a channel
// the caller may use, as the reads that show it to them. Returns the scope for the command's own variant checks.
export async function refusePostOutside(ctx: ScopeContext, postId: string): Promise<ChannelScope> {
  const scope = await channelScope(ctx);
  if (scope === null) return scope;
  const rows = await ctx.trx.selectFrom('crove_social.post_variant').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('post_id', '=', postId).execute();
  if (rows.length > 0 && !rows.some((r) => scope.has(r.channel_connection_id))) throw channelNotAllowed([...new Set(rows.map((r) => r.channel_connection_id))].sort());
  return scope;
}

// A command that makes the worker act on every channel of a post later (evergreen reposts, recurring copies): every
// variant of the post must be on a channel the caller may use.
export async function refusePostWholly(ctx: ScopeContext, postId: string): Promise<ChannelScope> {
  const scope = await channelScope(ctx);
  if (scope === null) return scope;
  const rows = await ctx.trx.selectFrom('crove_social.post_variant').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('post_id', '=', postId).execute();
  refuseOutside(
    scope,
    rows.map((r) => r.channel_connection_id),
  );
  return scope;
}

// SQL: the connection column is one the caller may use (TRUE when they are not limited).
export function connectionInScope(scope: ChannelScope, column: string): RawBuilder<boolean> {
  return scope === null ? sql<boolean>`TRUE` : sql<boolean>`${sql.ref(column)} = ANY(${[...scope]}::uuid[])`;
}

// SQL: the post (by its org and id columns) has a variant on a channel the caller may use (TRUE when not limited).
// Every post has at least one variant: none is ever deleted, and a post is made with one or more.
export function postInScope(scope: ChannelScope, idColumn = 'p.id', orgColumn = 'p.org_id'): RawBuilder<boolean> {
  return scope === null
    ? sql<boolean>`TRUE`
    : sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant sv WHERE sv.org_id = ${sql.ref(orgColumn)} AND sv.post_id = ${sql.ref(idColumn)} AND sv.channel_connection_id = ANY(${[...scope]}::uuid[]))`;
}

// The posts among these the caller may see, in their order.
export async function postsInScope(ctx: ScopeContext, scope: ChannelScope, postIds: readonly string[]): Promise<string[]> {
  if (scope === null || postIds.length === 0) return [...postIds];
  const rows = await ctx.trx
    .selectFrom('crove_social.post_variant')
    .select('post_id')
    .distinct()
    .where('org_id', '=', ctx.orgId)
    .where('post_id', 'in', [...new Set(postIds)])
    .where('channel_connection_id', 'in', [...scope])
    .execute();
  const seen = new Set(rows.map((r) => r.post_id));
  return postIds.filter((id) => seen.has(id));
}

// The variants among these the caller may see.
export async function variantsInScope(ctx: ScopeContext, scope: ChannelScope, variantIds: readonly string[]): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  let q = ctx.trx.selectFrom('crove_social.post_variant').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', [...new Set(variantIds)]);
  if (scope !== null) q = q.where('channel_connection_id', 'in', [...scope]);
  return new Set((await q.execute()).map((r) => r.id));
}

// The people among these who may hear of a post or a channel (notifications, #1081): owners, admins and members who
// are not limited, and limited ones when the channel is one of theirs and the post has a variant on one of theirs.
export async function usersInScope(trx: Trx, orgId: string, userIds: readonly string[], about: { postId: string | null; connectionId: string | null }): Promise<string[]> {
  if (userIds.length === 0) return [];
  const roles = await trx.selectFrom('crove_kernel.tenant_member').select(['user_id', 'role']).where('org_id', '=', orgId).where('user_id', 'in', [...userIds]).execute();
  const free = new Set(roles.filter((r) => r.role === 'owner' || r.role === 'admin').map((r) => r.user_id));
  const rest = userIds.filter((u) => !free.has(u));
  if (rest.length === 0) return [...userIds];
  const rows = await trx.selectFrom('crove_social.channel_access').select(['user_id', 'channel_connection_id']).where('org_id', '=', orgId).where('user_id', 'in', rest).execute();
  const lists = new Map<string, Set<string>>();
  for (const r of rows) lists.set(r.user_id, (lists.get(r.user_id) ?? new Set<string>()).add(r.channel_connection_id));
  const postChannels = about.postId
    ? (await trx.selectFrom('crove_social.post_variant').select('channel_connection_id').where('org_id', '=', orgId).where('post_id', '=', about.postId).execute()).map((v) => v.channel_connection_id)
    : [];
  return userIds.filter((u) => {
    const scope = lists.get(u);
    if (free.has(u) || scope === undefined) return true;
    if (about.connectionId !== null && !scope.has(about.connectionId)) return false;
    return about.postId === null || postChannels.length === 0 || postChannels.some((c) => scope.has(c));
  });
}

// The posts among these a person may see, in their order, as usersInScope decides for one post: every post for owners,
// admins and members who are not limited; for a limited one, those with a variant on one of their channels. Nobody
// who is not a member sees any. For a notification about many posts at once (a bulk assignment, #1062).
export async function postsVisibleTo(trx: Trx, orgId: string, userId: string, postIds: readonly string[]): Promise<string[]> {
  if (postIds.length === 0) return [];
  const member = await trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', orgId).where('user_id', '=', userId).executeTakeFirst();
  if (!member) return [];
  const list = member.role === 'owner' || member.role === 'admin' ? [] : await listOf(trx, orgId, userId);
  if (list.length === 0) return [...postIds];
  const rows = await trx
    .selectFrom('crove_social.post_variant')
    .select('post_id')
    .distinct()
    .where('org_id', '=', orgId)
    .where('post_id', 'in', [...new Set(postIds)])
    .where('channel_connection_id', 'in', list)
    .execute();
  const seen = new Set(rows.map((r) => r.post_id));
  return postIds.filter((id) => seen.has(id));
}

export interface ChannelAccessEntry {
  userId: string;
  // The channels of the member's list; an owner's or admin's list does not apply while they hold that role.
  connectionIds: string[];
}

// Replaces a member's list in one transaction. An empty list lifts the limit. Only owners and admins, and only for a
// member or a viewer: owners and admins use every channel, so a list for them would do nothing (clearing one left from
// before a promotion is allowed). Every channel must be one of the org's, of any status (a list may keep a revoked one,
// which still limits).
export const channelAccessSet = defineCommand({
  name: 'social.channel_access.set',
  input: zSocialChannelAccessSet,
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const by = ctx.actor.userId;
    // One change of a member's list at a time, so two at once never leave a mix of both.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_social.channel_access:${ctx.orgId}:${input.userId}`}, 0))`.execute(ctx.trx);
    const member = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', ctx.orgId).where('user_id', '=', input.userId).executeTakeFirst();
    if (!member) throw new DomainError('MEMBER_NOT_FOUND', 404, 'Người này không phải thành viên của tổ chức');
    const ids = [...new Set(input.channelConnectionIds.map((id) => id.toLowerCase()))].sort();
    if (ids.length > 0 && (member.role === 'owner' || member.role === 'admin')) {
      throw new DomainError('CHANNEL_ACCESS_NOT_LIMITABLE', 422, 'Chủ sở hữu và quản trị viên luôn dùng được mọi kênh, nên không giới hạn kênh cho họ được', { role: member.role });
    }
    if (ids.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
      if (found.length !== ids.length) {
        const known = new Set(found.map((c) => c.id));
        throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không thuộc tổ chức này', { connectionIds: ids.filter((id) => !known.has(id)) });
      }
    }
    const before = await listOf(ctx.trx, ctx.orgId, input.userId);
    const removed = before.filter((id) => !ids.includes(id));
    const added = ids.filter((id) => !before.includes(id));
    if (removed.length > 0) {
      await ctx.trx.deleteFrom('crove_social.channel_access').where('org_id', '=', ctx.orgId).where('user_id', '=', input.userId).where('channel_connection_id', 'in', removed).execute();
    }
    if (added.length > 0) {
      await ctx.trx
        .insertInto('crove_social.channel_access')
        .values(added.map((id) => ({ org_id: ctx.orgId, user_id: input.userId, channel_connection_id: id, created_by: by })))
        .execute();
    }
    ctx.audit({ user_id: input.userId, limited: ids.length > 0, connection_ids: ids, added, removed });
    return { userId: input.userId, limited: ids.length > 0, connectionIds: ids };
  },
});

// Every member's list, for the admin screen: members without a row are not listed (they use every channel).
export const channelAccessList = defineQuery({
  name: 'social.channel_access.list',
  input: z.object({}),
  access: ADMINS,
  handler: async (ctx): Promise<ChannelAccessEntry[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_social.channel_access')
      .select(['user_id', 'channel_connection_id'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('user_id')
      .orderBy('channel_connection_id')
      .execute();
    const byUser = new Map<string, string[]>();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.channel_connection_id]);
    return [...byUser].map(([userId, connectionIds]) => ({ userId, connectionIds }));
  },
});

// The caller's own limit, for the composer and the note on the channels page.
export const channelAccessMine = defineQuery({
  name: 'social.channel_access.mine',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ limited: boolean; connectionIds: string[] }> => {
    const scope = await channelScope(ctx);
    return scope === null ? { limited: false, connectionIds: [] } : { limited: true, connectionIds: [...scope].sort() };
  },
});

export const channelAccessCommands = [channelAccessSet];
export const channelAccessQueries = [channelAccessList, channelAccessMine];
