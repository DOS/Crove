// Monthly depreciation of fixed assets and allocation of prepaid costs (#919), straight line: each month of use takes
// the cost divided by the months, rounded down to whole dong, and the last month takes what is left, so the schedule
// adds up to the cost exactly. A month counts from the start month for the months of use, and not after the month an
// asset was stopped or disposed of (that month still counts). Sources (TT133, Articles 35 and 36 for 211 and 214;
// Article 33 for 242): straight-line depreciation by month from the month of use; the useful life comes from the
// accountant, within the bands of Circular 45/2013/TT-BTC.
import { Decimal, money, type DecimalValue, type Money } from '@crove/l10n-vn';
import { canonical } from './money.ts';

export interface ScheduledAsset {
  cost: Money;
  startMonth: string;
  months: number;
  endedMonth: string | null;
}

// 'YYYY-MM-01' of a 'YYYY-MM-DD' or 'YYYY-MM' text.
export function firstOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

// Whole months from a to b (both first days of a month): 0 for the same month, negative when b is before a.
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}

// The last month of the schedule as planned (before any early end).
export function lastMonth(asset: Pick<ScheduledAsset, 'startMonth' | 'months'>): string {
  return addMonths(asset.startMonth, asset.months - 1);
}

function regular(cost: Money, months: number): DecimalValue {
  return money(cost).dividedBy(months).toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

// The amount of the asset for a month, or '0' outside its schedule.
export function monthAmount(asset: ScheduledAsset, month: string): Money {
  const index = monthsBetween(asset.startMonth, month);
  if (index < 0 || index >= asset.months) return '0';
  if (asset.endedMonth !== null && month > asset.endedMonth) return '0';
  const base = regular(asset.cost, asset.months);
  if (index < asset.months - 1) return canonical(base);
  return canonical(money(asset.cost).minus(base.times(asset.months - 1)));
}

// What the asset is still worth in the books: its cost less what was posted for it.
export function remainingValue(cost: Money, posted: readonly Money[]): Money {
  return canonical(posted.reduce((acc, p) => acc.minus(money(p)), money(cost)));
}
