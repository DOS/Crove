// Member invites with consent (issue #35, plan §7.3 item 2). An owner or admin invites an email with a role; the
// person behind that email joins only by accepting, signed in with that email. Membership rows are written only by
// definers (the org's first owner by create_or_replay_org, everyone else by invite_accept): the runtime roles hold
// no INSERT on tenant_member.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db, MemberRole } from '@crove/db';
import { zId, zInviteRole, zInviteToken } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

// How long an invite stays valid. The table allows at most 30 days.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Pending, unexpired invites one org may hold at once.
export const MAX_PENDING_INVITES = 100;

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ROLE_LABEL: Record<MemberRole, string> = { owner: 'chủ sở hữu', admin: 'quản trị', member: 'thành viên', viewer: 'chỉ xem' };

// The fragment keeps the token out of server logs and Referer headers; the app reads it from location.hash.
export const INVITE_ACCEPT_PATH = '/-/invite';

export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Errors raised by crove_kernel.invite_for_user (invite_accept, invite_peek). The invitee holds the token, so the
// outcome is theirs to know; anyone signed in with another email learns only that the invite is not for them.
const INVITE_ERRORS: Record<string, DomainError> = {
  INVITE_NOT_FOUND: new DomainError('INVITE_NOT_FOUND', 404, 'Không tìm thấy lời mời, hãy kiểm tra lại liên kết'),
  INVITE_EMAIL_MISMATCH: new DomainError(
    'INVITE_EMAIL_MISMATCH',
    403,
    'Lời mời này dành cho một địa chỉ email khác. Hãy đăng nhập bằng đúng email được mời',
  ),
  INVITE_USED: new DomainError('INVITE_USED', 409, 'Lời mời này đã được sử dụng'),
  INVITE_REVOKED: new DomainError('INVITE_REVOKED', 409, 'Lời mời này đã bị thu hồi'),
  INVITE_EXPIRED: new DomainError('INVITE_EXPIRED', 409, 'Lời mời này đã hết hạn, hãy nhờ người mời gửi lại'),
};

async function withInviteErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const pg = error as { code?: string; message?: string };
    const mapped = pg?.code === 'P0001' && pg.message ? INVITE_ERRORS[pg.message] : undefined;
    if (mapped) throw new DomainError(mapped.code, mapped.status, mapped.message);
    throw error;
  }
}

// The actor's role now, not the one read when the context was entered. Takes FOR SHARE on the org's owner rows and
// the actor's row in user_id order, the rows and order role changes and removals lock FOR UPDATE (commands.ts), so a
// demotion or removal of the actor that commits first is seen (READ COMMITTED re-reads a locked row's newest
// version) and one that starts later waits for this command. Invites do not block each other.
async function currentRole(ctx: CommandContext, userId: string): Promise<MemberRole | null> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb.or([eb('role', '=', 'owner'), eb('user_id', '=', userId)]))
    .orderBy('user_id')
    .forShare()
    .execute();
  return rows.find((r) => r.user_id === userId)?.role ?? null;
}

// Invites an email to the org in context. R3 (plan §4.7: membership and role changes) needs fresh MFA (P11).
// It never looks the email up among accounts, so the answer is the same whether or not one exists. The token is
// returned once, inside the accept path, and never stored (only its SHA-256), so callers must not pass an
// idempotency key (a stored response would keep it); the API offers none. A new invite for the same email replaces
// the pending one, which is also how an inviter gets a fresh link.
export const createInvite = defineCommand({
  name: 'kernel.member.invite.create',
  input: z.object({ email: z.email().max(320), role: zInviteRole }),
  risk: 'R3',
  access: ADMINS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới mời được thành viên');
    const actorId = ctx.actor.userId;
    const role = await currentRole(ctx, actorId);
    if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Vai trò của bạn không được mời thành viên');
    // Only owners may grant admin rights.
    if (input.role === 'admin' && role !== 'owner') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới mời được quản trị viên');
    const email = normalizeEmail(input.email);

    // Members of this org are visible to the inviter anyway (kernel.org.get), so this reveals nothing new.
    const member = await ctx.trx
      .selectFrom('crove_kernel.tenant_member as m')
      .innerJoin('crove_kernel.user_account as u', 'u.id', 'm.user_id')
      .select('m.user_id')
      .where('m.org_id', '=', ctx.orgId)
      .where(sql<string>`pg_catalog.lower(pg_catalog.btrim(u.email))`, '=', email)
      .executeTakeFirst();
    if (member) throw new DomainError('ALREADY_MEMBER', 409, 'Người này đã là thành viên của tổ chức');

    const replaced = await ctx.trx
      .updateTable('crove_kernel.member_invite')
      .set({ status: 'revoked', revoked_at: ctx.now, revoked_by: actorId })
      .where('org_id', '=', ctx.orgId)
      .where('email', '=', email)
      .where('status', '=', 'pending')
      .returning('id')
      .execute();

    const pending = await ctx.trx
      .selectFrom('crove_kernel.member_invite')
      .select(sql<number>`pg_catalog.count(*)::int`.as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', ctx.now)
      .executeTakeFirstOrThrow();
    if (pending.n >= MAX_PENDING_INVITES) {
      throw new DomainError('TOO_MANY_INVITES', 429, `Tổ chức đang có quá nhiều lời mời chờ (tối đa ${MAX_PENDING_INVITES}); hãy thu hồi bớt`);
    }

    const token = newInviteToken();
    const expiresAt = new Date(ctx.now.getTime() + INVITE_TTL_MS);
    const invite = await ctx.trx
      .insertInto('crove_kernel.member_invite')
      .values({
        org_id: ctx.orgId,
        email,
        role: input.role,
        token_sha256: inviteTokenHash(token),
        invited_by: actorId,
        created_at: ctx.now,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ invite_id: invite.id, role: input.role, replaced: replaced.map((r) => r.id) });
    await ctx.activity('kernel.member_invite', invite.id, 'invite.created', `Mời ${email} tham gia với vai trò ${ROLE_LABEL[input.role]}`);
    return {
      inviteId: invite.id,
      email,
      role: input.role,
      expiresAt: expiresAt.toISOString(),
      acceptPath: `${INVITE_ACCEPT_PATH}#${token}`,
    };
  },
});

// Revokes a pending invite of the org in context. R1: it only takes away a way in.
export const revokeInvite = defineCommand({
  name: 'kernel.member.invite.revoke',
  input: z.object({ inviteId: zId }),
  risk: 'R1',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.member_invite', id: input.inviteId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thu hồi được lời mời');
    const invite = await ctx.trx
      .selectFrom('crove_kernel.member_invite')
      .select(['id', 'email', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.inviteId)
      .forUpdate()
      .executeTakeFirst();
    if (!invite) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy lời mời');
    if (invite.status !== 'pending') throw new DomainError('INVITE_NOT_PENDING', 409, 'Lời mời này đã được dùng hoặc đã bị thu hồi');
    await ctx.trx
      .updateTable('crove_kernel.member_invite')
      .set({ status: 'revoked', revoked_at: ctx.now, revoked_by: ctx.actor.userId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', invite.id)
      .execute();
    await ctx.activity('kernel.member_invite', invite.id, 'invite.revoked', `Thu hồi lời mời của ${invite.email}`);
    return { ok: true as const };
  },
});

export interface AcceptedInvite {
  orgId: string;
  slug: string;
  name: string;
  role: MemberRole;
}

// Accepts an invite as the signed-in user (org-less: the user is not a member until the definer has run). The
// definer checks the token, the user's email and the inviter, writes the membership and marks the invite accepted;
// execute() then enters the org as the user, so membership is checked as on every command, and writes this
// command's audit row in the same transaction (a deferred trigger refuses an accepted invite without it). The org
// comes from the invite alone: nothing in the request can point it at another org. R1: the user consents for
// themself and gains only the role the inviter chose.
export const acceptInvite = defineCommand({
  name: 'kernel.member.invite.accept',
  input: z.object({ token: zInviteToken }),
  risk: 'R1',
  access: ALL,
  bootstrap: async (trx, actor, input) =>
    withInviteErrors(async () => {
      const { rows } = await sql<{ org_id: string | null }>`
        SELECT crove_kernel.invite_accept(${actor.userId}::uuid, ${input.token}) AS org_id`.execute(trx);
      const orgId = rows[0]?.org_id;
      if (!orgId) throw new DomainError('INTERNAL', 500, 'Không chấp nhận được lời mời');
      return orgId;
    }),
  handler: async (ctx, input): Promise<AcceptedInvite> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới chấp nhận được lời mời');
    const userId = ctx.actor.userId;
    const invite = await ctx.trx
      .selectFrom('crove_kernel.member_invite')
      .select(['id', 'email', 'role', 'invited_by', 'accepted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('token_sha256', '=', inviteTokenHash(input.token))
      .where('status', '=', 'accepted')
      .where('accepted_by', '=', userId)
      .executeTakeFirstOrThrow();
    const membership = await ctx.trx
      .selectFrom('crove_kernel.tenant_member')
      .select(['role', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const tenant = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['org_id', 'slug', 'name'])
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();
    // A user who already belonged to the org keeps their role; the membership row then predates this transaction.
    const alreadyMember = invite.accepted_at !== null && membership.created_at.getTime() < invite.accepted_at.getTime();
    ctx.audit({ invite_id: invite.id, invited_by: invite.invited_by, invited_role: invite.role, role: membership.role, already_member: alreadyMember });
    await ctx.activity(
      'kernel.member',
      userId,
      'member.joined',
      alreadyMember
        ? `${invite.email} chấp nhận lời mời (đã là thành viên, giữ vai trò ${ROLE_LABEL[membership.role]})`
        : `${invite.email} chấp nhận lời mời và tham gia với vai trò ${ROLE_LABEL[membership.role]}`,
    );
    return { orgId: tenant.org_id, slug: tenant.slug, name: tenant.name, role: membership.role };
  },
});

export interface InvitePreview {
  orgName: string;
  role: 'admin' | 'member' | 'viewer';
  invitedBy: string;
  expiresAt: string;
}

// What the invitee consents to, under the same token and email checks as accepting. Org-less read (forUser).
export async function previewInvite(db: Db, userId: string, token: string): Promise<InvitePreview> {
  return withInviteErrors(async () => {
    const { rows } = await sql<{
      org_name: string;
      role: InvitePreview['role'];
      invited_by_email: string;
      invited_by_name: string | null;
      expires_at: Date;
    }>`SELECT org_name, role, invited_by_email, invited_by_name, expires_at FROM crove_kernel.invite_peek(${userId}::uuid, ${token})`.execute(db);
    const row = rows[0];
    if (!row) throw new DomainError('INVITE_NOT_FOUND', 404, 'Không tìm thấy lời mời, hãy kiểm tra lại liên kết');
    return {
      orgName: row.org_name,
      role: row.role,
      invitedBy: row.invited_by_name ? `${row.invited_by_name} (${row.invited_by_email})` : row.invited_by_email,
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

// Invites of the org in context that still matter to the inviter: pending (expired ones flagged), newest first.
export const invitesList = defineQuery({
  name: 'kernel.member.invites.list',
  input: z.object({}),
  access: ADMINS,
  handler: async (ctx) => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.member_invite as i')
      .leftJoin('crove_kernel.user_account as u', 'u.id', 'i.invited_by')
      .select(['i.id', 'i.email', 'i.role', 'i.status', 'i.expires_at', 'i.created_at', 'u.email as inviter_email', 'u.display_name as inviter_name'])
      .where('i.org_id', '=', ctx.orgId)
      .where('i.status', '=', 'pending')
      .orderBy('i.created_at', 'desc')
      .limit(MAX_PENDING_INVITES * 2)
      .execute();
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.expires_at.getTime() <= now ? ('expired' as const) : ('pending' as const),
      invitedBy: r.inviter_name ?? r.inviter_email ?? null,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    }));
  },
});

export const inviteCommands = [createInvite, revokeInvite, acceptInvite];
export const inviteQueries = [invitesList];
