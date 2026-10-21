// The VAT working screen's period picker (issue #316): a month ("2026-09") or a quarter ("2026-Q3"). The server checks
// the period again (zVatPeriod); these helpers only build it and pick a sensible default.
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

// What the HTKK XML puts in [25] (#692, #917): 0 for the accountant to fill in HTKK, all of [24], or the working's
// suggestion, [24] minus the VAT marked not deductible for want of a non-cash payment.
export const DEDUCT_CHOICES = ['none', 'all', 'suggested'] as const;
export type DeductChoice = (typeof DEDUCT_CHOICES)[number];

export function deductParams(choice: DeductChoice): Record<string, string> {
  if (choice === 'all') return { deductInput: '1' };
  if (choice === 'suggested') return { deduct: 'suggested' };
  return {};
}

// Only owners, admins and members mark invoices (finance.vat.payment_mark); viewers only read.
export function canMarkPayment(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}
