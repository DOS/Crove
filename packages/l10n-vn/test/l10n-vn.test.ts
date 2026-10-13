import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EInvoiceParseError,
  bookableLines,
  buildPurchaseJournal,
  checkInvoice,
  journalIsBalanced,
  looksLikeEInvoiceXml,
  parseEInvoiceXml,
  parseTaxCode,
  suggestDebitAccount,
} from '../src/index.ts';

const fixture = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));

describe('tax codes', () => {
  it('accepts a 10-digit code with a valid check digit', () => {
    expect(parseTaxCode('0101234565')).toEqual({ normalized: '0101234565', kind: 'enterprise', checksumValid: true });
  });
  it('flags a wrong check digit', () => {
    expect(parseTaxCode('0101234564')?.checksumValid).toBe(false);
  });
  it('normalizes branch codes and individual codes', () => {
    expect(parseTaxCode('0101234565 001')?.normalized).toBe('0101234565-001');
    expect(parseTaxCode('001099012345')).toEqual({ normalized: '001099012345', kind: 'individual', checksumValid: null });
    expect(parseTaxCode('abc')).toBeNull();
  });
});

describe('e-invoice XML', () => {
  it('detects and parses a Decree 123 invoice', () => {
    expect(looksLikeEInvoiceXml(fixture)).toBe(true);
    const invoice = parseEInvoiceXml(fixture);
    expect(invoice.series).toBe('C26TAB');
    expect(invoice.number).toBe('1234');
    expect(invoice.issueDate).toBe('2026-09-15');
    expect(invoice.seller.taxCode).toBe('0101234565');
    expect(invoice.buyer.name).toBe('CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU');
    expect(invoice.lines).toHaveLength(4);
    expect(invoice.lines[2]?.nature).toBe('discount');
    expect(invoice.subtotal).toBe('1800000');
    expect(invoice.vatTotal).toBe('180000');
    expect(invoice.total).toBe('1980000');
    expect(invoice.taxAuthorityCode).toBe('M2-26-ABCDE-00001234567');
    expect(invoice.hasSignature).toBe(true);
  });

  it('passes the deterministic checks', () => {
    const checks = checkInvoice(parseEInvoiceXml(fixture), '2026-10-13');
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({ lines_sum: 'pass', total: 'pass', vat_breakdown: 'pass', seller_tax_code: 'pass', issue_date: 'pass' });
    expect(byId.signature).toBe('warn');
  });

  it('fails the lines check when amounts do not add up', () => {
    const invoice = parseEInvoiceXml(fixture);
    invoice.subtotal = '1900000';
    expect(checkInvoice(invoice, '2026-10-13').find((c) => c.id === 'lines_sum')?.status).toBe('fail');
  });

  it('requires amounts to match exactly, since the payable is posted at the invoice total', () => {
    const invoice = parseEInvoiceXml(fixture);
    invoice.total = '1979999';
    expect(checkInvoice(invoice, '2026-10-13').find((c) => c.id === 'total')?.status).toBe('fail');
  });

  it('fails dates that do not exist', () => {
    const invoice = parseEInvoiceXml(fixture);
    invoice.issueDate = '2026-02-30';
    expect(checkInvoice(invoice, '2026-10-13').find((c) => c.id === 'issue_date')?.status).toBe('fail');
  });

  it('rejects malformed or oversized amounts instead of guessing them', () => {
    const variant = (from: string, to: string) => new TextEncoder().encode(fixture.toString('utf8').replace(from, to));
    expect(() => parseEInvoiceXml(variant('<TgTTTBSo>1980000</TgTTTBSo>', `<TgTTTBSo>${'9'.repeat(40)}</TgTTTBSo>`))).toThrow(EInvoiceParseError);
    expect(() => parseEInvoiceXml(variant('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1.980.000</TgTTTBSo>'))).toThrow(/TgTTTBSo/);
  });

  it('truncates oversized text from the XML', () => {
    const xml = fixture.toString('utf8').replace('<Ten>CÔNG TY TNHH DỊCH VỤ MẪU</Ten>', `<Ten>${'A'.repeat(5000)}</Ten>`);
    expect(parseEInvoiceXml(new TextEncoder().encode(xml)).seller.name).toHaveLength(2000);
  });

  it('fails the currency check for foreign-currency invoices', () => {
    const invoice = parseEInvoiceXml(fixture);
    invoice.currency = 'USD';
    expect(checkInvoice(invoice, '2026-10-13').find((c) => c.id === 'currency')?.status).toBe('fail');
    expect(checkInvoice(parseEInvoiceXml(fixture), '2026-10-13').some((c) => c.id === 'currency')).toBe(false);
  });

  it('rejects DOCTYPE and entities', () => {
    const evil = new TextEncoder().encode('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><HDon/>');
    expect(() => parseEInvoiceXml(evil)).toThrow(EInvoiceParseError);
  });

  it('rejects XML that is not an invoice', () => {
    expect(() => parseEInvoiceXml(new TextEncoder().encode('<root><a>1</a></root>'))).toThrow(/HDon/);
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
    const invoice = parseEInvoiceXml(fixture);
    const lines = bookableLines(invoice, null);
    expect(lines.map((l) => [l.debitAccount, l.amount])).toEqual([
      ['6422', '1000000'],
      ['6421', '1000000'],
      ['6422', '-200000'],
    ]);
    const journal = buildPurchaseJournal(lines, invoice.vatTotal, 'HĐ C26TAB-1234');
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
});
