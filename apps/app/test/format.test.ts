// Locale-aware money, number and date formatting (issue #47).
import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../src/lib/format.ts';

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
