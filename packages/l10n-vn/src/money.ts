import { Decimal as DecimalJs } from 'decimal.js';

// Money travels as decimal strings; arithmetic goes through decimal.js, never JS numbers.
export type Money = string;

const D = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });
type Decimal = DecimalJs;

export function money(value: string | number | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new D(0);
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/\s/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new Error(`not a decimal amount: ${value}`);
    return new D(cleaned);
  }
  return new D(value);
}

export function toMoney(value: Decimal): Money {
  return value.toDecimalPlaces(4).toFixed();
}

export function sum(values: Array<string | Decimal>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(typeof v === 'string' ? money(v) : v), new D(0));
}

// Amounts that differ by at most `tolerance` (default 1 VND, for rounding on invoices).
export function approxEqual(a: string | Decimal, b: string | Decimal, tolerance = '1'): boolean {
  const left = typeof a === 'string' ? money(a) : a;
  const right = typeof b === 'string' ? money(b) : b;
  return left.minus(right).abs().lessThanOrEqualTo(tolerance);
}

export { D as Decimal };
export type { DecimalJs as DecimalValue };
