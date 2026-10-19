// Cash and bank vouchers on screen (issue #327): entering a phiếu thu, phiếu chi, báo Có or báo Nợ, and showing one in
// the Inbox. The kernel checks every rule again (finance.voucher.prepare, then finance.voucher.record when approved);
// these helpers only keep the form from sending what it will refuse and preview the entry the approval posts.
import {
  cashRootOf,
  isCalendarDate,
  isInflow,
  needsParty,
  VOUCHER_MAX_LINES,
  type CashVoucherPage,
  type VoucherCursor,
  type VoucherType,
} from '@crove/kernel-contract';
import type { ChartAccount } from './accounts.ts';
import type { Translate } from '../i18n/runtime.ts';

export { VOUCHER_KIND } from '@crove/kernel-contract';

// The roles that may enter a voucher (kernel.proposal.request); approving needs owner or admin.
const REQUESTERS = ['owner', 'admin', 'member'];

export function canEnterVoucher(role: string | null | undefined): boolean {
  return Boolean(role && REQUESTERS.includes(role));
}

// An amount as typed, as the digits the API takes: "1.500.000", "1 500 000" and "1,500,000" are 1500000. Anything else
// (letters, a decimal part, a sign) is returned as typed, so the form refuses it.
export function normalizeAmount(text: string): string {
  const compact = text.trim().replace(/[\s.,]/g, '');
  return /^\d+$/.test(compact) ? compact.replace(/^0+(?=\d)/, '') : text.trim();
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
  if (!isCalendarDate(form.date)) return t('vouchers.errors.date');
  if (!form.cashAccount.startsWith(cashRootOf(form.type))) return t('vouchers.errors.cashAccount', { root: cashRootOf(form.type) });
  if (!form.description.trim()) return t('vouchers.errors.description');
  if (form.lines.length === 0 || form.lines.length > VOUCHER_MAX_LINES) return t('vouchers.errors.lines', { max: VOUCHER_MAX_LINES });
  for (const [i, line] of form.lines.entries()) {
    if (!line.account) return t('vouchers.errors.lineAccount', { line: i + 1 });
    if (line.account === form.cashAccount) return t('vouchers.errors.lineIsCash', { line: i + 1 });
    if (!isVoucherAmount(normalizeAmount(line.amount))) return t('vouchers.errors.amount', { line: i + 1 });
  }
  if (!form.partyId && form.lines.some((l) => needsParty(l.account))) return t('vouchers.errors.party');
  return null;
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
