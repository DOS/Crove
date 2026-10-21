// The wording of an invoice check (issue #677). Checks store a stable code and its parameters next to the
// Vietnamese sentence they were written with; the SPA words the code in the reader's language. A check written before
// #677 has no code, and a code this SPA does not know (or one missing a parameter) keeps its stored sentence.
// test/invoice-checks.test.ts checks that every code of INVOICE_CHECK_CODES is worded here.
import { INVOICE_CHECK_CODES, type Check, type InvoiceCheckCode } from '@crove/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';

export function isInvoiceCheckCode(code: string | undefined): code is InvoiceCheckCode {
  return code !== undefined && (INVOICE_CHECK_CODES as readonly string[]).includes(code);
}

// money formats an amount parameter (a decimal string) for the reader's locale.
export function invoiceCheckMessage(check: Check, t: Translate, money: (amount: string) => string): string {
  const code = check.code;
  if (!isInvoiceCheckCode(code)) return check.message;
  const p = check.params ?? {};
  const has = (...keys: string[]) => keys.every((key) => typeof p[key] === 'string');
  switch (code) {
    case 'currency.unsupported':
      return has('currency') ? t('invoiceChecks.currency.unsupported', { currency: p.currency ?? '' }) : check.message;
    case 'lines_sum.mismatch':
      return has('lines', 'subtotal') ? t('invoiceChecks.lines_sum.mismatch', { lines: money(p.lines ?? ''), subtotal: money(p.subtotal ?? '') }) : check.message;
    case 'seller_tax_code.checksum':
      return has('taxCode') ? t('invoiceChecks.seller_tax_code.checksum', { taxCode: p.taxCode ?? '' }) : check.message;
    case 'seller_tax_code.ok':
      return has('taxCode') ? t('invoiceChecks.seller_tax_code.ok', { taxCode: p.taxCode ?? '' }) : check.message;
    case 'related.replaces':
    case 'related.adjusts':
    case 'related.replaces_missing':
    case 'related.adjusts_missing':
      return has('invoice') ? t(`invoiceChecks.${code}`, { invoice: p.invoice ?? '' }) : check.message;
    case 'issue_date.ok':
      return has('date') ? t('invoiceChecks.issue_date.ok', { date: p.date ?? '' }) : check.message;
    case 'lines_sum.ok':
    case 'total.ok':
    case 'total.mismatch':
    case 'vat_breakdown.ok':
    case 'vat_breakdown.mismatch':
    case 'seller_tax_code.unreadable':
    case 'issue_date.invalid':
    case 'issue_date.future':
    case 'tax_authority_code.present':
    case 'tax_authority_code.missing':
    case 'signature.unverified':
    case 'signature.missing':
    case 'source.ai':
    case 'duplicate.found':
      return t(`invoiceChecks.${code}`);
  }
}
