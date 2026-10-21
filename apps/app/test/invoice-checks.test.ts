// Invoice check wording (issue #677): every code of INVOICE_CHECK_CODES reads in Vietnamese and English, a check
// written before #677 (no code) or with a code this SPA does not know keeps its stored sentence, and so does a known
// code whose parameters are missing.
import { describe, expect, it } from 'vitest';
import { INVOICE_CHECK_CODES, type Check } from '@crove/kernel-contract';
import { translatorFor } from '../src/i18n/runtime.ts';
import { invoiceCheckMessage } from '../src/lib/invoice-checks.ts';

const PARAMS = { currency: 'USD', rate: '25450', lines: '1800000', subtotal: '1900000', taxCode: '0101234564', date: '2026-10-13', invoice: 'C26TAB/1234' };
const check = (code: string | undefined, params: Record<string, string> | null = PARAMS): Check => ({
  id: code?.split('.')[0] ?? 'x',
  status: 'warn',
  message: 'STORED',
  ...(code ? { code } : {}),
  ...(params ? { params } : {}),
});
const money = (amount: string) => `<${amount}>`;

describe('invoice check wording', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`words every code in ${locale}, with its parameters`, () => {
      const t = translatorFor(locale);
      for (const code of INVOICE_CHECK_CODES) {
        const text = invoiceCheckMessage(check(code), t, money);
        expect(text, code).not.toBe('STORED');
        expect(text, code).not.toContain('invoiceChecks.');
        expect(text, code).not.toMatch(/\{\w+\}/);
      }
    });
  }

  it('fills the parameters, amounts through the money formatter', () => {
    const vi = translatorFor('vi');
    const en = translatorFor('en');
    expect(invoiceCheckMessage(check('lines_sum.mismatch'), vi, money)).toBe('Tổng các dòng (<1800000>) lệch tiền trước thuế (<1900000>)');
    expect(invoiceCheckMessage(check('seller_tax_code.checksum'), en, money)).toBe("The seller's tax code 0101234564 fails its check digit");
    expect(invoiceCheckMessage(check('currency.unsupported'), en, money)).toContain('USD');
    expect(invoiceCheckMessage(check('issue_date.ok'), vi, money)).toBe('Ngày lập 2026-10-13');
    // #916: the kind of a correction is worded in the reader's language.
    expect(invoiceCheckMessage(check('related.replaces_missing'), vi, money)).toContain('Hóa đơn thay thế cho hóa đơn C26TAB/1234');
    expect(invoiceCheckMessage(check('related.adjusts_missing'), en, money)).toMatch(/^Adjustment invoice for invoice C26TAB\/1234/);
  });

  it('keeps the stored sentence without a code, for an unknown code and when a parameter is missing', () => {
    const t = translatorFor('en');
    expect(invoiceCheckMessage(check(undefined), t, money)).toBe('STORED');
    expect(invoiceCheckMessage(check('signature.revoked'), t, money)).toBe('STORED');
    expect(invoiceCheckMessage(check('lines_sum.mismatch', { lines: '1' }), t, money)).toBe('STORED');
    expect(invoiceCheckMessage(check('issue_date.ok', null), t, money)).toBe('STORED');
    // A code without parameters needs none.
    expect(invoiceCheckMessage(check('duplicate.found', null), t, money)).toBe('This invoice is already in the Inbox or in the books');
  });
});
