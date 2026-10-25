// The tax calendar of a client (issue #921): what a TT133 company files or pays on a recurring schedule, and when. The
// rules are data (TAX_RULES), each with its legal basis and the periods it covers, so a change of the law is a change
// of the table. The partner's accountant (#61) has not confirmed the table yet: `confirmed` stays false until they do,
// and the screen says so. docs/integrations/tax-calendar.md lists the sources.
//
// A due date that falls on a Saturday or a Sunday moves to the next Monday (Civil Code 2015, Article 148(5)), as for
// the VAT return (vat-deadline.ts). Public holidays are not applied, so the date shown is never later than the real one.
// Dates are calendar dates (YYYY-MM-DD) in Vietnam time.
import { z } from 'zod';
import type { VatFilingPeriod } from './vat-deadline.ts';

export const TAX_OBLIGATIONS = ['vat_return', 'pit_withholding', 'cit_provisional', 'cit_finalization', 'pit_finalization', 'financial_statements', 'license_fee'] as const;
export type TaxObligation = (typeof TAX_OBLIGATIONS)[number];
export const PIT_FILING_PERIODS = ['month', 'quarter'] as const;
export type PitFilingPeriod = (typeof PIT_FILING_PERIODS)[number];

export type TaxFrequency = 'month' | 'quarter' | 'year';

// When a period's obligation is due:
// - afterEnd: in the `months`-th month after the period's last month, on `day` (or its last day); a day past the end of
//   a short month is that month's last day;
// - daysAfterEnd: `days` days after the period's last day;
// - inYear: on `month`/`day` of the calendar year of the period.
export type TaxDueRule =
  | { kind: 'afterEnd'; months: number; day: number | 'last' }
  | { kind: 'daysAfterEnd'; days: number }
  | { kind: 'inYear'; month: number; day: number };

export interface TaxRule {
  obligation: TaxObligation;
  frequency: TaxFrequency;
  // Years and quarters by the calendar, or by the org's fiscal year (its last month in the tax profile).
  basis: 'calendar' | 'fiscal';
  due: TaxDueRule;
  // The periods the rule covers, by their first day; null: no end.
  effectiveFrom: string;
  effectiveTo: string | null;
  legalBasis: string;
  // Whether the partner's accountant confirmed this line (#61).
  confirmed: boolean;
}

const LAW_38 = '2020-07-01';

export const TAX_RULES: readonly TaxRule[] = [
  {
    obligation: 'vat_return',
    frequency: 'month',
    basis: 'calendar',
    due: { kind: 'afterEnd', months: 1, day: 20 },
    effectiveFrom: LAW_38,
    effectiveTo: null,
    legalBasis: 'Luật Quản lý thuế 38/2019/QH14, Điều 44 khoản 1 điểm a',
    confirmed: false,
  },
  {
    obligation: 'vat_return',
    frequency: 'quarter',
    basis: 'calendar',
    due: { kind: 'afterEnd', months: 1, day: 'last' },
    effectiveFrom: LAW_38,
    effectiveTo: null,
    legalBasis: 'Luật Quản lý thuế 38/2019/QH14, Điều 44 khoản 1 điểm b',
    confirmed: false,
  },
  {
    obligation: 'pit_withholding',
    frequency: 'month',
    basis: 'calendar',
    due: { kind: 'afterEnd', months: 1, day: 20 },
    effectiveFrom: LAW_38,
    effectiveTo: null,
    legalBasis: 'Luật Quản lý thuế 38/2019/QH14, Điều 44 khoản 1 điểm a; Nghị định 126/2020/NĐ-CP, Điều 8 khoản 1',
    confirmed: false,
  },
  {
    obligation: 'pit_withholding',
    frequency: 'quarter',
    basis: 'calendar',
    due: { kind: 'afterEnd', months: 1, day: 'last' },
    effectiveFrom: LAW_38,
    effectiveTo: null,
    legalBasis: 'Luật Quản lý thuế 38/2019/QH14, Điều 44 khoản 1 điểm b; Nghị định 126/2020/NĐ-CP, Điều 9',
    confirmed: false,
  },
  {
    // Paid, not filed: the provisional CIT of a quarter of the fiscal year.
    obligation: 'cit_provisional',
    frequency: 'quarter',
    basis: 'fiscal',
    due: { kind: 'afterEnd', months: 1, day: 30 },
    effectiveFrom: LAW_38,
    effectiveTo: null,
    legalBasis: 'Luật Quản lý thuế 38/2019/QH14, Điều 55 khoản 1',
    confirmed: false,
  },
  {
    obligation: 'cit_finalization',
    frequency: 'year',
    basis: 'fiscal',
    due: { kind: 'afterEnd', months: 3, day: 'last' },
    effectiveFrom: LAW_38,
    effectiveTo: null,
    legalBasis: 'Luật Quản lý thuế 38/2019/QH14, Điều 44 khoản 2 điểm a',
    confirmed: false,
  },
  {
    // The finalization an employer files for the PIT it withheld, by calendar year.
    obligation: 'pit_finalization',
    frequency: 'year',
    basis: 'calendar',
    due: { kind: 'afterEnd', months: 3, day: 'last' },
    effectiveFrom: LAW_38,
    effectiveTo: null,
    legalBasis: 'Luật Quản lý thuế 38/2019/QH14, Điều 44 khoản 2 điểm a',
    confirmed: false,
  },
  {
    obligation: 'financial_statements',
    frequency: 'year',
    basis: 'fiscal',
    due: { kind: 'daysAfterEnd', days: 90 },
    effectiveFrom: '2017-01-01',
    effectiveTo: null,
    legalBasis: 'Thông tư 133/2016/TT-BTC, Điều 80 khoản 1',
    confirmed: false,
  },
  {
    // Abolished from 2026 by Resolution 198/2025/QH15: the last fee was for 2025.
    obligation: 'license_fee',
    frequency: 'year',
    basis: 'calendar',
    due: { kind: 'inYear', month: 1, day: 30 },
    effectiveFrom: '2020-01-01',
    effectiveTo: '2025-12-31',
    legalBasis: 'Nghị định 139/2016/NĐ-CP, Điều 6 khoản 3 (sửa đổi bởi Nghị định 22/2020/NĐ-CP); bãi bỏ từ năm 2026 theo Nghị quyết 198/2025/QH15',
    confirmed: false,
  },
];

// What an org decided: which obligations apply, and the settings the rules need. The VAT return follows the org's VAT
// filing period (#318); without one it is not listed.
export interface TaxProfileSettings {
  obligations: readonly TaxObligation[];
  vatFilingPeriod: VatFilingPeriod | null;
  pitFilingPeriod: PitFilingPeriod | null;
  // The last month of the fiscal year, 1 to 12 (12: the calendar year).
  fiscalYearEndMonth: number;
}

export interface TaxDue {
  obligation: TaxObligation;
  // "2026" (a year; a fiscal year is named by the calendar year it ends in), "2026-09" or "2026-Q3" (a quarter of the
  // calendar, or of the fiscal year for a fiscal rule).
  period: string;
  periodStart: string;
  periodEnd: string;
  // After the weekend rule.
  dueDate: string;
  legalBasis: string;
  confirmed: boolean;
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => d.toISOString().slice(0, 10);
// Month index counted from year 0 (y * 12 + m - 1), so arithmetic across years is plain addition.
const monthIndex = (y: number, m: number) => y * 12 + (m - 1);
const yearOf = (index: number) => Math.floor(index / 12);
const monthOf = (index: number) => (index % 12) + 1;
const lastDayOf = (index: number) => new Date(Date.UTC(yearOf(index), monthOf(index), 0)).getUTCDate();
const dateOf = (index: number, day: number) => `${yearOf(index)}-${pad(monthOf(index))}-${pad(Math.min(day, lastDayOf(index)))}`;

function parseDate(text: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`not a calendar date: ${text}`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || iso(date) !== text) throw new Error(`not a calendar date: ${text}`);
  return date;
}

// Saturday and Sunday move to the following Monday.
export function afterWeekend(date: string): string {
  const d = parseDate(date);
  const weekday = d.getUTCDay();
  return weekday === 6 ? iso(new Date(d.getTime() + 2 * DAY_MS)) : weekday === 0 ? iso(new Date(d.getTime() + DAY_MS)) : date;
}

interface Period {
  key: string;
  // Month indexes of the first and last month.
  first: number;
  last: number;
}

// The periods of a rule whose last month is between two month indexes.
function periods(rule: TaxRule, fiscalYearEndMonth: number, fromLast: number, toLast: number): Period[] {
  const length = rule.frequency === 'month' ? 1 : rule.frequency === 'quarter' ? 3 : 12;
  // The last month of the year the periods are aligned to (12 for the calendar).
  const yearEnd = rule.basis === 'fiscal' ? fiscalYearEndMonth : 12;
  const out: Period[] = [];
  // The first period end on or after fromLast: period ends are yearEnd shifted by whole periods.
  const offset = (((fromLast - (yearEnd - 1)) % length) + length) % length;
  for (let last = offset === 0 ? fromLast : fromLast + (length - offset); last <= toLast; last += length) {
    const first = last - length + 1;
    // The fiscal (or calendar) year the period belongs to is named by the year of its last month.
    const fyEnd = last + ((((yearEnd - 1 - (last % 12)) % 12) + 12) % 12);
    let key: string;
    if (rule.frequency === 'month') key = `${yearOf(last)}-${pad(monthOf(last))}`;
    else if (rule.frequency === 'year') key = String(yearOf(fyEnd));
    else key = `${yearOf(fyEnd)}-Q${4 - (fyEnd - last) / 3}`;
    out.push({ key, first, last });
  }
  return out;
}

function dueOf(rule: TaxRule, period: Period): string {
  const due = rule.due;
  let date: string;
  if (due.kind === 'afterEnd') {
    const index = period.last + due.months;
    date = dateOf(index, due.day === 'last' ? lastDayOf(index) : due.day);
  } else if (due.kind === 'daysAfterEnd') {
    const end = parseDate(dateOf(period.last, 31));
    date = iso(new Date(end.getTime() + due.days * DAY_MS));
  } else {
    date = dateOf(monthIndex(yearOf(period.last), due.month), due.day);
  }
  return afterWeekend(date);
}

// The rules an org's profile turns on.
export function rulesOf(profile: TaxProfileSettings): TaxRule[] {
  const on = new Set(profile.obligations);
  return TAX_RULES.filter((rule) => {
    if (rule.obligation === 'vat_return') return profile.vatFilingPeriod !== null && rule.frequency === profile.vatFilingPeriod;
    if (!on.has(rule.obligation)) return false;
    if (rule.obligation === 'pit_withholding') return profile.pitFilingPeriod !== null && rule.frequency === profile.pitFilingPeriod;
    return true;
  });
}

/** Every obligation of the profile due between two dates (both included), by due date, then obligation and period. */
export function taxDues(profile: TaxProfileSettings, from: string, to: string): TaxDue[] {
  parseDate(from);
  parseDate(to);
  if (!Number.isInteger(profile.fiscalYearEndMonth) || profile.fiscalYearEndMonth < 1 || profile.fiscalYearEndMonth > 12) {
    throw new Error(`not a month: ${profile.fiscalYearEndMonth}`);
  }
  const fromIndex = monthIndex(Number(from.slice(0, 4)), Number(from.slice(5, 7)));
  const toIndex = monthIndex(Number(to.slice(0, 4)), Number(to.slice(5, 7)));
  const out: TaxDue[] = [];
  for (const rule of rulesOf(profile)) {
    // No rule falls due more than 12 months after its period ends; one due inside its own period (inYear) falls due up
    // to 11 months before the period ends, so its periods are searched that far past the window too.
    const ahead = rule.due.kind === 'inYear' ? 12 : 0;
    for (const period of periods(rule, profile.fiscalYearEndMonth, fromIndex - 13, toIndex + ahead)) {
      const periodStart = dateOf(period.first, 1);
      if (periodStart < rule.effectiveFrom || (rule.effectiveTo !== null && periodStart > rule.effectiveTo)) continue;
      const dueDate = dueOf(rule, period);
      if (dueDate < from || dueDate > to) continue;
      out.push({
        obligation: rule.obligation,
        period: period.key,
        periodStart,
        periodEnd: dateOf(period.last, 31),
        dueDate,
        legalBasis: rule.legalBasis,
        confirmed: rule.confirmed,
      });
    }
  }
  const order = (o: TaxObligation) => TAX_OBLIGATIONS.indexOf(o);
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : order(a.obligation) - order(b.obligation) || (a.period < b.period ? -1 : 1)));
}

// What owners and admins set (kernel.tax_profile.save). The VAT return is not in the list: it follows the org's VAT
// filing period (kernel.org.set_vat_filing_period).
export const PROFILE_OBLIGATIONS = TAX_OBLIGATIONS.filter((o): o is Exclude<TaxObligation, 'vat_return'> => o !== 'vat_return');
export const zTaxProfile = z.strictObject({
  obligations: z.array(z.enum(PROFILE_OBLIGATIONS as [Exclude<TaxObligation, 'vat_return'>, ...Exclude<TaxObligation, 'vat_return'>[]])).max(PROFILE_OBLIGATIONS.length),
  pitFilingPeriod: z.enum(PIT_FILING_PERIODS).nullable(),
  fiscalYearEndMonth: z.number().int().min(1).max(12),
});
export type TaxProfile = z.infer<typeof zTaxProfile>;

export const zTaxPeriod = z.string().regex(/^20\d{2}(-(0[1-9]|1[0-2]|Q[1-4]))?$/);
// One obligation of one period for one legal entity (kernel.tax_obligation.done and .undo, #1496). Each entity files its
// own returns; without legalEntityId the mark is the org's default entity's.
export const zTaxObligationMark = z.strictObject({ obligation: z.enum(TAX_OBLIGATIONS), period: zTaxPeriod, legalEntityId: z.uuid().optional() });

// An obligation still to do on the home screen: due in the next 30 days, or overdue and not marked done. daysLeft is
// negative once the due date has passed.
export const zTaxDueView = z.object({
  obligation: z.enum(TAX_OBLIGATIONS),
  period: zTaxPeriod,
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daysLeft: z.number().int(),
  legalBasis: z.string(),
  confirmed: z.boolean(),
});
export type TaxDueView = z.infer<typeof zTaxDueView>;
