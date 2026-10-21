import { describe, expect, it } from 'vitest';
import { parseExchangeRate } from '../src/lib/exchange-rate.ts';

describe('exchange rate typed by the accountant (#918)', () => {
  it('reads groups of three digits as thousands, in the Vietnamese and the English way', () => {
    expect(['25450', '25.450', '25,450', '25 450', '1.250.000', '1,250,000'].map(parseExchangeRate)).toEqual(['25450', '25450', '25450', '25450', '1250000', '1250000']);
  });
  it('reads one separator that is not followed by exactly three digits as the decimal point', () => {
    expect(['25450.5', '25450,5', '25.450,55', '25,450.55', '0,0001', '170.25'].map(parseExchangeRate)).toEqual(['25450.5', '25450.5', '25450.55', '25450.55', '0.0001', '170.25']);
  });
  it('refuses what it cannot read, zero and negative rates', () => {
    for (const text of ['', 'abc', '25.450,50.1', '25,450.50,1', '1.25,000', '-25450', '0', '0.000', '25450.12345678901']) expect(parseExchangeRate(text), text).toBeNull();
  });
});
