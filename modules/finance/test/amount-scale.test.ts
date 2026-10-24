// Amounts below what the book currency holds (issue #1282, ADR-0021 decision 1): the answer to a posting the definer
// refused (AMOUNT_SCALE), and the earlier refusal of an invoice with an amount below one dong (AMOUNT_BELOW_DONG), whose
// rounding is the accountant's decision (#1308). The definer itself is tested on PostgreSQL in
// apps/kernel/test/finance-currency-scale.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import { amountScaleError } from '../src/ledger.ts';
import { amountBelowDongError, belowOneDongBooked } from '../src/record.ts';

const refusal = (detail: Record<string, unknown>) => ({ code: '22023', message: 'AMOUNT_SCALE', detail: JSON.stringify(detail) });

describe('amount scale refusal', () => {
  it('answers AMOUNT_SCALE naming the account and the currency rule', () => {
    const vnd = amountScaleError(refusal({ lineNo: 2, account: '6422', currency: 'VND', minorUnits: 0, amount: '100.5' }));
    expect(vnd).toBeInstanceOf(DomainError);
    expect(vnd).toMatchObject({ code: 'AMOUNT_SCALE', status: 422, details: { lineNo: 2, account: '6422', currency: 'VND', minorUnits: 0, amount: '100.5' } });
    expect(vnd?.message).toContain('tài khoản 6422');
    expect(vnd?.message).toContain('100.5');
    expect(vnd?.message).toContain('VND không có số lẻ');
    expect(vnd?.message).toContain('làm tròn rồi ghi lại');

    const usd = amountScaleError(refusal({ lineNo: 1, account: '331', currency: 'USD', minorUnits: 2, amount: '1.005' }));
    expect(usd?.message).toContain('USD chỉ có 2 chữ số sau dấu phẩy');
  });

  it('still answers when the detail is missing or malformed', () => {
    expect(amountScaleError({ code: '22023', message: 'AMOUNT_SCALE', detail: 'not json' })).toMatchObject({ code: 'AMOUNT_SCALE', status: 422 });
    expect(amountScaleError({ code: '22023', message: 'AMOUNT_SCALE' })?.message).toContain('Bút toán có số tiền');
  });

  it('leaves every other error alone', () => {
    expect(amountScaleError({ code: '22023', message: 'UNKNOWN_CURRENCY' })).toBeNull();
    expect(amountScaleError({ code: '22023', message: 'AMOUNT_INVALID' })).toBeNull();
    expect(amountScaleError({ code: '23514', message: 'AMOUNT_SCALE' })).toBeNull();
    expect(amountScaleError(new Error('AMOUNT_SCALE'))).toBeNull();
    expect(amountScaleError(null)).toBeNull();
  });
});

describe('invoice amounts below one dong', () => {
  const line = (amount: string) => ({ lineNo: 1, description: 'x', unit: null, quantity: null, unitPrice: null, amount, vatRate: null, debitAccount: '6422', reason: '' });
  const payload = (amounts: { line: string; subtotal: string; vatTotal: string; total: string }) =>
    ({ invoice: { subtotal: amounts.subtotal, vatTotal: amounts.vatTotal, total: amounts.total }, lines: [line(amounts.line)] }) as unknown as Parameters<
      typeof belowOneDongBooked
    >[0];

  it('finds the first booked amount with a fraction of a dong', () => {
    expect(belowOneDongBooked(payload({ line: '1000000', subtotal: '1000000', vatTotal: '100000', total: '1100000' }))).toBeNull();
    expect(belowOneDongBooked(payload({ line: '1000000.0000', subtotal: '1000000', vatTotal: '100000.00', total: '1100000' }))).toBeNull();
    expect(belowOneDongBooked(payload({ line: '1000000.5', subtotal: '1000000.5', vatTotal: '100000', total: '1100000.5' }))).toBe('1000000.5');
    expect(belowOneDongBooked(payload({ line: '1000000', subtotal: '1000000', vatTotal: '100000.05', total: '1100000.05' }))).toBe('100000.05');
  });

  it('refuses with AMOUNT_BELOW_DONG, says the accountant decides, and rounds nothing', () => {
    const error = amountBelowDongError('1000000.5');
    expect(error).toMatchObject({ code: 'AMOUNT_BELOW_DONG', status: 422, details: { amount: '1000000.5' } });
    expect(error.message).toContain('dưới một đồng (1000000.5)');
    expect(error.message).toContain('Kế toán cần quyết định cách làm tròn');
    expect(amountBelowDongError(null).details).toBeUndefined();
  });
});
