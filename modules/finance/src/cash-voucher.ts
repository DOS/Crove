// Cash and bank vouchers (issue #327): phiếu thu, phiếu chi, giấy báo Có, giấy báo Nợ. A voucher is a posting, so it
// follows the rules of every posting (plan §4.7: R3, P10 four-eyes, P11 fresh MFA, P12 eligible approvers):
// - finance.voucher.prepare: a user enters a voucher through kernel.proposal.request, which runs this to check it and
//   build the proposal (the party as found, the total). It writes nothing. Owners, admins and members may ask.
// - finance.voucher.record: runs only through kernel.proposal.approve, on the stored payload. It checks everything
//   again, inserts the voucher (the database numbers it per org and type, PT00001, PC00001 ...) and, in the same
//   transaction, posts its journal entry through the posting path, linked by source_type 'finance.cash_voucher'.
//   The database checks at commit (a deferred constraint trigger, 20261019270000) that the voucher has such an entry,
//   dated the voucher's date, that moves its cash account by its amount; it refuses the voucher otherwise. That check
//   only asks for the entry to exist by commit, not to be written in the same transaction (its error message says
//   more than it checks; applied migrations are never edited). The entry is this transaction's because this command
//   writes it right after the insert, for a voucher id the database has just generated.
// - finance.vouchers.list: the posted vouchers, page by page, with their reversal when their entry was reversed.
// A voucher is corrected by reversing its entry (finance.journal.reverse); it keeps its number and shows as reversed.
// A bank voucher may be made from a bank statement line (#326, bank-match.ts): it then names the line (bankLineId),
// follows it (account, date, direction, amount) and settles it; both commands check that, and the database holds it.
import { z } from 'zod';
import { sql } from 'kysely';
import {
  VOUCHER_COMMAND,
  VOUCHER_KIND,
  VOUCHER_PAGE_SIZE,
  voucherCode,
  zCashVoucherProposal,
  zCashVoucherRequest,
  zLocalDate,
  zVoucherCursor,
  zVoucherType,
  type CashVoucherPage,
  type CashVoucherProposal,
  type VoucherType,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { journalIsBalanced } from '@crove/l10n-vn';
import { assertUsableAccounts } from './accounts.ts';
import { checkBankLineVoucher, lockBankLine } from './bank-match.ts';
import {
  VOUCHER_LABELS,
  VOUCHER_SOURCE,
  buildVoucherJournal,
  voucherEntryDescription,
  voucherProblems,
  voucherTitle,
  voucherTotal,
  type VoucherProblem,
} from './domain/cash-voucher.ts';
import { postJournalEntry } from './ledger.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const PROBLEM_MESSAGES: Record<VoucherProblem, (type: VoucherType) => string> = {
  CASH_ACCOUNT_TYPE: (type) =>
    type === 'cash_receipt' || type === 'cash_payment'
      ? `${VOUCHER_LABELS[type]} thu chi qua quỹ tiền mặt: hãy chọn tài khoản 111 hoặc tài khoản con của 111`
      : `${VOUCHER_LABELS[type]} thu chi qua ngân hàng: hãy chọn tài khoản 112 hoặc tài khoản con của 112`,
  LINE_IS_CASH_ACCOUNT: () => 'Tài khoản đối ứng không được trùng tài khoản tiền của chứng từ',
  PARTY_REQUIRED: () => 'Dòng hạch toán vào 131 hoặc 331 cần chọn đối tượng (khách hàng hoặc nhà cung cấp)',
  TOTAL_TOO_LARGE: () => 'Tổng số tiền vượt quá giới hạn cho phép',
};

function refuseProblems(type: VoucherType, problems: VoucherProblem[]): void {
  const first = problems[0];
  if (first) throw new DomainError('VOUCHER_INVALID', 422, PROBLEM_MESSAGES[first](type), { problems });
}

// The party as stored, or a refusal. Read FOR SHARE when posting, so it stays as read until commit.
async function findParty(ctx: QueryContext, partyId: string, lock: boolean) {
  let query = ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', '=', partyId);
  if (lock) query = query.forShare();
  const party = await query.executeTakeFirst();
  if (!party) throw new DomainError('PARTY_NOT_FOUND', 422, 'Không tìm thấy đối tượng đã chọn; hãy chọn lại');
  return party;
}

// Every check of a voucher, when it is asked for and again when it is posted: its shape, its accounts (in the org's
// chart and in use) and its party.
async function checkVoucher(ctx: QueryContext, voucher: { type: VoucherType; cashAccount: string; partyId: string | null; lines: CashVoucherProposal['lines'] }) {
  refuseProblems(voucher.type, voucherProblems(voucher));
  await assertUsableAccounts(ctx, [voucher.cashAccount, ...voucher.lines.map((l) => l.account)]);
}

export const prepareVoucher = defineCommand({
  name: 'finance.voucher.prepare',
  input: zCashVoucherRequest,
  risk: 'R1',
  access: REQUESTERS,
  handler: async (ctx, input) => {
    const partyId = input.partyId ?? null;
    await checkVoucher(ctx, { type: input.type, cashAccount: input.cashAccount, partyId, lines: input.lines });
    if (input.bankLineId) {
      // One voucher proposal per line at a time: a second request for the line waits here for the first to commit,
      // then sees its proposal.
      await lockBankLine(ctx, input.bankLineId);
      const voucher = { type: input.type, date: input.date, cashAccount: input.cashAccount, total: voucherTotal(input.lines) };
      await checkBankLineVoucher(ctx, input.bankLineId, voucher, { pendingToo: true });
    }
    const party = partyId ? await findParty(ctx, partyId, false) : null;
    const built: CashVoucherProposal = {
      type: input.type,
      date: input.date,
      cashAccount: input.cashAccount,
      party: party ? { id: party.id, name: party.name, taxCode: party.tax_code } : null,
      personName: input.personName?.trim() || null,
      description: input.description.trim(),
      lines: input.lines.map((l) => ({ account: l.account, amount: l.amount, ...(l.memo?.trim() ? { memo: l.memo.trim() } : {}) })),
      total: voucherTotal(input.lines),
      ...(input.bankLineId ? { bankLineId: input.bankLineId } : {}),
    };
    // The payload is stored as the proposal and parsed again with this schema when it is approved
    // (finance.voucher.record). A payload the schema refuses (a party whose stored name or tax code is longer than a
    // voucher holds, say) could never be approved, and would abort every bulk approval it is part of, so it is refused
    // now, while the user is still on the form.
    const parsed = zCashVoucherProposal.safeParse(built);
    if (!parsed.success) {
      throw new DomainError('VOUCHER_INVALID', 422, 'Không lập được chứng từ từ dữ liệu này; hãy kiểm tra lại đối tượng và các dòng hạch toán', {
        problems: ['PROPOSAL_INVALID'],
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
      });
    }
    const payload = parsed.data;
    return { kind: VOUCHER_KIND, command: VOUCHER_COMMAND, title: voucherTitle(payload), payload };
  },
});

export const recordVoucher = defineCommand({
  name: VOUCHER_COMMAND,
  input: z.object({ payload: zCashVoucherProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  access: 'proposal',
  proposalKind: VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const partyId = payload.party?.id ?? null;
    // The stored payload is checked as if new: a sub-account deactivated or a party gone since it was asked for is
    // refused here. The total is the lines' sum, never taken from the payload as is.
    await checkVoucher(ctx, { type: payload.type, cashAccount: payload.cashAccount, partyId, lines: payload.lines });
    const total = voucherTotal(payload.lines);
    if (total !== payload.total) throw new DomainError('VOUCHER_INVALID', 422, 'Tổng số tiền không khớp các dòng của chứng từ', { problems: ['TOTAL_MISMATCH'] });
    // The line it settles is checked again: another voucher may have settled it since the proposal was made. The
    // database checks it once more under the line's lock when the voucher is inserted.
    if (payload.bankLineId) {
      await checkBankLineVoucher(ctx, payload.bankLineId, { type: payload.type, date: payload.date, cashAccount: payload.cashAccount, total }, { pendingToo: false });
    }
    const party = partyId ? await findParty(ctx, partyId, true) : null;
    const journal = buildVoucherJournal(payload);
    if (!journalIsBalanced(journal)) throw new DomainError('UNBALANCED', 422, 'Bút toán không cân');

    const voucher = await ctx.trx
      .insertInto('crove_finance.cash_voucher')
      .values({
        org_id: ctx.orgId,
        voucher_type: payload.type,
        voucher_date: payload.date,
        cash_account: payload.cashAccount,
        party_id: party?.id ?? null,
        person_name: payload.personName,
        description: payload.description,
        amount: total,
        proposal_id: ctx.proposalId,
        bank_line_id: payload.bankLineId ?? null,
        created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning(['id', 'number'])
      .executeTakeFirstOrThrow()
      .catch((error: { code?: string; message?: string }) => {
        // A voucher of the same line committed between the check above and this insert (the database's check waits for
        // it under the line's lock, then sees it).
        if (error?.code === '23505' && /is already settled by another cash voucher/.test(error.message ?? '')) {
          throw new DomainError('BANK_LINE_MATCHED', 409, 'Dòng sao kê này vừa được ghi chứng từ khác; hãy tải lại trang ngân hàng');
        }
        throw error;
      });
    const code = voucherCode(payload.type, voucher.number);
    // The party as it is now (its name may have changed since the voucher was asked for).
    const described = { description: payload.description, party: party ? { name: party.name } : null };
    const journalEntryId = await postJournalEntry(ctx, {
      entryDate: payload.date,
      description: voucherEntryDescription(code, described),
      sourceType: VOUCHER_SOURCE,
      sourceId: voucher.id,
      lines: journal.map((j) => ({
        lineNo: j.lineNo,
        accountCode: j.accountCode,
        debit: j.debit,
        credit: j.credit,
        // Every line but the cash line names the party, so 131 and 331 per party (and an advance per employee on 141)
        // follow the voucher.
        partyId: party && j.accountCode !== payload.cashAccount ? party.id : null,
        memo: j.memo,
      })),
    });
    ctx.audit({ voucher_type: payload.type, number: voucher.number, amount: total, lines: payload.lines.length });
    await ctx.activity('finance.cash_voucher', voucher.id, 'voucher.recorded', `Ghi sổ ${VOUCHER_LABELS[payload.type].toLowerCase()} ${code}: ${payload.description}`);
    await ctx.emit('finance.voucher.recorded', { voucherId: voucher.id, journalEntryId, type: payload.type, number: voucher.number });
    return { voucherId: voucher.id, journalEntryId, code };
  },
});

// The posted vouchers of a date range, newest first (by date, then by id: ids are time-ordered, so the newest voucher of
// a day comes first), with the entry that posted each and its reversal, if any. One page holds at most
// VOUCHER_PAGE_SIZE vouchers; before names the last voucher of the previous page, and more says whether older ones
// follow. A voucher has at most one entry and that entry at most one reversal, so each voucher is one row.
export const vouchersList = defineQuery({
  name: 'finance.vouchers.list',
  input: z.object({ from: zLocalDate.optional(), to: zLocalDate.optional(), type: zVoucherType.optional(), before: zVoucherCursor.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<CashVoucherPage> => {
    let query = ctx.trx
      .selectFrom('crove_finance.cash_voucher as v')
      .leftJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'v.org_id').onRef('p.id', '=', 'v.party_id'))
      .leftJoin('crove_finance.journal_entry as j', (join) =>
        join.onRef('j.org_id', '=', 'v.org_id').onRef('j.source_id', '=', 'v.id').on('j.source_type', '=', VOUCHER_SOURCE).on('j.reverses_entry_id', 'is', null),
      )
      .leftJoin('crove_finance.journal_entry as r', (join) => join.onRef('r.org_id', '=', 'j.org_id').onRef('r.reverses_entry_id', '=', 'j.id'))
      .select([
        'v.id',
        'v.voucher_type',
        'v.number',
        'v.voucher_date',
        'v.cash_account',
        'v.party_id',
        'p.name as party_name',
        'p.tax_code as party_tax_code',
        'v.person_name',
        'v.description',
        'v.amount',
        'v.proposal_id',
        'j.id as entry_id',
        'r.id as reversal_id',
        'r.entry_date as reversal_date',
      ])
      .where('v.org_id', '=', ctx.orgId)
      .orderBy('v.voucher_date', 'desc')
      .orderBy('v.id', 'desc')
      // One more than a page, to tell whether another page follows.
      .limit(VOUCHER_PAGE_SIZE + 1);
    if (input.from) query = query.where('v.voucher_date', '>=', input.from);
    if (input.to) query = query.where('v.voucher_date', '<=', input.to);
    if (input.type) query = query.where('v.voucher_type', '=', input.type);
    if (input.before) query = query.where(sql<boolean>`(v.voucher_date, v.id) < (${input.before.date}::date, ${input.before.id}::uuid)`);
    const rows = await query.execute();
    const items = rows.slice(0, VOUCHER_PAGE_SIZE).map((r) => ({
      id: r.id,
      type: r.voucher_type,
      number: r.number,
      code: voucherCode(r.voucher_type, r.number),
      date: r.voucher_date,
      cashAccount: r.cash_account,
      party: r.party_id && r.party_name !== null ? { id: r.party_id, name: r.party_name, taxCode: r.party_tax_code } : null,
      personName: r.person_name,
      description: r.description,
      amount: r.amount,
      journalEntryId: r.entry_id,
      reversal: r.reversal_id && r.reversal_date ? { id: r.reversal_id, entryDate: r.reversal_date } : null,
      proposalId: r.proposal_id,
    }));
    return { items, more: rows.length > VOUCHER_PAGE_SIZE };
  },
});

