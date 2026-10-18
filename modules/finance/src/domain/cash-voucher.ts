// Cash and bank vouchers (issue #327) as pure functions: the problems of a voucher and its TT133 journal entry.
//   phiếu thu   (cash_receipt): Dr 111x  total, Cr each line
//   phiếu chi   (cash_payment): Dr each line,   Cr 111x total
//   giấy báo Có (bank_credit):  Dr 112x  total, Cr each line
//   giấy báo Nợ (bank_debit):   Dr each line,   Cr 112x total
// A line settles a customer's debt (131), a vendor's (331), an expense (6422), an advance (141) and so on; lines on 131
// and 331 name the voucher's party, so receivables and payables per party (sổ chi tiết 131, 331) follow the payments.
import {
  cashRootOf,
  isInflow,
  levelOneAccount,
  needsParty,
  type CashVoucherProposal,
  type VoucherLine,
  type VoucherType,
} from '@crove/kernel-contract';
import { money, sum, toMoney, type JournalLineDraft } from '@crove/l10n-vn';

export const VOUCHER_SOURCE = 'finance.cash_voucher';

// The voucher's name in Vietnamese, for titles, memos and messages.
export const VOUCHER_LABELS: Record<VoucherType, string> = {
  cash_receipt: 'Phiếu thu',
  cash_payment: 'Phiếu chi',
  bank_credit: 'Giấy báo Có',
  bank_debit: 'Giấy báo Nợ',
};

export type VoucherProblem =
  // The cash or bank account is not 111 (cash vouchers) or 112 (bank vouchers), or under it.
  | 'CASH_ACCOUNT_TYPE'
  // A line posts to the voucher's own cash or bank account.
  | 'LINE_IS_CASH_ACCOUNT'
  // A line settles 131 or 331 and the voucher names no party.
  | 'PARTY_REQUIRED'
  // The total does not fit the money columns.
  | 'TOTAL_TOO_LARGE';

// At most 15 integer digits, so the total fits numeric(20, 4) with room to spare.
const MAX_TOTAL = '999999999999999';

export function voucherTotal(lines: readonly Pick<VoucherLine, 'amount'>[]): string {
  return toMoney(sum(lines.map((l) => l.amount)));
}

// The problems of a voucher, in a fixed order, before any account is looked up.
export function voucherProblems(voucher: { type: VoucherType; cashAccount: string; partyId: string | null; lines: readonly VoucherLine[] }): VoucherProblem[] {
  const problems: VoucherProblem[] = [];
  if (levelOneAccount(voucher.cashAccount) !== cashRootOf(voucher.type)) problems.push('CASH_ACCOUNT_TYPE');
  if (voucher.lines.some((l) => l.account === voucher.cashAccount)) problems.push('LINE_IS_CASH_ACCOUNT');
  if (voucher.partyId === null && voucher.lines.some((l) => needsParty(l.account))) problems.push('PARTY_REQUIRED');
  if (money(voucherTotal(voucher.lines)).greaterThan(MAX_TOTAL)) problems.push('TOTAL_TOO_LARGE');
  return problems;
}

// The voucher's line memo: its own, or the voucher's reason.
function lineMemo(line: VoucherLine, description: string): string {
  return line.memo?.trim() || description;
}

// The journal of a voucher. The cash or bank line carries the total; each voucher line is its own journal line, in the
// order entered, so a voucher settling two invoices of one vendor shows both. Money in is written debit first (the
// cash line), money out debit first too (the lines, then the cash line), as accountants write them.
export function buildVoucherJournal(voucher: Pick<CashVoucherProposal, 'type' | 'cashAccount' | 'lines' | 'description'>): JournalLineDraft[] {
  const total = voucherTotal(voucher.lines);
  const cash = { accountCode: voucher.cashAccount, memo: voucher.description };
  const lines: Array<Omit<JournalLineDraft, 'lineNo'>> = isInflow(voucher.type)
    ? [
        { ...cash, debit: total, credit: '0' },
        ...voucher.lines.map((l) => ({ accountCode: l.account, debit: '0', credit: toMoney(money(l.amount)), memo: lineMemo(l, voucher.description) })),
      ]
    : [
        ...voucher.lines.map((l) => ({ accountCode: l.account, debit: toMoney(money(l.amount)), credit: '0', memo: lineMemo(l, voucher.description) })),
        { ...cash, debit: '0', credit: total },
      ];
  return lines.map((l, i) => ({ lineNo: i + 1, ...l }));
}

// The journal entry's description: the voucher's code and reason, and the party when there is one.
export function voucherEntryDescription(code: string, voucher: { description: string; party: { name: string } | null }): string {
  const party = voucher.party ? ` (${voucher.party.name})` : '';
  return `${code} ${voucher.description}${party}`.slice(0, 500);
}

// The proposal title the Inbox shows: "Phiếu chi 1.500.000 đ: Trả tiền hàng (Công ty ABC)". The amount is grouped by
// dots, as Vietnamese amounts are written; no number yet (it is given when the proposal is approved).
export function voucherTitle(voucher: Pick<CashVoucherProposal, 'type' | 'total' | 'description'> & { party: { name: string } | null }): string {
  const amount = voucher.total.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const party = voucher.party ? ` (${voucher.party.name})` : '';
  return `${VOUCHER_LABELS[voucher.type]} ${amount} đ: ${voucher.description}${party}`.slice(0, 300);
}
