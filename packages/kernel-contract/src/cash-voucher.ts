// Cash and bank vouchers (issue #327): phiếu thu, phiếu chi, giấy báo Có and giấy báo Nợ. A user enters one by hand
// (or, later, a matched bank statement line proposes one, #326); it becomes a proposal that an owner or admin approves
// like any posting (R3, four-eyes, fresh MFA), and approving it numbers the voucher and posts its journal entry. The
// finance module decides every rule; the shapes here are shared with the SPA.
import { z } from 'zod';
import { VOUCHER_MAX_LINES, zAccountCode, zId, zLocalDate, zVoucherLine, zVoucherType, type VoucherType } from './schemas.ts';

// The proposal kind and the command its approval runs.
export const VOUCHER_KIND = 'finance.cash_voucher';
export const VOUCHER_COMMAND = 'finance.voucher.record';

// What a user enters (kernel.proposal.request with command finance.voucher.record).
export const zCashVoucherRequest = z.object({
  type: zVoucherType,
  // Ngày chứng từ: the voucher and its journal entry are dated on it.
  date: zLocalDate,
  // The cash box (111, 1111 or a sub-account) or bank account (112, 1121, 1121.VCB ...) the money moves through.
  cashAccount: zAccountCode,
  // The customer, vendor or other party; required when a line settles 131 or 331.
  partyId: zId.nullable().optional(),
  // Người nộp tiền / người nhận tiền as written on the voucher.
  personName: z.string().trim().max(200).optional(),
  // Lý do thu / lý do chi.
  description: z.string().trim().min(1).max(300),
  lines: z.array(zVoucherLine).min(1).max(VOUCHER_MAX_LINES),
});
export type CashVoucherRequest = z.infer<typeof zCashVoucherRequest>;

// Prefixes of the voucher numbers, as Vietnamese firms write them: PT00001, PC00001, BC00001, BN00001.
export const VOUCHER_PREFIXES: Record<VoucherType, string> = { cash_receipt: 'PT', cash_payment: 'PC', bank_credit: 'BC', bank_debit: 'BN' };

export function voucherCode(type: VoucherType, number: number): string {
  return `${VOUCHER_PREFIXES[type]}${String(number).padStart(5, '0')}`;
}

// Money in (receipts and bank credits: the cash or bank account is debited) or out (payments and bank debits).
export function isInflow(type: VoucherType): boolean {
  return type === 'cash_receipt' || type === 'bank_credit';
}

// The TT133 account the voucher's cash account must be or roll up to: 111 for cash, 112 for bank.
export function cashRootOf(type: VoucherType): '111' | '112' {
  return type === 'cash_receipt' || type === 'cash_payment' ? '111' : '112';
}

// The line account proposed first: a receipt usually collects a customer's debt (131), a payment settles a vendor's
// (331).
export function defaultCounterAccount(type: VoucherType): '131' | '331' {
  return isInflow(type) ? '131' : '331';
}

// Accounts whose lines must name the party: receivables and payables are kept per party (TT133 sổ chi tiết 131, 331).
export const PARTY_ACCOUNTS: readonly string[] = ['131', '331'];

// Every account code starts with its TT133 level-1 account (sub-account codes extend their parent's), so the first
// three characters tell which one it rolls up to.
export function levelOneAccount(code: string): string {
  return code.slice(0, 3);
}

export function needsParty(account: string): boolean {
  return PARTY_ACCOUNTS.includes(levelOneAccount(account));
}

// One voucher as the vouchers screen lists it.
export const zCashVoucherView = z.object({
  id: zId,
  type: zVoucherType,
  number: z.number().int().positive(),
  // PT00001 and the like.
  code: z.string(),
  date: zLocalDate,
  cashAccount: z.string(),
  party: z.object({ id: zId, name: z.string(), taxCode: z.string().nullable() }).nullable(),
  personName: z.string().nullable(),
  description: z.string(),
  amount: z.string(),
  journalEntryId: zId.nullable(),
  // The reversal of the voucher's entry, once it is reversed: the voucher no longer counts, its number stays used.
  reversal: z.object({ id: zId, entryDate: zLocalDate }).nullable(),
  proposalId: zId.nullable(),
});
export type CashVoucherView = z.infer<typeof zCashVoucherView>;
