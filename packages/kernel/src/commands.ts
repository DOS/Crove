import { sql } from 'kysely';
import { z } from 'zod';
import { zAccountCode, zId, zPurchaseProposal, zRole, zSessionRevoke } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, fileKey, type CommandContext } from '@crove/kernel-runtime';
import { PROPOSAL_REVISERS, actorRef, addAuthor, decideApproval, parseAuthors } from './approval.ts';
import { extractionCommands, refuseWhileReextracting } from './extraction.ts';
import { createOrgCommand, orgCreateCommand, type OrgCreateLimits } from './identity.ts';
import { inviteCommands } from './invites.ts';

const MEMBERS = ['owner', 'admin', 'member'] as const;
// Commands a proposal may execute when approved (they must also declare access: 'proposal', which the runtime checks
// against the proposal row: state 'approved' for that command, approved by the running kernel.proposal.approve).
const PROPOSAL_COMMANDS = new Set(['finance.purchase.record']);
const ADMINS = ['owner', 'admin'] as const;
// Approving executes an R3 command that posts to the ledger, so only roles that may post approve.
// The role model has no finance roles yet; owner and admin are the roles that may post today. This is the
// coarse gate; the approval policy in approval.ts (snapshot, live role, four-eyes) decides per proposal.
const APPROVERS = ADMINS;

const zLineAccounts = z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).max(1000);

// Membership and role changes are R3 (plan §4.7): they need a fresh second factor (P11, ADR-0028). Nobody joins an
// org without consent: members join by accepting an invite (invites.ts, #35); there is no direct add.

interface LockedMembers {
  actorRole: MemberRole | null;
  target: { role: MemberRole; email: string } | null;
  owners: number;
}

// Locks the rows a membership change decides on, in user_id order: every owner of the org, the actor and the
// target. Two owners changing each other at once serialize here; the one that waits re-reads the rows the other
// changed (READ COMMITTED re-checks a locked row's newest version), so it sees its own demotion or the smaller
// owner count and refuses. A row that became owner concurrently can only be missed, never counted twice, so the
// count errs on the side of refusing. RLS and the org_id filter keep other orgs' members out of reach.
async function lockMembers(ctx: CommandContext, actorId: string, targetId: string): Promise<LockedMembers> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb.or([eb('role', '=', 'owner'), eb('user_id', 'in', [actorId, targetId])]))
    .orderBy('user_id')
    .forUpdate()
    .execute();
  const target = rows.find((r) => r.user_id === targetId);
  let email = '';
  if (target) {
    const account = await ctx.trx.selectFrom('crove_kernel.user_account').select('email').where('id', '=', targetId).executeTakeFirst();
    email = account?.email ?? '';
  }
  return {
    actorRole: rows.find((r) => r.user_id === actorId)?.role ?? null,
    target: target ? { role: target.role, email } : null,
    owners: rows.filter((r) => r.role === 'owner').length,
  };
}

// Only owners manage roles and remove members (plan §4.6: role management is an owner right). The role read when
// the context was entered is re-checked under the lock, so an owner demoted by a concurrent command is refused.
async function lockForMemberChange(ctx: CommandContext, targetId: string) {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới quản lý được thành viên');
  const locked = await lockMembers(ctx, ctx.actor.userId, targetId);
  if (locked.actorRole !== 'owner') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới đổi được vai trò hoặc xóa thành viên');
  }
  if (!locked.target) throw new DomainError('MEMBER_NOT_FOUND', 404, 'Không tìm thấy thành viên này trong tổ chức');
  return { actorId: ctx.actor.userId, target: locked.target, owners: locked.owners };
}

// The refusal rolls the command back, so its audit row (written apart, plan §4.10) gets the roles from the error.
const LAST_OWNER = (targetUserId: string, newRole: MemberRole | null) =>
  new DomainError('LAST_OWNER', 409, 'Tổ chức phải còn ít nhất một chủ sở hữu', undefined, {
    audit: { target_user: targetUserId, role: newRole, previous_role: 'owner' },
  });

// Changes a member's role, owners included (promoting a member to owner makes a co-owner). R3 like every
// membership change. The new role applies from the member's next request: enter_context reads it in every
// transaction, and approvals re-check roles live (P12).
export const changeMemberRole = defineCommand({
  name: 'kernel.member.change_role',
  input: z.object({ userId: zId, role: zRole }),
  risk: 'R3',
  access: ['owner'],
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    const { target, owners } = await lockForMemberChange(ctx, input.userId);
    const previousRole = target.role;
    // Every role or membership change records target_user, role and previous_role (#88): a demotion can make a
    // self-approval legal (P10), so role changes must be reviewable next to the approvals they enable.
    ctx.audit({ target_user: input.userId, role: input.role, previous_role: previousRole, changed: previousRole !== input.role });
    if (previousRole === input.role) return { userId: input.userId, role: input.role, previousRole };
    if (previousRole === 'owner' && owners <= 1) throw LAST_OWNER(input.userId, input.role);
    await ctx.trx
      .updateTable('crove_kernel.tenant_member')
      .set({ role: input.role })
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', input.userId)
      .execute();
    await ctx.activity('kernel.member', input.userId, 'member.role_changed', `Đổi vai trò ${target.email} từ ${previousRole} thành ${input.role}`);
    await ctx.emit('kernel.member.role_changed', { userId: input.userId, oldRole: previousRole, newRole: input.role });
    return { userId: input.userId, role: input.role, previousRole };
  },
});

// Removes a member. Deleting the tenant_member row is the revocation: enter_context and my_orgs read membership
// in every transaction, so the member's next request is refused, with any token or session. An owner cannot
// remove themselves, and the org always keeps an owner.
export const removeMember = defineCommand({
  name: 'kernel.member.remove',
  input: z.object({ userId: zId }),
  risk: 'R3',
  access: ['owner'],
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    const { actorId, target, owners } = await lockForMemberChange(ctx, input.userId);
    if (input.userId === actorId) throw new DomainError('CANNOT_REMOVE_SELF', 422, 'Bạn không thể tự xóa mình khỏi tổ chức');
    if (target.role === 'owner' && owners <= 1) throw LAST_OWNER(input.userId, null);
    await ctx.trx
      .deleteFrom('crove_kernel.tenant_member')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', input.userId)
      .execute();
    // The removed member's pending invites go with them (they already stop working at acceptance while the inviter is
    // not a member; revoking them keeps them from coming back if the person is invited again later).
    const revokedInvites = await ctx.trx
      .updateTable('crove_kernel.member_invite')
      .set({ status: 'revoked', revoked_at: ctx.now, revoked_by: actorId })
      .where('org_id', '=', ctx.orgId)
      .where('invited_by', '=', input.userId)
      .where('status', '=', 'pending')
      .returning('id')
      .execute();
    ctx.audit({ target_user: input.userId, role: null, previous_role: target.role, revoked_invites: revokedInvites.map((r) => r.id) });
    await ctx.activity('kernel.member', input.userId, 'member.removed', `Xóa thành viên ${target.email} (${target.role})`);
    await ctx.emit('kernel.member.removed', { userId: input.userId, oldRole: target.role });
    return { userId: input.userId, previousRole: target.role };
  },
});

const zIngestFile = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageKey: z.string().min(1),
  source: z.enum(['upload', 'email']),
});

export const ingestFile = defineCommand({
  name: 'kernel.file.ingest',
  input: zIngestFile,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    if (input.storageKey !== fileKey(ctx.orgId, input.sha256)) throw new DomainError('INVALID_STORAGE_KEY', 400, 'Khóa lưu trữ không hợp lệ');
    const inserted = await ctx.trx
      .insertInto('crove_kernel.file')
      .values({
        org_id: ctx.orgId,
        sha256: input.sha256,
        storage_key: input.storageKey,
        filename: input.filename,
        content_type: input.contentType,
        size_bytes: String(input.sizeBytes),
        source: input.source,
        created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .onConflict((oc) => oc.columns(['org_id', 'sha256']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      const existing = await ctx.trx
        .selectFrom('crove_kernel.file')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('sha256', '=', input.sha256)
        .executeTakeFirstOrThrow();
      return { fileId: existing.id, duplicate: true };
    }
    await ctx.activity('kernel.file', inserted.id, 'file.received', `Nhận chứng từ ${input.filename}`);
    await ctx.emit('kernel.file.ingested', { fileId: inserted.id });
    return { fileId: inserted.id, duplicate: false };
  },
});

export const receiveInbound = defineCommand({
  name: 'kernel.inbound.receive',
  input: z.object({
    messageId: z.string().min(1).max(500),
    from: z.string().max(320).nullable(),
    subject: z.string().max(500).nullable(),
    files: z.array(zIngestFile).max(20),
  }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const message = await ctx.trx
      .insertInto('crove_kernel.inbound_message')
      .values({
        org_id: ctx.orgId,
        message_id: input.messageId,
        from_address: input.from,
        subject: input.subject,
        attachment_count: input.files.length,
      })
      .onConflict((oc) => oc.columns(['org_id', 'message_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!message) return { duplicate: true, fileIds: [] as string[] };
    const fileIds: string[] = [];
    for (const file of input.files) {
      const result = await ctx.run<{ fileId: string }>('kernel.file.ingest', file);
      fileIds.push(result.fileId);
    }
    return { duplicate: false, fileIds };
  },
});

// How often one org may rotate its inbound address (#113): perDay in any rolling 24 hours, total ever. Every
// rotation leaves a permanent tombstone row in crove_kernel.inbound_address, so the total bounds the ledger.
// Enforced by crove_kernel.inbound_rotate under a per-org lock, so the limit holds across API instances; a replay of
// an existing idempotency key never reaches the definer and does not count.
export interface InboundRotateLimits {
  perDay: number;
  total: number;
}

// The definer uses the same defaults when the API sets no limits.
export const DEFAULT_INBOUND_ROTATE_LIMITS: InboundRotateLimits = { perDay: 3, total: 50 };

// Matches the range the definer accepts.
const MAX_INBOUND_ROTATE_LIMIT = 999_999;

function assertRotateLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_INBOUND_ROTATE_LIMIT) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_INBOUND_ROTATE_LIMIT}`);
  }
}

// Rotates the org's inbound email address (plan §7.6). The old token is tombstoned and never issued again; mail
// to it is dropped by the worker like mail to an unknown token, including mail that was already queued for it
// when the rotation ran (the worker resolves the org when it processes a message, not when the API accepts it), so
// a supplier's mail in flight is lost without a bounce. R3 (plan §4.7: irreversible), since #113: the old address
// is tombstoned for good and the suppliers holding it are cut off, so a hijacked aal1 owner session must not be
// able to do it. As R3 it needs a fresh second factor (P11, enforced by the runtime) and its audit row records the
// assurance used. Owner only, enforced here and again in the definer. Over the limits the definer refuses with
// INBOUND_ROTATE_RATE_LIMITED (429 RATE_LIMITED) before writing anything.
export function inboundRotateCommand(limits: InboundRotateLimits = DEFAULT_INBOUND_ROTATE_LIMITS) {
  assertRotateLimit('perDay', limits.perDay);
  assertRotateLimit('total', limits.total);
  return defineCommand({
    name: 'kernel.inbound.rotate',
    input: z.object({}),
    risk: 'R3',
    access: ['owner'],
    handler: async (ctx) => {
      if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới đổi được địa chỉ nhận hóa đơn');
      // Transaction-local, read by the definer right below.
      await sql`SELECT set_config('crove.inbound_rotate_limit_per_day', ${String(limits.perDay)}, true),
                       set_config('crove.inbound_rotate_limit_total', ${String(limits.total)}, true)`.execute(ctx.trx);
      const { rows } = await sql<{ token: string | null }>`SELECT crove_kernel.inbound_rotate() AS token`.execute(ctx.trx);
      const token = rows[0]?.token;
      if (!token) throw new DomainError('INTERNAL', 500, 'Không đổi được địa chỉ nhận hóa đơn');
      await ctx.activity('kernel.org', ctx.orgId, 'inbound.rotated', 'Đổi địa chỉ email nhận hóa đơn; địa chỉ cũ ngừng nhận thư');
      return { inboundToken: token };
    },
  });
}

export const rotateInbound = inboundRotateCommand();

async function lockPendingProposal(ctx: CommandContext, id: string, revision?: number) {
  const proposal = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!proposal) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy đề xuất');
  if (proposal.status !== 'pending') throw new DomainError('PROPOSAL_DECIDED', 409, 'Đề xuất này đã được xử lý');
  if (revision !== undefined && proposal.revision !== revision) {
    throw new DomainError('STALE_REVISION', 409, 'Đề xuất đã thay đổi, hãy tải lại');
  }
  return proposal;
}

// True when lineAccounts asks for any account other than the one stored in the revision.
function changesContent(payload: unknown, lineAccounts: z.infer<typeof zLineAccounts>): boolean {
  if (lineAccounts.length === 0) return false;
  const parsed = zPurchaseProposal.safeParse(payload);
  if (!parsed.success) return true;
  const stored = new Map(parsed.data.lines.map((l) => [l.lineNo, l.debitAccount]));
  return lineAccounts.some((l) => stored.get(l.lineNo) !== l.debitAccount);
}

// Edits a pending proposal: the new content becomes a new revision authored by the editor (plan §8.3), and
// the approval policy runs again on it. An edit never approves; kernel.proposal.approve does, separately.
export const editProposal = defineCommand({
  name: 'kernel.proposal.edit',
  input: z.object({ id: zId, revision: z.number().int().positive(), lineAccounts: zLineAccounts.min(1) }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.proposal', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới chỉnh sửa được');
    const proposal = await lockPendingProposal(ctx, input.id, input.revision);
    await refuseWhileReextracting(ctx, proposal.source_file_id);
    const reviser = Object.hasOwn(PROPOSAL_REVISERS, proposal.command) ? PROPOSAL_REVISERS[proposal.command] : undefined;
    if (!reviser) throw new DomainError('NOT_EDITABLE', 422, 'Loại đề xuất này không chỉnh sửa được');
    const authors = parseAuthors(proposal.authors);
    if (!authors) throw new DomainError('NOT_EDITABLE', 422, 'Đề xuất thiếu thông tin người soạn nên không chỉnh sửa được');
    const revised = await ctx.run<{ changed: boolean; payload: unknown }>(
      reviser,
      { payload: proposal.payload, lineAccounts: input.lineAccounts },
      { proposalId: proposal.id },
    );
    if (!revised.changed) return { revision: proposal.revision, changed: false };
    const revision = proposal.revision + 1;
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ payload: JSON.stringify(revised.payload), revision, authors: JSON.stringify(addAuthor(authors, actorRef(ctx.actor))) })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    ctx.audit({ revision });
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.edited', `Chỉnh sửa (bản ${revision}): ${proposal.title}`);
    return { revision, changed: true };
  },
});

export const approveProposal = defineCommand({
  name: 'kernel.proposal.approve',
  input: z.object({
    id: zId,
    revision: z.number().int().positive(),
    // The accounts the approver saw. They must match the revision: changing them is an edit, never an approval.
    lineAccounts: zLineAccounts.optional(),
    note: z.string().max(500).optional(),
    acceptFailedChecks: z.boolean().optional(),
  }),
  risk: 'R3',
  access: APPROVERS,
  target: (input) => ({ type: 'kernel.proposal', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới duyệt được');
    const proposal = await lockPendingProposal(ctx, input.id, input.revision);
    // A re-extraction in flight would replace this revision's content (issue #40).
    await refuseWhileReextracting(ctx, proposal.source_file_id);
    if (!PROPOSAL_COMMANDS.has(proposal.command)) throw new DomainError('FORBIDDEN', 403, 'Loại đề xuất không được hỗ trợ');
    if (input.lineAccounts && changesContent(proposal.payload, input.lineAccounts)) {
      throw new DomainError('CONTENT_CHANGED', 409, 'Bạn đã đổi tài khoản nhưng chưa lưu; hãy lưu chỉnh sửa trước khi duyệt');
    }
    // P12 (snapshot and live role) and P10 (four-eyes), on the revision being approved.
    const decision = await decideApproval(ctx.trx, ctx.orgId, ctx.actor, proposal, { lock: true });
    if (decision.reason === 'four_eyes') {
      throw new DomainError('FOUR_EYES_REQUIRED', 403, 'Cần một người khác duyệt (bạn đã tải lên hoặc chỉnh sửa đề xuất này)', { rule: 'P10' });
    }
    if (decision.reason !== 'ok') {
      throw new DomainError('NOT_ELIGIBLE', 403, 'Bạn không có quyền duyệt đề xuất này', { rule: 'P12' });
    }
    ctx.audit({
      revision: proposal.revision,
      aal: ctx.actor.aal,
      policy: { P12: 'pass', P10: decision.fourEyes },
      eligible_approvers: decision.eligibleCount,
      self_approved: decision.selfApproved,
      accept_failed_checks: input.acceptFailedChecks ?? false,
    });
    // Approved for its command by this command: the runtime's proposal state gate lets the command run only now.
    // The same transaction ends 'executed', or rolls back to 'pending' if the command fails.
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ status: 'approved', decided_by: ctx.actor.userId, decided_at: ctx.now, executed_command_id: ctx.commandId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    const result = await ctx.run<{ documentId: string; journalEntryId: string }>(
      proposal.command,
      { payload: proposal.payload, acceptFailedChecks: input.acceptFailedChecks ?? false },
      { proposalId: proposal.id },
    );
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({
        status: 'executed',
        decision_note: input.note ?? null,
        result: JSON.stringify(result),
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.approved', `Đã duyệt: ${proposal.title}`);
    return result;
  },
});

export const rejectProposal = defineCommand({
  name: 'kernel.proposal.reject',
  input: z.object({ id: zId, reason: z.string().max(500).optional() }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.proposal', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới từ chối được');
    const proposal = await lockPendingProposal(ctx, input.id);
    await refuseWhileReextracting(ctx, proposal.source_file_id);
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ status: 'rejected', decided_by: ctx.actor.userId, decided_at: ctx.now, decision_note: input.reason ?? null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.rejected', `Từ chối: ${proposal.title}`);
    return { ok: true as const };
  },
});

// Revokes a session or every session of a user (ADR-0028 section 4), effective on the next request with any
// token of that session, refreshed or not. Enforced by the definer:
// - the user themself revokes globally, and the worker then signs the session out in Supabase Auth
//   (kernel.session.revoked; best effort and retried, correctness does not depend on it). For "every session" the
//   caller's own session id lets the definer run the global sign-out from another session, still alive when the
//   worker runs: the web app signs the caller's session out locally right away (issue #163);
// - the org owner revokes a member's session in that org only: no global record, no upstream sign-out, because
//   sessions are global and one org's owner has no say over the member's other orgs;
// - nobody else, admins included.
export const revokeSession = defineCommand({
  name: 'kernel.session.revoke',
  input: zSessionRevoke,
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    const current = ctx.actor.type === 'user' ? (ctx.actor.sessionId ?? null) : null;
    const { rows } = await sql<{ revoked_session: string; auth_subject: string | null; sign_out: 'local' | 'global' | null }>`
      SELECT revoked_session, auth_subject, sign_out
      FROM crove_kernel.session_revoke(${input.userId}::uuid, ${input.sessionId ?? null}::uuid, ${input.reason ?? null}, ${current}::uuid)`.execute(ctx.trx);
    for (const row of rows) {
      if (!row.sign_out || !row.auth_subject) continue;
      await ctx.emit('kernel.session.revoked', {
        userId: input.userId,
        subject: row.auth_subject,
        sessionId: row.revoked_session,
        scope: row.sign_out,
      });
    }
    const scope = input.all ? 'tất cả phiên đăng nhập' : 'một phiên đăng nhập';
    await ctx.activity('kernel.user', input.userId, 'session.revoked', `Thu hồi ${scope} (${rows.length})`);
    return { revoked: rows.map((r) => r.revoked_session) };
  },
});

const otherKernelCommands = [
  ...inviteCommands,
  changeMemberRole,
  removeMember,
  ingestFile,
  receiveInbound,
  ...extractionCommands,
  editProposal,
  approveProposal,
  rejectProposal,
  revokeSession,
];

// The kernel's commands; options.orgCreateLimits sets the org creation limits (default DEFAULT_ORG_CREATE_LIMITS),
// options.inboundRotateLimits the inbound address rotation limits (default DEFAULT_INBOUND_ROTATE_LIMITS).
export function buildKernelCommands(options: { orgCreateLimits?: OrgCreateLimits; inboundRotateLimits?: InboundRotateLimits } = {}) {
  return [
    options.orgCreateLimits ? orgCreateCommand(options.orgCreateLimits) : createOrgCommand,
    ...otherKernelCommands,
    options.inboundRotateLimits ? inboundRotateCommand(options.inboundRotateLimits) : rotateInbound,
  ];
}

export const kernelCommands = buildKernelCommands();
