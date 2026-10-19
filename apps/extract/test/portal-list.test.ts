// The tax portal's purchase-list reader (#465) and the .xlsx reader under it: header variants, value formats, rows it
// must skip or refuse, hostile workbooks, and the same file through the sandboxed parser process.
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, zExtractResponse } from '@crove/extract-contract';
import { parse } from '../src/parse.ts';
import { PortalListError, readAmount, readDate, readPortalList } from '../src/portal-list.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { XlsxError, columnOf, decodeXmlText, isDateFormat, readFirstSheet, serialToDate } from '../src/xlsx.ts';
import { FIXTURE_BUYER, PORTAL_HEADER, PORTAL_SCO_HEADER, buildXlsx, portalListXlsx, portalRow, type XlsxCell } from './xlsx-fixture.ts';
import { buildZip } from './zip-fixture.ts';

const SELLER = '0100109107';
const OTHER = '0302712572';

describe('readPortalList', () => {
  it('reads the portal layout: title rows, the header, text dates and number amounts', () => {
    const list = readPortalList(
      portalListXlsx([
        { series: 'C26TAA', number: 123, date: '05/09/2026', sellerTaxCode: SELLER, subtotal: 1_000_000, vat: 100_000, total: 1_100_000 },
        { template: '1', series: 'c26tbb', number: '0000456', date: '30/09/2026', sellerTaxCode: `${OTHER}-001`, total: 550_000, status: 'Hóa đơn đã bị hủy' },
      ]),
    );
    expect(list.headerRow).toBe(6);
    expect(list.listFrom).toBe('2026-09-01');
    expect(list.listTo).toBe('2026-09-30');
    expect(list.columns.map((c) => c.field)).toEqual([
      'template',
      'series',
      'number',
      'issueDate',
      'sellerTaxCode',
      'sellerName',
      'buyerTaxCode',
      'subtotal',
      'vatAmount',
      'total',
      'currency',
      'status',
      'checkResult',
    ]);
    expect(list.rows).toEqual([
      {
        rowNo: 7,
        sellerTaxCode: SELLER,
        sellerName: 'CÔNG TY TNHH NHÀ CUNG CẤP',
        buyerTaxCode: FIXTURE_BUYER,
        template: '1',
        series: 'C26TAA',
        number: '123',
        issueDate: '2026-09-05',
        currency: 'VND',
        subtotal: '1000000',
        vatAmount: '100000',
        total: '1100000',
        statusLabel: 'Hóa đơn mới',
        checkResult: 'Đã cấp mã hóa đơn',
      },
      expect.objectContaining({ rowNo: 8, sellerTaxCode: `${OTHER}-001`, series: 'C26TBB', number: '456', subtotal: null, total: '550000', statusLabel: 'Hóa đơn đã bị hủy' }),
    ]);
    expect(list.skipped).toEqual([]);
  });

  it('reads Excel date cells (built-in and custom formats, 1900 and 1904 systems) and inline strings', () => {
    // 46270 is 2026-09-05 in the 1900 system.
    const dated = (date: number): XlsxCell[] => portalRow(1, { series: 'C26TAA', number: 1, date: '', sellerTaxCode: SELLER }).map((cell, i) => (i === 4 ? { date } : cell));
    const rows: XlsxCell[][] = [PORTAL_HEADER, dated(46270)];
    for (const options of [{ strings: 'inline' as const }, { dateFormat: 'custom' as const }]) {
      expect(readPortalList(buildXlsx(rows, options)).rows[0]?.issueDate).toBe('2026-09-05');
    }
    const r1904: XlsxCell[][] = [PORTAL_HEADER, dated(46270 - 1462)];
    expect(readPortalList(buildXlsx(r1904, { date1904: true })).rows[0]?.issueDate).toBe('2026-09-05');
  });

  it('reads a header split over two rows (a seller group over its tax code and name)', () => {
    const top: XlsxCell[] = ['STT', 'Ký hiệu mẫu số', 'Ký hiệu hóa đơn', 'Số hóa đơn', 'Ngày lập', 'Thông tin người bán', null, 'Tổng tiền thanh toán'];
    const sub: XlsxCell[] = [null, null, null, null, null, 'MST', 'Tên người bán', null];
    const list = readPortalList(buildXlsx([['DANH SÁCH HÓA ĐƠN'], top, sub, [1, 1, 'C26TAA', 7, '01/09/2026', SELLER, 'Bên bán', '1.100.000']]));
    expect(list.headerRow).toBe(2);
    expect(list.rows).toEqual([expect.objectContaining({ rowNo: 4, sellerTaxCode: SELLER, sellerName: 'Bên bán', number: '7', total: '1100000' })]);
  });

  it('accepts header variants: other wording, no diacritics, the portal API names, a bare MST column', () => {
    const variants: XlsxCell[][] = [
      ['Mẫu số', 'Ký hiệu', 'Số HĐ', 'Ngày hóa đơn', 'Mã số thuế người bán', 'Tổng thanh toán', 'Trạng thái'],
      ['ky hieu mau so', 'ky hieu hoa don', 'so hoa don', 'ngay lap', 'mst nguoi ban', 'tong tien thanh toan', 'trang thai hoa don'],
      ['khmshdon', 'khhdon', 'shdon', 'tdlap', 'nbmst', 'tgtttbso', 'tthai'],
      ['Ký hiệu mẫu số:', 'Ký hiệu hóa đơn (*)', 'Số hóa đơn', 'Ngày lập', 'MST', 'Tổng tiền thanh toán', 'Trạng thái hóa đơn'],
    ];
    for (const header of variants) {
      const list = readPortalList(buildXlsx([header, ['1', 'K26TAA', '89', '2026-09-02', SELLER, '200000', '1']]));
      expect(list.rows, JSON.stringify(header)).toEqual([
        expect.objectContaining({ template: '1', series: 'K26TAA', number: '89', issueDate: '2026-09-02', sellerTaxCode: SELLER, total: '200000', statusLabel: '1' }),
      ]);
    }
  });

  it('ignores blank and totals rows and reports rows it cannot read by number and reason', () => {
    const list = readPortalList(
      buildXlsx([
        PORTAL_HEADER,
        portalRow(1, { series: 'C26TAA', number: 1, date: '01/09/2026', sellerTaxCode: SELLER, total: 10 }),
        [],
        [null, null, null, null, 'Tổng cộng', null, null, null, null, null, 100, 10, 0, 0, 110],
        portalRow(2, { series: 'C26TAA', number: 2, date: '31/02/2026', sellerTaxCode: SELLER }),
        portalRow(3, { series: 'C26TAA', number: 3, date: '01/09/2026', sellerTaxCode: '12345' }),
        portalRow(4, { series: '', number: 4, date: '01/09/2026', sellerTaxCode: SELLER }),
        portalRow(5, { series: 'C26TAA', number: 5, date: '01/09/2026', sellerTaxCode: '' }),
        portalRow(6, { series: 'C26TAA', number: 6, date: '01/09/2026', sellerTaxCode: SELLER, total: 'mười nghìn' }),
      ]),
    );
    expect(list.rows.map((r) => r.number)).toEqual(['1']);
    expect(list.skipped).toEqual([
      { rowNo: 5, reason: 'bad_date' },
      { rowNo: 6, reason: 'bad_tax_code' },
      { rowNo: 7, reason: 'no_series' },
      { rowNo: 8, reason: 'no_tax_code' },
      { rowNo: 9, reason: 'bad_amount' },
    ]);
  });

  it('reads the "máy tính tiền" layout, which has no currency column', () => {
    const row: XlsxCell[] = [1, 2, 'C26MAA', 15, '02/09/2026', SELLER, 'Quán ăn', 'Hà Nội', FIXTURE_BUYER, 'Người mua', null, 100000, 8000, 0, 108000, 'Hóa đơn mới', 'Cục Thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền'];
    const list = readPortalList(buildXlsx([[], [], ['DANH SÁCH HÓA ĐƠN MÁY TÍNH TIỀN'], ['Từ ngày 01/09/2026 đến ngày 30/09/2026'], [], PORTAL_SCO_HEADER, row], { strings: 'inline' }));
    expect(list.columns.find((c) => c.field === 'sellerName')?.header).toBe('Tên người bán/Tên người xuất hàng');
    expect(list.rows).toEqual([
      expect.objectContaining({ template: '2', series: 'C26MAA', number: '15', sellerName: 'Quán ăn', buyerTaxCode: FIXTURE_BUYER, currency: 'VND', total: '108000', statusLabel: 'Hóa đơn mới' }),
    ]);
  });

  it("pads tax codes stored as numbers, and reads amounts written with the portal's format as text", () => {
    const row = portalRow(1, { series: 'C26TAA', number: 9, date: '01/09/2026', sellerTaxCode: '', total: '2,092,593.0' }).map((cell, i) => (i === 5 ? 100109107 : i === 7 ? 309876546 : cell));
    expect(readPortalList(buildXlsx([PORTAL_HEADER, row])).rows).toEqual([expect.objectContaining({ sellerTaxCode: SELLER, buyerTaxCode: FIXTURE_BUYER, total: '2092593' })]);
  });

  it('reads the tail of a row one cell wider than the header (the "không mã" quirk) one column to the right', () => {
    const base = portalRow(1, { series: 'C26TAA', number: 3, date: '01/09/2026', sellerTaxCode: SELLER, status: 'Hóa đơn đã bị hủy', check: 'Cục Thuế đã nhận không mã' });
    const wide = [...base.slice(0, 15), null, ...base.slice(15)];
    const [row] = readPortalList(buildXlsx([PORTAL_HEADER, wide])).rows;
    expect(row).toMatchObject({ currency: 'VND', statusLabel: 'Hóa đơn đã bị hủy', checkResult: 'Cục Thuế đã nhận không mã' });
  });

  it('refuses a sheet it does not recognize, saying which columns are missing', () => {
    expect(() => readPortalList(buildXlsx([['Mã', 'Tên', 'Số dư Nợ'], ['111', 'Tiền mặt', 100]]))).toThrow(/không thấy dòng tiêu đề/);
    expect(() => readPortalList(buildXlsx([['Ký hiệu hóa đơn', 'Số hóa đơn', 'Tên người bán'], ['C26TAA', 1, 'A']]))).toThrow(/thiếu cột MST người bán, Ngày lập/);
    expect(() => readPortalList(buildXlsx([['STT', 'Ký hiệu mẫu số', 'Ký hiệu hóa đơn', 'Số hóa đơn', 'Ngày lập', 'MST người mua', 'Tên người mua'], [1, 1, 'C26TAA', 1, '01/09/2026', SELLER, 'B']]))).toThrow(
      /danh sách hóa đơn bán ra/,
    );
    expect(() => readPortalList(buildXlsx([]))).toThrow(PortalListError);
  });

  it('refuses an Excel 97-2003 file, a ZIP that is not a workbook, DOCTYPE, and more rows than allowed', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(() => readPortalList(ole)).toThrow(/97-2003/);
    expect(() => readPortalList(buildZip([{ name: 'a.xml', data: '<a/>' }]))).toThrow(/Không phải tệp Excel/);
    expect(() => readPortalList(new TextEncoder().encode('not a zip'))).toThrow(PortalListError);
    const doctype = buildXlsx([PORTAL_HEADER], { override: { 'xl/sharedStrings.xml': '<!DOCTYPE x [<!ENTITY a "b">]><sst><si><t>&a;</t></si></sst>' } });
    expect(() => readPortalList(doctype)).toThrow(/DOCTYPE/);
    const many = Array.from({ length: EXTRACT_LIMITS.maxPortalListRows + 1 }, (_, i) => portalRow(i + 1, { series: 'C26TAA', number: i + 1, date: '01/09/2026', sellerTaxCode: SELLER }));
    expect(() => readPortalList(buildXlsx([PORTAL_HEADER, ...many], { strings: 'inline' }))).toThrow(/hơn 20000 hóa đơn/);
  });
});

describe('value readers', () => {
  it('reads amounts in Excel, Vietnamese and English formats', () => {
    const text = (value: string) => readAmount({ kind: 'text', value });
    expect(readAmount({ kind: 'number', value: '1100000' })).toBe('1100000');
    expect(readAmount({ kind: 'number', value: '1.5E+6' })).toBe('1500000');
    expect(text('1.500.000')).toBe('1500000');
    expect(text('1,500,000')).toBe('1500000');
    expect(text('1.500.000,5')).toBe('1500000.5');
    expect(text('1,500,000.25')).toBe('1500000.25');
    expect(text('1500000.5')).toBe('1500000.5');
    expect(text('(100.000)')).toBe('-100000');
    expect(text('-2.000 đ')).toBe('-2000');
    expect(text('')).toBeNull();
    expect(text('abc')).toBe('invalid');
    expect(text('1e40')).toBe('invalid');
  });

  it('reads dates as dd/mm/yyyy text, ISO text and Excel serials, and refuses impossible ones', () => {
    expect(readDate({ kind: 'text', value: '5/9/2026' }, false)).toBe('2026-09-05');
    expect(readDate({ kind: 'text', value: '05-09-2026 14:30:00' }, false)).toBe('2026-09-05');
    expect(readDate({ kind: 'text', value: '2026-09-05T00:00:00' }, false)).toBe('2026-09-05');
    expect(readDate({ kind: 'date', value: '46270' }, false)).toBe('2026-09-05');
    expect(readDate({ kind: 'number', value: '46270' }, false)).toBe('2026-09-05');
    expect(readDate({ kind: 'number', value: '123' }, false)).toBeNull();
    expect(readDate({ kind: 'text', value: '30/02/2026' }, false)).toBeNull();
    expect(readDate({ kind: 'text', value: '09/05/26' }, false)).toBeNull();
  });
});

describe('xlsx reader', () => {
  it('turns Excel serials into calendar days around the 1900 leap-year bug', () => {
    expect(serialToDate('1', false)).toBe('1900-01-01');
    expect(serialToDate('59', false)).toBe('1900-02-28');
    expect(serialToDate('61', false)).toBe('1900-03-01');
    expect(serialToDate('46270.75', false)).toBe('2026-09-05');
    expect(serialToDate('1', true)).toBe('1904-01-02');
    expect(serialToDate('0', false)).toBeNull();
  });

  it('knows date formats, cell references and XML text', () => {
    expect(isDateFormat('dd/MM/yyyy')).toBe(true);
    expect(isDateFormat('[$-42A]d mmmm yyyy')).toBe(true);
    expect(isDateFormat('#,##0')).toBe(false);
    expect(isDateFormat('"Ngày"0')).toBe(false);
    expect(columnOf('A1')).toBe(0);
    expect(columnOf('AB12')).toBe(27);
    expect(columnOf('1')).toBeNull();
    expect(decodeXmlText('a &lt;b&gt; &amp;amp; &#7885; &#x1EA1; &bogus;')).toBe('a <b> &amp; ọ ạ &bogus;');
  });

  it('reads rich text, phonetic runs and formula results, and refuses a string index out of range', () => {
    const sheet = readFirstSheet(
      buildXlsx([['x', { formula: 'A1&"y"', cached: 'xy' }]], {
        override: {
          'xl/sharedStrings.xml': '<sst><si><r><t>Hóa </t></r><r><t>đơn</t></r><rPh><t>ignored</t></rPh></si></sst>',
        },
      }),
    );
    expect([...(sheet.rows[0]?.cells.values() ?? [])].map((c) => c.value)).toEqual(['Hóa đơn', 'xy']);
    const broken = buildXlsx([['x']], { override: { 'xl/sharedStrings.xml': '<sst></sst>' } });
    expect(() => readFirstSheet(broken)).toThrow(XlsxError);
  });

  it('refuses hostile parts with unclosed tags in one pass, well under a second each', () => {
    const MB = 1024 * 1024;
    const repeat = (unit: string) => unit.repeat(Math.ceil(MB / unit.length));
    const hostile: Array<[string, string]> = [
      ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${repeat('<row>')}</sheetData></worksheet>`],
      ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1">${repeat('<c r="A1">')}</row></sheetData></worksheet>`],
      ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1"><c t="inlineStr"><is>${repeat('<t>')}</is></c></row></sheetData></worksheet>`],
      ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${repeat('<!--')}</sheetData></worksheet>`],
      ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1"><c r="A1" t="${repeat('x')}`],
      ['xl/worksheets/sheet1.xml', `<worksheet>${repeat('<sheetData>')}`],
      ['xl/sharedStrings.xml', `<sst>${repeat('<si>')}</sst>`],
      ['xl/sharedStrings.xml', `<sst><si>${repeat('<t>')}</si></sst>`],
      ['xl/sharedStrings.xml', `<sst><si>${repeat('<rPh>')}</si></sst>`],
      ['xl/styles.xml', `<styleSheet>${repeat('<xf ')}`],
    ];
    for (const [part, xml] of hostile) {
      const file = buildXlsx([['x']], { override: { [part]: xml } });
      const started = performance.now();
      expect(() => readFirstSheet(file), part).toThrow(XlsxError);
      expect(performance.now() - started, `${part}: ${xml.slice(0, 40)}`).toBeLessThan(1000);
    }
  });

  it('reads a full-size sheet quickly', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => portalRow(i + 1, { series: 'C26TAA', number: i + 1, date: '01/09/2026', sellerTaxCode: SELLER, total: 1000 }));
    const file = buildXlsx([PORTAL_HEADER, ...rows], { strings: 'inline' });
    const started = performance.now();
    expect(readPortalList(file).rows).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('caps a decompression bomb by its declared size', () => {
    const bomb = '<worksheet><sheetData>' + '<row/>'.repeat(2_000_000) + '</sheetData></worksheet>';
    const zip = buildXlsx([['x']], { override: { 'xl/worksheets/sheet1.xml': bomb } });
    expect(() => readFirstSheet(zip, { maxPartBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxRows: 10, maxColumns: 10, maxCellChars: 100 })).toThrow(/quá lớn/);
  });
});

describe('through the parser and the sandbox', () => {
  const file = portalListXlsx([{ series: 'C26TAA', number: 1, date: '01/09/2026', sellerTaxCode: SELLER, total: 110 }]);

  it('answers a valid contract result, and an invalid answer for a wrong file', async () => {
    const ok = await parse('portal_invoice_list', file);
    expect(zExtractResponse.parse(ok)).toMatchObject({ ok: true, kind: 'portal_invoice_list', list: { rows: [{ number: '1' }] } });
    const bad = await parse('portal_invoice_list', buildXlsx([['nothing here']]));
    expect(bad).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('Không nhận ra bảng danh sách hóa đơn') });
  });

  it('reads the list in a parser process', async () => {
    const answer = await runSandboxed('portal_invoice_list', file);
    expect(answer).toMatchObject({ ok: true, kind: 'portal_invoice_list', list: { headerRow: 6, rows: [{ sellerTaxCode: SELLER }] } });
  });

});
