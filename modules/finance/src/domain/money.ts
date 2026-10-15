// Money rules of ADR-0021 decision 1, as pure functions. Amounts are decimal strings and all arithmetic goes
// through decimal.js (`@crove/l10n-vn`), never JS numbers.
// - Every stored amount fits `amount numeric(20,4)`; the currency's ISO 4217 minor units decide how many of
//   the 4 decimals may be used, and an amount with more is refused, never rounded silently.
// - A line amount is rounded once, half away from zero, to the currency's minor units.
// - Exchange rates are direct quotes: units of the book currency per 1 unit of the foreign currency.
import { Decimal, money, type DecimalValue, type Money } from '@crove/l10n-vn';

// ISO 4217 minor units for the currencies Crove knows so far. VND has none.
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  VND: 0,
  JPY: 0,
  KRW: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CNY: 2,
  SGD: 2,
  THB: 2,
  KWD: 3,
  BHD: 3,
  CLF: 4,
};

// Domain limits: numeric(20,4), unit_amount numeric(24,8), quantity numeric(20,6), fx_rate numeric(24,10).
export const AMOUNT_SCALE = 4;
export const AMOUNT_LIMIT = '1e16';
export const UNIT_AMOUNT_SCALE = 8;
export const UNIT_AMOUNT_LIMIT = '1e16';
export const QUANTITY_SCALE = 6;
export const QUANTITY_LIMIT = '1e14';
export const FX_RATE_SCALE = 10;
export const FX_RATE_LIMIT = '1e14';

export type MoneyErrorCode = 'UNKNOWN_CURRENCY' | 'NOT_A_DECIMAL' | 'AMOUNT_SCALE' | 'AMOUNT_OVERFLOW' | 'INVALID_FX_RATE';

// No parameter properties: the kernel image runs TypeScript in Node's strip-only mode.
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MoneyError';
    this.code = code;
  }
}

export function minorUnits(currency: string): number {
  const units = CURRENCY_MINOR_UNITS[currency];
  if (units === undefined) throw new MoneyError('UNKNOWN_CURRENCY', `unknown currency ${currency}`);
  return units;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

// Strict parse: a plain decimal string ("1500000", "12.50", "-3"). No exponents, separators or blanks.
export function parseDecimal(value: string): DecimalValue {
  if (!DECIMAL.test(value)) throw new MoneyError('NOT_A_DECIMAL', `not a decimal string: ${JSON.stringify(value)}`);
  return money(value);
}

function checkFits(value: DecimalValue, scale: number, limit: string, what: string): void {
  if (value.decimalPlaces() > scale) throw new MoneyError('AMOUNT_SCALE', `${what} ${value.toFixed()} has more than ${scale} decimals`);
  if (value.abs().greaterThanOrEqualTo(limit)) throw new MoneyError('AMOUNT_OVERFLOW', `${what} ${value.toFixed()} does not fit`);
}

// An amount as stored: fits numeric(20,4) and uses at most the currency's minor units. Returns the
// canonical string (no trailing zeros, no exponent).
export function checkAmount(value: string, currency: string): Money {
  const units = minorUnits(currency);
  const parsed = parseDecimal(value);
  checkFits(parsed, AMOUNT_SCALE, AMOUNT_LIMIT, 'amount');
  if (parsed.decimalPlaces() > units) {
    throw new MoneyError('AMOUNT_SCALE', `${currency} allows ${units} decimals, got ${parsed.toFixed()}`);
  }
  return canonical(parsed);
}

export function roundToCurrency(value: DecimalValue, currency: string): DecimalValue {
  return value.toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_UP);
}

// quantity x unit price, kept exact, then rounded once to the currency (3 x 33,333.33333333 VND = 100,000).
export function lineAmount(quantity: string, unitAmount: string, currency: string): Money {
  const q = parseDecimal(quantity);
  const u = parseDecimal(unitAmount);
  checkFits(q, QUANTITY_SCALE, QUANTITY_LIMIT, 'quantity');
  checkFits(u, UNIT_AMOUNT_SCALE, UNIT_AMOUNT_LIMIT, 'unit amount');
  const rounded = roundToCurrency(q.times(u), currency);
  checkFits(rounded, AMOUNT_SCALE, AMOUNT_LIMIT, 'line amount');
  return canonical(rounded);
}

// Foreign amount to book currency through a direct quote (25,432.5 VND per USD), rounded once.
export function toBookCurrency(amount: string, foreignCurrency: string, rate: string, bookCurrency: string): Money {
  const a = parseDecimal(checkAmount(amount, foreignCurrency));
  const r = parseDecimal(rate);
  if (!r.isPositive() || r.isZero()) throw new MoneyError('INVALID_FX_RATE', `rate must be positive, got ${rate}`);
  checkFits(r, FX_RATE_SCALE, FX_RATE_LIMIT, 'fx rate');
  const converted = roundToCurrency(a.times(r), bookCurrency);
  checkFits(converted, AMOUNT_SCALE, AMOUNT_LIMIT, 'converted amount');
  return canonical(converted);
}

// The form an amount takes in a payload hash: exactly 4 decimals, as numeric(20,4)::text prints it.
export function fixed4(value: string): string {
  const parsed = parseDecimal(value);
  return parsed.isZero() ? '0.0000' : parsed.toFixed(AMOUNT_SCALE);
}

export function canonical(value: DecimalValue): Money {
  return value.isZero() ? '0' : value.toFixed();
}
