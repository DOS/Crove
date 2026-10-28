// Asking again for a proposal that expired (#876, plan §8.3: 'expired' is terminal). The expired proposal stays as it
// is; kernel.proposal.resubmit makes a new pending proposal from the same source, which is approved like any other:
// - a proposal a user requested (kernel.proposal.request) runs the module's preparer again on what was sent, so every
//   check of the request (the entry still reversible, no other open reversal of it, the bank line still open, ...)
//   runs anew and the content is built from the database as it is now;
// - a proposal read from a file is proposed again from the same reading, unless the file has a newer proposal or is
//   being read again; the approval checks the invoice again when it posts it.
// An agent's proposal is not asked for again here: its causal chain belongs to the agent's run.
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { actorRef, addAuthor, eligibleApprovers, parseAuthors } from './approval.ts';
import { refuseWhileReextracting } from './extraction.ts';

// Proposals a user may ask for (kernel.proposal.request), and the module command that checks the request and builds
// the proposal from the database; it writes nothing. The title and payload come from it, never from the requester.
// A cash or bank voucher (#327) and a general journal voucher (NVK, #888) are entered by hand this way; a year-end
// closing (#889) is built from the ledger for the year named, and a month's depreciation (#919) from the register.
export const PROPOSAL_PREPARERS = {
  'finance.journal.reverse': 'finance.journal.prepare_reversal',
  'finance.voucher.record': 'finance.voucher.prepare',
  'finance.journal_voucher.record': 'finance.journal_voucher.prepare',
  'finance.closing.record': 'finance.closing.prepare',
  'finance.depreciation.record': 'finance.depreciation.prepare',
} as const;
export type RequestableCommand = keyof typeof PROPOSAL_PREPARERS;
export const REQUESTABLE = Object.keys(PROPOSAL_PREPARERS) as [RequestableCommand, ...RequestableCommand[]];

// legalEntityId: the legal entity the proposal belongs to, for a preparer whose payload does not name it (a reversal
// takes its entry's); see preparedEntity.
export const zPreparedProposal = z.object({
  kind: z.string().min(1),
  command: z.string().min(1),
  title: z.string().min(1).max(300),
  payload: z.record(z.string(), z.unknown()),
  legalEntityId: zId.optional(),
});

// The legal entity of a prepared proposal (#1538): the one its preparer names, else its payload's legalEntityId (the
// entity a voucher posts into, resolved by the preparer as the requester), else none, and the database gives it the
// org's default entity (b_legal_entity). A member or agent limited to other entities is refused that one by le_scope.
export function preparedEntity(draft: { legalEntityId?: string | undefined; payload: Record<string, unknown> }): string | undefined {
  if (draft.legalEntityId) return draft.legalEntityId;
  const named = zId.safeParse(draft.payload.legalEntityId);
  return named.success ? named.data : undefined;
}

const isRequestable = (command: string): command is RequestableCommand => Object.hasOwn(PROPOSAL_PREPARERS, command);

export interface ResubmitFacts {
  status: string;
  command: string;
  authors: unknown;
  requested_by_agent: string | null;
  request_input: unknown;
  source_file_id: string | null;
  extraction_id: string | null;
}

export type ResubmitSource = 'request' | 'file';

// Where a new proposal would come from, or null when the proposal cannot be asked for again: an agent's, one whose
// authors cannot be read (fail closed, as the approval does: four-eyes needs them), a requested one made before its
// request was kept, or one with no source at all.
export function resubmitSource(p: ResubmitFacts): ResubmitSource | null {
  if (p.requested_by_agent !== null) return null;
  if (parseAuthors(p.authors) === null) return null;
  if (isRequestable(p.command)) return p.request_input === null || p.request_input === undefined ? null : 'request';
  return p.source_file_id !== null && p.extraction_id !== null ? 'file' : null;
}

// Whether the user may ask for it again: a person among its authors. A file forwarded by email has no person among its
// authors; then any member who may edit it may, as they may read the file again (kernel.file.reextract).
export function mayResubmit(p: ResubmitFacts, userId: string): boolean {
  const authors = parseAuthors(p.authors);
  if (authors === null) return false;
  const people = authors.flatMap((a) => (a.type === 'user' ? [a.id] : []));
  if (people.includes(userId)) return true;
  return resubmitSource(p) === 'file' && people.length === 0;
}

export const resubmitProposal = defineCommand({
  name: 'kernel.proposal.resubmit',
  input: z.object({ id: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  // The roles that may ask for a proposal (kernel.proposal.request) or read a file again.
  access: ['owner', 'admin', 'member'],
  target: (input) => ({ type: 'kernel.proposal', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới gửi lại được đề xuất');
    // Locked, so two requests to ask for it again serialize and the second finds the first's proposal.
    const old = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    if (!old) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy đề xuất');
    if (old.status !== 'expired') throw new DomainError('PROPOSAL_NOT_EXPIRED', 409, 'Chỉ gửi lại được đề xuất đã hết hạn');
    const again = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('resubmitted_from', '=', old.id)
      .executeTakeFirst();
    if (again) throw new DomainError('PROPOSAL_RESUBMITTED', 409, 'Đề xuất này đã được gửi lại rồi', { proposalId: again.id });
    const source = resubmitSource(old);
    if (!source) {
      throw new DomainError(
        'NOT_RESUBMITTABLE',
        422,
        old.requested_by_agent !== null ? 'Đề xuất này do tác tử AI lập; nếu vẫn cần, hãy giao việc lại cho tác tử' : 'Đề xuất này không gửi lại được; hãy lập một đề xuất mới',
      );
    }
    if (!mayResubmit(old, ctx.actor.userId)) throw new DomainError('FORBIDDEN', 403, 'Chỉ người soạn đề xuất mới gửi lại được');
    const authors = parseAuthors(old.authors);
    if (authors === null) throw new DomainError('NOT_RESUBMITTABLE', 422, 'Đề xuất này không gửi lại được; hãy lập một đề xuất mới');

    let content: {
      kind: string;
      command: string;
      title: string;
      payload: string;
      request_input?: string;
      legal_entity_id?: string;
      source_file_id?: string | null;
      extraction_id?: string | null;
      duplicate_of?: string | null;
      tainted?: boolean;
    };
    if (source === 'request') {
      const preparer = PROPOSAL_PREPARERS[old.command as RequestableCommand];
      const draft = zPreparedProposal.parse(await ctx.run(preparer, old.request_input));
      if (draft.command !== old.command) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      content = {
        kind: draft.kind,
        command: draft.command,
        title: draft.title,
        payload: JSON.stringify(draft.payload),
        request_input: JSON.stringify(old.request_input),
        // The entity the preparer names now, else the expired proposal's (#1538).
        legal_entity_id: preparedEntity(draft) ?? old.legal_entity_id,
      };
    } else {
      // Only the file's newest proposal is asked for again, as kernel.file.reextract acts on it alone.
      const newest = await ctx.trx
        .selectFrom('crove_kernel.proposal')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('source_file_id', '=', old.source_file_id)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (newest?.id !== old.id) {
        throw new DomainError('PROPOSAL_SUPERSEDED', 409, 'Chứng từ này đã có đề xuất mới hơn; hãy mở đề xuất đó', { proposalId: newest?.id ?? null });
      }
      await refuseWhileReextracting(ctx, old.source_file_id);
      content = {
        kind: old.kind,
        command: old.command,
        title: old.title,
        payload: JSON.stringify(old.payload),
        source_file_id: old.source_file_id,
        extraction_id: old.extraction_id,
        // The reading's entity, as the expired proposal had (b_legal_entity checks it against the extraction).
        legal_entity_id: old.legal_entity_id,
        // The duplicate found when the file was read; posting it checks the invoice against the books again
        // (DUPLICATE_INVOICE), so a duplicate recorded since cannot be posted twice.
        duplicate_of: old.duplicate_of,
        // The reading stays tainted; the insert trigger derives it from the extraction too.
        tainted: old.tainted,
      };
    }
    const created = await ctx.trx
      .insertInto('crove_kernel.proposal')
      .values({
        org_id: ctx.orgId,
        ...content,
        // P12: who may approve it now; P10: whoever wrote the content stays an author, and so does the user asking.
        eligible_approvers: await eligibleApprovers(ctx.trx, ctx.orgId, content.command),
        authors: JSON.stringify(addAuthor(authors, actorRef(ctx.actor))),
        resubmitted_from: old.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ proposal_id: created.id, resubmitted_from: old.id, source, proposal_command: content.command });
    await ctx.activity('kernel.proposal', old.id, 'proposal.resubmitted', `Gửi lại thành đề xuất mới: ${content.title}`);
    await ctx.activity('kernel.proposal', created.id, 'proposal.created', content.title);
    await ctx.emit('kernel.proposal.created', { proposalId: created.id, kind: content.kind });
    return { proposalId: created.id };
  },
});
