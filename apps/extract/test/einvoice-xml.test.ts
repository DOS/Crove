// The e-invoice XML parser (Decree 254/2026/ND-CP, formerly Decree 123/2020/ND-CP). It lives in crove-extract and runs only in its parser
// processes (External-tenant gate T12); these tests call it directly.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkInvoice, looksLikeEInvoiceXml, type ParsedInvoice } from '@crove/l10n-vn';
import { EInvoiceParseError, parseEInvoiceXml } from '../src/einvoice-xml.ts';

const fixture = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));
// The parsed form @crove/l10n-vn tests its checks and journal against.
const parsed = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;

describe('e-invoice XML', () => {
  it('detects and parses a Decree 123 invoice', () => {
    expect(looksLikeEInvoiceXml(fixture)).toBe(true);
    const invoice = parseEInvoiceXml(fixture);
    expect(invoice.series).toBe('C26TAB');
    expect(invoice.number).toBe('1234');
    expect(invoice.issueDate).toBe('2026-09-15');
    expect(invoice.seller.taxCode).toBe('0101234564');
    expect(invoice.buyer.name).toBe('CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU');
    expect(invoice.lines).toHaveLength(4);
    expect(invoice.lines[2]?.nature).toBe('discount');
    expect(invoice.subtotal).toBe('1800000');
    expect(invoice.vatTotal).toBe('180000');
    expect(invoice.total).toBe('1980000');
    expect(invoice.taxAuthorityCode).toBe('M2-26-ABCDE-00001234567');
    expect(invoice.hasSignature).toBe(true);
  });

  it('produces exactly the parsed fixture that @crove/l10n-vn checks', () => {
    expect(parseEInvoiceXml(fixture)).toEqual(parsed);
  });

  it('reads the invoice a replacement or an adjustment corrects (TTHDLQuan, #916)', () => {
    const replacement = parseEInvoiceXml(readFileSync(new URL('./fixtures/einvoice-replacement.xml', import.meta.url)));
    expect(replacement.number).toBe('1240');
    expect(replacement.related).toEqual({
      kind: 'replacement',
      template: '1',
      series: 'C26TAB',
      number: '1234',
      issueDate: '2026-09-15',
      note: 'Thay thế hóa đơn số 1234 do sai địa chỉ người mua',
    });
    // Apart from the block, a replacement reads like any invoice.
    const { related: _, ...rest } = replacement;
    expect(rest).toEqual({ ...parsed, number: '1240', issueDate: '2026-09-20' });

    const adjustment = parseEInvoiceXml(readFileSync(new URL('./fixtures/einvoice-adjustment.xml', import.meta.url)));
    // The original's number is normalized as invoice numbers are, so it matches the recorded document.
    expect(adjustment.related).toMatchObject({ kind: 'adjustment', series: 'C26TAB', number: '1234', issueDate: '2026-09-15' });
    // An adjustment carries the signed difference.
    expect([adjustment.subtotal, adjustment.vatTotal, adjustment.total]).toEqual(['-200000', '-20000', '-220000']);
  });

  it('leaves out a related block of another kind or without the original number, and an invoice without one is unchanged', () => {
    expect('related' in parseEInvoiceXml(fixture)).toBe(false);
    const variant = (from: string, to: string) =>
      parseEInvoiceXml(new TextEncoder().encode(readFileSync(new URL('./fixtures/einvoice-replacement.xml', import.meta.url), 'utf8').replace(from, to)));
    expect(variant('<TCHDon>1</TCHDon>', '<TCHDon>9</TCHDon>').related).toBeUndefined();
    expect(variant('<SHDCLQuan>1234</SHDCLQuan>', '').related).toBeUndefined();
  });

  it('derives the subtotal from the lines when a sales invoice has no subtotal or rate table', () => {
    const xml = fixture
      .toString('utf8')
      .replace(/<THTTLTSuat>[\s\S]*<\/THTTLTSuat>/, '')
      .replace('<TgTCThue>1800000</TgTCThue>', '')
      .replace('<TgTThue>180000</TgTThue>', '<TgTThue>0</TgTThue>')
      .replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1800000</TgTTTBSo>');
    const invoice = parseEInvoiceXml(new TextEncoder().encode(xml));
    expect(invoice.subtotal).toBe('1800000');
    const byId = Object.fromEntries(checkInvoice(invoice, '2026-10-13').map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({ lines_sum: 'pass', total: 'pass' });
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

  it('rejects DOCTYPE and entities', () => {
    const evil = new TextEncoder().encode('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><HDon/>');
    expect(() => parseEInvoiceXml(evil)).toThrow(EInvoiceParseError);
  });

  it('rejects XML that is not an invoice', () => {
    expect(() => parseEInvoiceXml(new TextEncoder().encode('<root><a>1</a></root>'))).toThrow(/HDon/);
  });
});
