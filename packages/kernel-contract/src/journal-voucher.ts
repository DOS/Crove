// General journal vouchers (issue #888): phiếu kế toán khác, NVK. A user enters a balanced entry by hand (an accrual,
// salaries, depreciation, a reclassification): a date, a reason and two or more lines, each on one account, debit or
// credit, with a party where the account is kept per party. It becomes a proposal that an owner or admin approves like
// any posting (R3, four-eyes, fresh MFA), and approving it numbers the voucher (NVK00001 ...) and posts its journal
// entry. The finance module decides every rule; the shapes here are shared with the SPA.
import { z } from 'zod';
import { JOURNAL_VOUCHER_MAX_LINES, zAccountCode, zId, zJournalAmount, zJournalVoucherProposal, zLocalDate } from './schemas.ts';

// The proposal kind and the command its approval runs.
export const JOURNAL_VOUCHER_KIND = 'finance.journal_voucher';
export const JOURNAL_VOUCHER_COMMAND = 'finance.journal_voucher.record';

// One line as entered: exactly one of debit and credit is above zero (the module checks it).
export const zJournalVoucherLineRequest = z.object({
  account: zAccountCode,
  // The customer, vendor or other party; required on the accounts kept per party (131, 331).
  partyId: zId.nullable().optional(),
  debit: zJournalAmount,
  credit: zJournalAmount,
  // Diễn giải of the line; the voucher's reason when empty.
  memo: z.string().trim().max(300).optional(),
});
export type JournalVoucherLineRequest = z.infer<typeof zJournalVoucherLineRequest>;

// What a user enters (kernel.proposal.request with command finance.journal_voucher.record).
export const zJournalVoucherRequest = z.object({
  // Ngày chứng từ: the voucher and its journal entry are dated on it.
  date: zLocalDate,
  // Diễn giải of the voucher.
  description: z.string().trim().min(1).max(300),
  lines: z.array(zJournalVoucherLineRequest).min(2).max(JOURNAL_VOUCHER_MAX_LINES),
});
export type JournalVoucherRequest = z.infer<typeof zJournalVoucherRequest>;

// NVK00001 and the like.
export function journalVoucherCode(number: number): string {
  return `NVK${String(number).padStart(5, '0')}`;
}

// Year-end closing (issue #889), kết chuyển: classes 5 to 8 to 911, then the year's result to 4212, as a general
// journal voucher dated the year's last day. A user names the year; the server builds every line from the ledger.
export const YEAR_CLOSING_COMMAND = 'finance.closing.record';
export const zYearClosingRequest = z.object({ year: z.number().int().min(2000).max(2100) });
export type YearClosingRequest = z.infer<typeof zYearClosingRequest>;
// The proposal (kind finance.journal_voucher, shown as one) with the year it closes.
export const zYearClosingProposal = zJournalVoucherProposal.extend({ closingYear: zYearClosingRequest.shape.year });
export type YearClosingProposal = z.infer<typeof zYearClosingProposal>;
