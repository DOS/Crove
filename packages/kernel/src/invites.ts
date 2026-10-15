// Pending member invites with consent (issue #35, plan §7.3). Owners and admins invite an email address in the org;
// the person becomes a member only when they accept, signed in with an account that has that email.
//
// In the org (execute()): kernel.member.invite and kernel.member.invite_revoke write crove_kernel.member_invite
// through tenant RLS. For the invitee, who is not a member yet:
// - accepting is the org-less command kernel.member.invite_accept: its bootstrap, the definer member_invite_accept,
//   checks the invite and creates the membership, then executeOrgless() enters the org as the new member and writes
//   the audit row in the same transaction (a deferred trigger refuses the commit without it);
// - declining and listing are definers called in runtime.forUser(), after the session check; the decline definer
//   writes its own audit row, since a non-member cannot enter the org.
// Every definer matches the invite to the caller's account email (set from the verified access token on sign-in),
// never to an address the client sends.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zInviteEmail, zInviteRole } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, toDomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';
import type { OrgSummary } from './identity.ts';
import { lockMembers } from './membership.ts';

const ADMINS = ['owner', 'admin'] as const;
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// Open, unexpired invites an org may hold at once, so a compromised admin cannot flood other people's invite lists.
export const MAX_OPEN_INVITES = 100;
// Declined invites stay on the org's list this long, so the inviter sees the answer.
const DECLINED_VISIBLE_DAYS = 30;

const INVITE_ERRORS: Record<string, () => DomainError> = {
  INVITE_NOT_FOUND: () => new DomainError('INVITE_NOT_FOUND', 404, 'Không tìm thấy lời mời'),
  INVITE_REVOKED: () => new DomainError('INVITE_REVOKED', 409, 'Lời mời này đã bị thu hồi'),
  INVITE_CLOSED: () => new DomainError('INVITE_CLOSED', 409, 'Lời mời này đã được xử lý'),
  INVITE_EXPIRED: () => new DomainError('INVITE_EXPIRED', 409, 'Lời mời đã hết hạn, hãy nhờ người mời gửi lại'),
  INVITE_STALE: () =>
    new DomainError('INVITE_STALE', 409, 'Người gửi lời mời không còn quyền mời; hãy nhờ chủ sở hữu hoặc quản trị viên gửi lại'),
  ALREADY_MEMBER: () => new DomainError('ALREADY_MEMBER', 409, 'Bạn đã là thành viên của tổ chức này'),
};

// Maps the invite definers' exceptions (RAISE EXCEPTION '<CODE>', SQLSTATE P0001) to domain errors.
function inviteError(error: unknown): DomainError {
  const pg = error as { code?: string; message?: string } | null;
  const known = pg?.code === 'P0001' && pg.message ? INVITE_ERRORS[pg.message] : undefined;
  return known ? known() : toDomainError(error);
}

const forbidden = (message = 'Vai trò của bạn không được thực hiện việc này') => new DomainError('FORBIDDEN', 403, message);

// The actor's role as of now, under the same locks as role changes and removals (see lockMembers), so an owner or
// admin demoted or removed by a concurrent command is refused.
async function lockInviter(ctx: Parameters<typeof lockMembers>[0]) {
  if (ctx.actor.type !== 'user') throw forbidden('Chỉ người dùng mới quản lý được thành viên');
  const { actorRole } = await lockMembers(ctx, ctx.actor.userId, ctx.actor.userId);
  if (actorRole !== 'owner' && actorRole !== 'admin') throw forbidden();
  return { actorId: ctx.actor.userId, actorRole };
}

// Invites an email address into the org. R3 like every membership change (P11). Owners invite any role but owner;
// admins invite members and viewers. An open invite to the same address is revoked (its own audited command) and
// replaced, so the new role and expiry apply. Nobody becomes a member here.
export const inviteMember = defineCommand({
  name: 'kernel.member.invite',
  input: z.object({ email: zInviteEmail, role: zInviteRole }),
  risk: 'R3',
  access: ADMINS,
  handler: async (ctx, input) => {
    const { actorId, actorRole } = await lockInviter(ctx);
    if (input.role === 'admin' && actorRole !== 'owner') throw forbidden('Chỉ chủ sở hữu mới mời được quản trị viên');
    // Locks the open invite to this address, so two invites to one address serialize here.
    const open = await ctx.trx
      .selectFrom('crove_kernel.member_invite')
      .select(['id', 'role'])
      .where('org_id', '=', ctx.orgId)
      .where('email', '=', input.email)
      .where('accepted_at', 'is', null)
      .where('declined_at', 'is', null)
      .where('revoked_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (open?.role === 'admin' && actorRole !== 'owner') throw forbidden('Chỉ chủ sở hữu mới đổi được lời mời quản trị viên');
    const member = await ctx.trx
      .selectFrom('crove_kernel.tenant_member as m')
      .innerJoin('crove_kernel.user_account as u', 'u.id', 'm.user_id')
      .select('m.user_id')
      .where('m.org_id', '=', ctx.orgId)
      .where(sql<string>`lower(btrim(u.email))`, '=', input.email)
      .executeTakeFirst();
    if (member) throw new DomainError('ALREADY_MEMBER', 409, 'Người này đã là thành viên của tổ chức');
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM crove_kernel.member_invite
      WHERE org_id = ${ctx.orgId}::uuid AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL
        AND expires_at > now() AND email <> ${input.email}`.execute(ctx.trx);
    if (Number(rows[0]?.n ?? 0) >= MAX_OPEN_INVITES) {
      throw new DomainError('INVITE_LIMIT', 429, `Tổ chức đang có quá nhiều lời mời chưa trả lời (tối đa ${MAX_OPEN_INVITES}); hãy thu hồi bớt`);
    }
    if (open) await ctx.run('kernel.member.invite_revoke', { inviteId: open.id });
    let created: { id: string; expires_at: Date };
    try {
      created = await ctx.trx
        .insertInto('crove_kernel.member_invite')
        .values({ org_id: ctx.orgId, email: input.email, role: input.role, invited_by: actorId })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow();
    } catch (error) {
      // An invite to the same address committed after the lock above found none.
      if ((error as { code?: string } | null)?.code === '23505') throw new DomainError('RETRY', 409, 'Người này vừa được mời, hãy tải lại và thử lại');
      throw error;
    }
    ctx.audit({ invite_id: created.id, role: input.role, replaced_invite_id: open?.id ?? null });
    await ctx.activity('kernel.member_invite', created.id, 'member.invited', `Mời ${input.email} tham gia (${input.role})`);
    await ctx.emit('kernel.member.invited', { inviteId: created.id, role: input.role });
    return { inviteId: created.id, email: input.email, role: input.role, expiresAt: created.expires_at.toISOString() };
  },
});

// Revokes an open invite, pending or expired. Owners revoke any invite; admins revoke member and viewer invites.
// R1: it takes no access away from anyone and is undone by inviting again.
export const revokeInvite = defineCommand({
  name: 'kernel.member.invite_revoke',
  input: z.object({ inviteId: zId }),
  risk: 'R1',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.member_invite', id: input.inviteId }),
  handler: async (ctx, input) => {
    const { actorId, actorRole } = await lockInviter(ctx);
    const invite = await ctx.trx
      .selectFrom('crove_kernel.member_invite')
      .select(['id', 'email', 'role', 'expires_at', 'accepted_at', 'declined_at', 'revoked_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.inviteId)
      .forUpdate()
      .executeTakeFirst();
    if (!invite) throw INVITE_ERRORS.INVITE_NOT_FOUND!();
    if (invite.role === 'admin' && actorRole !== 'owner') throw forbidden('Chỉ chủ sở hữu mới thu hồi được lời mời quản trị viên');
    if (invite.accepted_at || invite.declined_at || invite.revoked_at) throw INVITE_ERRORS.INVITE_CLOSED!();
    await ctx.trx
      .updateTable('crove_kernel.member_invite')
      .set({ revoked_at: ctx.now, revoked_by: actorId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', invite.id)
      .execute();
    ctx.audit({ role: invite.role, expired: invite.expires_at.getTime() <= ctx.now.getTime() });
    await ctx.activity('kernel.member_invite', invite.id, 'member.invite_revoked', `Thu hồi lời mời ${invite.email} (${invite.role})`);
    return { inviteId: invite.id };
  },
});

// The invitee accepts (org-less, see the file header). R1: the person consents for themselves; the org's side of
// the decision is the inviter's R3 invite. Access lists every role so a replay still returns the first response
// after the member's role changed.
export const acceptInviteCommand = defineCommand({
  name: 'kernel.member.invite_accept',
  input: z.object({ orgId: zId, inviteId: zId }),
  risk: 'R1',
  access: ALL,
  target: (input) => ({ type: 'kernel.member_invite', id: input.inviteId }),
  bootstrap: async (trx, actor, input, idempotencyKey) => {
    try {
      const { rows } = await sql<{ org_id: string | null }>`
        SELECT crove_kernel.member_invite_accept(${actor.userId}::uuid, ${input.orgId}::uuid, ${input.inviteId}::uuid, ${idempotencyKey}) AS org_id`.execute(trx);
      const orgId = rows[0]?.org_id;
      if (!orgId) throw new DomainError('INTERNAL', 500, 'Không nhận được lời mời');
      return orgId;
    } catch (error) {
      throw inviteError(error);
    }
  },
  handler: async (ctx, input): Promise<OrgSummary> => {
    if (ctx.actor.type !== 'user') throw forbidden();
    const invite = await ctx.trx
      .selectFrom('crove_kernel.member_invite')
      .select(['role', 'invited_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.inviteId)
      .executeTakeFirstOrThrow();
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select(['org_id', 'slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    ctx.audit({ role: invite.role, invited_by: invite.invited_by });
    await ctx.activity('kernel.member', ctx.actor.userId, 'member.joined', `Nhận lời mời và tham gia tổ chức (${invite.role})`);
    await ctx.emit('kernel.member.joined', { userId: ctx.actor.userId, role: invite.role, inviteId: input.inviteId });
    return { orgId: tenant.org_id, slug: tenant.slug, name: tenant.name, role: invite.role };
  },
});

export function acceptInvite(
  runtime: Runtime,
  actor: UserActor,
  input: { orgId: string; inviteId: string },
  idempotencyKey?: string,
): Promise<OrgSummary> {
  return runtime.executeOrgless<OrgSummary>('kernel.member.invite_accept', input, { actor, ...(idempotencyKey ? { idempotencyKey } : {}) });
}

export async function declineInvite(runtime: Runtime, actor: UserActor, input: { orgId: string; inviteId: string }): Promise<{ ok: true }> {
  const { orgId, inviteId } = z.object({ orgId: zId, inviteId: zId }).parse(input);
  await runtime.forUser(actor, async (db) => {
    try {
      await sql`SELECT crove_kernel.member_invite_decline(${actor.userId}::uuid, ${orgId}::uuid, ${inviteId}::uuid)`.execute(db);
    } catch (error) {
      throw inviteError(error);
    }
  });
  return { ok: true };
}

export interface MyInvite {
  orgId: string;
  inviteId: string;
  orgName: string;
  role: Exclude<MemberRole, 'owner'>;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export function myInvites(runtime: Runtime, actor: UserActor): Promise<MyInvite[]> {
  return runtime.forUser(actor, async (db) => {
    const { rows } = await sql<{
      org_id: string;
      invite_id: string;
      org_name: string;
      role: Exclude<MemberRole, 'owner'>;
      invited_by_name: string;
      created_at: Date;
      expires_at: Date;
    }>`SELECT org_id, invite_id, org_name, role, invited_by_name, created_at, expires_at FROM crove_kernel.my_invites(${actor.userId}::uuid)`.execute(db);
    return rows.map((r) => ({
      orgId: r.org_id,
      inviteId: r.invite_id,
      orgName: r.org_name,
      role: r.role,
      invitedBy: r.invited_by_name,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    }));
  });
}

// The org's open invites and the ones declined in the last 30 days, for its owners and admins.
export const orgInvitesQuery = defineQuery({
  name: 'kernel.member.invites',
  input: z.object({}),
  access: ADMINS,
  handler: async (ctx) => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.member_invite as i')
      .leftJoin('crove_kernel.user_account as u', 'u.id', 'i.invited_by')
      .select(['i.id', 'i.email', 'i.role', 'i.created_at', 'i.expires_at', 'i.declined_at', 'u.display_name', 'u.email as inviter_email'])
      .where('i.org_id', '=', ctx.orgId)
      .where('i.accepted_at', 'is', null)
      .where('i.revoked_at', 'is', null)
      .where((eb) => eb.or([eb('i.declined_at', 'is', null), eb('i.declined_at', '>', sql<Date>`now() - make_interval(days => ${DECLINED_VISIBLE_DAYS})`)]))
      .orderBy('i.created_at', 'desc')
      .limit(200)
      .execute();
    const now = Date.now();
    return rows.map((r) => ({
      inviteId: r.id,
      email: r.email,
      role: r.role,
      status: r.declined_at ? ('declined' as const) : r.expires_at.getTime() <= now ? ('expired' as const) : ('pending' as const),
      invitedBy: r.display_name ?? r.inviter_email ?? null,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    }));
  },
});
