// Opening balances from Excel (issue #320). The browser reads the template and sends its rows as text; the module
// decides everything else:
// - finance.opening_balance.preview checks a trial balance and answers per-row and whole-entry problems. It writes
//   nothing.
// - finance.opening_balance.post checks it again and posts it as one opening entry through the posting path. It is a
//   posting run by a user, so it is R3 (fresh MFA, P11) and only the roles that may post run it (owner and admin).
//   A user's own R3 is allowed without a proposal (plan §4.7); a system import would need one (P13).
// One opening entry per org: while one is in force (not reversed), another is refused. To replace it, reverse it like
// any entry (finance.journal.reverse, through a proposal), on its own date (reversal.ts refuses another), then import
// again: the old entry and its reversal cancel out at every date, so the new one stands alone. Posts for one org are serialized by a
// transaction-level advisory lock, so two at once cannot both pass the check; this relies on READ COMMITTED (the
// runtime's isolation for commands), so the second sees the first's entry once it gets the lock.
// The opening balances are as at the end of the date, so every other entry must be dated later. The posting guard on
// journal_entry holds every writer to that (#366, 20261020210000): an entry dated on or before the opening entry in
// force is refused (BEFORE_OPENING_BALANCE), and the opening entry takes the org's period_lock row FOR UPDATE, so an
// import and a posting in flight wait for each other and the second is refused if it breaks the rule.
import { sql } from 'kysely';
import { zOpeningBalanceImport, type OpeningBalanceImport } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { chartOfAccounts } from './accounts.ts';
import { OPENING_BALANCE_SOURCE, checkOpeningBalance, type LedgerFacts, type OpeningCheck } from './domain/opening-balance.ts';
import { postJournalEntry } from './ledger.ts';

const POSTERS = ['owner', 'admin'] as const;

// The opening entry in force and the earliest other entry. An opening entry's reversal (source kernel.proposal,
// reverses_entry_id set) belongs with it and does not count as another entry.
async function ledgerFacts(ctx: QueryContext): Promise<LedgerFacts> {
  const opening = await ctx.trx
    .selectFrom('crove_finance.journal_entry as e')
    .select(['e.id', 'e.entry_date'])
    .where('e.org_id', '=', ctx.orgId)
    .where('e.source_type', '=', OPENING_BALANCE_SOURCE)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('crove_finance.journal_entry as r')
            .select('r.id')
            .whereRef('r.org_id', '=', 'e.org_id')
            .whereRef('r.reverses_entry_id', '=', 'e.id'),
        ),
      ),
    )
    .orderBy('e.entry_date')
    .orderBy('e.id')
    .executeTakeFirst();
  const first = await ctx.trx
    .selectFrom('crove_finance.journal_entry as e')
    .leftJoin('crove_finance.journal_entry as o', (join) => join.onRef('o.org_id', '=', 'e.org_id').onRef('o.id', '=', 'e.reverses_entry_id'))
    .select((eb) => eb.fn.min('e.entry_date').as('first'))
    .where('e.org_id', '=', ctx.orgId)
    .where('e.source_type', '<>', OPENING_BALANCE_SOURCE)
    .where((eb) => eb.or([eb('o.id', 'is', null), eb('o.source_type', '<>', OPENING_BALANCE_SOURCE)]))
    .executeTakeFirst();
  return {
    openingEntry: opening ? { id: opening.id, entryDate: opening.entry_date } : null,
    firstEntryDate: first?.first ?? null,
  };
}

async function check(ctx: QueryContext, input: OpeningBalanceImport): Promise<OpeningCheck> {
  return checkOpeningBalance(input, await chartOfAccounts(ctx), await ledgerFacts(ctx));
}

export const openingBalancePreview = defineQuery({
  name: 'finance.opening_balance.preview',
  input: zOpeningBalanceImport,
  access: POSTERS,
  handler: async (ctx, input) => (await check(ctx, input)).preview,
});

export const openingBalancePost = defineCommand({
  name: 'finance.opening_balance.post',
  input: zOpeningBalanceImport,
  risk: 'R3',
  access: POSTERS,
  handler: async (ctx, input) => {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${OPENING_BALANCE_SOURCE}:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    const { preview, lines } = await check(ctx, input);
    if (preview.openingEntry) {
      throw new DomainError('OPENING_BALANCE_EXISTS', 409, 'Đã có bút toán số dư đầu kỳ; hãy đảo bút toán đó trước khi nhập lại', {
        entryId: preview.openingEntry.id,
      });
    }
    if (preview.errors.includes('AFTER_ENTRIES')) {
      throw new DomainError(
        'OPENING_BALANCE_AFTER_ENTRIES',
        422,
        `Đã có bút toán từ ngày ${preview.firstEntryDate}; ngày số dư đầu kỳ phải trước ngày đó`,
        { firstEntryDate: preview.firstEntryDate },
      );
    }
    if (preview.errors.includes('UNBALANCED')) {
      throw new DomainError('UNBALANCED', 422, `Tổng dư Nợ và tổng dư Có chênh nhau ${preview.totals.difference} đồng`, {
        difference: preview.totals.difference,
      });
    }
    if (!preview.ok) {
      const rows = preview.rows.filter((r) => r.errors.length > 0).map((r) => r.rowNo);
      throw new DomainError('OPENING_BALANCE_INVALID', 422, 'Bảng số dư có dòng không hợp lệ; hãy xem lại trước khi ghi sổ', {
        rows: rows.slice(0, 50),
        noBalances: preview.errors.includes('NO_BALANCES'),
      });
    }
    const journalEntryId = await postJournalEntry(ctx, {
      entryDate: input.asOf,
      description: `Số dư đầu kỳ tại ngày ${input.asOf}`,
      sourceType: OPENING_BALANCE_SOURCE,
      // Unique per posting, so the (source_type, source_id) key never stops a later opening entry after a reversal.
      sourceId: ctx.commandId,
      lines: lines.map((l) => ({ ...l, partyId: null, memo: null })),
    });
    ctx.audit({ as_of: input.asOf, lines: lines.length, total_debit: preview.totals.debit, total_credit: preview.totals.credit });
    await ctx.activity('finance.journal_entry', journalEntryId, 'opening_balance.posted', `Ghi số dư đầu kỳ tại ngày ${input.asOf}`);
    await ctx.emit('finance.opening_balance.posted', { entryId: journalEntryId, asOf: input.asOf });
    return { journalEntryId, lines: lines.length };
  },
});
