// The register workbook (#919): one sheet, a header row, one row per entry with its accounts, schedule, what was posted
// and what is left. Amounts exact and no text read as a formula, as in the other exports.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { FixedAsset } from '@crove/kernel-contract';
import { buildFixedAssetsWorkbook } from '../src/index.ts';
import { expectExcelSheetNames } from './sheet-names.ts';

const printer: FixedAsset = {
  id: '01900000-0000-7000-8000-000000000001',
  kind: 'fixed_asset',
  name: 'Máy in văn phòng',
  cost: '36000000',
  assetAccount: '2111',
  accumulatedAccount: '2141',
  expenseAccount: '6422',
  startMonth: '2026-08',
  months: 36,
  lastMonth: '2029-07',
  ended: { month: '2026-10', reason: 'Thanh lý' },
  source: null,
  posted: '2000000',
  postedMonths: 2,
  remaining: '34000000',
  lastPostedMonth: '2026-09',
};

describe('buildFixedAssetsWorkbook', () => {
  it('writes one row per entry under a header', async () => {
    const bytes = await buildFixedAssetsWorkbook(
      [printer, { ...printer, id: '01900000-0000-7000-8000-000000000002', kind: 'prepaid_cost', name: '=SUM(A1)', assetAccount: '242', accumulatedAccount: null, cost: '12345678901234567', ended: null, posted: '0', postedMonths: 0, remaining: '12345678901234567', lastPostedMonth: null }],
      'demo',
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Sổ tài sản']);
    expectExcelSheetNames(workbook);
    const sheet = workbook.getWorksheet('Sổ tài sản');
    const rows = (sheet?.getRows(1, sheet.rowCount) ?? []).map((row) => (row.values as unknown[]).slice(1));
    expect(rows[0]?.[0]).toBe('Loại');
    expect(rows[1]).toEqual(['Tài sản cố định', 'Máy in văn phòng', '2111', '2141', '6422', 36000000, '08/2026', 36, '07/2029', 2000000, 34000000, '09/2026', 'Từ sau tháng 10/2026: Thanh lý']);
    // A name that looks like a formula stays text; an amount too large for a double stays exact.
    expect(rows[2]?.[0]).toBe('Chi phí trả trước');
    expect(rows[2]?.[1]).toBe('=SUM(A1)');
    expect(rows[2]?.[3]).toBe('');
    expect(rows[2]?.[5]).toBe('12345678901234567');
  });
});
