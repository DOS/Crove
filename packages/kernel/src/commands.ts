import { sql } from 'kysely';
import { z } from 'zod';
import { zAccountCode, zId, zRole } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';

const MEMBERS = ['owner', 'admin', 'member'] as const;
const ADMINS = ['owner', 'admin'] as const;

export const addMember = defineCommand({
  name: 'kernel.member.add',
  input: z.object({ email: z.email(), role: zRole.exclude(['owner']) }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const { rows } = await sql<{ id: string | null }>`SELECT crove_kernel.user_id_by_email(${input.email}) AS id`.execute(ctx.trx);
    const userId = rows[0]?.id;
    if (!userId) throw new DomainError('USER_NOT_FOUND', 404, 'Người này chưa có tài khoản, hãy nhờ họ đăng ký trước');
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

export const approveProposal = defineCommand({
  name: 'kernel.proposal.approve',
  input: z.object({
    id: zId,
    revision: z.number().int().positive(),
    lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).optional(),
    note: z.string().max(500).optional(),
  }),
  risk: 'R3',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.proposal', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới duyệt được');
    const proposal = await lockPendingProposal(ctx, input.id, input.revision);
    const result = await ctx.run<{ documentId: string; journalEntryId: string }>(
      proposal.command,
      { payload: proposal.payload, lineAccounts: input.lineAccounts ?? [] },
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

export const kernelCommands = [addMember, ingestFile, receiveInbound, recordExtraction, approveProposal, rejectProposal];
