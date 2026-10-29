// Bank statement lines to bank vouchers (issue #326, stage 2a). A line of the bank screen becomes a báo Có (money in) or
// báo Nợ (money out) through the voucher's own path: the user opens the voucher form from the line
// (finance.bank.line_voucher prefills it and suggests the party, domain/bank-match.ts), kernel.proposal.request runs
// finance.voucher.prepare, and approving the proposal runs finance.voucher.record (R3, four-eyes, fresh MFA). The
// voucher then names the line (cash_voucher.bank_line_id), and the database holds the link (20261020130000): the line
// is in the voucher's bank account, on its date, in its direction, for its amount, and settled by at most one voucher
// whose entry is not reversed. The checks here are the same rules, worded for the user before the database refuses.
//
// A line is open, proposed (a pending voucher proposal names it) or matched (a posted voucher settles it). Asking for a
// second voucher of a line already proposed is refused: the requests for one line are serialized by a transaction
// lock on it, the same lock the database's check takes when a voucher is posted.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  VOUCHER_COMMAND,
  defaultCounterAccount,
  voucherCode,
  zAccountCode,
  zId,
  zLedgerPeriod,
  type BankLine,
  type BankLineCandidate,
  type BankLineState,
  type BankLineVoucher,
  type BankMatchReason,
  type BankOpenLines,
  type VoucherType,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { Decimal } from '@crove/l10n-vn';
import { matchLine, type MatchCandidate } from './domain/bank-match.ts';
import { VOUCHER_SOURCE } from './domain/cash-voucher.ts';
import { ledgerPeriod } from './domain/ledger-reports.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { latestRevision } from './source-entry.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The reasons strong enough to ask for vouchers in bulk: what the description itself names.
const STRONG_REASONS: readonly BankMatchReason[] = ['tax_code', 'invoice'];
// The most lines finance.bank.suggestions reads at once (a busy month of one account).
export const BANK_SUGGESTIONS_MAX = 500;

// The candidates a suggestion reads: invoices of the line's amount and party balances equal to it, at most this many
// each. A line rarely has more than a handful; past this, the suggestion lists none of the extra ones.
const CANDIDATE_ROWS = 50;
// A voucher's lý do holds at most this many characters.
const DESCRIPTION_MAX = 300;

export interface StoredBankLine {
  id: string;
  bankAccount: string;
  date: string;
  description: string;
  amount: string;
  balance: string | null;
  reference: string | null;
  ambiguous: boolean;
  importId: string;
  // The legal entity whose books the line is in (#1280); a voucher made from it is in the same entity.
  legalEntityId: string;
}

// The lines, as the org has them, in no particular order; ids of other orgs or of no line are left out.
async function findBankLines(ctx: QueryContext, ids: readonly string[]): Promise<StoredBankLine[]> {
  if (ids.length === 0) return [];
  const rows = await ctx.trx
    .selectFrom('crove_finance.bank_line')
    .select(['id', 'bank_account', 'value_date', 'description', 'amount', 'running_balance', 'bank_ref', 'ambiguous', 'import_id', 'legal_entity_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', ids)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    bankAccount: row.bank_account,
    date: row.value_date,
    description: row.description,
    amount: new Decimal(row.amount).toFixed(),
    balance: row.running_balance === null ? null : new Decimal(row.running_balance).toFixed(),
    reference: row.bank_ref,
    ambiguous: row.ambiguous,
    importId: row.import_id,
    legalEntityId: row.legal_entity_id,
  }));
}

// The line, as the org has it, or null.
export async function findBankLine(ctx: QueryContext, id: string): Promise<StoredBankLine | null> {
  return (await findBankLines(ctx, [id]))[0] ?? null;
}

// The same transaction lock the database's check takes when a voucher of the line is posted (20261020130000).
export const lockBankLine = (ctx: QueryContext, id: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_finance.bank_line:${ctx.orgId}:${id}`}, 0))`.execute(ctx.trx);

// The state of each of the lines: the posted voucher whose entry is not reversed, else a pending voucher proposal,
// else open.
export async function bankLineStates(ctx: QueryContext, ids: readonly string[]): Promise<Map<string, BankLineState>> {
  const states = new Map<string, BankLineState>(ids.map((id) => [id, { status: 'open' }]));
  if (ids.length === 0) return states;
  const settled = await ctx.trx
    .selectFrom('crove_finance.cash_voucher as v')
    .innerJoin('crove_finance.journal_entry as e', (join) =>
      join.onRef('e.org_id', '=', 'v.org_id').onRef('e.source_id', '=', 'v.id').on('e.source_type', '=', VOUCHER_SOURCE).on('e.reverses_entry_id', 'is', null).on(latestRevision('e')),
    )
    .leftJoin('crove_finance.journal_entry as r', (join) => join.onRef('r.org_id', '=', 'e.org_id').onRef('r.reverses_entry_id', '=', 'e.id'))
    .select(['v.id', 'v.bank_line_id', 'v.voucher_type', 'v.number'])
    .where('v.org_id', '=', ctx.orgId)
    .where('v.bank_line_id', 'in', ids)
    .where('r.id', 'is', null)
    .execute();
  const proposed = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select(['id', sql<string>`payload->>'bankLineId'`.as('line_id')])
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', VOUCHER_COMMAND)
    .where('status', '=', 'pending')
    .where(sql<string>`payload->>'bankLineId'`, 'in', ids)
    .orderBy('created_at')
    .execute();
  for (const p of proposed) states.set(p.line_id, { status: 'proposed', proposalId: p.id });
  for (const v of settled) {
    if (v.bank_line_id) states.set(v.bank_line_id, { status: 'matched', voucherId: v.id, code: voucherCode(v.voucher_type as VoucherType, v.number) });
  }
  return states;
}

export const bankLineView = (line: StoredBankLine, state: BankLineState): BankLine => ({
  id: line.id,
  date: line.date,
  description: line.description,
  amount: line.amount,
  balance: line.balance,
  reference: line.reference,
  ambiguous: line.ambiguous,
  importId: line.importId,
  state,
});

// The voucher type a line makes: a báo Có for money in, a báo Nợ for money out.
export const bankVoucherType = (amount: string): VoucherType => (new Decimal(amount).isPositive() ? 'bank_credit' : 'bank_debit');

// Refuses a voucher that does not follow its line, or a line already settled; with pendingToo, a line already
// proposed as well (asking for a voucher; posting the proposal that names it is the point). The line is read as the
// org has it; with legalEntityId, only a line of that legal entity (#1280) is found.
export async function checkBankLineVoucher(
  ctx: QueryContext,
  bankLineId: string,
  voucher: { type: VoucherType; date: string; cashAccount: string; total: string },
  options: { pendingToo: boolean; legalEntityId?: string | undefined },
): Promise<StoredBankLine> {
  const line = await findBankLine(ctx, bankLineId);
  if (!line || (options.legalEntityId !== undefined && line.legalEntityId !== options.legalEntityId)) throw new DomainError('BANK_LINE_NOT_FOUND', 422, 'Không tìm thấy dòng sao kê; hãy tải lại trang ngân hàng');
  const problems: string[] = [];
  if (voucher.type !== bankVoucherType(line.amount)) problems.push('TYPE');
  if (voucher.cashAccount !== line.bankAccount) problems.push('ACCOUNT');
  if (voucher.date !== line.date) problems.push('DATE');
  if (!new Decimal(voucher.total).equals(new Decimal(line.amount).abs())) problems.push('AMOUNT');
  if (problems.length > 0) {
    throw new DomainError(
      'BANK_LINE_MISMATCH',
      422,
      'Chứng từ phải theo dòng sao kê: cùng tài khoản ngân hàng, cùng ngày, cùng chiều tiền và đúng số tiền của dòng',
      { problems },
    );
  }
  const state = (await bankLineStates(ctx, [line.id])).get(line.id);
  if (state?.status === 'matched') {
    throw new DomainError('BANK_LINE_MATCHED', 409, `Dòng sao kê này đã có chứng từ ${state.code}`, { voucherId: state.voucherId, code: state.code });
  }
  if (options.pendingToo && state?.status === 'proposed') {
    throw new DomainError('BANK_LINE_PROPOSED', 409, 'Dòng sao kê này đã có chứng từ đang chờ duyệt', { proposalId: state.proposalId });
  }
  return line;
}

type PartyRow = { id: string; name: string; tax_code: string | null };

const readParties = (ctx: QueryContext): Promise<PartyRow[]> =>
  ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).execute();

// The voucher a line makes and the party it is probably about, given the org's parties. withBalances: false leaves out
// the open-balance reason (its query is the costliest, and only finance.bank.line_voucher shows it). Invoices and
// balances are read in the line's legal entity (#1280).
async function lineVoucherFor(
  ctx: QueryContext,
  line: StoredBankLine,
  state: BankLineState,
  parties: readonly PartyRow[],
  withBalances = true,
): Promise<BankLineVoucher> {
  const amount = new Decimal(line.amount).abs();
  const type = bankVoucherType(line.amount);
  const inflow = type === 'bank_credit';
  // Sales for money in, purchases for money out, of exactly the line's amount, not voided, issued by the line's date.
  const invoices = await ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .leftJoin('crove_finance.purchase_document_void as x', (join) => join.onRef('x.org_id', '=', 'd.org_id').onRef('x.document_id', '=', 'd.id'))
    .select(['d.party_id', 'd.invoice_series', 'd.invoice_number', 'd.total'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.legal_entity_id', '=', line.legalEntityId)
    .where('d.direction', '=', inflow ? 'sale' : 'purchase')
    .where('d.total', '=', amount.toFixed())
    .where('d.invoice_date', '<=', line.date)
    .where('x.document_id', 'is', null)
    .orderBy('d.invoice_date', 'desc')
    .limit(CANDIDATE_ROWS)
    .execute();
  // Parties whose open balance on the line's side equals the amount on the line's date: owed to the org on 131 for
  // money in, owed by the org on 331 for money out.
  const side = inflow ? sql<string>`pg_catalog.sum(l.debit) - pg_catalog.sum(l.credit)` : sql<string>`pg_catalog.sum(l.credit) - pg_catalog.sum(l.debit)`;
  const balances = !withBalances
    ? []
    : await ctx.trx
        .selectFrom('crove_finance.journal_line as l')
        .innerJoin('crove_finance.journal_entry as e', (join) => join.onRef('e.org_id', '=', 'l.org_id').onRef('e.id', '=', 'l.entry_id'))
        .select(['l.party_id', side.as('balance')])
        .where('l.org_id', '=', ctx.orgId)
        .where('l.legal_entity_id', '=', line.legalEntityId)
        .where('l.party_id', 'is not', null)
        .where('l.account_code', 'like', inflow ? '131%' : '331%')
        .where('e.entry_date', '<=', line.date)
        .groupBy('l.party_id')
        .having(side, '=', amount.toFixed())
        .limit(CANDIDATE_ROWS)
        .execute();

  const match = matchLine(
    { description: line.description, amount: line.amount },
    parties.map((p) => ({ id: p.id, name: p.name, taxCode: p.tax_code })),
    invoices.map((i) => ({ partyId: i.party_id, series: i.invoice_series, number: i.invoice_number, total: i.total })),
    balances.flatMap((b) => (b.party_id ? [{ partyId: b.party_id, balance: b.balance }] : [])),
  );
  const byId = new Map(parties.map((p) => [p.id, p]));
  const view = (c: MatchCandidate): BankLineCandidate[] => {
    const party = byId.get(c.partyId);
    if (!party) return [];
    return [{ party: { id: party.id, name: party.name, taxCode: party.tax_code }, reason: c.reason, ...(c.invoice ? { invoice: c.invoice } : {}) }];
  };
  const description = line.description.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX).trim();
  return {
    bankAccount: line.bankAccount,
    line: bankLineView(line, state),
    // A voucher holds whole dong, at most 15 digits; a line with fractions of a dong (a foreign currency account) makes
    // none.
    voucher:
      amount.isInteger() && amount.lessThan('1e15')
        ? {
            type,
            date: line.date,
            amount: amount.toFixed(0),
            description: description || (inflow ? 'Thu tiền qua ngân hàng' : 'Chi tiền qua ngân hàng'),
            counterAccount: defaultCounterAccount(type),
          }
        : null,
    suggested: match.suggested ? (view(match.suggested)[0] ?? null) : null,
    candidates: match.candidates.flatMap(view),
  };
}

// The voucher a line makes and the party it is probably about, for the voucher form. Reads only; the user confirms the
// party when entering the voucher, and an approver checks it again.
export const bankLineVoucher = defineQuery({
  name: 'finance.bank.line_voucher',
  input: z.object({ bankLineId: zId }),
  access: REQUESTERS,
  handler: async (ctx, input): Promise<BankLineVoucher> => {
    const line = await findBankLine(ctx, input.bankLineId);
    if (!line) throw new DomainError('BANK_LINE_NOT_FOUND', 404, 'Không tìm thấy dòng sao kê; hãy tải lại trang ngân hàng');
    const state = (await bankLineStates(ctx, [line.id])).get(line.id) ?? { status: 'open' };
    return lineVoucherFor(ctx, line, state, await readParties(ctx));
  },
});

// The open lines of an account and period whose party stands out by a strong reason (its tax code, or an invoice of the
// amount, named in the description), with the voucher each makes (stage 2b): the bank screen offers to ask for all of
// them at once, each through kernel.proposal.request as a user would. At most BANK_SUGGESTIONS_MAX lines are read.
export const bankSuggestions = defineQuery({
  name: 'finance.bank.suggestions',
  input: z.object({ bankAccount: zAccountCode, period: zLedgerPeriod, legalEntityId: zId.optional() }),
  access: REQUESTERS,
  handler: async (ctx, input): Promise<BankLineVoucher[]> => {
    const period = ledgerPeriod(input.period);
    // The lines of one legal entity (#1280).
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const ids = await ctx.trx
      .selectFrom('crove_finance.bank_line')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('bank_account', '=', input.bankAccount)
      .where('value_date', '>=', period.from)
      .where('value_date', '<=', period.to)
      .orderBy('value_date')
      .orderBy('import_id')
      .orderBy('position')
      .limit(BANK_SUGGESTIONS_MAX)
      .execute();
    const states = await bankLineStates(ctx, ids.map((r) => r.id));
    const open = await findBankLines(ctx, ids.filter((r) => states.get(r.id)?.status === 'open').map((r) => r.id));
    const byId = new Map(open.map((l) => [l.id, l]));
    const parties = await readParties(ctx);
    const out: BankLineVoucher[] = [];
    // In statement order. The open-balance reason is never strong, so its query is skipped: a tie it would add sits
    // below the strong reason that decides.
    for (const { id } of ids) {
      const line = byId.get(id);
      if (!line) continue;
      const made = await lineVoucherFor(ctx, line, { status: 'open' }, parties, false);
      if (made.voucher && made.suggested && STRONG_REASONS.includes(made.suggested.reason)) out.push(made);
    }
    return out;
  },
});

// The open lines of each bank account (no voucher, no pending voucher proposal): how many, how many flagged as
// ambiguous at import, and the oldest one's date. The Inbox lists them as statement lines to resolve (stage 2b). The
// lines of one legal entity (#1280).
export const bankOpenLines = defineQuery({
  name: 'finance.bank.open_lines',
  input: z.object({ legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<BankOpenLines> => {
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_line as l')
      .select([
        'l.bank_account',
        sql<string>`pg_catalog.count(*)`.as('open'),
        sql<string>`pg_catalog.count(*) FILTER (WHERE l.ambiguous)`.as('ambiguous'),
        sql<string>`pg_catalog.to_char(pg_catalog.min(l.value_date), 'YYYY-MM-DD')`.as('oldest'),
      ])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.legal_entity_id', '=', legalEntityId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('crove_finance.cash_voucher as v')
              .innerJoin('crove_finance.journal_entry as e', (join) =>
                join.onRef('e.org_id', '=', 'v.org_id').onRef('e.source_id', '=', 'v.id').on('e.source_type', '=', VOUCHER_SOURCE).on('e.reverses_entry_id', 'is', null).on(latestRevision('e')),
              )
              .select('v.id')
              .whereRef('v.org_id', '=', 'l.org_id')
              .whereRef('v.bank_line_id', '=', 'l.id')
              .where(({ not, exists, selectFrom }) =>
                not(exists(selectFrom('crove_finance.journal_entry as r').select('r.id').whereRef('r.org_id', '=', 'e.org_id').whereRef('r.reverses_entry_id', '=', 'e.id'))),
              ),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('crove_kernel.proposal as p')
              .select('p.id')
              .whereRef('p.org_id', '=', 'l.org_id')
              .where('p.command', '=', VOUCHER_COMMAND)
              .where('p.status', '=', 'pending')
              .where(sql`p.payload->>'bankLineId'`, '=', sql`l.id::text`),
          ),
        ),
      )
      .groupBy('l.bank_account')
      .orderBy('l.bank_account')
      .execute();
    return {
      accounts: rows.map((r) => ({ bankAccount: r.bank_account, open: Number(r.open), ambiguous: Number(r.ambiguous), oldest: r.oldest })),
    };
  },
});
