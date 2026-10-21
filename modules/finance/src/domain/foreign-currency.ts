// Foreign-currency invoices booked in VND (#918). TT133 books are kept in VND at the rate of the transaction: the
// invoice's own exchange rate (TGia of an e-invoice XML), or the rate the accountant enters for an invoice read without
// one. Every amount is converted and rounded half up to whole dong; the totals are converted first and the parts are
// fitted to them, so the entry balances and the parts always add up to the totals:
//   - subtotal and VAT are each converted, and the total is their sum;
//   - each line is converted, and the rounding difference against the converted subtotal goes to the line with the
//     largest amount (the first of them on a tie);
//   - the invoice's VAT table is fitted the same way to the converted subtotal of its rows and to the converted VAT.
// Exchange differences on payment (515, 635) are not booked here.
import { Decimal, money, type DecimalValue, type Money } from '@crove/l10n-vn';
import { FX_RATE_LIMIT, FX_RATE_SCALE, MoneyError, canonical, parseDecimal, roundToCurrency } from './money.ts';

export const BOOK_CURRENCY = 'VND';

// A rate as a positive decimal within the fx rate scale, or MoneyError INVALID_FX_RATE.
export function checkRate(rate: string): DecimalValue {
  const r = parseDecimal(rate);
  if (!r.isPositive() || r.isZero() || r.decimalPlaces() > FX_RATE_SCALE || r.abs().greaterThanOrEqualTo(FX_RATE_LIMIT)) {
    throw new MoneyError('INVALID_FX_RATE', `rate must be positive with at most ${FX_RATE_SCALE} decimals, got ${rate}`);
  }
  return r;
}

export function toDong(amount: Money, rate: DecimalValue): DecimalValue {
  return roundToCurrency(money(amount).times(rate), BOOK_CURRENCY);
}

// Each value converted, then the difference against target added to the value of the largest magnitude.
export function fitted(values: readonly Money[], rate: DecimalValue, target: DecimalValue): Money[] {
  const converted = values.map((v) => toDong(v, rate));
  if (converted.length === 0) return [];
  const diff = converted.reduce((acc, v) => acc.minus(v), target);
  if (!diff.isZero()) {
    let largest = 0;
    converted.forEach((v, i) => {
      if (v.abs().greaterThan(converted[largest]!.abs())) largest = i;
    });
    converted[largest] = converted[largest]!.plus(diff);
  }
  return converted.map(canonical);
}

// A unit price in VND, kept to 4 decimals like other amounts.
export function unitPriceToDong(unitPrice: Money | null, rate: DecimalValue): Money | null {
  return unitPrice === null ? null : canonical(money(unitPrice).times(rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
}

export interface ForeignAmounts {
  currency: string;
  rate: Money;
  subtotal: Money;
  vatTotal: Money;
  total: Money;
}

export interface ConvertibleInvoice<L> {
  currency: string;
  subtotal: Money;
  vatTotal: Money;
  total: Money;
  lines: L[];
  taxBreakdown?: Array<{ rate: string; taxableAmount: Money; vatAmount: Money }> | undefined;
}

// The invoice in VND: lines (their signed amount as `amountOf` reads it, written back with `withAmount`), totals and
// VAT table, with the original currency, rate and totals.
export function convertInvoice<L extends { unitPrice: Money | null }, I extends ConvertibleInvoice<L>>(
  invoice: I,
  rateText: string,
  amountOf: (line: L) => Money,
  withAmount: (line: L, amount: Money) => L,
): { invoice: I; foreign: ForeignAmounts } {
  const rate = checkRate(rateText);
  const subtotal = toDong(invoice.subtotal, rate);
  const vat = toDong(invoice.vatTotal, rate);
  const amounts = fitted(invoice.lines.map(amountOf), rate, subtotal);
  const lines = invoice.lines.map((line, i) => ({ ...withAmount(line, amounts[i]!), unitPrice: unitPriceToDong(line.unitPrice, rate) }));
  const rows = invoice.taxBreakdown;
  let taxBreakdown = rows;
  if (rows && rows.length > 0) {
    const taxableTarget = toDong(canonical(rows.reduce((acc, r) => acc.plus(money(r.taxableAmount)), money(0))), rate);
    const taxable = fitted(rows.map((r) => r.taxableAmount), rate, taxableTarget);
    const vats = fitted(rows.map((r) => r.vatAmount), rate, vat);
    taxBreakdown = rows.map((r, i) => ({ ...r, taxableAmount: taxable[i]!, vatAmount: vats[i]! }));
  }
  return {
    invoice: {
      ...invoice,
      subtotal: canonical(subtotal),
      vatTotal: canonical(vat),
      total: canonical(subtotal.plus(vat)),
      lines,
      ...(taxBreakdown ? { taxBreakdown } : {}),
    },
    foreign: {
      currency: invoice.currency.toUpperCase(),
      rate: canonical(rate),
      subtotal: invoice.subtotal,
      vatTotal: invoice.vatTotal,
      total: invoice.total,
    },
  };
}

// The original amount and rate as an entry's description shows them: "USD 400, tỷ giá 25450".
export function foreignNote(foreign: Pick<ForeignAmounts, 'currency' | 'rate' | 'total'>): string {
  return `${foreign.currency} ${canonical(money(foreign.total))}, tỷ giá ${canonical(money(foreign.rate))}`;
}
