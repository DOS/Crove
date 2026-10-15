import { describe, expect, it } from 'vitest';
import { AmountFormatError, toParsed } from '../src/index.ts';

type Extracted = Parameters<typeof toParsed>[0];

const base: Extracted = {
  isInvoice: true,
  series: 'C26TAB',
  number: '00001234',
  issueDate: '2026-09-15',
  currency: 'VND',
  seller: { name: 'Người bán', taxCode: '0101234564', address: null },
  buyer: { name: 'Người mua', taxCode: null, address: null },
  lines: [{ description: 'Dịch vụ', unit: null, quantity: '1', unitPrice: '250000', amount: '250000', vatRate: '10%', isDiscount: false }],
  subtotal: '250000',
  vatTotal: '25000',
  total: '275000',
};

describe('AI extraction output', () => {
  it('keeps plain amounts and normalizes the invoice number', () => {
    const parsed = toParsed(base);
    expect(parsed?.total).toBe('275000');
    expect(parsed?.number).toBe('1234');
  });

  it('refuses printed VND amounts instead of reading 250.000 as 250', () => {
    expect(() => toParsed({ ...base, total: '275.000' })).toThrow(AmountFormatError);
    expect(() => toParsed({ ...base, subtotal: '1,250,000' })).toThrow(AmountFormatError);
  });

  it('allows decimals for foreign currencies and treats an empty VAT as zero', () => {
    const parsed = toParsed({ ...base, currency: 'usd', subtotal: '12.5', total: '12.5', vatTotal: '' });
    expect(parsed?.currency).toBe('USD');
    expect(parsed?.vatTotal).toBe('0');
  });
});
