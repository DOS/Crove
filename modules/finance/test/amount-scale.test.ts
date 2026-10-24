// The answer to a posting the definer refused because an amount has more decimals than the book currency uses (issue
// #1282, ADR-0021 decision 1). The refusal itself is tested on PostgreSQL in
// apps/kernel/test/finance-currency-scale.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import { amountScaleError } from '../src/ledger.ts';

const refusal = (detail: Record<string, unknown>) => ({ code: '22023', message: 'AMOUNT_SCALE', detail: JSON.stringify(detail) });

describe('amount scale refusal', () => {
  it('answers AMOUNT_SCALE with the line and the currency rule', () => {
    const vnd = amountScaleError(refusal({ lineNo: 2, currency: 'VND', minorUnits: 0, amount: '100.5' }));
    expect(vnd).toBeInstanceOf(DomainError);
    expect(vnd).toMatchObject({ code: 'AMOUNT_SCALE', status: 422, details: { lineNo: 2, currency: 'VND', minorUnits: 0, amount: '100.5' } });
    expect(vnd?.message).toContain('Dòng 2');
    expect(vnd?.message).toContain('100.5');
    expect(vnd?.message).toContain('VND không có số lẻ');

    const usd = amountScaleError(refusal({ lineNo: 1, currency: 'USD', minorUnits: 2, amount: '1.005' }));
    expect(usd?.message).toContain('USD chỉ có 2 chữ số sau dấu phẩy');
  });

  it('still answers when the detail is missing or malformed', () => {
    expect(amountScaleError({ code: '22023', message: 'AMOUNT_SCALE', detail: 'not json' })).toMatchObject({ code: 'AMOUNT_SCALE', status: 422 });
    expect(amountScaleError({ code: '22023', message: 'AMOUNT_SCALE' })?.message).toContain('Một dòng');
  });

  it('leaves every other error alone', () => {
    expect(amountScaleError({ code: '22023', message: 'UNKNOWN_CURRENCY' })).toBeNull();
    expect(amountScaleError({ code: '23514', message: 'AMOUNT_SCALE' })).toBeNull();
    expect(amountScaleError(new Error('AMOUNT_SCALE'))).toBeNull();
    expect(amountScaleError(null)).toBeNull();
  });
});
