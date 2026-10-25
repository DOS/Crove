// Amount fields (#1391): grouped as the reader's language groups digits, from any of the forms the form accepts.
import { describe, expect, it } from 'vitest';
import { groupAmount } from '../src/lib/amount-input.ts';
import { normalizeAmount } from '../src/lib/vouchers.ts';

describe('amount input', () => {
  it('groups a whole amount, typed in any accepted form', () => {
    for (const typed of ['32832000', '32.832.000', '32,832,000', ' 32 832 000 ']) {
      expect(groupAmount(typed, 'vi'), typed).toBe('32.832.000');
      expect(groupAmount(typed, 'en'), typed).toBe('32,832,000');
    }
    expect(groupAmount('999', 'vi')).toBe('999');
    expect(groupAmount('1000', 'vi')).toBe('1.000');
    // Past what a JS number holds exactly: still grouped digit by digit.
    expect(groupAmount('123456789012345678', 'vi')).toBe('123.456.789.012.345.678');
  });

  it('leaves what is not a whole amount as typed, and an empty field empty', () => {
    for (const typed of ['', '12a', '-3000', '1.5e3', '12.34', '1,5']) expect(groupAmount(typed, 'vi'), typed).toBe(typed);
  });

  it('groups to a value the form reads back as the same digits', () => {
    expect(normalizeAmount(groupAmount('32832000', 'vi'))).toBe('32832000');
    expect(normalizeAmount(groupAmount('32832000', 'en'))).toBe('32832000');
  });
});
