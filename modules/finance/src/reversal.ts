// Reversing a posted journal entry (issue #138). A reversal is itself a posting, so it follows the same approval
// rules as recording a purchase (plan §4.7: R3, P10 four-eyes, P11 step-up, P12 eligible approvers):
// - finance.journal.prepare_reversal: a user asks for a reversal through kernel.proposal.request, which runs this to
//   check the entry and build the proposal. It writes nothing.
// - finance.journal.reverse: runs only through kernel.proposal.approve, on the stored payload. It posts a NEW entry
//   through the posting path whose lines mirror the original's (debit and credit swapped), linked by
//   reverses_entry_id. It never appends lines to an existing entry.
// The database enforces the rules for every writer (20261016210000): one reversal per entry, a reversal cannot be
// reversed (post a new entry instead), no reversal dated before the original, and an exact mirror over every line.
import { z } from 'zod';
import { zId, zLocalDate } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { postJournalEntry } from './ledger.ts';

export const REVERSAL_COMMAND = 'finance.journal.reverse';
export const REVERSAL_KIND = 'finance.journal_reversal';

export const zJournalReversal = z.object({
  entryId: zId,
  // The reversal's own date: on or after the original's, usually the day the mistake is corrected.
  entryDate: zLocalDate,
  reason: z.string().trim().min(1).max(500),
});
export type JournalReversal = z.infer<typeof zJournalReversal>;

const NOT_FOUND = () => new DomainError('ENTRY_NOT_FOUND', 404, 'Không tìm thấy bút toán');
const ALREADY_REVERSED = () => new DomainError('ALREADY_REVERSED', 409, 'Bút toán này đã được đảo');

// The entry as the caller sees it (RLS), and whether it may be reversed. The database re-checks all of it.
async function reversibleEntry(ctx: CommandContext, reversal: JournalReversal) {
  const entry = await ctx.trx
    .selectFrom('crove_finance.journal_entry')
    .select(['id', 'entry_date', 'description', 'reverses_entry_id'])
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

const reversalTitle = (entry: { entry_date: string; description: string }) =>
  `Đảo bút toán ngày ${entry.entry_date}: ${entry.description}`.slice(0, 300);

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
    }).catch((error: { code?: string; constraint?: string }) => {
      // A concurrent reversal of the same entry committed first: its insert held the unique index.
      if (error?.code === '23505' && error.constraint === 'journal_entry_reverses_uq') throw ALREADY_REVERSED();
      throw error;
    });
    ctx.audit({ reversed_entry_id: entry.id, reversal_entry_id: journalEntryId });
    await ctx.activity('finance.journal_entry', entry.id, 'journal_entry.reversed', `Đảo bút toán: ${entry.description}`);
    await ctx.emit('finance.journal_entry.reversed', { entryId: entry.id, reversalEntryId: journalEntryId });
    return { journalEntryId, reversedEntryId: entry.id };
  },
});
