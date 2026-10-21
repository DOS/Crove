import { describe, expect, it } from 'vitest';
import { checkRate, convertInvoice, fitted, foreignNote, toDong } from '../src/domain/foreign-currency.ts';

interface Line {
  amount: string;
  unitPrice: string | null;
}

const convert = (invoice: { subtotal: string; vatTotal: string; total: string; lines: Line[]; taxBreakdown?: Array<{ rate: string; taxableAmount: string; vatAmount: string }> }, rate: string) =>
  convertInvoice<Line, typeof invoice & { currency: string }>(
    { ...invoice, currency: 'usd' },
    rate,
    (l) => l.amount,
    (l, amount) => ({ ...l, amount }),
  );

describe('foreign-currency invoices booked in VND (#918)', () => {
  it('converts every amount at the rate, rounded half up to whole dong', () => {
    expect(toDong('100.5', checkRate('25450.5')).toFixed()).toBe('2557775');
    expect(toDong('0.01', checkRate('25450')).toFixed()).toBe('255');
    expect(toDong('0.02', checkRate('24.98')).toFixed()).toBe('0');
  });

  it('fits the lines to the converted subtotal, putting the difference on the largest line, the first of a tie', () => {
    // Three lines of 0.01 USD at 25,450: each 254.5 rounds to 255 (765), while 0.03 USD is 763.5, so 764.
    expect(fitted(['0.01', '0.01', '0.01'], checkRate('25450'), toDong('0.03', checkRate('25450')))).toEqual(['254', '255', '255']);
    expect(fitted(['5', '-1', '10'], checkRate('3'), toDong('14', checkRate('3')))).toEqual(['15', '-3', '30']);
    expect(fitted([], checkRate('3'), toDong('0', checkRate('3')))).toEqual([]);
  });

  it('keeps the entry balanced: lines add up to the subtotal, the VAT table to the VAT, and the total is their sum', () => {
    const { invoice, foreign } = convert(
      {
        subtotal: '100.03',
        vatTotal: '10.01',
        total: '110.04',
        lines: [
          { amount: '33.34', unitPrice: '33.34' },
          { amount: '33.34', unitPrice: '16.67' },
          { amount: '33.35', unitPrice: null },
        ],
        taxBreakdown: [
          { rate: '10%', taxableAmount: '66.68', vatAmount: '6.67' },
          { rate: '10%', taxableAmount: '33.35', vatAmount: '3.34' },
        ],
      },
      '25450.5',
    );
    const sum = (values: string[]) => values.reduce((a, v) => a + Number(v), 0);
    expect(invoice.subtotal).toBe(toDong('100.03', checkRate('25450.5')).toFixed());
    expect(sum(invoice.lines.map((l) => l.amount))).toBe(Number(invoice.subtotal));
    expect(sum((invoice.taxBreakdown ?? []).map((r) => r.vatAmount))).toBe(Number(invoice.vatTotal));
    expect(Number(invoice.total)).toBe(Number(invoice.subtotal) + Number(invoice.vatTotal));
    expect(invoice.lines.map((l) => l.unitPrice)).toEqual(['848519.67', '424259.835', null]);
    expect(foreign).toEqual({ currency: 'USD', rate: '25450.5', subtotal: '100.03', vatTotal: '10.01', total: '110.04' });
    expect(foreignNote(foreign)).toBe('USD 110.04, tỷ giá 25450.5');
  });

  it('refuses a rate that is not positive or has too many decimals', () => {
    for (const rate of ['0', '-1', '1.12345678901', 'abc']) expect(() => checkRate(rate), rate).toThrow();
    expect(checkRate('0.0000000001').toFixed()).toBe('0.0000000001');
  });
});
