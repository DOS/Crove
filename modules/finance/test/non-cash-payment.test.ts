import { describe, expect, it } from 'vitest';
import { NON_CASH_THRESHOLDS, needsPaymentCheck, nonCashThreshold, paymentMethodKind } from '../src/domain/non-cash-payment.ts';

describe('non-cash payment threshold (#917)', () => {
  it('is 20 million VND up to 2025-06-30 and 5 million from 2025-07-01', () => {
    expect(nonCashThreshold('2025-06-30').amount).toBe('20000000');
    expect(nonCashThreshold('2025-07-01').amount).toBe('5000000');
    expect(nonCashThreshold('2019-01-01').amount).toBe('20000000');
    expect(nonCashThreshold('2026-10-21').amount).toBe('5000000');
  });

  it('keeps its rules as dated data, newest first, ending with an open-ended rule', () => {
    const dates = NON_CASH_THRESHOLDS.map((r) => r.from).filter((d): d is string => d !== null);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(NON_CASH_THRESHOLDS.at(-1)?.from).toBeNull();
    // A newer rule added on top wins from its date.
    const rules = [{ from: '2027-01-01', amount: '10000000', source: 'test' }, ...NON_CASH_THRESHOLDS];
    expect(nonCashThreshold('2026-12-31', rules).amount).toBe('5000000');
    expect(nonCashThreshold('2027-01-01', rules).amount).toBe('10000000');
  });

  it('flags an invoice at or above the threshold of its date, VAT included, unless it says it was paid by bank', () => {
    expect(needsPaymentCheck({ issueDate: '2025-07-01', total: '5000000', paymentMethod: 'TM' })).toBe(true);
    expect(needsPaymentCheck({ issueDate: '2025-07-01', total: '4999999.99', paymentMethod: 'TM' })).toBe(false);
    expect(needsPaymentCheck({ issueDate: '2025-06-30', total: '19999999', paymentMethod: 'TM' })).toBe(false);
    expect(needsPaymentCheck({ issueDate: '2025-06-30', total: '20000000', paymentMethod: null })).toBe(true);
    expect(needsPaymentCheck({ issueDate: '2026-09-15', total: '8000000', paymentMethod: 'CK' })).toBe(false);
    expect(needsPaymentCheck({ issueDate: '2026-09-15', total: '8000000', paymentMethod: 'TM/CK' })).toBe(true);
  });
});

describe('payment method of an invoice (HTTToan)', () => {
  it('reads bank only when every way named is non-cash', () => {
    for (const m of ['CK', 'Chuyển khoản', 'chuyen khoan', 'Thẻ', 'CK / Thẻ']) expect(paymentMethodKind(m), m).toBe('bank');
  });
  it('reads cash only when every way named is cash', () => {
    for (const m of ['TM', 'Tiền mặt', ' tm ']) expect(paymentMethodKind(m), m).toBe('cash');
  });
  it('leaves the rest unknown: empty, both, offsetting or anything else', () => {
    for (const m of [null, '', ' ', 'TM/CK', 'Tiền mặt hoặc chuyển khoản', 'TM,CK', 'Đối trừ công nợ', 'Khác']) expect(paymentMethodKind(m), String(m)).toBe('unknown');
  });
});
