// Reversing a posted journal entry (issue #138). A reversal is itself a posting, so it follows the same approval
// rules as recording a purchase (plan §4.7: R3, P10 four-eyes, P11 step-up, P12 eligible approvers):
// - finance.journal.prepare_reversal: a user asks for a reversal through kernel.proposal.request, which runs this to
//   check the entry and build the proposal. It writes nothing.
// - finance.journal.reverse: runs only through kernel.proposal.approve, on the stored payload. It posts a NEW entry
//   through the posting path whose lines mirror the original's (debit and credit swapped), linked by
//   reverses_entry_id. It never appends lines to an existing entry.
// The database enforces the rules for every writer (20261016210000): one reversal per entry, a reversal cannot be
// reversed (post a new entry instead), no reversal dated before the original, and an exact mirror over every line.
// A request is refused while another reversal of the same entry waits for approval (#254).
// Reversing the entry of a purchase document also voids Crove's record of that document (#165, 20261018000000): an
// append-only void row naming the reversal, in the same transaction, so the same supplier invoice can be recorded
// again with the right accounts. It corrects Crove's records only, never the supplier's e-invoice. The database holds
// every writer to both directions: a void names the reversal of its document's entry, and such a reversal commits
// only with its void (20261018150000).
import { sql } from 'kysely';
import { z } from 'zod';
import { zJournalReversal, type DocumentDirection, type JournalReversal } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { OPENING_BALANCE_SOURCE } from './domain/opening-balance.ts';
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
  // An opening entry (#320) is reversed on its own date, so it cancels out at every date and the next opening entry
  // replaces it whole. A later reversal would leave both counted until then, and it can never be moved.
  if (entry.source_type === OPENING_BALANCE_SOURCE && reversal.entryDate !== entry.entry_date) {
    throw new DomainError('OPENING_REVERSAL_DATE', 422, `Bút toán số dư đầu kỳ chỉ được đảo vào đúng ngày của nó (${entry.entry_date})`, {
      entryDate: entry.entry_date,
    });
  }
  return entry;
}

// A reversal already asked for and waiting for approval (#254): a second request for the same entry is refused, as its
// approval could only fail with ALREADY_REVERSED once the first is approved. Requests for one entry are serialized by
// a transaction-level advisory lock, so two at once cannot both pass: the second waits for the first to commit, then
// finds its proposal. Open proposals are checked before the reversal itself (reversibleEntry): an approval that commits
// in between turns the proposal executed and posts the reversal together, so one of the two checks sees it. The id is
// compared lower-cased, as payloads store it (prepareReversal) and as a payload written before that may not.
// This relies on READ COMMITTED (the runtime's isolation for commands): the lookup after the lock takes a new snapshot
// and so sees a proposal committed while it waited. Under REPEATABLE READ both requests could pass.
// The lock is keyed by the entry alone (a uuid, lower-cased), so every spelling of the request takes the same lock.
export const OPEN_REVERSAL_STATUSES = ['pending', 'approved'] as const;
async function refuseOpenReversal(ctx: CommandContext, entryId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${REVERSAL_KIND}:${entryId}`}, 0))`.execute(ctx.trx);
  const open = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('kind', '=', REVERSAL_KIND)
    .where('status', 'in', OPEN_REVERSAL_STATUSES)
    .where(sql<string>`pg_catalog.lower(payload->>'entryId')`, '=', entryId)
    // The oldest, for a stable answer should there be more than one (proposals raised before this rule).
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (open) {
    throw new DomainError('REVERSAL_PENDING', 409, 'Bút toán này đã có đề xuất đảo đang chờ duyệt; hãy duyệt hoặc từ chối đề xuất đó', {
      proposalId: open.id,
    });
  }
}

// The direction of the document an entry records (a purchase or a sale, #313), or null for an entry with no document.
async function documentDirection(ctx: CommandContext, entry: { source_type: string; source_id: string }): Promise<DocumentDirection | null> {
  if (entry.source_type !== PURCHASE_SOURCE) return null;
  const document = await ctx.trx
    .selectFrom('crove_finance.purchase_document')
    .select('direction')
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', entry.source_id)
    .executeTakeFirst();
  return document?.direction ?? 'purchase';
}

const VOID_LABELS: Record<DocumentDirection, string> = { purchase: 'hủy chứng từ mua', sale: 'hủy chứng từ bán' };

const reversalTitle = (entry: { entry_date: string; description: string }, direction: DocumentDirection | null) =>
  `Đảo bút toán ngày ${entry.entry_date}${direction ? ` (${VOID_LABELS[direction]})` : ''}: ${entry.description}`.slice(0, 300);

export const prepareReversal = defineCommand({
  name: 'finance.journal.prepare_reversal',
  input: zJournalReversal,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin', 'member'],
  target: (input) => ({ type: 'finance.journal_entry', id: input.entryId.toLowerCase() }),
  handler: async (ctx, input) => {
    // One spelling of the id in every payload, so open requests are found by it.
    const request = { ...input, entryId: input.entryId.toLowerCase() };
    await refuseOpenReversal(ctx, request.entryId);
    const entry = await reversibleEntry(ctx, request);
    return { kind: REVERSAL_KIND, command: REVERSAL_COMMAND, title: reversalTitle(entry, await documentDirection(ctx, entry)), payload: request };
  },
});

export const reverseEntry = defineCommand({
  name: REVERSAL_COMMAND,
  input: z.object({ payload: zJournalReversal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'financial',
  access: 'proposal',
  proposalKind: REVERSAL_KIND,
  target: (input) => ({ type: 'finance.journal_entry', id: input.payload.entryId }),
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const entry = await reversibleEntry(ctx, payload);
    return postReversal(ctx, entry, payload.entryDate, payload.reason);
  },
});

// Posts the mirror of `entry` on `entryDate` and, for a document's entry, voids the document: the approval of a
// reversal, and of a replacement invoice whose original is in the books (#916, record.ts). The caller has checked that
// the entry may be reversed on that date; the database checks it again.
export async function postReversal(
  ctx: CommandContext,
  entry: { id: string; entry_date: string; description: string; source_type: string; source_id: string },
  entryDate: string,
  reason: string,
) {
  if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
  const lines = await ctx.trx
    .selectFrom('crove_finance.journal_line')
    .select(['line_no', 'account_code', 'debit', 'credit', 'party_id', 'memo'])
    .where('org_id', '=', ctx.orgId)
    .where('entry_id', '=', entry.id)
    .orderBy('line_no')
    .execute();
  const journalEntryId = await postJournalEntry(ctx, {
    entryDate,
    description: `Đảo bút toán ngày ${entry.entry_date}: ${entry.description} (lý do: ${reason})`,
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
        reason,
        voided_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .execute();
    // The event keeps its name for sales too (finance.purchase_document holds both directions) and says which it was.
    const direction = (await documentDirection(ctx, entry)) ?? 'purchase';
    const voided = direction === 'sale' ? 'Hủy chứng từ bán do đảo bút toán' : 'Hủy chứng từ mua do đảo bút toán';
    await ctx.activity('finance.purchase_document', voidedDocumentId, direction === 'sale' ? 'sale.voided' : 'purchase.voided', `${voided}: ${entry.description}`);
    await ctx.emit('finance.purchase.voided', { documentId: voidedDocumentId, reversalEntryId: journalEntryId, direction });
  }
  ctx.audit({ reversed_entry_id: entry.id, reversal_entry_id: journalEntryId, voided_document_id: voidedDocumentId });
  await ctx.activity('finance.journal_entry', entry.id, 'journal_entry.reversed', `Đảo bút toán: ${entry.description}`);
  await ctx.emit('finance.journal_entry.reversed', { entryId: entry.id, reversalEntryId: journalEntryId });
  return { journalEntryId, reversedEntryId: entry.id, ...(voidedDocumentId ? { voidedDocumentId } : {}) };
}
