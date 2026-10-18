// VAT working for one tax period (issue #316): the input and output invoices of a month or a quarter and the totals
// by VAT rate that feed form 01/GTGT (the VAT return under the credit method). Pure functions; amounts are decimal
// strings and all arithmetic goes through decimal.js, never JS numbers.
//
// Legal sources (checked 2026-10-17 against public summaries of the texts; an accountant still has to confirm the
// figures on a real month, issue #61):
// - Rates 0%, 5% and 10%, and the goods and services not subject to VAT: Law on Value Added Tax No. 48/2024/QH15
//   (in force from 2025-07-01), Articles 5 and 9.
// - The reduced 8% rate (10% minus 2%), see REDUCED_RATE_PERIODS below. For 2026 it is Resolution 204/2025/QH15 and
//   Decree 174/2025/ND-CP (issued 2025-06-30): from 2025-07-01 to 2026-12-31, with the excluded goods and services
//   of its Appendices I and II. The reduced goods are listed on Form 01 of Appendix III of that decree, filed with
//   the VAT return.
// - Form 01/GTGT indicators: Appendix II of Circular 80/2021/TT-BTC. From the July 2026 (Q3 2026) period the form
//   comes from Circular 89/2026/TT-BTC, which keeps the indicators used here and adds [32b] (values outside the VAT
//   base) and [34a] (sales outside the scope of the VAT law); Crove has no data for those two yet, so they are 0.
//   Sales at the reduced 8% rate are declared in [32]/[33] with the 10% rate, the VAT actually charged in [33], and
//   the reduction on the appendix of the decree.
// The rules are data (the tables below), so a correction is a change to the data, not to the code.
import { VAT_PERIOD_PATTERN, VAT_RATES } from '@crove/kernel-contract';
import { Decimal, money, type DecimalValue, type Money } from '@crove/l10n-vn';
import { canonical } from './money.ts';

// The rate buckets of an invoice line (VAT_RATES, shared with the API contract). KCT: not subject to VAT ("không
// chịu thuế"). KKKNT: not declared and not taxed ("không kê khai, tính nộp thuế"). other: a rate Crove cannot place
// (blank, "KHAC:...", unreadable).
export { VAT_PERIOD_PATTERN, VAT_RATES };
export type VatRate = (typeof VAT_RATES)[number];

// The percentage charged at each taxed rate. KCT, KKKNT and 0% charge none.
const RATE_PERCENT: Readonly<Partial<Record<VatRate, number>>> = { '5': 5, '8': 8, '10': 10 };

// TSuat as written on Decree 123 e-invoices ("10%", "8%", "KCT", "KKKNT", "KHAC:3.5%") or as extracted from a PDF.
export function normalizeVatRate(raw: string | null | undefined): VatRate {
  const value = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (value === 'KCT') return 'KCT';
  if (value === 'KKKNT') return 'KKKNT';
  const match = /^(\d{1,2})(?:[.,]0+)?%?$/.exec(value);
  if (match) {
    const rate = String(Number(match[1]));
    if (rate === '0' || rate === '5' || rate === '8' || rate === '10') return rate;
  }
  return 'other';
}

// Periods when the 8% reduced rate applied (both dates included), with their sources.
export const REDUCED_RATE_PERIODS: ReadonlyArray<{ from: string; to: string; source: string }> = [
  { from: '2022-02-01', to: '2022-12-31', source: 'Resolution 43/2022/QH15, Decree 15/2022/ND-CP' },
  { from: '2023-07-01', to: '2023-12-31', source: 'Resolution 101/2023/QH15, Decree 44/2023/ND-CP' },
  { from: '2024-01-01', to: '2024-06-30', source: 'Resolution 110/2023/QH15, Decree 94/2023/ND-CP' },
  { from: '2024-07-01', to: '2024-12-31', source: 'Resolution 142/2024/QH15, Decree 72/2024/ND-CP' },
  { from: '2025-01-01', to: '2025-06-30', source: 'Resolution 174/2024/QH15, Decree 180/2024/ND-CP' },
  { from: '2025-07-01', to: '2026-12-31', source: 'Resolution 204/2025/QH15, Decree 174/2025/ND-CP' },
];

export function reducedRateApplies(date: string): boolean {
  return REDUCED_RATE_PERIODS.some((p) => date >= p.from && date <= p.to);
}

// A tax period: a month ("2026-09") or a quarter ("2026-Q3"). Monthly filers are those above 50 billion VND of
// revenue in the previous year; the rest file quarterly (Decree 126/2020/ND-CP, Article 9). Crove does not decide
// which applies; the accountant picks. VAT_PERIOD_PATTERN: "2026-09" or "2026-Q3".

export interface VatPeriod {
  period: string;
  kind: 'month' | 'quarter';
  from: string;
  to: string;
}

function lastDayOfMonth(year: number, month: number): string {
  // Day 0 of the next month is the last day of this one (UTC, so no time zone shifts it).
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function vatPeriod(period: string): VatPeriod {
  const match = VAT_PERIOD_PATTERN.exec(period);
  if (!match || !match[1] || !match[2]) throw new Error(`not a VAT period: ${JSON.stringify(period)}`);
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) throw new Error(`year out of range: ${period}`);
  if (match[2].startsWith('Q')) {
    const quarter = Number(match[2].slice(1));
    const first = (quarter - 1) * 3 + 1;
    return { period, kind: 'quarter', from: `${year}-${String(first).padStart(2, '0')}-01`, to: lastDayOfMonth(year, first + 2) };
  }
  const month = Number(match[2]);
  return { period, kind: 'month', from: `${year}-${match[2]}-01`, to: lastDayOfMonth(year, month) };
}

export interface VatLineInput {
  amount: Money;
  vatRate: string | null;
}

export interface VatDocumentInput {
  vatAmount: Money;
  lines: ReadonlyArray<VatLineInput>;
}

export interface RateAmounts {
  rate: VatRate;
  taxable: Money;
  vat: Money;
}

export interface DocumentBreakdown {
  // One row per rate the document's lines carry, in VAT_RATES order.
  rates: RateAmounts[];
  // The document's VAT was split across several rates (or put on 'other') by estimate, not read from the invoice.
  allocated: boolean;
}

function byRateOrder(a: { rate: VatRate }, b: { rate: VatRate }): number {
  return VAT_RATES.indexOf(a.rate) - VAT_RATES.indexOf(b.rate);
}

/**
 * Splits one invoice into taxable value and VAT by rate. Crove stores each line's amount and rate and the invoice's
 * total VAT, not the VAT per rate, so:
 * - the taxable value of a rate is the sum of its lines (a discount line is already negative);
 * - an invoice with one taxed rate (5, 8 or 10) puts all its VAT on that rate, exactly as invoiced;
 * - an invoice with several taxed rates estimates each rate's VAT as taxable x rate, rounded half up to whole dong,
 *   and puts the rounding difference on the rate with the largest taxable value, so the rates add up to the
 *   invoice's VAT exactly (flagged `allocated`);
 * - VAT on an invoice whose lines name no taxed rate goes to 'other' (flagged `allocated`), for the accountant.
 */
export function documentVatByRate(doc: VatDocumentInput): DocumentBreakdown {
  const taxable = new Map<VatRate, DecimalValue>();
  for (const line of doc.lines) {
    const rate = normalizeVatRate(line.vatRate);
    taxable.set(rate, (taxable.get(rate) ?? money(0)).plus(money(line.amount)));
  }
  const vat = new Map<VatRate, DecimalValue>([...taxable.keys()].map((r) => [r, money(0)]));
  const total = money(doc.vatAmount);
  const taxed = [...taxable.keys()].filter((r) => RATE_PERCENT[r] !== undefined).sort((a, b) => byRateOrder({ rate: a }, { rate: b }));
  let allocated = false;
  if (taxed.length === 1 && taxed[0]) {
    vat.set(taxed[0], total);
  } else if (taxed.length > 1) {
    allocated = true;
    let estimated = money(0);
    for (const rate of taxed) {
      const estimate = (taxable.get(rate) ?? money(0)).times(RATE_PERCENT[rate] ?? 0).dividedBy(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      vat.set(rate, estimate);
      estimated = estimated.plus(estimate);
    }
    // The largest taxable value (by absolute amount) takes the difference; ties go to the higher rate.
    const largest = [...taxed].sort((a, b) => {
      const diff = (taxable.get(b) ?? money(0)).abs().comparedTo((taxable.get(a) ?? money(0)).abs());
      return diff !== 0 ? diff : byRateOrder({ rate: b }, { rate: a });
    })[0];
    if (largest) vat.set(largest, (vat.get(largest) ?? money(0)).plus(total.minus(estimated)));
  } else if (!total.isZero()) {
    allocated = true;
    vat.set('other', total);
    if (!taxable.has('other')) taxable.set('other', money(0));
  }
  const rates = [...taxable.keys()]
    .map((rate) => ({ rate, taxable: canonical(taxable.get(rate) ?? money(0)), vat: canonical(vat.get(rate) ?? money(0)) }))
    .sort(byRateOrder);
  return { rates, allocated };
}

/**
 * Whether an invoice's VAT is far from what its lines' rates give (issue #358): the invoice's VAT against the sum of
 * each line's amount x its rate (0 for 0%, KCT and KKKNT). Sellers round VAT to whole dong per line or on the total,
 * so up to one dong per taxed line is rounding, not a mismatch; with no taxed line, any VAT is. Invoices with a line
 * of unknown rate are not judged: Crove cannot say what VAT that line carries, and `rate_unknown` already flags them.
 */
export function vatMismatch(doc: VatDocumentInput): boolean {
  let expected = money(0);
  let taxedLines = 0;
  for (const line of doc.lines) {
    const rate = normalizeVatRate(line.vatRate);
    if (rate === 'other') return false;
    const percent = RATE_PERCENT[rate];
    if (percent === undefined) continue;
    expected = expected.plus(money(line.amount).times(percent).dividedBy(100));
    taxedLines += 1;
  }
  return money(doc.vatAmount).minus(expected).abs().greaterThan(money(taxedLines));
}

export interface SideTotals {
  // Every rate of VAT_RATES, in order, zero when no invoice carries it.
  byRate: RateAmounts[];
  taxable: Money;
  vat: Money;
  documents: number;
}

export function sideTotals(breakdowns: ReadonlyArray<Pick<DocumentBreakdown, 'rates'>>): SideTotals {
  const taxable = new Map<VatRate, DecimalValue>(VAT_RATES.map((r) => [r, money(0)]));
  const vat = new Map<VatRate, DecimalValue>(VAT_RATES.map((r) => [r, money(0)]));
  for (const doc of breakdowns) {
    for (const row of doc.rates) {
      taxable.set(row.rate, (taxable.get(row.rate) ?? money(0)).plus(money(row.taxable)));
      vat.set(row.rate, (vat.get(row.rate) ?? money(0)).plus(money(row.vat)));
    }
  }
  const sum = (m: Map<VatRate, DecimalValue>) => [...m.values()].reduce((acc, v) => acc.plus(v), money(0));
  return {
    byRate: VAT_RATES.map((rate) => ({ rate, taxable: canonical(taxable.get(rate) ?? money(0)), vat: canonical(vat.get(rate) ?? money(0)) })),
    taxable: canonical(sum(taxable)),
    vat: canonical(sum(vat)),
    documents: breakdowns.length,
  };
}

// The form 01/GTGT indicators Crove can fill from invoices, in the form's order. [25] (input VAT eligible for
// deduction) and everything from [36] on need the accountant's judgement or the previous return, so they are left
// out. Labels stay Vietnamese: they are the form's own wording, for Vietnamese accountants.
export interface FormIndicator {
  code: string;
  label: string;
  amount: Money;
}

export function form01Indicators(input: SideTotals, output: SideTotals): FormIndicator[] {
  const of = (side: SideTotals, rate: VatRate) => side.byRate.find((r) => r.rate === rate) ?? { rate, taxable: '0', vat: '0' };
  const add = (...values: Money[]) => canonical(values.reduce<DecimalValue>((acc, v) => acc.plus(money(v)), money(0)));
  const v26 = of(output, 'KCT').taxable;
  const v29 = of(output, '0').taxable;
  const v30 = of(output, '5').taxable;
  const v31 = of(output, '5').vat;
  // The reduced 8% rate is declared with 10%; [33] holds the VAT actually charged.
  const v32 = add(of(output, '10').taxable, of(output, '8').taxable);
  const v33 = add(of(output, '10').vat, of(output, '8').vat);
  const v32a = of(output, 'KKKNT').taxable;
  const v27 = add(v29, v30, v32, v32a);
  const v28 = add(v31, v33);
  return [
    { code: '23', label: 'Giá trị hàng hóa, dịch vụ mua vào', amount: input.taxable },
    { code: '24', label: 'Thuế GTGT của hàng hóa, dịch vụ mua vào', amount: input.vat },
    { code: '26', label: 'Hàng hóa, dịch vụ bán ra không chịu thuế GTGT', amount: v26 },
    { code: '27', label: 'Hàng hóa, dịch vụ bán ra chịu thuế GTGT ([27]=[29]+[30]+[32]+[32a])', amount: v27 },
    { code: '28', label: 'Thuế GTGT của hàng hóa, dịch vụ bán ra ([28]=[31]+[33])', amount: v28 },
    { code: '29', label: 'Hàng hóa, dịch vụ bán ra chịu thuế suất 0%', amount: v29 },
    { code: '30', label: 'Hàng hóa, dịch vụ bán ra chịu thuế suất 5%', amount: v30 },
    { code: '31', label: 'Thuế GTGT của hàng hóa, dịch vụ bán ra chịu thuế suất 5%', amount: v31 },
    { code: '32', label: 'Hàng hóa, dịch vụ bán ra chịu thuế suất 10% (gồm 8% được giảm)', amount: v32 },
    { code: '33', label: 'Thuế GTGT của hàng hóa, dịch vụ bán ra chịu thuế suất 10% (gồm 8% được giảm)', amount: v33 },
    { code: '32a', label: 'Hàng hóa, dịch vụ bán ra không phải kê khai, tính nộp thuế GTGT', amount: v32a },
    { code: '34', label: 'Tổng doanh thu hàng hóa, dịch vụ bán ra ([34]=[26]+[27])', amount: add(v26, v27) },
    { code: '35', label: 'Tổng thuế GTGT của hàng hóa, dịch vụ bán ra ([35]=[28])', amount: v28 },
  ];
}
