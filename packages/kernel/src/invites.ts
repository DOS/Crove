// Member invites with consent (issue #35, plan §7.3 item 2). An owner or admin invites an email with a role; the
// person behind that email joins only by accepting, signed in with that email. Membership rows are written only by
// definers (the org's first owner by create_or_replay_org, everyone else by invite_accept): the runtime roles hold
// no INSERT on tenant_member.
import { createHash, randomBytes } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import type { Db, MemberRole } from '@crove/db';
import { zId, zInviteRole, zInviteToken } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type SessionStatusSource } from '@crove/kernel-runtime';
import { createMailMessage, type DirectMail } from './mail.ts';
import { memberProfiles } from './profiles.ts';

// How long an invite stays valid. The table allows at most 30 days.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Pending, unexpired invites one org may hold at once.
export const MAX_PENDING_INVITES = 100;
// Invites one org may create in any 24 hours, in total and per email (revoked and replaced ones count). Each invite
// sends a mail (#129), and replacing or revoking frees pending slots, so these bound the mail an org can send.
export const MAX_INVITES_PER_DAY = 50;
export const MAX_INVITES_PER_EMAIL_PER_DAY = 3;

// Invite mails one address may get in any 24 hours from all orgs together (#185): one account may create several
// orgs, so the per-org limits alone let it mail one address several times a day. An org's first invite of an
// address in the window is never refused by this cap (only its repeats are), so nobody can use up an address's cap
// to keep its real employer from inviting it.
export interface InviteLimits {
  perRecipientPerDay: number;
}

export const DEFAULT_INVITE_LIMITS: InviteLimits = { perRecipientPerDay: 5 };

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
// AUTH_GRANTS_MISSING (55000, db mode without auth.users.email_confirmed_at or its grant) is mapped by the runtime
// (503).
const INVITE_ERRORS: Record<string, DomainError> = {
  INVITE_NOT_FOUND: new DomainError('INVITE_NOT_FOUND', 404, 'Không tìm thấy lời mời, hãy kiểm tra lại liên kết'),
  INVITE_EMAIL_MISMATCH: new DomainError(
    'INVITE_EMAIL_MISMATCH',
    403,
    'Lời mời này dành cho một địa chỉ email khác. Hãy đăng nhập bằng đúng email được mời',
  ),
  INVITE_EMAIL_UNCONFIRMED: new DomainError(
    'INVITE_EMAIL_UNCONFIRMED',
    403,
    'Email của bạn chưa được xác nhận. Hãy mở thư xác nhận rồi mở lại liên kết mời',
  ),
  INVITE_USED: new DomainError('INVITE_USED', 409, 'Lời mời này đã được sử dụng'),
  INVITE_REVOKED: new DomainError('INVITE_REVOKED', 409, 'Lời mời này đã bị thu hồi'),
  INVITE_EXPIRED: new DomainError('INVITE_EXPIRED', 409, 'Lời mời này đã hết hạn, hãy nhờ người mời gửi lại'),
};

// The JSON DETAIL of INVITE_RATE_LIMITED (crove_kernel.invite_mail_gate, #185): which limit refused. The refusal for
// a recipient says only that this address got too many invites, which the inviter chose to send; it is the same
// whether or not the address has an account, and it tells nothing about who else invited it or when.
const RATE_LIMIT_MESSAGES: Record<string, string> = {
  invite_busy: 'Hệ thống đang bận gửi lời mời; hãy thử lại sau',
  invite_org_per_day: 'Tổ chức đã gửi quá nhiều lời mời trong 24 giờ qua; hãy thử lại sau',
  invite_email_per_day: 'Tổ chức đã mời email này quá nhiều lần trong 24 giờ qua; hãy thử lại sau',
  invite_recipient_per_day: 'Email này đã nhận quá nhiều lời mời trong 24 giờ qua; hãy thử lại sau',
};

function inviteRateLimited(error: unknown): DomainError | null {
  const pg = error as { code?: string; message?: string; detail?: string } | null;
  if (pg?.code !== 'P0001' || pg.message !== 'INVITE_RATE_LIMITED') return null;
  let parsed: { rule?: unknown; limit?: unknown } = {};
  try {
    parsed = JSON.parse(pg.detail ?? '{}') as typeof parsed;
  } catch {
    parsed = {};
  }
  const rule = typeof parsed.rule === 'string' && Object.hasOwn(RATE_LIMIT_MESSAGES, parsed.rule) ? parsed.rule : 'invite_org_per_day';
  const details: Record<string, unknown> =
    rule === 'invite_busy' ? { rule, retryAfterSeconds: 1 } : { rule, limit: typeof parsed.limit === 'number' ? parsed.limit : null };
  return new DomainError('INVITE_RATE_LIMITED', 429, RATE_LIMIT_MESSAGES[rule] as string, details);
}

// Runs one of the invite mail definers. Thrown, not returned: the failed statement aborted this transaction, which
// then rolls back.
async function inviteMailCheck(ctx: CommandContext, query: RawBuilder<unknown>): Promise<void> {
  try {
    await query.execute(ctx.trx);
  } catch (error) {
    throw inviteRateLimited(error) ?? error;
  }
}

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

// Whether the deployment reads Supabase Auth's own tables (AUTH_SESSION_CHECK=db): the invite definers then also
// require a confirmed email in auth.users (defense in depth, #134).
export function upstreamAuth(mode: SessionStatusSource['mode'] | null): boolean {
  return mode === 'db';
}

interface LockedRoles {
  // The actor's role now, not the one read when the context was entered.
  role: MemberRole | null;
  // The org's owners now. They stay owners until this command commits: a demotion needs the FOR UPDATE lock.
  owners: ReadonlySet<string>;
}

// Takes FOR SHARE on the org's owner rows and the actor's row in user_id order, the rows and order role changes and
// removals lock FOR UPDATE (commands.ts), so a demotion or removal of the actor (or of an owner) that commits first
// is seen (READ COMMITTED re-reads a locked row's newest version) and one that starts later waits for this command.
// These row locks do not block other invites; invite creation is serialized afterwards by invite_mail_gate's advisory
// locks (#185), which only invite creation takes, always after these rows, so they never close a deadlock cycle.
// Membership rows are locked before invite rows on every path (these commands, the member commands, invite_accept),
// so the two never deadlock.
async function lockRoles(ctx: CommandContext, userId: string): Promise<LockedRoles> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb.or([eb('role', '=', 'owner'), eb('user_id', '=', userId)]))
    .orderBy('user_id')
    .forShare()
    .execute();
  return {
    role: rows.find((r) => r.user_id === userId)?.role ?? null,
    owners: new Set(rows.filter((r) => r.role === 'owner').map((r) => r.user_id)),
  };
}

// An admin never takes away what an owner decided (#134): a pending, unexpired invite created by a current owner is
// revoked or replaced only by an owner. Expired invites may be cleaned up by any admin.
function ownersInvite(invite: { invited_by: string; expires_at: Date }, locked: LockedRoles, now: Date): boolean {
  return locked.owners.has(invite.invited_by) && invite.expires_at.getTime() > now.getTime();
}

interface PendingInvite {
  id: string;
  invited_by: string;
  expires_at: Date;
}

// The refusals between ALREADY_MEMBER and the daily limits, in this order: an admin's invite for an email with a
// current owner's pending, unexpired invite (#134), then the org's cap on pending invites. Returns the org's pending
// invites of this email, which the new invite replaces. Run twice: once before the locks, on what has committed,
// so a refusal does not wait for them (#270), and once under them (lock), which decides. Either way the cap counts
// the pending invites other than this email's, the number left once they are replaced.
async function pendingRefusals(ctx: CommandContext, email: string, locked: LockedRoles, lock: boolean): Promise<PendingInvite[]> {
  const query = ctx.trx
    .selectFrom('crove_kernel.member_invite')
    .select(['id', 'invited_by', 'expires_at'])
    .where('org_id', '=', ctx.orgId)
    .where('email', '=', email)
    .where('status', '=', 'pending');
  const previous = await (lock ? query.forUpdate() : query).execute();
  // An admin's invite refuses to replace a current owner's unexpired one (#134): the owner's invite stays and the
  // admin is told why. Revoking it silently would let an admin undo an owner's invite, or change its role, without
  // the owner noticing.
  const byOwner = locked.role === 'owner' ? [] : previous.filter((p) => ownersInvite(p, locked, ctx.now));
  if (byOwner.length > 0) {
    throw new DomainError(
      'INVITE_PENDING_BY_OWNER',
      409,
      'Chủ sở hữu đã mời email này và lời mời vẫn còn hiệu lực. Hãy nhờ chủ sở hữu thu hồi hoặc gửi lại lời mời',
      undefined,
      { audit: { pending_invites: byOwner.map((p) => p.id) } },
    );
  }
  const pending = await ctx.trx
    .selectFrom('crove_kernel.member_invite')
    .select(sql<number>`pg_catalog.count(*)::int`.as('n'))
    .where('org_id', '=', ctx.orgId)
    .where('status', '=', 'pending')
    .where('email', '<>', email)
    .where('expires_at', '>', ctx.now)
    .executeTakeFirstOrThrow();
  if (pending.n >= MAX_PENDING_INVITES) {
    throw new DomainError('TOO_MANY_INVITES', 429, `Tổ chức đang có quá nhiều lời mời chờ (tối đa ${MAX_PENDING_INVITES}); hãy thu hồi bớt`);
  }
  return previous;
}

// Invites an email to the org in context. R3 (plan §4.7: membership and role changes) needs fresh MFA (P11).
// It never looks the email up among accounts, so the answer is the same whether or not one exists. The token is
// returned once, inside the accept path, and never stored (only its SHA-256), so callers must not pass an
// idempotency key (a stored response would keep it); the API offers none. A new invite for the same email replaces
// the pending one, which is also how an inviter gets a fresh link. limits.perRecipientPerDay caps the invites one
// address gets from all orgs together (default DEFAULT_INVITE_LIMITS). The limits that key on an address count its
// inbox (crove_kernel.invite_cap_key: no +tag, no dots at Gmail, #270); the invite itself stays bound to the email
// as given. The invite mail gets its crove_kernel.mail_message row here (#538): as suppressed when the org has
// stopped mail to the address; otherwise as sending, and the API, which holds the token, reads it back
// (kernel.mail.direct.get), sends the mail and records the outcome. The answer stays the one #35 defined, the same
// for every address. mail.messageIdDomain is the right-hand side of its Message-ID.
export function inviteCreateCommand(limits: InviteLimits = DEFAULT_INVITE_LIMITS, mail: { messageIdDomain?: string | undefined } = {}) {
  if (!Number.isInteger(limits.perRecipientPerDay) || limits.perRecipientPerDay < 1 || limits.perRecipientPerDay > 1000) {
    throw new Error('perRecipientPerDay must be an integer from 1 to 1000');
  }
  return defineCommand({
    name: 'kernel.member.invite.create',
    input: z.object({ email: z.email().max(320), role: zInviteRole }),
    risk: 'R3',
    access: ADMINS,
    handler: async (ctx, input) => {
      if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới mời được thành viên');
      const actorId = ctx.actor.userId;
      const locked = await lockRoles(ctx, actorId);
      const role = locked.role;
      if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Vai trò của bạn không được mời thành viên');
      // Only owners may grant admin rights.
      if (input.role === 'admin' && role !== 'owner') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới mời được quản trị viên');
      const email = normalizeEmail(input.email);

      // Members of this org are visible to the inviter anyway (kernel.org.get), so this reveals nothing new. Their
      // emails come through the definer (plan §3.6, #169), never a join on user_account.
      const { rows: member } = await sql<{ user_id: string }>`
        SELECT p.user_id FROM crove_kernel.member_profiles(
          ARRAY(SELECT m.user_id FROM crove_kernel.tenant_member m WHERE m.org_id = ${ctx.orgId}::uuid)) p
        WHERE pg_catalog.lower(pg_catalog.btrim(p.email)) = ${email}
        LIMIT 1`.execute(ctx.trx);
      if (member.length > 0) throw new DomainError('ALREADY_MEMBER', 409, 'Người này đã là thành viên của tổ chức');

      // The daily limits (#185), counted in the database: this org's invites in total and for this inbox, and every
      // org's invites of this inbox, which reveals nothing about accounts. First without the locks, on what has
      // committed, after the refusals that come before them: an invite already over a limit is refused here at once
      // instead of waiting for the locks (and holding up other invites of the address meanwhile, #270).
      const limitArgs = sql`${email}, ${MAX_INVITES_PER_DAY}::int, ${MAX_INVITES_PER_EMAIL_PER_DAY}::int, ${limits.perRecipientPerDay}::int`;
      await pendingRefusals(ctx, email, locked, false);
      await inviteMailCheck(ctx, sql`SELECT crove_kernel.invite_mail_precheck(${limitArgs})`);

      // A lock per org and one per inbox (#185), taken before the pending invite is read: invites of one org, and
      // invites of one inbox from any org, run one at a time from here on, so the counts below are exact under
      // concurrency and the replacement always sees the previous invite. A wait past 3 seconds is 429 invite_busy.
      await inviteMailCheck(ctx, sql`SELECT crove_kernel.invite_mail_lock(${email})`);

      // The same refusals under the locks, which decide; the pending invite this one replaces is locked after the
      // membership rows.
      const previous = await pendingRefusals(ctx, email, locked, true);
      const replaced =
        previous.length === 0
          ? []
          : await ctx.trx
              .updateTable('crove_kernel.member_invite')
              .set({ status: 'revoked', revoked_at: ctx.now, revoked_by: actorId })
              .where('org_id', '=', ctx.orgId)
              .where(
                'id',
                'in',
                previous.map((p) => p.id),
              )
              .where('status', '=', 'pending')
              .returning('id')
              .execute();
      await inviteMailCheck(ctx, sql`SELECT crove_kernel.invite_mail_gate(${limitArgs})`);

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
          // The database's clock, the clock of the daily window (#270), not ctx.now. The expiry stays ctx.now plus the
          // TTL; only an API clock more than the TTL behind would make it precede the database's clock, and then the
          // invite is born expired and dated just before its expiry, so the row stays valid (expires_at > created_at).
          created_at: sql<Date>`LEAST(pg_catalog.clock_timestamp(), ${expiresAt}::timestamptz - interval '1 millisecond')`,
          expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const message = await createMailMessage(ctx, {
        stream: 'system',
        source: 'kernel.member.invite.create',
        sourceId: invite.id,
        templateKey: 'kernel.member.invite',
        to: email,
        status: 'sending',
        messageIdDomain: mail.messageIdDomain,
      });
      ctx.audit({ invite_id: invite.id, role: input.role, replaced: replaced.map((r) => r.id), mail: message.status });
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
}

export const createInvite = inviteCreateCommand();

// Revokes a pending invite of the org in context. R1: it only takes away a way in. The actor's role is re-checked
// under the membership locks (an admin demoted meanwhile cannot revoke), and an admin cannot revoke a current
// owner's unexpired invite (#134), as for replacing one.
export const revokeInvite = defineCommand({
  name: 'kernel.member.invite.revoke',
  input: z.object({ inviteId: zId }),
  risk: 'R1',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.member_invite', id: input.inviteId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thu hồi được lời mời');
    const locked = await lockRoles(ctx, ctx.actor.userId);
    if (locked.role !== 'owner' && locked.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Vai trò của bạn không được thu hồi lời mời');
    const invite = await ctx.trx
      .selectFrom('crove_kernel.member_invite')
      .select(['id', 'email', 'status', 'invited_by', 'expires_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.inviteId)
      .forUpdate()
      .executeTakeFirst();
    if (!invite) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy lời mời');
    if (invite.status !== 'pending') throw new DomainError('INVITE_NOT_PENDING', 409, 'Lời mời này đã được dùng hoặc đã bị thu hồi');
    if (locked.role !== 'owner' && ownersInvite(invite, locked, ctx.now)) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới thu hồi được lời mời do chủ sở hữu tạo', undefined, {
        audit: { invite_id: invite.id },
      });
    }
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
  bootstrap: async (trx, actor, input, _idempotencyKey, env) =>
    withInviteErrors(async () => {
      const { rows } = await sql<{ org_id: string | null }>`
        SELECT crove_kernel.invite_accept(${actor.userId}::uuid, ${input.token}, ${upstreamAuth(env.sessionMode)}) AS org_id`.execute(trx);
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
    // A membership change records target_user, role and previous_role like a role change (#88). The target is the
    // actor: a user only ever joins through their own consent.
    ctx.audit({
      invite_id: invite.id,
      invited_by: invite.invited_by,
      invited_role: invite.role,
      target_user: userId,
      role: membership.role,
      previous_role: alreadyMember ? membership.role : null,
      already_member: alreadyMember,
    });
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
// `upstream` as for accepting: upstreamAuth(runtime.sessionMode). Required, so no caller skips the db-mode check
// by leaving it out.
export async function previewInvite(db: Db, userId: string, token: string, options: { upstream: boolean }): Promise<InvitePreview> {
  return withInviteErrors(async () => {
    const { rows } = await sql<{
      org_name: string;
      role: InvitePreview['role'];
      invited_by_email: string;
      invited_by_name: string | null;
      expires_at: Date;
    }>`SELECT org_name, role, invited_by_email, invited_by_name, expires_at FROM crove_kernel.invite_peek(${userId}::uuid, ${token}, ${options.upstream})`.execute(db);
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
      .selectFrom('crove_kernel.member_invite')
      .select(['id', 'email', 'role', 'status', 'expires_at', 'created_at', 'invited_by'])
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .limit(MAX_PENDING_INVITES * 2)
      .execute();
    // Inviters through the definer (plan §3.6, #169). An inviter who left the org has no profile here: null, as before.
    const inviters = await memberProfiles(ctx.trx, rows.map((r) => r.invited_by));
    // Each invite's newest mail row (#539): sent, delivered, bounced, or not sent because the address is stopped.
    const mails = new Map<string, DirectMail['status']>();
    if (rows.length > 0) {
      const sent = await ctx.trx
        .selectFrom('crove_kernel.mail_message')
        .select(['source_id', 'status'])
        .distinctOn('source_id')
        .where('org_id', '=', ctx.orgId)
        .where('source', '=', 'kernel.member.invite.create')
        .where('source_id', 'in', rows.map((r) => r.id))
        .orderBy('source_id')
        .orderBy('created_at', 'desc')
        .execute();
      for (const m of sent) if (m.source_id) mails.set(m.source_id, m.status);
    }
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.expires_at.getTime() <= now ? ('expired' as const) : ('pending' as const),
      invitedBy: inviters.get(r.invited_by)?.displayName ?? inviters.get(r.invited_by)?.email ?? null,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      mail: mails.get(r.id) ?? null,
    }));
  },
});

export const inviteCommands = [createInvite, revokeInvite, acceptInvite];
export const inviteQueries = [invitesList];
