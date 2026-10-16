// Locale-aware money, number and date formatting (issue #47).
import { describe, expect, it } from 'vitest';
import { previewPurchaseJournal, toUnits } from '../src/lib/decimal.ts';
import { formatDate, formatDateTime, formatDecimal, formatMoney, formatNumber } from '../src/lib/format.ts';

// Intl separates the amount and the currency symbol with a no-break space.
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('formatMoney', () => {
  it('formats VND without decimals in both locales', () => {
    expect(plain(formatMoney('1980000.0000', 'vi'))).toBe('1.980.000 ₫');
    expect(plain(formatMoney('1980000.0000', 'en'))).toBe('₫1,980,000');
    expect(plain(formatMoney('-250000', 'vi'))).toBe('-250.000 ₫');
  });

  it('formats amounts beyond float precision exactly', () => {
    expect(plain(formatMoney('9007199254740993.0000', 'vi'))).toBe('9.007.199.254.740.993 ₫');
    expect(plain(formatMoney('12345678901234567.25', 'en', 'USD'))).toBe('US$12,345,678,901,234,567.25');
  });

  it('uses the precision of other currencies', () => {
    expect(plain(formatMoney('1234.5000', 'vi', 'USD'))).toBe('1.234,50 US$');
    expect(plain(formatMoney('1234.5', 'en', 'USD'))).toBe('US$1,234.50');
  });

  it('shows the decimals an amount has, up to the 4 the ledger keeps, never rounding to whole đồng', () => {
    expect(plain(formatMoney('100.5', 'vi'))).toBe('100,5 ₫');
    expect(plain(formatMoney('100.5000', 'en'))).toBe('₫100.5');
    expect(plain(formatMoney('-0.0001', 'vi'))).toBe('-0,0001 ₫');
    expect(plain(formatMoney('1234.5678', 'en', 'USD'))).toBe('US$1,234.5678');
    // Past the fourth decimal (an invoice line read with 8): half away from zero, as the ledger rounds.
    expect(plain(formatMoney('100.00005', 'vi'))).toBe('100,0001 ₫');
    expect(plain(formatMoney('-100.00005', 'vi'))).toBe('-100,0001 ₫');
  });

  // Issue #215: rounding each line to whole đồng could show two 100.5 lines as 101 + 101 next to a 201 total. Shown
  // exactly, the lines of an entry always add up to its totals on screen.
  it('never shows a journal line 1 ₫ off the total it adds up to', () => {
    const parse = (shown: string) => toUnits(plain(shown).replace(' ₫', '').replace(/\./g, '').replace(',', '.'));
    const cases: Array<[string, string[], string]> = [
      ['two half đồng lines', ['100.5', '100.5'], '0'],
      ['many fractional lines', ['0.4', '0.4', '0.4', '1000000.3333', '2.6667'], '100000.3'],
      ['negative adjustment', ['-100.5', '-0.5'], '-10.1'],
    ];
    for (const [name, amounts, vat] of cases) {
      const lines = amounts.map((amount, i) => ({ debitAccount: String(6000 + i), amount, vatRate: '10%' }));
      const entry = previewPurchaseJournal(lines, vat);
      const shown = entry.map((l) => ({ debit: parse(formatMoney(l.debit, 'vi')), credit: parse(formatMoney(l.credit, 'vi')) }));
      const debits = shown.reduce((acc, l) => acc + l.debit, 0n);
      const credits = shown.reduce((acc, l) => acc + l.credit, 0n);
      expect(debits, name).toBe(credits);
      // Each line on screen is the amount the ledger holds.
      expect(shown.map((l) => l.debit - l.credit), name).toEqual(entry.map((l) => toUnits(l.debit) - toUnits(l.credit)));
    }
  });

  it('keeps empty and unparseable values, and an unknown currency code', () => {
    expect(formatMoney(null, 'vi')).toBe('');
    expect(formatMoney(undefined, 'en')).toBe('');
    expect(formatMoney('', 'vi')).toBe('');
    expect(formatMoney('abc', 'vi')).toBe('abc');
    expect(plain(formatMoney('1000', 'vi', 'đồng'))).toBe('1.000 đồng');
  });
});

describe('formatNumber', () => {
  it('groups digits per locale', () => {
    expect(formatNumber(1234567, 'vi')).toBe('1.234.567');
    expect(formatNumber(1234567n, 'en')).toBe('1,234,567');
    expect(formatNumber('1234.5', 'vi')).toBe('1.234,5');
  });
});

describe('formatDate', () => {
  it('writes calendar dates day first without shifting the day', () => {
    expect(formatDate('2026-10-16', 'vi')).toBe('16/10/2026');
    expect(formatDate('2026-01-02T23:30:00.000Z', 'en')).toBe('02/01/2026');
    expect(formatDate('', 'vi')).toBe('');
    expect(formatDate(null, 'vi')).toBe('');
    expect(formatDate('not a date', 'vi')).toBe('not a date');
  });
});

describe('formatDateTime', () => {
  it('formats a timestamp in each locale', () => {
    // vi-VN short style writes a two-digit year ("15:05 16/10/26"), as before i18n.
    expect(formatDateTime('2026-10-16T08:05:00.000Z', 'vi')).toMatch(/16\/10\/26/);
    expect(formatDateTime('2026-10-16T08:05:00.000Z', 'en')).toMatch(/16\/10\/2026/);
    expect(formatDateTime(null, 'en')).toBe('');
  });
});

describe('formatDecimal', () => {
  it('keeps up to the given decimals, as AI budgets do', () => {
    expect(formatDecimal('1.123456', 'en', 6)).toBe('1.123456');
    expect(formatDecimal('0.000049', 'vi', 6)).toBe('0,000049');
    expect(formatDecimal('150.500000', 'vi', 6)).toBe('150,5');
    expect(formatDecimal('n/a', 'en', 6)).toBe('n/a');
  });
});
