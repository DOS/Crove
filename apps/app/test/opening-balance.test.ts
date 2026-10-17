// Opening balances from Excel (issue #320): the template round trip, reading a workbook as Excel writes it (deflated
// parts, shared strings, number cells, namespace prefixes) and the rows sent to the kernel.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { OPENING_BALANCE_MAX_ROWS } from '@crove/kernel-contract';
import { buildTemplate, sheetToRows, TEMPLATE_HEADERS } from '../src/lib/opening-balance.ts';
import { crc32, MAX_XLSX_BYTES, readFirstSheet, XlsxError, zipStored, type SheetRows } from '../src/lib/xlsx.ts';

// A zip with deflated entries, as Excel writes it.
function zipDeflated(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = encoder.encode(text);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const NS = 'http://schemas.openxmlformats.org';

// A workbook whose first sheet is sheet2.xml (sheets reordered in Excel), with prefixed elements, shared strings with
// rich text and a phonetic run, entities, number cells (one with an exponent) and a gap in the columns.
function excelWorkbook(sheetData: string, strings: string[]): Uint8Array {
  return zipDeflated({
    '[Content_Types].xml': `<Types xmlns="${NS}/package/2006/content-types"/>`,
    'xl/workbook.xml': `<x:workbook xmlns:x="${NS}/spreadsheetml/2006/main" xmlns:rel="${NS}/officeDocument/2006/relationships"><x:sheets><x:sheet name="Số dư" sheetId="2" rel:id="rId7"/><x:sheet name="Khác" sheetId="1" rel:id="rId1"/></x:sheets></x:workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Target="worksheets/sheet1.xml" Id="rId1" Type="t"/><Relationship Type="t" Target="/xl/worksheets/sheet2.xml" Id="rId7"/></Relationships>`,
    'xl/sharedStrings.xml': `<x:sst xmlns:x="${NS}/spreadsheetml/2006/main">${strings.map((s) => `<x:si>${s}</x:si>`).join('')}</x:sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<x:worksheet xmlns:x="${NS}/spreadsheetml/2006/main"><x:sheetData>${sheetData}</x:sheetData></x:worksheet>`,
  });
}

const HEADER_STRINGS = ['<x:t>Mã tài khoản</x:t>', '<x:r><x:t>Tên tài </x:t></x:r><x:r><x:rPr><x:b/></x:rPr><x:t>khoản</x:t></x:r><x:rPh><x:t>ignored</x:t></x:rPh>', '<x:t>Dư Nợ</x:t>', '<x:t>Dư Có</x:t>'];

describe('xlsx reader', () => {
  it('reads the first sheet of a workbook as Excel writes it', async () => {
    const sheet = await readFirstSheet(
      excelWorkbook(
        `<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>2</x:v></x:c><x:c r="D1" t="s"><x:v>3</x:v></x:c></x:row>` +
          `<x:row r="3"><x:c r="A3"><x:v>111</x:v></x:c><x:c r="B3" t="s"><x:v>4</x:v></x:c><x:c r="C3" s="3"><x:v>1500000</x:v></x:c></x:row>` +
          `<x:row r="4"><x:c r="A4" t="inlineStr"><x:is><x:t>411</x:t></x:is></x:c><x:c r="D4" t="str"><x:f>SUM(C3)</x:f><x:v>1.5E+16</x:v></x:c><x:c r="E4"/></x:row>` +
          `<x:row r="5"><x:c r="C5" t="b"><x:v>1</x:v></x:c><x:c r="D5" t="e"><x:v>#N/A</x:v></x:c></x:row>`,
        [...HEADER_STRINGS, '<x:t xml:space="preserve">Tiền mặt &amp; &#x110;ồng </x:t>'],
      ),
    );
    expect(sheet.get(1)?.get(1)).toEqual({ kind: 'text', value: 'Tên tài khoản' });
    expect(sheet.get(2)).toBeUndefined();
    expect(sheet.get(3)?.get(0)).toEqual({ kind: 'number', value: '111' });
    expect(sheet.get(3)?.get(1)).toEqual({ kind: 'text', value: 'Tiền mặt & Đồng ' });
    expect(sheet.get(3)?.get(2)).toEqual({ kind: 'number', value: '1500000' });
    expect(sheet.get(3)?.has(3)).toBe(false);
    // A formula's cached string result is text; an empty cell is absent.
    expect(sheet.get(4)?.get(3)).toEqual({ kind: 'text', value: '1.5E+16' });
    expect(sheet.get(4)?.has(4)).toBe(false);
    // A boolean is never the amount 1: it reads as the word, which the kernel refuses.
    expect(sheet.get(5)?.get(2)).toEqual({ kind: 'text', value: 'TRUE' });
    expect(sheet.get(5)?.get(3)).toEqual({ kind: 'text', value: '#N/A' });
  });

  it('refuses what is not an xlsx file and files over the limit', async () => {
    await expect(readFirstSheet(new TextEncoder().encode('Mã tài khoản,Dư Nợ\n111,100'))).rejects.toMatchObject({ reason: 'not_xlsx' });
    await expect(readFirstSheet(zipStored([{ name: 'a.txt', data: new Uint8Array([1]) }]))).rejects.toMatchObject({ reason: 'not_xlsx' });
    await expect(readFirstSheet(new Uint8Array(MAX_XLSX_BYTES + 1))).rejects.toBeInstanceOf(XlsxError);
  });

  it('stops inflating a part that grows past the limit', async () => {
    const bomb = zipDeflated({ 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${' '.repeat(21 * 1024 * 1024)}</sheetData></worksheet>` });
    expect(bomb.byteLength).toBeLessThan(MAX_XLSX_BYTES);
    await expect(readFirstSheet(bomb)).rejects.toMatchObject({ reason: 'too_large' });
  });
});

describe('opening balance template', () => {
  it('round-trips: the template reads back as its headers and accounts, amounts empty', async () => {
    const bytes = buildTemplate([
      { code: '111', name: 'Tiền mặt' },
      { code: '1331', name: 'Thuế GTGT được khấu trừ <hàng hóa> & "dịch vụ"' },
    ]);
    const sheet = await readFirstSheet(bytes);
    expect([0, 1, 2, 3].map((c) => sheet.get(1)?.get(c)?.value)).toEqual([...TEMPLATE_HEADERS]);
    expect(sheet.get(3)?.get(1)).toEqual({ kind: 'text', value: 'Thuế GTGT được khấu trừ <hàng hóa> & "dịch vụ"' });
    // Nothing filled yet: every account row is skipped, so the import is empty.
    expect(sheetToRows(sheet)).toEqual({
      ok: true,
      rows: [
        { rowNo: 2, accountCode: '111', accountName: 'Tiền mặt', debit: '', credit: '' },
        { rowNo: 3, accountCode: '1331', accountName: 'Thuế GTGT được khấu trừ <hàng hóa> & "dịch vụ"', debit: '', credit: '' },
      ],
    });
  });
});

describe('sheetToRows', () => {
  const text = (value: string) => ({ kind: 'text' as const, value });
  const num = (value: string) => ({ kind: 'number' as const, value });
  const sheetOf = (rows: Record<number, Array<ReturnType<typeof text> | ReturnType<typeof num> | undefined>>): SheetRows =>
    new Map(
      Object.entries(rows).map(([r, cells]) => [
        Number(r),
        new Map(cells.flatMap((cell, col) => (cell ? [[col, cell] as const] : []))),
      ]),
    );
  const HEAD = TEMPLATE_HEADERS.map(text);

  it('sends number cells as stored and text amounts normalized, with sheet row numbers', () => {
    const result = sheetToRows(
      sheetOf({
        1: [text(' mã  TÀI khoản '), ...HEAD.slice(1)],
        2: [num('111'), text('Tiền mặt'), num('1.125'), undefined],
        3: [text(''), text('')],
        5: [text(' 331 '), undefined, undefined, text('1.500.000')],
        6: [text('112'), undefined, text('1 000,5'), text('-')],
        7: [undefined, text('TÀI SẢN')],
      }),
    );
    expect(result).toEqual({
      ok: true,
      rows: [
        // 1.125 in a number cell stays a fraction for the kernel to refuse; it is not read as 1125.
        { rowNo: 2, accountCode: '111', accountName: 'Tiền mặt', debit: '1.125', credit: '' },
        { rowNo: 5, accountCode: '331', accountName: '', debit: '', credit: '1500000' },
        { rowNo: 6, accountCode: '112', accountName: '', debit: '1000,5', credit: '' },
        { rowNo: 7, accountCode: '', accountName: 'TÀI SẢN', debit: '', credit: '' },
      ],
    });
  });

  it('never cuts a value that is too long: it becomes one the kernel refuses', () => {
    const long = '9'.repeat(60);
    const result = sheetToRows(sheetOf({ 1: HEAD, 2: [text('111'), text('x'.repeat(300)), text(long), num(long)] }));
    expect(result).toMatchObject({ ok: true, rows: [{ debit: '?', credit: '?', accountName: 'x'.repeat(200) }] });
  });

  it('refuses a sheet that is not the template, an empty one and one with too many rows', () => {
    expect(sheetToRows(sheetOf({ 1: [text('Số hiệu TK'), ...HEAD.slice(1)], 2: [text('111'), undefined, num('1')] }))).toEqual({ ok: false, problem: 'template' });
    expect(sheetToRows(sheetOf({ 2: [text('111'), undefined, num('1')] }))).toEqual({ ok: false, problem: 'template' });
    expect(sheetToRows(sheetOf({ 1: HEAD }))).toEqual({ ok: false, problem: 'empty' });
    const many: Record<number, Array<ReturnType<typeof text>>> = { 1: HEAD };
    for (let r = 2; r <= OPENING_BALANCE_MAX_ROWS + 2; r++) many[r] = [text('111')];
    expect(sheetToRows(sheetOf(many))).toEqual({ ok: false, problem: 'too_many' });
  });
});
