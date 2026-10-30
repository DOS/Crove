// Invoice check codes (issue #677): every outcome checkInvoice and the extraction job can write carries a code of
// INVOICE_CHECK_CODES, named after its check id, and every listed code is one they can write. The SPA words exactly
// that list (apps/app/test/invoice-checks.test.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INVOICE_CHECK_CODES, zCheck } from '@crove/kernel-contract';
import { checkInvoice, classificationCheck, enterpriseCheckDigit, SIGNATURE_REASONS, type InvoiceCheck, type ParsedInvoice } from '@crove/l10n-vn';
import { relatedCheck } from '../src/extract.ts';
import { enteredRateCheck } from '../src/record.ts';

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
  // A foreign-currency e-invoice with its own rate (#918), booked at it.
  invoice((i) => {
    i.currency = 'USD';
    i.exchangeRate = '25450';
  }),
  invoice((i) => {
    i.currency = 'USD';
    i.exchangeRate = null;
    i.subtotal = '1';
    i.total = '1';
    i.taxBreakdown = i.taxBreakdown.map((t) => ({ ...t, vatAmount: '1' }));
    i.issueDate = '2999-01-01';
    i.taxAuthorityCode = null;
    i.hasSignature = false;
  }),
  // A VND invoice with an amount below one dong (#1282).
  invoice((i) => {
    i.total = `${i.total}.5`;
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
      i.signature = { status: 'unverified', reason, signer: null, issuer: null, signedAt: null };
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
  // And these, for a replacement or an adjustment invoice whose original is in the books or not (#916).
  const related = (kind: 'replacement' | 'adjustment', documentId: string | null) =>
    relatedCheck({ kind, template: '1', series: 'C26TAB', number: '1234', issueDate: '2026-09-15', documentId });
  const ORIGINAL = '00000000-0000-7000-8000-000000000001';
  const checks = [
    ...VARIANTS.flatMap((v) => checkInvoice(v, '2026-10-13')),
    DUPLICATE,
    related('replacement', ORIGINAL),
    related('adjustment', ORIGINAL),
    related('replacement', null),
    related('adjustment', null),
    // And the reviser this one, for a rate the accountant entered (#918).
    enteredRateCheck('USD', '25450'),
    // And the account check (#2091): lines no rule matched, and every line with its account.
    ...[[{ lineNo: 1, debitAccount: '000' }], [{ lineNo: 1, debitAccount: '6422' }]].map((lines) => classificationCheck(lines)!),
  ];

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
    expect(byCode.get('currency.converted')?.params).toEqual({ currency: 'USD', rate: '25450' });
    expect(byCode.get('currency.rate_entered')?.params).toEqual({ currency: 'USD', rate: '25450' });
    expect(byCode.get('lines_sum.mismatch')?.params).toEqual({ lines: expect.any(String), subtotal: '1' });
    expect(byCode.get('seller_tax_code.ok')?.params).toEqual({ taxCode: VALID_CODE });
    expect(byCode.get('issue_date.ok')?.params).toEqual({ date: parsed.issueDate });
    expect(byCode.get('amount_scale.fraction')?.params).toEqual({ amount: '1980000.5' });
  });

  it('fails a VND invoice with an amount below one dong, and not a foreign one or a whole-dong one (#1282)', () => {
    const scale = (i: ParsedInvoice) => checkInvoice(i, '2026-10-13').filter((c) => c.id === 'amount_scale');
    expect(scale(invoice())).toEqual([]);
    expect(scale(invoice((i) => (i.lines[0]!.amount = `${i.lines[0]!.amount}.0000`)))).toEqual([]);
    expect(scale(invoice((i) => (i.lines[0]!.amount = `${i.lines[0]!.amount}.25`)))).toMatchObject([{ status: 'fail', code: 'amount_scale.fraction' }]);
    expect(scale(invoice((i) => (i.vatTotal = `${i.vatTotal}.5`)))).toMatchObject([{ status: 'fail' }]);
    expect(
      scale(
        invoice((i) => {
          i.currency = 'USD';
          i.exchangeRate = '25450';
          i.total = '100.25';
        }),
      ),
    ).toEqual([]);
  });

  it('shows only the start of a currency that is not a code, so the check always fits its schema', () => {
    const [check] = checkInvoice(invoice((i) => (i.currency = 'X'.repeat(2000))), '2026-10-13');
    expect(check).toMatchObject({ id: 'currency', params: { currency: 'X'.repeat(20) } });
    expect(zCheck.safeParse(check).success).toBe(true);
  });
});
