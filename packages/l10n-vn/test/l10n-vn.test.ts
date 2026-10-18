import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bookableLines,
  bookableSaleLines,
  buildPurchaseJournal,
  buildSalesJournal,
  checkInvoice,
  enterpriseCheckDigit,
  isCalendarDate,
  isFixedAssetAccount,
  journalIsBalanced,
  looksLikeEInvoiceXml,
  parseTaxCode,
  suggestDebitAccount,
  type ParsedInvoice,
} from '../src/index.ts';

// The parsed form of the e-invoice fixture. This package holds no parser (External-tenant gate T12); the parser's
// own tests in apps/extract check that it turns the XML fixture into exactly this.
const parsed = JSON.parse(readFileSync(new URL('./fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;
const invoice = (): ParsedInvoice => structuredClone(parsed);
const encode = (text: string) => new TextEncoder().encode(text);

describe('tax codes', () => {
  it('accepts a 10-digit code with a valid check digit', () => {
    expect(parseTaxCode('0101234565')).toEqual({ normalized: '0101234565', kind: 'enterprise', checksumValid: true }); // mst-guard: allow the checksum must accept a valid code (synthetic, not a known business)
  });
  it('flags a wrong check digit', () => {
    expect(parseTaxCode('0101234564')?.checksumValid).toBe(false);
  });
  it('normalizes branch codes and individual codes', () => {
    expect(parseTaxCode('0101234564 001')?.normalized).toBe('0101234564-001');
    expect(parseTaxCode('001099012345')).toEqual({ normalized: '001099012345', kind: 'individual', checksumValid: null });
    expect(parseTaxCode('abc')).toBeNull();
  });
});

describe('e-invoice detection', () => {
  it('recognizes an invoice or a tax authority message from its first bytes, without parsing', () => {
    expect(looksLikeEInvoiceXml(encode('<?xml version="1.0" encoding="UTF-8"?>\n<HDon><DLHDon/></HDon>'))).toBe(true);
    expect(looksLikeEInvoiceXml(encode('<inv:HDon xmlns:inv="urn:x">'))).toBe(true);
    expect(looksLikeEInvoiceXml(encode('<TDiep><DLieu><HDon/></DLieu></TDiep>'))).toBe(true);
    expect(looksLikeEInvoiceXml(encode('<root><a>1</a></root>'))).toBe(false);
    expect(looksLikeEInvoiceXml(encode('%PDF-1.4'))).toBe(false);
  });
});

describe('invoice checks', () => {
  it('passes the deterministic checks', () => {
    const checks = checkInvoice(invoice(), '2026-10-13');
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({ lines_sum: 'pass', total: 'pass', vat_breakdown: 'pass', issue_date: 'pass' });
    expect(byId.signature).toBe('warn');
    // The synthetic fixture seller has a checksum-invalid MST on purpose (see mst-fixture-guard.test.ts).
    expect(byId.seller_tax_code).toBe('warn');
  });

  it('passes the seller tax code check when the check digit is right', () => {
    const changed = invoice();
    changed.seller.taxCode = `990000001${enterpriseCheckDigit('990000001')}`;
    expect(checkInvoice(changed, '2026-10-13').find((c) => c.id === 'seller_tax_code')?.status).toBe('pass');
  });

  it('fails the lines check when amounts do not add up', () => {
    const changed = invoice();
    changed.subtotal = '1900000';
    expect(checkInvoice(changed, '2026-10-13').find((c) => c.id === 'lines_sum')?.status).toBe('fail');
  });

  it('requires amounts to match exactly, since the payable is posted at the invoice total', () => {
    const changed = invoice();
    changed.total = '1979999';
    expect(checkInvoice(changed, '2026-10-13').find((c) => c.id === 'total')?.status).toBe('fail');
  });

  it.each(['2026-02-30', '2026-13-01', '0000-00-00', '13/10/2026', ''])('fails the date %j without throwing', (issueDate) => {
    const changed = invoice();
    changed.issueDate = issueDate;
    expect(checkInvoice(changed, '2026-10-13').find((c) => c.id === 'issue_date')?.status).toBe('fail');
    expect(isCalendarDate(issueDate)).toBe(false);
  });

  it('fails the currency check for foreign-currency invoices', () => {
    const changed = invoice();
    changed.currency = 'USD';
    expect(checkInvoice(changed, '2026-10-13').find((c) => c.id === 'currency')?.status).toBe('fail');
    expect(checkInvoice(invoice(), '2026-10-13').some((c) => c.id === 'currency')).toBe(false);
  });
});

describe('TT133 accounting', () => {
  it('suggests accounts from the description, preferring the vendor rule', () => {
    const line = { lineNo: 1, nature: 'goods' as const, code: null, description: 'Cước internet', unit: null, quantity: null, unitPrice: null, amount: '100', vatRate: '10%' };
    expect(suggestDebitAccount(line, null).account).toBe('6422');
    expect(suggestDebitAccount({ ...line, description: 'Phí quảng cáo Google' }, null).account).toBe('6421');
    expect(suggestDebitAccount({ ...line, description: 'Laptop văn phòng', amount: '35000000' }, null).account).toBe('211');
    expect(suggestDebitAccount(line, '156').account).toBe('156');
  });

  it('builds a balanced purchase entry with discount, VAT and payable', () => {
    const source = invoice();
    const lines = bookableLines(source, null);
    expect(lines.map((l) => [l.debitAccount, l.amount])).toEqual([
      ['6422', '1000000'],
      ['6421', '1000000'],
      ['6422', '-200000'],
    ]);
    const journal = buildPurchaseJournal(lines, source.vatTotal, 'HĐ C26TAB-1234');
    expect(journal.map((j) => [j.accountCode, j.debit, j.credit])).toEqual([
      ['6421', '1000000', '0'],
      ['6422', '800000', '0'],
      ['1331', '180000', '0'],
      ['331', '0', '1980000'],
    ]);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it('credits expense and input VAT for an adjustment invoice with negative amounts', () => {
    const lines = [{ lineNo: 1, debitAccount: '6422', amount: '-1000000' }];
    const journal = buildPurchaseJournal(lines as Parameters<typeof buildPurchaseJournal>[0], '-100000', 'HĐ điều chỉnh');
    expect(journal.map((j) => [j.accountCode, j.debit, j.credit])).toEqual([
      ['6422', '0', '1000000'],
      ['1331', '0', '100000'],
      ['331', '1100000', '0'],
    ]);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it('posts on sub-accounts as given, and books input VAT of a fixed asset sub-account to 1332 (#319)', () => {
    const lines = [
      { lineNo: 1, debitAccount: '211.XE', amount: '50000000', vatRate: '10%' },
      { lineNo: 2, debitAccount: '6422.HCM', amount: '1000000', vatRate: '10%' },
    ];
    const journal = buildPurchaseJournal(lines as Parameters<typeof buildPurchaseJournal>[0], '5100000', 'HĐ xe');
    expect(journal.map((j) => [j.accountCode, j.debit, j.credit])).toEqual([
      ['211.XE', '50000000', '0'],
      ['6422.HCM', '1000000', '0'],
      ['1331', '100000', '0'],
      ['1332', '5000000', '0'],
      ['331', '0', '56100000'],
    ]);
    expect(isFixedAssetAccount('2111')).toBe(true);
    expect(isFixedAssetAccount('2141')).toBe(false);
  });
});

describe('TT133 sales entries (#313)', () => {
  it('proposes every line of a sale to 511 and posts Dr 131, Cr 511, Cr 3331', () => {
    const source = invoice();
    const lines = bookableSaleLines(source);
    expect(lines.map((l) => [l.debitAccount, l.amount])).toEqual([
      ['511', '1000000'],
      ['511', '1000000'],
      ['511', '-200000'],
    ]);
    expect(new Set(lines.map((l) => l.reason))).toEqual(new Set(['Doanh thu bán hàng và cung cấp dịch vụ']));
    const journal = buildSalesJournal(lines, source.vatTotal, 'HĐ bán C26TAB-1234');
    expect(journal.map((j) => [j.lineNo, j.accountCode, j.debit, j.credit])).toEqual([
      [1, '131', '1980000', '0'],
      [2, '511', '0', '1800000'],
      [3, '3331', '0', '180000'],
    ]);
    expect(journal.find((j) => j.accountCode === '3331')?.memo).toBe('Thuế GTGT HĐ bán C26TAB-1234');
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it('credits each revenue account, and debits one whose lines net below zero', () => {
    const lines = [
      { lineNo: 1, debitAccount: '5113', amount: '3000000' },
      { lineNo: 2, debitAccount: '5111', amount: '1000000' },
      { lineNo: 3, debitAccount: '5211', amount: '-500000' },
    ];
    const journal = buildSalesJournal(lines as Parameters<typeof buildSalesJournal>[0], '350000', 'HĐ bán');
    expect(journal.map((j) => [j.accountCode, j.debit, j.credit])).toEqual([
      ['131', '3850000', '0'],
      ['5111', '0', '1000000'],
      ['5113', '0', '3000000'],
      ['5211', '500000', '0'],
      ['3331', '0', '350000'],
    ]);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it('reverses the sides for an adjustment invoice that lowers a sale', () => {
    const lines = [{ lineNo: 1, debitAccount: '511', amount: '-1000000' }];
    const journal = buildSalesJournal(lines as Parameters<typeof buildSalesJournal>[0], '-100000', 'HĐ điều chỉnh giảm');
    expect(journal.map((j) => [j.accountCode, j.debit, j.credit])).toEqual([
      ['131', '0', '1100000'],
      ['511', '1000000', '0'],
      ['3331', '100000', '0'],
    ]);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it('posts nothing on 3331 for a sale without VAT', () => {
    const lines = [{ lineNo: 1, debitAccount: '511', amount: '500000' }];
    const journal = buildSalesJournal(lines as Parameters<typeof buildSalesJournal>[0], '0', 'HĐ bán KCT');
    expect(journal.map((j) => [j.accountCode, j.debit, j.credit])).toEqual([
      ['131', '500000', '0'],
      ['511', '0', '500000'],
    ]);
  });
});