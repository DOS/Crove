// Invoice check wording (issue #677): every code of INVOICE_CHECK_CODES reads in Vietnamese and English, a check
// written before #677 (no code) or with a code this SPA does not know keeps its stored sentence, and so does a known
// code whose parameters are missing.
import { describe, expect, it } from 'vitest';
import { INVOICE_CHECK_CODES, type Check } from '@crove/kernel-contract';
import { translatorFor } from '../src/i18n/runtime.ts';
import { invoiceCheckMessage } from '../src/lib/invoice-checks.ts';

const PARAMS = { currency: 'USD', rate: '25450', lines: '1800000', subtotal: '1900000', taxCode: '0101234564', date: '2026-10-13', invoice: 'C26TAB/1234', amount: '1000000.5', count: '2' };
// (count, lines: the unclassified-lines check of #2091 names how many lines and which; `lines` is also the sum of the lines-sum check.)
const check = (code: string | undefined, params: Record<string, string> | null = PARAMS): Check => ({
  id: code?.split('.')[0] ?? 'x',
  status: 'warn',
  message: 'STORED',
  ...(code ? { code } : {}),
  ...(params ? { params } : {}),
});
const format = { money: (amount: string) => `<${amount}>`, date: (date: string) => `[${date}]` };

describe('invoice check wording', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`words every code in ${locale}, with its parameters`, () => {
      const t = translatorFor(locale);
      for (const code of INVOICE_CHECK_CODES) {
        const text = invoiceCheckMessage(check(code), t, format);
        expect(text, code).not.toBe('STORED');
        expect(text, code).not.toContain('invoiceChecks.');
        expect(text, code).not.toMatch(/\{\w+\}/);
      }
    });
  }

  for (const locale of ['vi', 'en'] as const) {
    it(`gives each code its own sentence in ${locale}`, () => {
      const t = translatorFor(locale);
      const seen = new Map<string, string>();
      for (const code of INVOICE_CHECK_CODES) {
        const text = invoiceCheckMessage(check(code), t, format);
        // A total that does not add up once read "Chữ ký số hợp lệ, đã xác minh" through a fallthrough in the switch.
        expect(seen.get(text), `${code} reads like ${seen.get(text)}`).toBeUndefined();
        seen.set(text, code);
      }
    });
  }

  it('fills the parameters, amounts and dates through their formatters', () => {
    const vi = translatorFor('vi');
    const en = translatorFor('en');
    expect(invoiceCheckMessage(check('lines_sum.mismatch'), vi, format)).toBe('Tổng các dòng (<1800000>) lệch tiền trước thuế (<1900000>)');
    expect(invoiceCheckMessage(check('seller_tax_code.checksum'), en, format)).toBe("The seller's tax code 0101234564 fails its check digit");
    expect(invoiceCheckMessage(check('currency.unsupported'), en, format)).toContain('USD');
    // The date goes through the date formatter (dd/mm/yyyy in the app, #1332).
    expect(invoiceCheckMessage(check('issue_date.ok'), vi, format)).toBe('Ngày lập [2026-10-13]');
    // #916: the kind of a correction is worded in the reader's language.
    expect(invoiceCheckMessage(check('related.replaces_missing'), vi, format)).toContain('Hóa đơn thay thế cho hóa đơn C26TAB/1234');
    // #2091: the unclassified-lines check names how many lines and which.
    expect(invoiceCheckMessage(check('accounts.unclassified', { count: '2', lines: '2, 3' }), en, format)).toBe('No account rule matched 2 line(s) (line 2, 3): choose their accounts before approving');
    expect(invoiceCheckMessage(check('accounts.unclassified', { count: '2', lines: '2, 3' }), vi, format)).toContain('Chưa phân loại 2 dòng (dòng 2, 3)');
    expect(invoiceCheckMessage(check('accounts.unclassified', null), en, format)).toBe('STORED');
    expect(invoiceCheckMessage(check('related.adjusts_missing'), en, format)).toMatch(/^Adjustment invoice for invoice C26TAB\/1234/);
  });

  it('keeps the stored sentence without a code, for an unknown code and when a parameter is missing', () => {
    const t = translatorFor('en');
    expect(invoiceCheckMessage(check(undefined), t, format)).toBe('STORED');
    expect(invoiceCheckMessage(check('signature.revoked'), t, format)).toBe('STORED');
    expect(invoiceCheckMessage(check('lines_sum.mismatch', { lines: '1' }), t, format)).toBe('STORED');
    expect(invoiceCheckMessage(check('issue_date.ok', null), t, format)).toBe('STORED');
    // A code without parameters needs none.
    expect(invoiceCheckMessage(check('duplicate.found', null), t, format)).toBe('This invoice is already in the Inbox or in the books');
  });
});
