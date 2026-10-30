// Cash and bank vouchers on screen (issue #327): entering a phiếu thu, phiếu chi, báo Có or báo Nợ, and showing one in
// the Inbox. The kernel checks every rule again (finance.voucher.prepare, then finance.voucher.record when approved);
// these helpers only keep the form from sending what it will refuse and preview the entry the approval posts.
import {
  cashRootOf,
  isCalendarDate,
  isInflow,
  needsParty,
  VOUCHER_MAX_LINES,
  VOUCHER_TYPES,
  type CashVoucherPage,
  type VoucherCursor,
  type VoucherType,
} from '@crove/kernel-contract';
import { z } from 'zod';
import type { ChartAccount } from './accounts.ts';
import { readSearch, type Defined } from './search.ts';
import type { Translate } from '../i18n/runtime.ts';

export { VOUCHER_KIND } from '@crove/kernel-contract';

// The roles that may enter a voucher (kernel.proposal.request); approving needs owner or admin.
const REQUESTERS = ['owner', 'admin', 'member'];

export function canEnterVoucher(role: string | null | undefined): boolean {
  return Boolean(role && REQUESTERS.includes(role));
}

// An amount as typed, as the digits the API takes: "1.500.000", "1 500 000" and "1,500,000" are 1500000. Only plain
// digits or digits grouped by three with one kind of separator are read; anything else (letters, a sign, a decimal
// part such as "12.34" or "1,5", or a misplaced separator) is returned as typed, so the form refuses it. Stripping
// every separator first read "12.34" as 1234 (#1391 review).
const GROUPED = /^(?:\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+)$/;
export function normalizeAmount(text: string): string {
  const value = text.trim().replace(/\s+/g, ' ');
  if (!/^\d+$/.test(value) && !GROUPED.test(value)) return text.trim();
  return value.replace(/[ .,]/g, '').replace(/^0+(?=\d)/, '');
}

const WHOLE = /^\d{1,15}$/;

export function isVoucherAmount(value: string): boolean {
  return WHOLE.test(value) && /[1-9]/.test(value);
}

// The cash or bank accounts a voucher of this type may move: 111 or 112 and their sub-accounts that are in use.
export function cashAccountChoices(accounts: readonly ChartAccount[], type: VoucherType): ChartAccount[] {
  const root = cashRootOf(type);
  return accounts.filter((a) => a.active && a.code.startsWith(root));
}

export interface VoucherForm {
  type: VoucherType;
  date: string;
  cashAccount: string;
  partyId: string;
  description: string;
  lines: Array<{ account: string; amount: string }>;
}

// The first problem with the form, or null when it can be sent.
export function voucherFormError(form: VoucherForm, t: Translate): string | null {
  const fields: VoucherField[] = ['date', 'cashAccount', 'description', 'lines', ...form.lines.map((_, i) => i), 'party'];
  for (const field of fields) {
    const error = voucherFieldError(form, field, t);
    if (error) return error;
  }
  return null;
}

// A field of the form a problem sits under (DESIGN.md §4.2, #2004): a line by its index, the count of lines below them.
export type VoucherField = 'date' | 'cashAccount' | 'description' | 'lines' | 'party' | number;

// The problem with one field of the form, or null.
export function voucherFieldError(form: VoucherForm, field: VoucherField, t: Translate): string | null {
  switch (field) {
    case 'date':
      return isCalendarDate(form.date) ? null : t('vouchers.errors.date');
    case 'cashAccount':
      return form.cashAccount.startsWith(cashRootOf(form.type)) ? null : t('vouchers.errors.cashAccount', { root: cashRootOf(form.type) });
    case 'description':
      return form.description.trim() ? null : t('vouchers.errors.description');
    case 'lines':
      return form.lines.length === 0 || form.lines.length > VOUCHER_MAX_LINES ? t('vouchers.errors.lines', { max: VOUCHER_MAX_LINES }) : null;
    case 'party':
      return !form.partyId && form.lines.some((l) => needsParty(l.account)) ? t('vouchers.errors.party') : null;
    default: {
      const line = form.lines[field];
      if (!line) return null;
      if (!line.account) return t('vouchers.errors.lineAccount', { line: field + 1 });
      if (line.account === form.cashAccount) return t('vouchers.errors.lineIsCash', { line: field + 1 });
      if (!isVoucherAmount(normalizeAmount(line.amount))) return t('vouchers.errors.amount', { line: field + 1 });
      return null;
    }
  }
}

// The sum of whole-VND amounts as a decimal string (BigInt: never a JS number).
export function voucherTotal(lines: ReadonlyArray<{ amount: string }>): string {
  return lines.reduce((acc, l) => acc + (isVoucherAmount(normalizeAmount(l.amount)) ? BigInt(normalizeAmount(l.amount)) : 0n), 0n).toString();
}

export interface VoucherJournalLine {
  accountCode: string;
  debit: string;
  credit: string;
  // The line's own description, when it has one (the cash or bank line has none).
  memo?: string;
}

// Mirrors buildVoucherJournal in @crove/mod-finance: money in debits the cash or bank account for the total and credits
// each line; money out debits each line and credits the cash or bank account.
export function previewVoucherJournal(voucher: {
  type: VoucherType;
  cashAccount: string;
  lines: ReadonlyArray<{ account: string; amount: string; memo?: string | undefined }>;
}): VoucherJournalLine[] {
  const total = voucherTotal(voucher.lines);
  const cash: VoucherJournalLine = { accountCode: voucher.cashAccount, debit: isInflow(voucher.type) ? total : '0', credit: isInflow(voucher.type) ? '0' : total };
  const lines = voucher.lines.map((l): VoucherJournalLine => {
    const amount = normalizeAmount(l.amount);
    return {
      accountCode: l.account,
      debit: isInflow(voucher.type) ? '0' : amount,
      credit: isInflow(voucher.type) ? amount : '0',
      ...(l.memo?.trim() ? { memo: l.memo.trim() } : {}),
    };
  });
  return isInflow(voucher.type) ? [cash, ...lines] : [...lines, cash];
}

// The problems finance.voucher.prepare and finance.voucher.record name in a VOUCHER_INVALID refusal; each has words in
// vouchers.problems of both catalogs.
export const VOUCHER_PROBLEMS = ['CASH_ACCOUNT_TYPE', 'LINE_IS_CASH_ACCOUNT', 'PARTY_REQUIRED', 'TOTAL_TOO_LARGE', 'TOTAL_MISMATCH', 'PROPOSAL_INVALID'] as const;
export type VoucherProblemCode = (typeof VOUCHER_PROBLEMS)[number];

// Which of the voucher's own rules a refusal names (VOUCHER_INVALID carries it in its details), or null for any other
// refusal or a problem this version of the app does not know (then the kernel's message is shown).
export function voucherProblem(error: unknown): VoucherProblemCode | null {
  const e = error as { code?: unknown; data?: { problems?: unknown } } | null;
  if (e?.code !== 'VOUCHER_INVALID' || !Array.isArray(e.data?.problems)) return null;
  const first: unknown = e.data.problems[0];
  return VOUCHER_PROBLEMS.find((p) => p === first) ?? null;
}

// Where the next page of finance.vouchers.list starts: after the last voucher of this page, when older ones follow.
export function nextVoucherCursor(page: CashVoucherPage): VoucherCursor | undefined {
  const last = page.items.at(-1);
  return page.more && last ? { date: last.date, id: last.id } : undefined;
}

// ?type=&from=&to= of the vouchers list (#1513): one type and a date range, each left out when not set.
const zDay = z.string().refine(isCalendarDate).optional().catch(undefined);
const zVouchersSearch = z.object({ type: z.enum(VOUCHER_TYPES).optional().catch(undefined), from: zDay, to: zDay });
export type VouchersSearch = Defined<z.output<typeof zVouchersSearch>>;
export const parseVouchersSearch = (search: Record<string, unknown>): VouchersSearch => readSearch(zVouchersSearch, search);
