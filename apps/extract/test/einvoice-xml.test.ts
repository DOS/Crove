// The e-invoice XML parser (Decree 123/2020/ND-CP). It lives in crove-extract and runs only in its parser
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

  it('produces exactly the parsed fixture that @crove/l10n-vn checks', () => {
    expect(parseEInvoiceXml(fixture)).toEqual(parsed);
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
