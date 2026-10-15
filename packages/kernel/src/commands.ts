import { sql } from 'kysely';
import { z } from 'zod';
import { zAccountCode, zId, zPurchaseProposal, zRole, zSessionRevoke } from '@crove/kernel-contract';
import { DomainError, defineCommand, fileKey, type CommandContext } from '@crove/kernel-runtime';
import { actorRef, addAuthor, decideApproval, eligibleApprovers, parseAuthors, type ActorRef } from './approval.ts';
import { createOrgCommand, orgCreateCommand, type OrgCreateLimits } from './identity.ts';

const MEMBERS = ['owner', 'admin', 'member'] as const;
// Commands a proposal may execute when approved (they must also declare access: 'proposal').
const PROPOSAL_COMMANDS = new Set(['finance.purchase.record']);
// The module command that computes a new revision's payload when a user edits a proposal (access: 'proposal').
const PROPOSAL_REVISERS: Record<string, string> = { 'finance.purchase.record': 'finance.purchase.revise' };
const ADMINS = ['owner', 'admin'] as const;
// Approving executes an R3 command that posts to the ledger, so only roles that may post approve.
// The role model has no finance roles yet; owner and admin are the roles that may post today. This is the
// coarse gate; the approval policy in approval.ts (snapshot, live role, four-eyes) decides per proposal.
const APPROVERS = ADMINS;

const zLineAccounts = z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).max(1000);

// Membership and role changes are R3 (plan §4.7): they need a fresh second factor (P11, ADR-0028).
export const addMember = defineCommand({
  name: 'kernel.member.add',
  input: z.object({ email: z.email(), role: zRole.exclude(['owner']) }),
  risk: 'R3',
  access: ADMINS,
  handler: async (ctx, input) => {
    // Only owners may grant or change admin rights; nobody can change an owner through this command.
    if (input.role === 'admin' && ctx.role !== 'owner') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới cấp được quyền quản trị');
    }
    const { rows } = await sql<{ id: string | null }>`SELECT crove_kernel.user_id_by_email(${input.email}) AS id`.execute(ctx.trx);
    const userId = rows[0]?.id;
    if (!userId) throw new DomainError('USER_NOT_FOUND', 404, 'Người này chưa có tài khoản, hãy nhờ họ đăng ký trước');
    const existing = await ctx.trx
      .selectFrom('crove_kernel.tenant_member')
      .select('role')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (existing?.role === 'owner') throw new DomainError('FORBIDDEN', 403, 'Không đổi được vai trò của chủ sở hữu');
    if (existing?.role === 'admin' && ctx.role !== 'owner') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới đổi được vai trò của quản trị viên');
    }
    await ctx.trx
      .insertInto('crove_kernel.tenant_member')
      .values({ org_id: ctx.orgId, user_id: userId, role: input.role })
      .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet({ role: input.role }))
      .execute();
    await ctx.activity('kernel.member', userId, 'member.added', `Thêm thành viên ${input.email} (${input.role})`);
    return { userId };
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

export const zProposalDraft = z.object({
  kind: z.string(),
  command: z.string(),
  title: z.string().max(300),
  payload: z.record(z.string(), z.unknown()),
  duplicateOf: zId.nullable(),
});

export const recordExtraction = defineCommand({
  name: 'kernel.extraction.record',
  input: z.object({
    fileId: zId,
    method: z.enum(['einvoice_xml', 'pdf_text_ai', 'image_ai', 'unsupported']),
    status: z.enum(['done', 'failed']),
    result: z.unknown().nullable(),
    checks: z.array(z.object({ id: z.string(), status: z.enum(['pass', 'warn', 'fail']), message: z.string() })),
    error: z.string().max(2000).nullable(),
    proposal: zProposalDraft.nullable(),
  }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    const existing = await ctx.trx
      .selectFrom('crove_kernel.extraction')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', input.fileId)
      .executeTakeFirst();
    if (existing) return { extractionId: existing.id, proposalId: null, duplicate: true };
    const extraction = await ctx.trx
      .insertInto('crove_kernel.extraction')
      .values({
        org_id: ctx.orgId,
        file_id: input.fileId,
        method: input.method,
        status: input.status,
        result: input.result === null ? null : JSON.stringify(input.result),
        checks: JSON.stringify(input.checks),
        error: input.error,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    let proposalId: string | null = null;
    if (input.proposal) {
      // Authors (P10): the extraction itself, and the user who uploaded the source file, since the content
      // is read from what they supplied. A forwarded email has no authenticated sender, so it adds nobody.
      const file = await ctx.trx
        .selectFrom('crove_kernel.file')
        .select('created_by')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.fileId)
        .executeTakeFirst();
      const authors: ActorRef[] = [actorRef(ctx.actor)];
      if (file?.created_by) authors.push({ type: 'user', id: file.created_by });
      const proposal = await ctx.trx
        .insertInto('crove_kernel.proposal')
        .values({
          org_id: ctx.orgId,
          kind: input.proposal.kind,
          command: input.proposal.command,
          title: input.proposal.title,
          payload: JSON.stringify(input.proposal.payload),
          source_file_id: input.fileId,
          extraction_id: extraction.id,
          duplicate_of: input.proposal.duplicateOf,
          // P12: who may approve this command right now; approval re-checks each one's role live.
          eligible_approvers: await eligibleApprovers(ctx.trx, ctx.orgId, input.proposal.command),
          authors: JSON.stringify(authors),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      proposalId = proposal.id;
      await ctx.activity('kernel.proposal', proposal.id, 'proposal.created', input.proposal.title);
      await ctx.emit('kernel.proposal.created', { proposalId: proposal.id, kind: input.proposal.kind });
    } else {
      await ctx.activity('kernel.file', input.fileId, 'extraction.failed', input.error ?? 'Không đọc được chứng từ');
    }
    return { extractionId: extraction.id, proposalId, duplicate: false };
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
    const reviser = PROPOSAL_REVISERS[proposal.command];
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
      policy: { P12: 'pass', P10: decision.selfApproved ? 'self_approved' : 'pass' },
      eligible_approvers: decision.eligibleCount,
      self_approved: decision.selfApproved,
      accept_failed_checks: input.acceptFailedChecks ?? false,
    });
    const result = await ctx.run<{ documentId: string; journalEntryId: string }>(
      proposal.command,
      { payload: proposal.payload, acceptFailedChecks: input.acceptFailedChecks ?? false },
      { proposalId: proposal.id },
    );
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({
        status: 'executed',
        decided_by: ctx.actor.userId,
        decided_at: ctx.now,
        decision_note: input.note ?? null,
        executed_command_id: ctx.commandId,
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
//   (kernel.session.revoked; best effort and retried, correctness does not depend on it);
// - the org owner revokes a member's session in that org only: no global record, no upstream sign-out, because
//   sessions are global and membership needs no consent from the member;
// - nobody else, admins included.
export const revokeSession = defineCommand({
  name: 'kernel.session.revoke',
  input: zSessionRevoke,
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  target: (input) => ({ type: 'kernel.user', id: input.userId }),
  handler: async (ctx, input) => {
    const { rows } = await sql<{ revoked_session: string; auth_subject: string | null; sign_out: 'local' | 'global' | null }>`
      SELECT revoked_session, auth_subject, sign_out
      FROM crove_kernel.session_revoke(${input.userId}::uuid, ${input.sessionId ?? null}::uuid, ${input.reason ?? null})`.execute(ctx.trx);
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
  addMember,
  ingestFile,
  receiveInbound,
  recordExtraction,
  editProposal,
  approveProposal,
  rejectProposal,
  revokeSession,
];

// The kernel's commands; options.orgCreateLimits sets the org creation limits (default DEFAULT_ORG_CREATE_LIMITS).
export function buildKernelCommands(options: { orgCreateLimits?: OrgCreateLimits } = {}) {
  return [options.orgCreateLimits ? orgCreateCommand(options.orgCreateLimits) : createOrgCommand, ...otherKernelCommands];
}

export const kernelCommands = buildKernelCommands();
