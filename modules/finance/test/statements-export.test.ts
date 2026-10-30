// The financial statements workbook (issue #154): B01-DNN and B02-DNN sheets, each opening with the draft notice,
// totals in bold, the balances no line reads listed after the lines, and the unbalanced warning on B01. Amounts exact
// and no text read as a formula, as in the other exports. With the comparison columns (#2090): B01's start of year, and
// B02 for the same period of the previous year and the period right before; a comparison that does not exist has no column.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildStatementsWorkbook, ledgerPeriod, type FinancialStatements } from '../src/index.ts';
import { DRAFT_NOTICE } from '../src/statements-export.ts';
import { expectExcelSheetNames } from './sheet-names.ts';

const NO_COMPARISON: FinancialStatements['comparison'] = { startOfYear: null, lastYear: null, previous: null };

function statements(
  overrides: { balanced?: boolean; unmapped?: FinancialStatements['b01']['unmapped']; payable?: string; period?: string; comparison?: FinancialStatements['comparison'] } = {},
): FinancialStatements {
  return {
    period: ledgerPeriod(overrides.period ?? '2026-09'),
    comparison: overrides.comparison ?? NO_COMPARISON,
    b01: {
      asOf: '2026-09-30',
      lines: [
        { code: '181', label: 'Thuế GTGT được khấu trừ', amount: '360000', total: false },
        { code: '200', label: 'TỔNG CỘNG TÀI SẢN', amount: '360000', total: true },
        { code: '311', label: 'Phải trả người bán', amount: overrides.payable ?? '3960000', total: false },
        { code: '500', label: 'TỔNG CỘNG NGUỒN VỐN', amount: '360000', total: true },
      ],
      unmapped: overrides.unmapped ?? [],
      balanced: overrides.balanced ?? true,
    },
    b02: {
      from: '2026-09-01',
      to: '2026-09-30',
      lines: [
        { code: '24', label: 'Chi phí quản lý kinh doanh', amount: '1800000', total: false },
        { code: '60', label: '=SUM(A1)', amount: '-1800000', total: true },
      ],
      unmapped: [],
    },
  };
}

async function readBack(s: FinancialStatements) {
  const bytes = await buildStatementsWorkbook(s, 'demo');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return workbook;
}

const rowsOf = (sheet: ExcelJS.Worksheet | undefined) => (sheet?.getRows(1, sheet.rowCount) ?? []).map((row) => (row.values as unknown[]).slice(1));

describe('buildStatementsWorkbook', () => {
  it('adds the start of year to B01 and the same period a year earlier and the period before to B02', async () => {
    const workbook = await readBack(
      statements({
        comparison: {
          startOfYear: { asOf: '2025-12-31', amounts: { '181': '100000', '200': '100000', '311': '-12345678901234567', '500': '100000' } },
          lastYear: { period: '2025-09', from: '2025-09-01', to: '2025-09-30', amounts: { '24': '900000', '60': '-900000' } },
          previous: { period: '2026-08', from: '2026-08-01', to: '2026-08-31', amounts: { '24': '1800000' } },
        },
      }),
    );
    const b01 = rowsOf(workbook.getWorksheet('B01-DNN'));
    expect(b01.slice(2)).toEqual([
      ['Chỉ tiêu', 'Mã số', 'Số cuối kỳ (2026-09-30)', 'Số đầu năm (2025-12-31)'],
      ['Thuế GTGT được khấu trừ', '181', 360000, 100000],
      ['TỔNG CỘNG TÀI SẢN', '200', 360000, 100000],
      // Amounts stay exact, and a line the start of year has nothing on reads 0.
      ['Phải trả người bán', '311', 3960000, '-12345678901234567'],
      ['TỔNG CỘNG NGUỒN VỐN', '500', 360000, 100000],
    ]);
    const b02 = rowsOf(workbook.getWorksheet('B02-DNN'));
    expect(b02.slice(2)).toEqual([
      ['Chỉ tiêu', 'Mã số', 'Kỳ này', 'Cùng kỳ năm trước (2025-09)', 'Kỳ liền trước (2026-08)'],
      ['Chi phí quản lý kinh doanh', '24', 1800000, 900000, 1800000],
      ['=SUM(A1)', '60', -1800000, -900000, 0],
    ]);
  });

  it('names the previous year for a year, and leaves out a comparison that does not exist', async () => {
    const year = await readBack(
      statements({
        period: '2026',
        comparison: { startOfYear: null, lastYear: { period: '2025', from: '2025-01-01', to: '2025-12-31', amounts: { '24': '5000' } }, previous: null },
      }),
    );
    expect(rowsOf(year.getWorksheet('B02-DNN')).slice(2, 4)).toEqual([
      ['Chỉ tiêu', 'Mã số', 'Kỳ này', 'Năm trước (2025)'],
      ['Chi phí quản lý kinh doanh', '24', 1800000, 5000],
    ]);
    // B01 has no start of year here: its header row keeps the three columns.
    expect(rowsOf(year.getWorksheet('B01-DNN'))[2]).toEqual(['Chỉ tiêu', 'Mã số', 'Số cuối kỳ (2026-09-30)']);
  });

  it('writes B01 and B02, each under the draft notice, with totals in bold', async () => {
    const workbook = await readBack(statements());
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['B01-DNN', 'B02-DNN']);
    expectExcelSheetNames(workbook);
    expect(workbook.title).toMatch(/^Báo cáo tài chính /);
    const b01 = workbook.getWorksheet('B01-DNN');
    expect(rowsOf(b01)).toEqual([
      [DRAFT_NOTICE],
      ['Báo cáo tình hình tài chính (B01-DNN) tại ngày 2026-09-30'],
      ['Chỉ tiêu', 'Mã số', 'Số cuối kỳ (2026-09-30)'],
      ['Thuế GTGT được khấu trừ', '181', 360000],
      ['TỔNG CỘNG TÀI SẢN', '200', 360000],
      ['Phải trả người bán', '311', 3960000],
      ['TỔNG CỘNG NGUỒN VỐN', '500', 360000],
    ]);
    expect(b01?.getRow(4).font?.bold).toBeFalsy();
    expect(b01?.getRow(5).font?.bold).toBe(true);
    const b02 = rowsOf(workbook.getWorksheet('B02-DNN'));
    expect(b02[0]).toEqual([DRAFT_NOTICE]);
    expect(b02[1]).toEqual(['Báo cáo kết quả hoạt động kinh doanh (B02-DNN), kỳ 2026-09 (2026-09-01 đến 2026-09-30)']);
    expect(b02.slice(3)).toEqual([
      ['Chi phí quản lý kinh doanh', '24', 1800000],
      // A label that looks like a formula stays text.
      ['=SUM(A1)', '60', -1800000],
    ]);
  });

  it('lists the balances no line reads, warns when B01 does not balance, and keeps amounts exact', async () => {
    const workbook = await readBack(
      statements({
        balanced: false,
        payable: '12345678901234567',
        unmapped: [{ accountCode: '3388', accountName: 'Phải trả khác', partyName: 'Công ty TNHH ABC', amount: '-500000' }],
      }),
    );
    const b01 = rowsOf(workbook.getWorksheet('B01-DNN'));
    expect(b01.find((r) => r[1] === '311')?.[2]).toBe('12345678901234567');
    expect(b01.slice(7)).toEqual([
      [],
      ['Cảnh báo: các số dư dưới đây chưa được chỉ tiêu nào đọc, báo cáo chưa đầy đủ (số dư Nợ dương, Có âm)'],
      ['Phải trả khác, Công ty TNHH ABC', '3388', -500000],
      ['Cảnh báo: tổng tài sản (mã 200) và tổng nguồn vốn (mã 500) không bằng nhau'],
    ]);
  });
});
