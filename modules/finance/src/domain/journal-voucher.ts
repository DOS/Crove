// General journal vouchers (issue #888) as pure functions: the problems of a voucher, its total and its TT133 journal
// entry. Each voucher line is one journal line, in the order entered, debit or credit as entered; lines on the accounts
// kept per party (131, 331) name their party, so receivables and payables per party follow the voucher.
import { needsParty, type JournalVoucherProposal } from '@crove/kernel-contract';
import { money, sum, toMoney, type JournalLineDraft } from '@crove/l10n-vn';

export const JOURNAL_VOUCHER_SOURCE = 'finance.journal_voucher';
export const JOURNAL_VOUCHER_LABEL = 'Phiếu kế toán';

export type JournalVoucherProblem =
  // A line with both a debit and a credit, or neither.
  | 'LINE_SIDE'
  // The debits and the credits differ.
  | 'UNBALANCED'
  // A line on 131 or 331 names no party.
  | 'PARTY_REQUIRED'
  // The total does not fit the money columns.
  | 'TOTAL_TOO_LARGE';

// At most 15 integer digits, so the total fits numeric(20, 4) with room to spare.
const MAX_TOTAL = '999999999999999';

interface Line {
  account: string;
  debit: string;
  credit: string;
}

const positive = (amount: string) => /[1-9]/.test(amount);

// The sum of the debits (equal to the credits once balanced).
export function journalVoucherTotal(lines: readonly Pick<Line, 'debit'>[]): string {
  return toMoney(sum(lines.map((l) => l.debit)));
}

// The problems of a voucher, in a fixed order, before any account or party is looked up.
export function journalVoucherProblems(lines: readonly (Line & { partyId: string | null })[]): JournalVoucherProblem[] {
  const problems: JournalVoucherProblem[] = [];
  if (lines.some((l) => positive(l.debit) === positive(l.credit))) problems.push('LINE_SIDE');
  if (!money(journalVoucherTotal(lines)).equals(money(toMoney(sum(lines.map((l) => l.credit)))))) problems.push('UNBALANCED');
  if (lines.some((l) => l.partyId === null && needsParty(l.account))) problems.push('PARTY_REQUIRED');
  if (money(journalVoucherTotal(lines)).greaterThan(MAX_TOTAL)) problems.push('TOTAL_TOO_LARGE');
  return problems;
}

export function buildJournalVoucherJournal(voucher: Pick<JournalVoucherProposal, 'lines' | 'description'>): JournalLineDraft[] {
  return voucher.lines.map((l, i) => ({
    lineNo: i + 1,
    accountCode: l.account,
    debit: toMoney(money(l.debit)),
    credit: toMoney(money(l.credit)),
    memo: l.memo?.trim() || voucher.description,
  }));
}

// The journal entry's description: the voucher's code and reason.
export function journalVoucherEntryDescription(code: string, description: string): string {
  return `${code} ${description}`.slice(0, 500);
}

// The proposal title the Inbox shows: "Phiếu kế toán 12.000.000 đ: Trích trước lương tháng 10". No number yet (it is
// given when the proposal is approved).
export function journalVoucherTitle(voucher: Pick<JournalVoucherProposal, 'total' | 'description'>): string {
  const amount = voucher.total.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${JOURNAL_VOUCHER_LABEL} ${amount} đ: ${voucher.description}`.slice(0, 300);
}
