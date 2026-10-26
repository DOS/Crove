// The VAT working screen's period picker (issue #316): a month ("2026-09") or a quarter ("2026-Q3"). The server checks
// the period again (zVatPeriod); these helpers only build it and pick a sensible default.
import { z } from 'zod';
import { toUnits } from './decimal.ts';
import { readSearch, type Defined } from './search.ts';
import { normalizeAmount } from './vouchers.ts';

export type PeriodKind = 'month' | 'quarter';

export interface PeriodChoice {
  kind: PeriodKind;
  year: number;
  // 1-12 for a month, 1-4 for a quarter.
  index: number;
}

export function periodKey(choice: PeriodChoice): string {
  return choice.kind === 'month' ? `${choice.year}-${String(choice.index).padStart(2, '0')}` : `${choice.year}-Q${choice.index}`;
}

// A return is filed after its period ends, so the default is the month (or quarter) before the one containing today.
export function defaultPeriod(kind: PeriodKind, today: Date = new Date()): PeriodChoice {
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  if (kind === 'month') return month === 1 ? { kind, year: year - 1, index: 12 } : { kind, year, index: month - 1 };
  const quarter = Math.ceil(month / 3);
  return quarter === 1 ? { kind, year: year - 1, index: 4 } : { kind, year, index: quarter - 1 };
}

// The same period seen as the other kind: a month becomes its quarter, a quarter its first month.
export function switchKind(choice: PeriodChoice, kind: PeriodKind): PeriodChoice {
  if (kind === choice.kind) return choice;
  return kind === 'quarter' ? { kind, year: choice.year, index: Math.ceil(choice.index / 3) } : { kind, year: choice.year, index: (choice.index - 1) * 3 + 1 };
}

// The years offered: this year and the five before it (a return may be amended for earlier periods).
export function yearOptions(today: Date = new Date()): number[] {
  const year = today.getFullYear();
  return Array.from({ length: 6 }, (_, i) => year - i);
}

// A month or quarter key as the address carries it, read back into a choice (#1513); null for anything else and for a
// year the picker does not offer.
export function periodChoiceOf(key: string, today: Date = new Date()): PeriodChoice | null {
  const match = /^(\d{4})-(?:(\d{2})|Q([1-4]))$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  if (!yearOptions(today).includes(year)) return null;
  if (match[3]) return { kind: 'quarter', year, index: Number(match[3]) };
  const index = Number(match[2]);
  return index >= 1 && index <= 12 ? { kind: 'month', year, index } : null;
}

// ?period= of the VAT and portal list screens (#1513): a month or a quarter, left out for the default one.
const zPeriodSearch = z.object({ period: z.string().refine((key) => periodChoiceOf(key) !== null).optional().catch(undefined) });
export type PeriodSearch = Defined<z.output<typeof zPeriodSearch>>;
export const parsePeriodSearch = (search: Record<string, unknown>): PeriodSearch => readSearch(zPeriodSearch, search);

// The search to write for a picked period: none when it is the default, so the address shows only a choice.
export function periodSearch(key: string, defaultKey: string): PeriodSearch {
  return key === defaultKey ? {} : { period: key };
}

// What the HTKK XML puts in [25] (#692, #917): 0 for the accountant to fill in HTKK, all of [24], or the working's
// suggestion, [24] minus the VAT marked not deductible for want of a non-cash payment.
export const DEDUCT_CHOICES = ['none', 'all', 'suggested'] as const;
export type DeductChoice = (typeof DEDUCT_CHOICES)[number];

export function deductParams(choice: DeductChoice): Record<string, string> {
  if (choice === 'all') return { deductInput: '1' };
  if (choice === 'suggested') return { deduct: 'suggested' };
  return {};
}

// An amount of the return as typed (#1400): whole dong, at most 14 digits, grouped or not; null otherwise. The server
// checks again.
export function wholeDong(text: string): string | null {
  const value = normalizeAmount(text);
  return /^\d{1,14}$/.test(value) ? value.replace(/^0+(?=\d)/, '') : null;
}

// [43] as the form works it out (#1400) when [37], [38], [39a] and [42] are 0, as in the HTKK file: with
// x = [35] - [25] - [22] ([35] rounded half up to the dong), [43] = -x when x < 0, else 0. A prefill the accountant
// corrects to the return as filed.
export function carriedOutOf(v35: string, v25: string, v22: string): string {
  const x = BigInt(roundDong(v35)) - BigInt(v25) - BigInt(v22);
  return x < 0n ? (-x).toString() : '0';
}

// A decimal amount rounded half up (away from zero) to whole dong, as the HTKK file writes it.
export function roundDong(value: string): string {
  const units = toUnits(value);
  return (units < 0n ? -((-units + 5000n) / 10000n) : (units + 5000n) / 10000n).toString();
}

// The [25] the HTKK file would hold for this choice (#692, #917), to prefill the return as filed (#1400).
export function deductAmount(choice: DeductChoice, vat24: string, suggested25: string): string {
  return choice === 'all' ? roundDong(vat24) : choice === 'suggested' ? roundDong(suggested25) : '0';
}

// Only owners and admins mark a VAT return filed or take the mark back (finance.vat.return_mark, #1400).
export function canMarkFiled(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

// Only owners, admins and members mark invoices (finance.vat.payment_mark); viewers only read.
export function canMarkPayment(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}
