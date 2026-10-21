// The general journal voucher form (NVK, #888): what the SPA checks before it asks, so the user sees a mistake on the
// form. The kernel checks every rule again (finance.journal_voucher.prepare, then finance.journal_voucher.record when
// approved) and decides.
import { JOURNAL_VOUCHER_MAX_LINES, needsParty } from '@crove/kernel-contract';
import { normalizeAmount } from './vouchers.ts';

export interface JournalFormLine {
  account: string;
  partyId: string;
  debit: string;
  credit: string;
}

export interface JournalForm {
  date: string;
  description: string;
  lines: readonly JournalFormLine[];
}

export type JournalFormProblem = 'description' | 'lines' | 'amount' | 'side' | 'party' | 'unbalanced';

const WHOLE = /^\d{1,15}$/;

// An amount as the API takes it: digits, "0" when empty.
export function journalAmount(text: string): string {
  const value = normalizeAmount(text);
  return value === '' ? '0' : value;
}

const positive = (value: string) => WHOLE.test(value) && /[1-9]/.test(value);

// The debits and the credits of the form, as whole VND; an amount that is not one counts as 0.
export function journalTotals(lines: readonly JournalFormLine[]): { debit: string; credit: string } {
  const add = (side: 'debit' | 'credit') =>
    lines.reduce((total, l) => {
      const value = journalAmount(l[side]);
      return WHOLE.test(value) ? total + BigInt(value) : total;
    }, 0n);
  return { debit: add('debit').toString(), credit: add('credit').toString() };
}

// The first problem of the form, in the order the user fills it in, or null.
export function journalFormProblem(form: JournalForm): JournalFormProblem | null {
  if (!form.description.trim()) return 'description';
  if (form.lines.length < 2 || form.lines.length > JOURNAL_VOUCHER_MAX_LINES) return 'lines';
  for (const l of form.lines) {
    const debit = journalAmount(l.debit);
    const credit = journalAmount(l.credit);
    if (!WHOLE.test(debit) || !WHOLE.test(credit)) return 'amount';
    if (positive(debit) === positive(credit)) return 'side';
  }
  if (form.lines.some((l) => !l.partyId && needsParty(l.account))) return 'party';
  const totals = journalTotals(form.lines);
  if (totals.debit !== totals.credit) return 'unbalanced';
  return null;
}

// The problems finance.journal_voucher.prepare and .record name in a JOURNAL_VOUCHER_INVALID refusal; each has words in
// journalVoucher.problems.
const SERVER_PROBLEMS = ['LINE_SIDE', 'UNBALANCED', 'PARTY_REQUIRED', 'TOTAL_TOO_LARGE', 'TOTAL_MISMATCH', 'PROPOSAL_INVALID'] as const;
export type JournalServerProblem = (typeof SERVER_PROBLEMS)[number];

export function journalVoucherProblem(error: unknown): JournalServerProblem | null {
  const e = error as { code?: unknown; data?: { problems?: unknown } } | null;
  if (e?.code !== 'JOURNAL_VOUCHER_INVALID' || !Array.isArray(e.data?.problems)) return null;
  const first = e.data.problems[0];
  return SERVER_PROBLEMS.find((p) => p === first) ?? null;
}
