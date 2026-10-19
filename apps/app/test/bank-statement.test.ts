// Bank statements (issue #326): finding a bank export's columns by their headers, the lines under them, and CSV as
// banks write it.
import { describe, expect, it } from 'vitest';
import { findColumns, headerKey, headerLabels, parseCsv, statementRows } from '../src/lib/bank-statement.ts';
import type { SheetCell, SheetRows } from '../src/lib/xlsx.ts';

const sheet = (rows: Record<number, Array<string | number | null>>): SheetRows =>
  new Map(
    Object.entries(rows).map(([n, cells]) => [
      Number(n),
      new Map(
        cells.flatMap((v, col): Array<[number, SheetCell]> =>
          v === null ? [] : [[col, typeof v === 'number' ? { kind: 'number', value: String(v) } : { kind: 'text', value: v }]],
        ),
      ),
    ]),
  );

describe('headerKey', () => {
  it('drops marks and case', () => {
    expect(headerKey(' Số tiền ghi Nợ (VND) ')).toBe('so tien ghi no vnd');
    expect(headerKey('Ngày GD')).toBe('ngay gd');
  });
});

describe('findColumns', () => {
  it('finds the header under the title rows, with money in and out columns', () => {
    const rows = sheet({
      1: ['SAO KÊ TÀI KHOẢN'],
      2: ['Số tài khoản: 0011 0000 0000'],
      4: ['STT', 'Ngày giao dịch', 'Số tham chiếu', 'Số tiền ghi nợ', 'Số tiền ghi có', 'Số dư', 'Nội dung'],
      5: [1, '01/09/2026', 'FT001', null, '50.000.000', '50.000.000', 'Góp vốn'],
      6: [2, 46268, 'FT002', 11000, null, 49989000, 'Phí SMS'],
      7: [null, 'Tổng cộng', null, 11000, '50.000.000'],
    });
    const mapping = findColumns(rows);
    expect(mapping).toEqual({ headerRow: 4, columns: { date: 1, reference: 2, moneyOut: 3, moneyIn: 4, balance: 5, description: 6, amount: null } });
    expect(headerLabels(rows, 4).map((h) => h.label)).toEqual(['STT', 'Ngày giao dịch', 'Số tham chiếu', 'Số tiền ghi nợ', 'Số tiền ghi có', 'Số dư', 'Nội dung']);
    // Number cells go as stored, text amounts made plain; the total row has no date and is left out.
    expect(statementRows(rows, mapping as NonNullable<typeof mapping>)).toEqual([
      { rowNo: 5, date: '01/09/2026', description: 'Góp vốn', moneyIn: '50000000', moneyOut: '', balance: '50000000', reference: 'FT001' },
      { rowNo: 6, date: '46268', description: 'Phí SMS', moneyIn: '', moneyOut: '11000', balance: '49989000', reference: 'FT002' },
    ]);
  });

  it('takes one signed amount column when the file has no sides, and English headers', () => {
    const rows = sheet({ 1: ['Transaction Date', 'Description', 'Amount', 'Balance', 'Reference'], 2: ['2026-09-01', 'Fee', '-11,000', '989,000', 'R1'] });
    const mapping = findColumns(rows);
    expect(mapping?.columns).toEqual({ date: 0, description: 1, amount: 2, balance: 3, reference: 4, moneyIn: null, moneyOut: null });
    expect(statementRows(rows, mapping as NonNullable<typeof mapping>)).toEqual([
      { rowNo: 2, date: '2026-09-01', description: 'Fee', moneyIn: '-11000', moneyOut: '', balance: '989000', reference: 'R1' },
    ]);
  });

  it('refuses an exponent typed as text, and keeps one in a number cell', () => {
    const rows = sheet({ 1: ['Ngày', 'Ghi có', 'Ghi nợ'], 2: ['01/09/2026', '1e3', null], 3: ['02/09/2026', null, 1.5e16] });
    const mapping = findColumns(rows);
    expect(statementRows(rows, mapping as NonNullable<typeof mapping>)?.map((r) => [r.moneyIn, r.moneyOut])).toEqual([
      ['?', ''],
      ['', '15000000000000000'],
    ]);
  });

  it('finds nothing without a date and an amount', () => {
    expect(findColumns(sheet({ 1: ['Tên', 'Địa chỉ'], 2: ['Ngày', 'Ghi chú'] }))).toBeNull();
  });
});

describe('parseCsv', () => {
  it('reads semicolons, quotes and a byte order mark', () => {
    const rows = parseCsv('﻿Ngày;Nội dung;Ghi có\r\n01/09/2026;"Thu tiền; khách ""A""";1.000.000\r\n\r\n02/09/2026;Phí;\n');
    expect([...rows.keys()]).toEqual([1, 2, 4]);
    expect(rows.get(2)?.get(1)).toEqual({ kind: 'text', value: 'Thu tiền; khách "A"' });
    expect(rows.get(4)?.has(2)).toBe(false);
  });

  it('reads commas and tabs', () => {
    expect(parseCsv('a,b,c\n1,"2,5",3').get(2)?.get(1)?.value).toBe('2,5');
    expect(parseCsv('a\tb\n1\t2').get(2)?.get(1)?.value).toBe('2');
  });
});
