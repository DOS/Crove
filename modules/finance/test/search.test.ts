// What finance.search (#673) reads as an amount; the search itself runs against PostgreSQL in
// apps/kernel/test/finance-search.db.test.ts.
import { describe, expect, it } from 'vitest';
import { searchAmount } from '../src/search.ts';

describe('searchAmount', () => {
  it('reads dong amounts written the usual ways', () => {
    for (const typed of ['1.980.000', '1,980,000', '1 980 000', '1980000', ' 1.980.000 đ', '1.980.000đ', '1980000 VND', '1.980.000 vnđ']) {
      expect(searchAmount(typed), typed).toBe('1980000');
    }
    expect(searchAmount('500')).toBe('500');
    expect(searchAmount('0000123')).toBe('123');
    expect(searchAmount('0')).toBe('0');
  });

  it('reads nothing else as an amount', () => {
    for (const typed of ['1.98.000', '1.980,000', '19800,00', '1,5', 'dien luc', '0101234564-001', '12a', '', 'đ', '1.980.000.0000.000']) {
      expect(searchAmount(typed), typed).toBeNull();
    }
    // Longer than any amount the ledger holds.
    expect(searchAmount('1234567890123456')).toBeNull();
  });
});
