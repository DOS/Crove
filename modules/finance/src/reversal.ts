// Reversing a posted journal entry (issue #138). A reversal is itself a posting, so it follows the same approval
// rules as recording a purchase (plan §4.7: R3, P10 four-eyes, P11 step-up, P12 eligible approvers):
// - finance.journal.prepare_reversal: a user asks for a reversal through kernel.proposal.request, which runs this to
//   check the entry and build the proposal. It writes nothing.
// - finance.journal.reverse: runs only through kernel.proposal.approve, on the stored payload. It posts a NEW entry
//   through the posting path whose lines mirror the original's (debit and credit swapped), linked by
//   reverses_entry_id. It never appends lines to an existing entry.
// The database enforces the rules for every writer (20261016210000): one reversal per entry, a reversal cannot be
// reversed (post a new entry instead), no reversal dated before the original, and an exact mirror over every line.
// Reversing the entry of a purchase document also voids Crove's record of that document (#165, 20261017120000): an
// append-only void row naming the reversal, in the same transaction, so the same supplier invoice can be recorded
// again with the right accounts. It corrects Crove's records only, never the supplier's e-invoice.
import { z } from 'zod';
import { zJournalReversal, type JournalReversal } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { postJournalEntry } from './ledger.ts';

export { zJournalReversal, type JournalReversal };

export const REVERSAL_COMMAND = 'finance.journal.reverse';
export const REVERSAL_KIND = 'finance.journal_reversal';
const PURCHASE_SOURCE = 'finance.purchase_document';

const NOT_FOUND = () => new DomainError('ENTRY_NOT_FOUND', 404, 'Không tìm thấy bút toán');
const ALREADY_REVERSED = () => new DomainError('ALREADY_REVERSED', 409, 'Bút toán này đã được đảo');
// The database refuses a reversal that does not mirror every line of the original. Through this command that happens
// only when the approver cannot see every line (for example lines of a legal entity outside their scope): the mirror
// of the visible lines is not the whole entry. Same code and status as the runtime's mapping of 23514.
const PARTIAL_MIRROR = () =>
  new DomainError(
    'INVALID',
    422,
    'Không đảo được bút toán này vì bạn không được xem tất cả các dòng của nó, nên không tạo được bút toán đảo đầy đủ. Hãy nhờ người được xem toàn bộ bút toán duyệt đề xuất này.',
    { reason: 'partial_mirror' },
  );

// The entry as the caller sees it (RLS), and whether it may be reversed. The database re-checks all of it.
async function reversibleEntry(ctx: CommandContext, reversal: JournalReversal) {
  const entry = await ctx.trx
    .selectFrom('crove_finance.journal_entry')
    .select(['id', 'entry_date', 'description', 'reverses_entry_id', 'source_type', 'source_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', reversal.entryId)
    .executeTakeFirst();
  if (!entry) throw NOT_FOUND();
  if (entry.reverses_entry_id !== null) {
    throw new DomainError('ENTRY_IS_REVERSAL', 422, 'Đây là bút toán đảo nên không đảo lại được; hãy ghi một bút toán mới');
  }
  const reversed = await ctx.trx
    .selectFrom('crove_finance.journal_entry')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('reverses_entry_id', '=', reversal.entryId)
    .executeTakeFirst();
  if (reversed) throw ALREADY_REVERSED();
  // Both are YYYY-MM-DD, so string order is date order.
  if (reversal.entryDate < entry.entry_date) {
    throw new DomainError('REVERSAL_DATE_BEFORE_ENTRY', 422, 'Ngày bút toán đảo không được trước ngày của bút toán gốc');
  }
  return entry;
}

const reversalTitle = (entry: { entry_date: string; description: string; source_type: string }) =>
  `Đảo bút toán ngày ${entry.entry_date}${entry.source_type === PURCHASE_SOURCE ? ' (hủy chứng từ mua)' : ''}: ${entry.description}`.slice(0, 300);

export const prepareReversal = defineCommand({
  name: 'finance.journal.prepare_reversal',
  input: zJournalReversal,
  risk: 'R1',
  access: ['owner', 'admin', 'member'],
  target: (input) => ({ type: 'finance.journal_entry', id: input.entryId }),
  handler: async (ctx, input) => {
    const entry = await reversibleEntry(ctx, input);
    return { kind: REVERSAL_KIND, command: REVERSAL_COMMAND, title: reversalTitle(entry), payload: input };
  },
});

export const reverseEntry = defineCommand({
  name: REVERSAL_COMMAND,
  input: z.object({ payload: zJournalReversal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  access: 'proposal',
  target: (input) => ({ type: 'finance.journal_entry', id: input.payload.entryId }),
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const entry = await reversibleEntry(ctx, payload);
    const lines = await ctx.trx
      .selectFrom('crove_finance.journal_line')
      .select(['line_no', 'account_code', 'debit', 'credit', 'party_id', 'memo'])
      .where('org_id', '=', ctx.orgId)
      .where('entry_id', '=', entry.id)
      .orderBy('line_no')
      .execute();
    const journalEntryId = await postJournalEntry(ctx, {
      entryDate: payload.entryDate,
      description: `Đảo bút toán ngày ${entry.entry_date}: ${entry.description} (lý do: ${payload.reason})`,
      // The approval that ordered it; the original is reverses_entry_id.
      sourceType: 'kernel.proposal',
      sourceId: ctx.proposalId,
      reversesEntryId: entry.id,
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        accountCode: l.account_code,
        debit: l.credit,
        credit: l.debit,
        partyId: l.party_id,
        memo: l.memo,
      })),
    }).catch((error: { code?: string; constraint?: string; message?: string }) => {
      // A concurrent reversal of the same entry committed first: its insert held the unique index.
      if (error?.code === '23505' && error.constraint === 'journal_entry_reverses_uq') throw ALREADY_REVERSED();
      // The original is posted, so it balances and has at least 2 lines, and the date and reversal rules were checked
      // above: a mirror the database still refuses (not a mirror, unbalanced, too few lines) was built from fewer lines
      // than the entry has, because the approver cannot see them all.
      if (error?.code === '23514' && /does not mirror the entry it reverses|does not balance|needs at least 2 lines/.test(error.message ?? '')) {
        throw PARTIAL_MIRROR();
      }
      throw error;
    });
    // A purchase entry: void Crove's record of its document, naming this reversal (the database checks the link).
    const voidedDocumentId = entry.source_type === PURCHASE_SOURCE ? entry.source_id : null;
    if (voidedDocumentId) {
      await ctx.trx
        .insertInto('crove_finance.purchase_document_void')
        .values({
          org_id: ctx.orgId,
          document_id: voidedDocumentId,
          reversal_entry_id: journalEntryId,
          reason: payload.reason,
          voided_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        })
        .execute();
      await ctx.activity('finance.purchase_document', voidedDocumentId, 'purchase.voided', `Hủy chứng từ do đảo bút toán: ${entry.description}`);
      await ctx.emit('finance.purchase.voided', { documentId: voidedDocumentId, reversalEntryId: journalEntryId });
    }
    ctx.audit({ reversed_entry_id: entry.id, reversal_entry_id: journalEntryId, voided_document_id: voidedDocumentId });
    await ctx.activity('finance.journal_entry', entry.id, 'journal_entry.reversed', `Đảo bút toán: ${entry.description}`);
    await ctx.emit('finance.journal_entry.reversed', { entryId: entry.id, reversalEntryId: journalEntryId });
    return { journalEntryId, reversedEntryId: entry.id, ...(voidedDocumentId ? { voidedDocumentId } : {}) };
  },
});
