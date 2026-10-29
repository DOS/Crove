import { sql } from 'kysely';
import { z } from 'zod';
import {
  MAX_IMPORT_BYTES,
  MAX_SOCIAL_VIDEO_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_PURPOSES,
  VOUCHER_COMMAND,
  VOUCHER_TYPES,
  zAccountCode,
  zBulkApproveItems,
  zExchangeRate,
  zId,
  zLocalDate,
  zProposalSignature,
  zPurchaseProposal,
  zRole,
  zSessionRevoke,
} from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import {
  DomainError,
  defineCommand,
  newStagingKey,
  type CommandContext,
  type Runtime,
  type UserActor,
} from '@crove/kernel-runtime';
import { agentCommands } from './agents.ts';
import { channelCommands } from './channels.ts';
import {
  actorRef,
  addAuthor,
  APPROVAL_POLICY_VERSION,
  decideApproval,
  eligibleApprovers,
  keepingChiefAccountant,
  LEDGER_APPROVE_PERMISSION,
  parseAuthors,
} from './approval.ts';
import { archiveCommands } from './archives.ts';
import { imageSizeCommands } from './image-sizes.ts';
import { fileHoldCommands } from './evidence-holds.ts';
import { extractionCommands, legalEntityMoveRefused, readAgainIn, refuseWhileReextracting } from './extraction.ts';
import { ingestFileRow, zIngestFile } from './files.ts';
import { createOrgCommand, myOrgs, orgCreateCommand, type OrgCreateLimits, type OrgSummary } from './identity.ts';
import { acceptInvite, createInvite, inviteCreateCommand, revokeInvite, type InviteLimits } from './invites.ts';
import { mailCommands, queueContactMail } from './mail.ts';
import { auditLogCommands } from './audit-log.ts';
import { personalDataCommands } from './personal-data.ts';
import { notificationCommands } from './notifications.ts';
import { inboxItemCommands } from './inbox-items.ts';
import { offboardingCommands } from './offboarding.ts';
import { memberProfiles } from './profiles.ts';
import { setAddress, setContactEmail } from './org-address.ts';
import { partyCommands } from './parties.ts';
import { setTaxCode, setVatFilingPeriod } from './tax-code.ts';
import { setApprovalPreset } from './approval-preset.ts';
import { legalEntityCommands } from './legal-entities.ts';
import { numberingCommands } from './numbering.ts';
import { roleCommands } from './roles.ts';
import { calendarCommands } from './calendar.ts';
import { proposalReminderCommands } from './proposal-reminders.ts';
import { PROPOSAL_PREPARERS, REQUESTABLE, preparedEntity, resubmitProposal, zPreparedProposal } from './proposal-resubmit.ts';
import { usageCommands } from './usage-limits.ts';
import { userStatusCommands } from './user-status.ts';
import { taxCalendarCommands } from './tax-calendar.ts';

const MEMBERS = ['owner', 'admin', 'member'] as const;
// The command that records an invoice proposal (a purchase or a sale).
const PURCHASE_COMMAND = 'finance.purchase.record';
// Commands a proposal may execute when approved (they must also declare access: 'proposal', which the runtime checks
// against the proposal row: state 'approved' for that command, approved by the running kernel.proposal.approve).
const PROPOSAL_COMMANDS = new Set([
  PURCHASE_COMMAND,
  'finance.journal.reverse',
  'finance.voucher.record',
  'finance.journal_voucher.record',
  'finance.closing.record',
  'finance.depreciation.record',
]);
// The proposals a user may ask for and their preparers: PROPOSAL_PREPARERS in proposal-resubmit.ts.
const ADMINS = ['owner', 'admin'] as const;
// Approving executes an R3 command that posts to the ledger, so only roles that may post approve: owner and admin,
// and a member holding the approval permission through an org-wide role assignment (the commands' `permission`,
// #1279). This is the coarse gate; the approval policy in approval.ts (snapshot, live role or permission, four-eyes)
// decides per proposal.
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
    // Through the definer (plan §3.6, #169): the target is a member of the org in context, so it is found.
    email = (await memberProfiles(ctx.trx, [targetId])).get(targetId)?.email ?? '';
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
  sideEffect: 'internal',
  access: ['owner'],
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    const { actorId, target, owners } = await lockForMemberChange(ctx, input.userId);
    const previousRole = target.role;
    // Every role or membership change records target_user, role and previous_role (#88): a demotion can make a
    // self-approval legal (P10), so role changes must be reviewable next to the approvals they enable.
    ctx.audit({ target_user: input.userId, role: input.role, previous_role: previousRole, changed: previousRole !== input.role });
    if (previousRole === input.role) return { userId: input.userId, role: input.role, previousRole };
    if (previousRole === 'owner' && owners <= 1) throw LAST_OWNER(input.userId, input.role);
    // A demotion to viewer of the last chief accountant under the accountant preset is refused (#1402).
    await keepingChiefAccountant(() =>
      ctx.trx.updateTable('crove_kernel.tenant_member').set({ role: input.role }).where('org_id', '=', ctx.orgId).where('user_id', '=', input.userId).execute(),
    );
    // Pending invites the member could no longer issue are revoked in the same transaction, after the membership locks
    // (the order every invite path uses): an admin or owner who becomes a member or viewer loses every invite, an
    // owner who becomes an admin loses their admin invites (only owners grant admin). Accepting re-checks the
    // inviter's role as well, as a backstop for any other path (#134).
    const lostRoles: Array<'admin' | 'member' | 'viewer'> = input.role === 'owner' ? [] : input.role === 'admin' ? ['admin'] : ['admin', 'member', 'viewer'];
    const revokedInvites =
      lostRoles.length === 0
        ? []
        : await ctx.trx
            .updateTable('crove_kernel.member_invite')
            .set({ status: 'revoked', revoked_at: ctx.now, revoked_by: actorId })
            .where('org_id', '=', ctx.orgId)
            .where('invited_by', '=', input.userId)
            .where('status', '=', 'pending')
            .where('role', 'in', lostRoles)
            .returning('id')
            .execute();
    ctx.audit({ revoked_invites: revokedInvites.map((r) => r.id) });
    await ctx.activity('kernel.member', input.userId, 'member.role_changed', `Đổi vai trò ${target.email} từ ${previousRole} thành ${input.role}`);
    await ctx.emit('kernel.member.role_changed', { userId: input.userId, oldRole: previousRole, newRole: input.role });
    return { userId: input.userId, role: input.role, previousRole };
  },
});

// Removes a member. Deleting the tenant_member row is the revocation: enter_context and my_orgs read membership
// in every transaction, so the member's next request is refused, with any token or session. An owner cannot
// remove themselves, and the org always keeps an owner. Its audit row (outcome ok, target the user) starts the 30 days
// before crove_notes.member_items_purge removes their private notes (#1733): another way to end a membership must
// record the same row.
export const removeMember = defineCommand({
  name: 'kernel.member.remove',
  input: z.object({ userId: zId }),
  risk: 'R3',
  sideEffect: 'internal',
  access: ['owner'],
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    const { actorId, target, owners } = await lockForMemberChange(ctx, input.userId);
    if (input.userId === actorId) throw new DomainError('CANNOT_REMOVE_SELF', 422, 'Bạn không thể tự xóa mình khỏi tổ chức');
    if (target.role === 'owner' && owners <= 1) throw LAST_OWNER(input.userId, null);
    // Removing the last chief accountant under the accountant preset is refused (#1402).
    await keepingChiefAccountant(() => ctx.trx.deleteFrom('crove_kernel.tenant_member').where('org_id', '=', ctx.orgId).where('user_id', '=', input.userId).execute());
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

// Uploads (the API, as the uploading member) and email attachments (kernel.inbound.receive, system). The uploader is
// recorded as the file's creator; an email has no authenticated sender, so its files have none.
export const ingestFile = defineCommand({
  name: 'kernel.file.ingest',
  input: zIngestFile,
  // Its event queues the extraction job, which sends the file to the AI endpoint (plan §4.7: a job with egress
  // derives R2; #1662).
  risk: 'R2',
  sideEffect: 'external',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const filed = await ingestFileRow(ctx, input, ctx.actor.type === 'user' ? ctx.actor.userId : null);
    // The same document uploaded again in another entity (#1764): read again there when it may be.
    if (filed.duplicate && input.legalEntityId !== undefined && input.source === 'upload' && ctx.actor.type === 'user') {
      await readAgainIn(ctx, filed.fileId, input.legalEntityId);
    }
    return filed;
  },
});

// Staged uploads (plan §7.6, ADR-0013). At most this many open (unused, unexpired) grants per user and org.
export const MAX_OPEN_UPLOADS = 20;

// Grants one user may open per org in any rolling minute (issue #223). A claimed grant is no longer open, so the open
// cap alone does not bound a loop of begin, claim and a late POST to the still valid form, which leaves a staging
// object behind each time; this does, together with the staging sweep and the bucket's lifecycle rule.
export interface UploadBeginLimits {
  perMinute: number;
}

export const DEFAULT_UPLOAD_BEGIN_LIMITS: UploadBeginLimits = { perMinute: 20 };

// Opens a single-use grant for one presigned upload to a random staging key. The database sets the 5-minute expiry
// and the creator (the user in the sealed context). The API signs the upload form for the returned key.
export function beginUploadCommand(limits: UploadBeginLimits = DEFAULT_UPLOAD_BEGIN_LIMITS) {
  if (!Number.isInteger(limits.perMinute) || limits.perMinute < 1 || limits.perMinute > 1000) {
    throw new Error('perMinute must be an integer from 1 to 1000');
  }
  return defineCommand({
    name: 'kernel.file.upload.begin',
    // social: an image or video for a post, so the grant allows a video's size (#409); a document stays at 25 MB.
    input: z.object({ purpose: z.enum(UPLOAD_PURPOSES).optional() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: MEMBERS,
    handler: async (ctx, input) => {
      if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tải tệp lên được');
      const userId = ctx.actor.userId;
      // import: a spreadsheet for a module's import (#465), at most 10 MB.
      const maxBytes = input.purpose === 'social' ? MAX_SOCIAL_VIDEO_BYTES : input.purpose === 'import' ? MAX_IMPORT_BYTES : MAX_UPLOAD_BYTES;
      // Serializes begins of one user in one org, so concurrent requests cannot pass either cap together.
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.file_upload:${ctx.orgId}:${userId}`}, 0))`.execute(ctx.trx);
      // Both counts use the database clock: the insert trigger sets created_at and expires_at from now(), the start
      // of the inserting transaction, and they are compared with now() here. Only grants of the last 5 minutes can
      // count (a grant expires 5 minutes after it is created), which bounds the scan on file_upload_recent_idx.
      const counts = await ctx.trx
        .selectFrom('crove_kernel.file_upload')
        .select([
          sql<string>`count(*) FILTER (WHERE used_at IS NULL AND expires_at > pg_catalog.now())`.as('open'),
          sql<string>`count(*) FILTER (WHERE created_at > pg_catalog.now() - interval '1 minute')`.as('recent'),
        ])
        .where('org_id', '=', ctx.orgId)
        .where('created_by', '=', userId)
        .where(sql<boolean>`created_at > pg_catalog.now() - interval '5 minutes'`)
        .executeTakeFirstOrThrow();
      if (Number(counts.open) >= MAX_OPEN_UPLOADS) {
        throw new DomainError('RATE_LIMITED', 429, 'Quá nhiều lượt tải lên đang mở; hãy chờ vài phút rồi thử lại');
      }
      if (Number(counts.recent) >= limits.perMinute) {
        throw new DomainError('RATE_LIMITED', 429, 'Bạn mở quá nhiều lượt tải lên trong một phút; hãy thử lại sau');
      }
      const row = await ctx.trx
        .insertInto('crove_kernel.file_upload')
        .values({ org_id: ctx.orgId, staging_key: newStagingKey(), created_by: userId, max_bytes: String(maxBytes) })
        .returning(['id', 'staging_key', 'max_bytes', 'expires_at'])
        .executeTakeFirstOrThrow();
      ctx.audit({ upload_id: row.id });
      return { uploadId: row.id, stagingKey: row.staging_key, maxBytes: Number(row.max_bytes), expiresAt: row.expires_at.toISOString() };
    },
  });
}

export const beginUpload = beginUploadCommand();

// Uses a grant, once: only its creator, only before it expires (database clock). The API reads the staging object
// only after this commits, so a second completion of the same upload never reads it again.
export const claimUpload = defineCommand({
  name: 'kernel.file.upload.claim',
  input: z.object({ uploadId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.file_upload', id: input.uploadId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tải tệp lên được');
    const row = await ctx.trx
      .selectFrom('crove_kernel.file_upload')
      .select(['staging_key', 'created_by', 'max_bytes', 'used_at', sql<boolean>`expires_at <= pg_catalog.now()`.as('expired')])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.uploadId)
      .forUpdate()
      .executeTakeFirst();
    // Another user's grant reads as missing.
    if (!row || row.created_by !== ctx.actor.userId) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy lượt tải lên');
    if (row.used_at) throw new DomainError('UPLOAD_USED', 409, 'Lượt tải lên này đã được dùng');
    if (row.expired) throw new DomainError('UPLOAD_EXPIRED', 409, 'Lượt tải lên đã hết hạn; hãy tải lại tệp');
    await ctx.trx
      .updateTable('crove_kernel.file_upload')
      .set({ used_at: sql`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.uploadId)
      .execute();
    return { stagingKey: row.staging_key, maxBytes: Number(row.max_bytes) };
  },
});

// The most characters of a mail's text kept with it (#779), as the CHECK on crove_kernel.inbound_message.body_text.
export const INBOUND_TEXT_MAX = 20_000;

export const receiveInbound = defineCommand({
  name: 'kernel.inbound.receive',
  input: z.object({
    messageId: z.string().min(1).max(500),
    from: z.string().max(320).nullable(),
    subject: z.string().max(500).nullable(),
    // The mail's text (#779); absent from a worker built before it.
    text: z.string().min(1).max(INBOUND_TEXT_MAX).nullable().optional(),
    files: z.array(zIngestFile).max(20),
  }),
  // Each attachment runs kernel.file.ingest nested, whose event queues the extraction job that sends the file to the
  // AI endpoint (plan §4.7: a job with egress derives R2, through a nested run too; #1698). A system command, so the
  // worker runs it as before.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input) => {
    const message = await ctx.trx
      .insertInto('crove_kernel.inbound_message')
      .values({
        org_id: ctx.orgId,
        message_id: input.messageId,
        from_address: input.from,
        subject: input.subject,
        body_text: input.text ?? null,
        attachment_count: input.files.length,
      })
      .onConflict((oc) => oc.columns(['org_id', 'message_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!message) return { duplicate: true, fileIds: [] as string[] };
    // What the org used of its daily limits (#675): the message, and the bytes of the attachments it keeps.
    const bytes = input.files.reduce((total, file) => total + file.sizeBytes, 0);
    await ctx.trx
      .insertInto('crove_kernel.org_usage')
      .values([
        { org_id: ctx.orgId, metric: 'inbound_emails', amount: '1' },
        ...(bytes > 0 ? [{ org_id: ctx.orgId, metric: 'attachment_bytes' as const, amount: String(bytes) }] : []),
      ])
      .execute();
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
    // The old address stops receiving at once and is never given out again (a tombstone).
    sideEffect: 'irreversible',
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

// A user asks for a proposal that is not read from a file, for example reversing a posted journal entry (#138). The
// requester is its author, so with two or more eligible approvers someone else approves it (P10), and the approval
// runs the command at its own risk level (R3 for a posting, with step-up, P11). Asking is R1 and posts nothing.
export const requestProposal = defineCommand({
  name: 'kernel.proposal.request',
  input: z.object({ command: z.enum(REQUESTABLE), input: z.record(z.string(), z.unknown()) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tạo được đề xuất');
    const draft = zPreparedProposal.parse(await ctx.run(PROPOSAL_PREPARERS[input.command], input.input));
    if (draft.command !== input.command) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    const entity = preparedEntity(draft);
    const proposal = await ctx.trx
      .insertInto('crove_kernel.proposal')
      .values({
        org_id: ctx.orgId,
        kind: draft.kind,
        command: draft.command,
        title: draft.title,
        payload: JSON.stringify(draft.payload),
        // P12: who may approve this command right now; approval re-checks each one's role live.
        eligible_approvers: await eligibleApprovers(ctx.trx, ctx.orgId, draft.command),
        authors: JSON.stringify([actorRef(ctx.actor)]),
        // Kept so the requester can ask for it again if it expires (#876); the preparer then checks it all anew.
        request_input: JSON.stringify(input.input),
        // The entity it belongs to (#1538): a member limited to other entities neither sees nor decides it.
        ...(entity ? { legal_entity_id: entity } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ proposal_id: proposal.id, proposal_command: draft.command });
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.created', draft.title);
    await ctx.emit('kernel.proposal.created', { proposalId: proposal.id, kind: draft.kind });
    return { proposalId: proposal.id };
  },
});

async function lockPendingProposal(ctx: CommandContext, id: string, revision?: number) {
  const proposal = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!proposal) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy đề xuất');
  // An expired proposal (#876) is terminal: nobody approves, edits or rejects it any more.
  if (proposal.status === 'expired') {
    throw new DomainError('PROPOSAL_EXPIRED', 409, 'Đề xuất này đã quá hạn chờ duyệt nên không duyệt, sửa hay từ chối được nữa');
  }
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
//
// It declares proposalEditor: the runtime runs a reviser only for the command that declares it (#161, #216).
export const editProposal = defineCommand({
  name: 'kernel.proposal.edit',
  proposalEditor: true,
  // lineAccounts, an exchangeRate for a foreign-currency invoice read without one (#918), the legal entity whose books
  // the invoice goes to (#1280, only the proposal's own since #1764), or several of them.
  input: z
    .object({
      id: zId,
      revision: z.number().int().positive(),
      lineAccounts: zLineAccounts.min(1).optional(),
      exchangeRate: zExchangeRate.optional(),
      legalEntityId: zId.optional(),
    })
    .refine((v) => v.lineAccounts !== undefined || v.exchangeRate !== undefined || v.legalEntityId !== undefined, 'lineAccounts, exchangeRate or legalEntityId'),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.proposal', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới chỉnh sửa được');
    const proposal = await lockPendingProposal(ctx, input.id, input.revision);
    // A proposal stays in its legal entity (#1764): moving it would show one entity's document to another's members,
    // and its entity never changes (ADR-0021, b_legal_entity). The database refuses it too (proposal_entity_payload).
    if (input.legalEntityId !== undefined && input.legalEntityId.toLowerCase() !== proposal.legal_entity_id) throw legalEntityMoveRefused();
    await refuseWhileReextracting(ctx, proposal.source_file_id);
    // The module's reviser for this proposal's command, from the registered definitions (their `revises`).
    const reviser = ctx.reviserOf(proposal.command);
    if (!reviser) throw new DomainError('NOT_EDITABLE', 422, 'Loại đề xuất này không chỉnh sửa được');
    const authors = parseAuthors(proposal.authors);
    if (!authors) throw new DomainError('NOT_EDITABLE', 422, 'Đề xuất thiếu thông tin người soạn nên không chỉnh sửa được');
    const revised = await ctx.run<{ changed: boolean; payload: unknown }>(
      reviser,
      {
        payload: proposal.payload,
        lineAccounts: input.lineAccounts ?? [],
        ...(input.exchangeRate ? { exchangeRate: input.exchangeRate } : {}),
        ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
      },
      { proposalId: proposal.id },
    );
    if (!revised.changed) return { revision: proposal.revision, changed: false };
    const named = zId.safeParse((revised.payload as { legalEntityId?: unknown } | null)?.legalEntityId);
    if (named.success && named.data.toLowerCase() !== proposal.legal_entity_id) throw legalEntityMoveRefused();
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

// The signature verification stored on an invoice proposal (#674), and whether approving it needs the approver's
// confirmation: an invoice read from e-invoice XML whose signature is not verified, including one read before #674
// (no verification stored) and an unsigned cash register invoice (unverified, cash_register).
function signatureOf(payload: unknown): { status: string | null; reason: string | null; needsConfirmation: boolean } {
  const body = payload as { signature?: unknown; extractionMethod?: unknown } | null;
  const parsed = zProposalSignature.safeParse(body?.signature);
  const status = parsed.success ? parsed.data.status : null;
  const reason = parsed.success ? parsed.data.reason : null;
  const xml = body?.extractionMethod === 'einvoice_xml';
  return { status, reason, needsConfirmation: status === 'unverified' || (xml && status !== 'verified') };
}

export const approveProposal = defineCommand({
  name: 'kernel.proposal.approve',
  input: z.object({
    id: zId,
    revision: z.number().int().positive(),
    // The accounts the approver saw. They must match the revision: changing them is an edit, never an approval.
    lineAccounts: zLineAccounts.optional(),
    note: z.string().max(500).optional(),
    acceptFailedChecks: z.boolean().optional(),
    // The approver confirmed this revision of an invoice whose digital signature is unverified (#674). Required for
    // such an invoice (SIGNATURE_UNVERIFIED otherwise); the revision above binds it to what the approver saw. An
    // approval of such an invoice that went through was therefore confirmed: its audit row and the revision's payload
    // (signature.status) say so.
    acceptUnverifiedSignature: z.boolean().optional(),
    // A purchase invoice dated in a locked month (#478): the approver posts its entry on this date, in an open month.
    // An approval-time choice like acceptFailedChecks, never part of the revision: finance.purchase.record checks it
    // and the audit row records it. Only a user's single approval sets it; a bulk approval and an agent never do.
    postingDate: zLocalDate.optional(),
  }),
  risk: 'R3',
  // Approving runs the proposal's command: a posting, a payment or another R3 effect.
  sideEffect: 'financial',
  access: APPROVERS,
  // A chief accountant (an org-wide role assignment holding it, #1279) passes this gate too; P12 still decides.
  permission: LEDGER_APPROVE_PERMISSION,
  target: (input) => ({ type: 'kernel.proposal', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới duyệt được');
    const proposal = await lockPendingProposal(ctx, input.id, input.revision);
    if (input.postingDate !== undefined && proposal.command !== PURCHASE_COMMAND) {
      throw new DomainError('POSTING_DATE_NOT_ALLOWED', 422, 'Chỉ hóa đơn mua vào mới chọn được ngày ghi sổ khác ngày hóa đơn');
    }
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
    // An invoice whose digital signature could not be verified (#674) is approved only with the approver's explicit
    // confirmation of this revision. It never blocks the invoice otherwise: confirmed, it is approved as any other.
    const signature = proposal.command === PURCHASE_COMMAND ? signatureOf(proposal.payload) : null;
    if (signature?.needsConfirmation && input.acceptUnverifiedSignature !== true) {
      throw new DomainError('SIGNATURE_UNVERIFIED', 422, 'Chưa xác minh được chữ ký số của hóa đơn này; hãy kiểm tra hóa đơn gốc rồi xác nhận khi duyệt');
    }
    ctx.audit({
      revision: proposal.revision,
      aal: ctx.actor.aal,
      policy: { P12: 'pass', P10: decision.fourEyes },
      // The rules, the org's preset and its version, and the build this approval ran under (plan §4.7, #1402).
      policy_version: APPROVAL_POLICY_VERSION,
      org_policy: decision.orgPolicy,
      build: ctx.build,
      eligible_approvers: decision.eligibleCount,
      self_approved: decision.selfApproved,
      accept_failed_checks: input.acceptFailedChecks ?? false,
      // An invoice's signature verification and whether the approver confirmed it (#674).
      ...(signature
        ? { accept_unverified_signature: input.acceptUnverifiedSignature === true, signature_status: signature.status, signature_reason: signature.reason }
        : {}),
      ...(input.postingDate !== undefined ? { posting_date: input.postingDate } : {}),
    });
    // Approved for its command by this command: the runtime's proposal state gate lets the command run only now.
    // The same transaction ends 'executed', or rolls back to 'pending' if the command fails.
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ status: 'approved', decided_by: ctx.actor.userId, decided_at: ctx.now, executed_command_id: ctx.commandId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    const result = await ctx.run<Record<string, unknown>>(
      proposal.command,
      {
        payload: proposal.payload,
        acceptFailedChecks: input.acceptFailedChecks ?? false,
        ...(input.postingDate !== undefined ? { postingDate: input.postingDate } : {}),
      },
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

// The refusals of one item that leave the rest of the batch going: every per-proposal code the nested
// kernel.proposal.approve can raise for that proposal's state, its approval policy or its content. Listed by code,
// never by status: any other error aborts the whole batch, including an unknown or newly added code, FORBIDDEN (a
// proposal command the kernel does not support, the proposal state gate), a second factor that went stale while the
// batch ran (STEP_UP_REQUIRED: one step-up covers the whole batch or none of it), INVALID, and every server fault.
export const BULK_ITEM_REFUSALS: ReadonlySet<string> = new Set([
  // The proposal (lockPendingProposal, refuseWhileReextracting): another org's id reads like one that does not exist.
  'NOT_FOUND',
  'PROPOSAL_DECIDED',
  // A proposal that expired while the batch was prepared (#876).
  'PROPOSAL_EXPIRED',
  'STALE_REVISION',
  'EXTRACTION_PENDING',
  // The approval policy (decideApproval): P10 and P12.
  'FOUR_EYES_REQUIRED',
  'NOT_ELIGIBLE',
  // An invoice whose digital signature is unverified, sent without its confirmation (#674).
  'SIGNATURE_UNVERIFIED',
  // Recording a purchase (finance.purchase.record and its account check).
  'CHECKS_BLOCKING',
  'CHECKS_FAILED',
  'DUPLICATE_INVOICE',
  'TOTAL_MISMATCH',
  'UNBALANCED',
  'UNKNOWN_LINE',
  'UNSUPPORTED_CURRENCY',
  // A sale no longer the org's own, or a purchase the org issued (#313): the org tax code changed since.
  'NOT_OWN_SALE',
  'OWN_INVOICE',
  // A line's account against its direction (#430): revenue on a sale line only.
  'NOT_REVENUE_ACCOUNT',
  'REVENUE_ACCOUNT_ON_PURCHASE',
  'UNKNOWN_ACCOUNT',
  'ACCOUNT_INACTIVE',
  'PARENT_TAGGED',
  // Reversing an entry (finance.journal.reverse).
  'ENTRY_NOT_FOUND',
  'ALREADY_REVERSED',
  'ENTRY_IS_REVERSAL',
  'REVERSAL_DATE_BEFORE_ENTRY',
  'OPENING_REVERSAL_DATE',
  // Posting a cash or bank voucher (finance.voucher.record, #327).
  'VOUCHER_INVALID',
  'PARTY_NOT_FOUND',
  // A voucher made from a bank statement line (#326): the line no longer fits it, or another voucher settled it.
  'BANK_LINE_NOT_FOUND',
  'BANK_LINE_MISMATCH',
  'BANK_LINE_MATCHED',
  // Posting into a locked month (#329): the proposal's date is in or before the last locked month.
  'PERIOD_LOCKED',
  // Posting on or before the org's opening entry (#366).
  'BEFORE_OPENING_BALANCE',
  // A legal entity the approver may not see, or a document posted in another entity before (#1280).
  'LEGAL_ENTITY_NOT_ALLOWED',
  'SOURCE_LEGAL_ENTITY',
]);

// Whether a nested approval's error refuses only that item.
export function isBulkItemRefusal(error: unknown): error is DomainError {
  return error instanceof DomainError && BULK_ITEM_REFUSALS.has(error.code);
}

// The order a bulk approval runs its items in, so that concurrent batches take their locks in one order. Every item
// but a cash or bank voucher comes first, in id order, so two batches over the same proposals lock them in the same
// order. Vouchers (#327) follow, by voucher type (VOUCHER_TYPES order) and then id: posting one holds its org's
// numbering lock for its type until commit (20261019270000), so a batch taking PT then PC and another taking PC then
// PT would deadlock (40P01, both users told to retry). In one type order the second batch waits for the first. A voucher
// made from a bank statement line (#326) also locks that line, always after its numbering lock (20261020130000), and a
// line takes vouchers of one type only, so the order holds.
// voucherTypes: the voucher type of each voucher item, by proposal id; items not in it are not vouchers.
export function bulkApproveOrder<T extends { id: string }>(items: readonly T[], voucherTypes: ReadonlyMap<string, string>): T[] {
  const rank = (id: string) => {
    const type = voucherTypes.get(id);
    return type === undefined ? 0 : 1 + Math.max(0, (VOUCHER_TYPES as readonly string[]).indexOf(type));
  };
  return [...items].sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type BulkApproveResult =
  | { id: string; outcome: 'approved'; result: Record<string, unknown> }
  | { id: string; outcome: 'refused'; code: string; rule: string | null };

// Approves many pending proposals in one action (issue #315): one R3 command, so the runtime checks the role, the
// fresh second factor (P11) and, for a remote Supabase Auth, the live session once, before any item; a stale step-up
// refuses the whole batch. Each item then runs kernel.proposal.approve as a nested command, which applies its own
// P12 eligibility and P10 four-eyes decision and writes its own audit row, exactly as approving it alone would. An
// item refused with a listed per-proposal code (BULK_ITEM_REFUSALS) rolls back to its savepoint and the others go
// on. Each item runs under ctx.tryRun (issue #429), so a refused item also gets its own denied/failed audit row for
// kernel.proposal.approve with the proposal as its target, written by the runtime once the items ran, the
// row approving it alone would have left, linked to the batch (detail parentCommandId, the batch row's command_id).
// The batch's audit row lists every item's outcome. When the whole batch aborts, the item rows roll back with it and
// the batch's own refusal row records it. Items run in the order of
// bulkApproveOrder, so concurrent batches take their locks in the same order. No line
// accounts and no acceptFailedChecks: a bulk approval only approves what it would approve as shown, and an invoice
// with failed checks is refused (CHECKS_FAILED) for a one-by-one review.
export const approveProposals = defineCommand({
  name: 'kernel.proposal.approve_many',
  // At most MAX_BULK_APPROVE (50) items, each once. Each is a ledger posting in the same transaction, so the batch
  // stays short; the Inbox sends a larger selection in several batches, each under the same step-up freshness rule.
  input: z.object({ items: zBulkApproveItems }),
  risk: 'R3',
  // Each item runs its proposal's posting, as kernel.proposal.approve does.
  sideEffect: 'financial',
  access: APPROVERS,
  // A chief accountant (an org-wide role assignment holding it, #1279) passes this gate too; P12 still decides.
  permission: LEDGER_APPROVE_PERMISSION,
  handler: async (ctx, input): Promise<{ results: BulkApproveResult[] }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới duyệt được');
    // The voucher type of each voucher item, read without a lock: a pending voucher is never edited, so its type stays.
    // Each item is still locked and checked by its own nested approval.
    const vouchers = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select(['id', sql<string | null>`payload ->> 'type'`.as('voucher_type')])
      .where('org_id', '=', ctx.orgId)
      .where('command', '=', VOUCHER_COMMAND)
      .where('id', 'in', input.items.map((i) => i.id))
      .execute();
    const voucherTypes = new Map(vouchers.map((v) => [v.id, v.voucher_type ?? '']));
    const outcomes = new Map<string, BulkApproveResult>();
    for (const item of bulkApproveOrder(input.items, voucherTypes)) {
      // An item's confirmation of an unverified signature (#674) is passed on with its own id and revision.
      const confirm = item.acceptUnverifiedSignature === true ? { acceptUnverifiedSignature: true } : {};
      const attempt = await ctx.tryRun<Record<string, unknown>>('kernel.proposal.approve', { id: item.id, revision: item.revision, ...confirm }, { recover: isBulkItemRefusal });
      if (attempt.status === 'ok') {
        outcomes.set(item.id, { id: item.id, outcome: 'approved', result: attempt.value });
      } else {
        const { refusal } = attempt;
        const rule = typeof refusal.details?.rule === 'string' ? refusal.details.rule : null;
        outcomes.set(item.id, { id: item.id, outcome: 'refused', code: refusal.code, rule });
      }
    }
    const results = input.items.map((item) => outcomes.get(item.id) as BulkApproveResult);
    ctx.audit({
      approved: results.filter((r) => r.outcome === 'approved').length,
      refused: results.filter((r) => r.outcome === 'refused').length,
      // Each item's confirmation of an unverified signature as the batch sent it (#674); the item's own approval row
      // records the signature it confirmed.
      items: results.map((r, i) => {
        const accept_unverified_signature = input.items[i]?.acceptUnverifiedSignature === true;
        return r.outcome === 'approved'
          ? { id: r.id, outcome: r.outcome, accept_unverified_signature }
          : { id: r.id, outcome: r.outcome, code: r.code, rule: r.rule, accept_unverified_signature };
      }),
    });
    return { results };
  },
});

export const rejectProposal = defineCommand({
  name: 'kernel.proposal.reject',
  input: z.object({ id: zId, reason: z.string().max(500).optional() }),
  risk: 'R1',
  sideEffect: 'internal',
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
// The user's own revoke also works without an org: see revokeOwnSessionsWithoutOrg.
export const revokeSession = defineCommand({
  name: 'kernel.session.revoke',
  input: zSessionRevoke,
  risk: 'R1',
  sideEffect: 'internal',
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

// The user's orgs this session can enter (me.get): an org whose owner revoked this session there is left out, so
// the SPA never sends the user back into it (issue #247). The membership checks stay in enter_context.
export async function sessionOrgs(db: Db, userId: string, sessionId: string | null): Promise<OrgSummary[]> {
  const orgs = await myOrgs(db, userId);
  if (!sessionId || orgs.length === 0) return orgs;
  const { rows } = await sql<{ org_id: string }>`
    SELECT r AS org_id FROM crove_kernel.session_revoked_orgs(${userId}::uuid, ${sessionId}::uuid) r`.execute(db);
  const revoked = new Set(rows.map((r) => r.org_id));
  return orgs.filter((org) => !revoked.has(org.orgId));
}

// The user's own revoke sent without an org (issue #184: sign-out on the onboarding and invite pages). A self revoke
// is global, so the org only decides where the audit row lands:
// - a user who belongs to an org runs kernel.session.revoke through execute() in their orgs, oldest first, as from
//   any other page: the same definer, membership and session checks, audit row and upstream sign-out. An org that
//   cannot run it (its owner revoked this session there, or the user left it since the lookup) passes to the next
//   one, so one org's owner cannot block a global self revoke (issue #196);
// - a user with no org that can run it has nowhere to audit: crove_kernel.session_revoke_orgless revokes in Crove
//   only, in the org-less request transaction right after the session check, and refuses while some org could.
// Revoking another user's sessions always needs that user's org: owners revoke in their org only.
export async function revokeOwnSessionsWithoutOrg(runtime: Runtime, actor: UserActor, rawInput: unknown): Promise<{ revoked: string[] }> {
  const parsed = zSessionRevoke.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION', 422, 'Dữ liệu không hợp lệ', { issues: parsed.error.issues.slice(0, 10) });
  }
  const input = parsed.data;
  if (input.userId !== actor.userId) throw new DomainError('ORG_REQUIRED', 400, 'Thiếu tổ chức (header x-crove-org)');
  // A second pass covers a user who joined an org between the lookup and the org-less definer.
  for (let pass = 0; pass < 2; pass += 1) {
    const orgs = await runtime.forUser(actor, (db) => myOrgs(db, actor.userId));
    for (const org of orgs) {
      try {
        return await runtime.execute<{ revoked: string[] }>('kernel.session.revoke', input, { actor, orgId: org.orgId });
      } catch (error) {
        // Only the refusals that are about this org: any other one, a dead session included, is the answer.
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== 'SESSION_REVOKED_IN_ORG' && code !== 'NOT_A_MEMBER') throw error;
      }
    }
    try {
      return await runtime.forUser(actor, async (db) => {
        try {
          const { rows } = await sql<{ revoked_session: string }>`
            SELECT r AS revoked_session
            FROM crove_kernel.session_revoke_orgless(${actor.userId}::uuid, ${actor.sessionId ?? null}::uuid,
              ${input.sessionId ?? null}::uuid, ${input.reason ?? null}) r`.execute(db);
          return { revoked: rows.map((r) => r.revoked_session) };
        } catch (error) {
          // Thrown, not returned: the failed statement aborted this transaction, which then rolls back.
          if ((error as { message?: unknown } | null)?.message === 'ORG_REQUIRED') throw new DomainError('ORG_REQUIRED', 409, 'Thử lại trong tổ chức');
          throw error;
        }
      });
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'ORG_REQUIRED')) throw error;
    }
  }
  throw new DomainError('RETRY', 409, 'Xung đột đồng thời, hãy thử lại');
}

const otherKernelCommands = [
  revokeInvite,
  acceptInvite,
  changeMemberRole,
  removeMember,
  ingestFile,
  claimUpload,
  receiveInbound,
  ...extractionCommands,
  ...archiveCommands,
  ...imageSizeCommands,
  ...fileHoldCommands,
  ...notificationCommands,
  ...inboxItemCommands,
  requestProposal,
  editProposal,
  approveProposal,
  approveProposals,
  rejectProposal,
  resubmitProposal,
  revokeSession,
  ...offboardingCommands,
  ...agentCommands,
  ...channelCommands,
  setTaxCode,
  setVatFilingPeriod,
  setApprovalPreset,
  ...legalEntityCommands,
  ...numberingCommands,
  ...roleCommands,
  ...calendarCommands,
  setAddress,
  setContactEmail,
  queueContactMail,
  ...partyCommands,
  ...mailCommands,
  ...proposalReminderCommands,
  ...taxCalendarCommands,
  ...auditLogCommands,
  ...usageCommands,
  ...userStatusCommands,
  ...personalDataCommands,
];

// The kernel's commands; options.orgCreateLimits sets the org creation limits (default DEFAULT_ORG_CREATE_LIMITS),
// options.inboundRotateLimits the inbound address rotation limits (default DEFAULT_INBOUND_ROTATE_LIMITS),
// options.uploadBeginLimits the presigned upload grant rate (default DEFAULT_UPLOAD_BEGIN_LIMITS), options.inviteLimits
// the invite mails one address may get from all orgs (default DEFAULT_INVITE_LIMITS), options.messageIdDomain the
// right-hand side of the Message-ID of the mail the kernel records (default DEFAULT_MESSAGE_ID_DOMAIN).
export function buildKernelCommands(
  options: {
    orgCreateLimits?: OrgCreateLimits;
    inboundRotateLimits?: InboundRotateLimits;
    uploadBeginLimits?: UploadBeginLimits;
    inviteLimits?: InviteLimits;
    messageIdDomain?: string;
  } = {},
) {
  return [
    options.orgCreateLimits ? orgCreateCommand(options.orgCreateLimits) : createOrgCommand,
    options.inviteLimits || options.messageIdDomain
      ? inviteCreateCommand(options.inviteLimits, { messageIdDomain: options.messageIdDomain })
      : createInvite,
    ...otherKernelCommands,
    options.uploadBeginLimits ? beginUploadCommand(options.uploadBeginLimits) : beginUpload,
    options.inboundRotateLimits ? inboundRotateCommand(options.inboundRotateLimits) : rotateInbound,
  ];
}

export const kernelCommands = buildKernelCommands();
