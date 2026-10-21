// Invoice check codes (issue #677): every outcome checkInvoice and the extraction job can write carries a code of
// INVOICE_CHECK_CODES, named after its check id, and every listed code is one they can write. The SPA words exactly
// that list (apps/app/test/invoice-checks.test.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INVOICE_CHECK_CODES, zCheck } from '@crove/kernel-contract';
import { checkInvoice, enterpriseCheckDigit, SIGNATURE_REASONS, type InvoiceCheck, type ParsedInvoice } from '@crove/l10n-vn';

const parsed = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;
// A checksum-valid code for the "valid" outcome, computed here rather than written out, so no valid code sits in a
// test file (the MST fixture guard); the same synthetic prefix as the guard's own test.
const VALID_CODE = `990000001${enterpriseCheckDigit('990000001')}`;
const invoice = (change: (i: ParsedInvoice) => void = () => {}): ParsedInvoice => {
  const copy = structuredClone(parsed);
  change(copy);
  return copy;
};

// One invoice per outcome, so that every branch of checkInvoice runs at least once.
const VARIANTS: ParsedInvoice[] = [
  invoice(),
  invoice((i) => {
    i.currency = 'USD';
    i.subtotal = '1';
    i.total = '1';
    i.taxBreakdown = i.taxBreakdown.map((t) => ({ ...t, vatAmount: '1' }));
    i.issueDate = '2999-01-01';
    i.taxAuthorityCode = null;
    i.hasSignature = false;
  }),
  invoice((i) => {
    i.seller.taxCode = 'not a code';
    i.issueDate = '2026-02-30';
  }),
  invoice((i) => {
    i.seller.taxCode = VALID_CODE;
    i.source = 'ai';
  }),
  // The signature verification (#674): verified, each reason, and an answer from a sandbox without it.
  invoice((i) => {
    i.signature = { status: 'verified', reason: null, signer: 'CÔNG TY TNHH DỊCH VỤ MẪU', issuer: 'CA', signedAt: '2026-09-15T03:00:00.000Z' };
  }),
  ...SIGNATURE_REASONS.map((reason) =>
    invoice((i) => {
      i.signature = { status: reason === 'cash_register' ? 'not_applicable' : 'unverified', reason, signer: null, issuer: null, signedAt: null };
    }),
  ),
  invoice((i) => {
    delete i.signature;
  }),
  invoice((i) => {
    delete i.signature;
    i.hasSignature = false;
  }),
];
// The extraction job adds this one (modules/finance/src/extract.ts).
const DUPLICATE: InvoiceCheck = { id: 'duplicate', status: 'fail', code: 'duplicate.found', message: 'Hóa đơn này đã có trong Inbox hoặc đã ghi sổ' };

describe('invoice check codes', () => {
  const checks = [...VARIANTS.flatMap((v) => checkInvoice(v, '2026-10-13')), DUPLICATE];

  it('gives every check a listed code named after its id, and fits the stored check schema', () => {
    for (const check of checks) {
      expect(INVOICE_CHECK_CODES, check.code).toContain(check.code);
      expect(check.code.startsWith(`${check.id}.`), check.code).toBe(true);
      expect(zCheck.safeParse(check).success, check.code).toBe(true);
    }
  });

  it('writes every listed code, so the list holds no wording nothing uses', () => {
    expect(new Set(checks.map((c) => c.code))).toEqual(new Set(INVOICE_CHECK_CODES));
  });

  it('carries the values of the sentence as parameters', () => {
    const byCode = new Map(checks.map((c) => [c.code, c]));
    expect(byCode.get('currency.unsupported')?.params).toEqual({ currency: 'USD' });
    expect(byCode.get('lines_sum.mismatch')?.params).toEqual({ lines: expect.any(String), subtotal: '1' });
    expect(byCode.get('seller_tax_code.ok')?.params).toEqual({ taxCode: VALID_CODE });
    expect(byCode.get('issue_date.ok')?.params).toEqual({ date: parsed.issueDate });
  });

  it('shows only the start of a currency that is not a code, so the check always fits its schema', () => {
    const [check] = checkInvoice(invoice((i) => (i.currency = 'X'.repeat(2000))), '2026-10-13');
    expect(check).toMatchObject({ id: 'currency', params: { currency: 'X'.repeat(20) } });
    expect(zCheck.safeParse(check).success).toBe(true);
  });
});
