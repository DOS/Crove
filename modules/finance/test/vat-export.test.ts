// The VAT working workbook (issue #316): the summary with the form 01/GTGT indicators, one listing per side, amounts
// exact (text beyond Excel's 15 digits) and no text read as a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildVatWorkbook, form01Indicators, sideTotals, vatPeriod, type VatInvoiceView, type VatReport } from '../src/index.ts';

function invoice(id: string, overrides: Partial<VatInvoiceView> = {}): VatInvoiceView {
  return {
    id,
    issueDate: '2026-09-15',
    series: 'C26TAB',
    number: '1234',
    partyName: 'Công ty TNHH ABC',
    partyTaxCode: '0101234564',
    subtotal: '1800000',
    vatAmount: '180000',
    total: '1980000',
    rates: [{ rate: '10', taxable: '1800000', vat: '180000' }],
    warnings: [],
    ...overrides,
  };
}

function report(input: VatInvoiceView[], output: VatInvoiceView[] | null): VatReport {
  const inputSide = { available: true, documents: input, totals: sideTotals(input) };
  const outputSide = { available: output !== null, documents: output ?? [], totals: sideTotals(output ?? []) };
  return { period: vatPeriod('2026-09'), input: inputSide, output: outputSide, indicators: form01Indicators(inputSide.totals, outputSide.totals) };
}

async function readBack(r: VatReport): Promise<ExcelJS.Workbook> {
  const bytes = await buildVatWorkbook(r, 'demo');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return workbook;
}

const rowsOf = (sheet: ExcelJS.Worksheet) => (sheet.getRows(1, sheet.rowCount) ?? []).map((row) => (row.values as unknown[]).slice(1));

describe('buildVatWorkbook', () => {
  it('writes the summary, then the sales and purchase listings', async () => {
    const workbook = await readBack(
      report(
        [
          invoice('a'),
          invoice('b', {
            number: '99',
            rates: [
              { rate: '8', taxable: '333333', vat: '26667' },
              { rate: '10', taxable: '1000001', vat: '100001' },
            ],
            warnings: ['rate_split'],
          }),
        ],
        null,
      ),
    );
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Tong hop', 'Ban ra', 'Mua vao']);

    const summary = rowsOf(workbook.getWorksheet('Tong hop') as ExcelJS.Worksheet);
    const byCode = new Map(summary.filter((r) => typeof r[0] === 'string' && String(r[0]).startsWith('[')).map((r) => [r[0], r[2]]));
    expect(byCode.get('[23]')).toBe(3133334);
    expect(byCode.get('[24]')).toBe(306668);
    expect(byCode.get('[32]')).toBe(0);
    expect(summary.some((r) => r.includes('Chưa nhập mã số thuế của tổ chức nên Crove chưa nhận ra hóa đơn bán ra'))).toBe(true);

    const sales = rowsOf(workbook.getWorksheet('Ban ra') as ExcelJS.Worksheet);
    expect(sales[0]).toEqual(['STT', 'Ngày hóa đơn', 'Ký hiệu HĐ', 'Số HĐ', 'MST người mua', 'Tên người mua', 'Thuế suất', 'Giá trị chưa có thuế', 'Thuế GTGT', 'Ghi chú']);

    const purchases = rowsOf(workbook.getWorksheet('Mua vao') as ExcelJS.Worksheet);
    expect(purchases.slice(1)).toEqual([
      [1, '2026-09-15', 'C26TAB', '1234', '0101234564', 'Công ty TNHH ABC', '10%', 1800000, 180000, ''],
      [2, '2026-09-15', 'C26TAB', '99', '0101234564', 'Công ty TNHH ABC', '8%', 333333, 26667, 'Thuế GTGT chia theo thuế suất là số ước tính'],
      [2, '2026-09-15', 'C26TAB', '99', '0101234564', 'Công ty TNHH ABC', '10%', 1000001, 100001, 'Thuế GTGT chia theo thuế suất là số ước tính'],
      [undefined, undefined, undefined, undefined, undefined, 'Tổng cộng', undefined, 3133334, 306668],
    ]);
  });

  it('says when sales at an unknown rate are in no indicator, and names a VAT mismatch (#358)', async () => {
    const OTHER = 'Doanh thu bán ra chưa rõ thuế suất, không nằm trong chỉ tiêu nào: kiểm tra các hóa đơn đó trước khi nộp tờ khai';
    const workbook = await readBack(
      report(
        [invoice('a', { vatAmount: '0', rates: [{ rate: '10', taxable: '1800000', vat: '0' }], warnings: ['vat_mismatch'] })],
        [invoice('s', { rates: [{ rate: 'other', taxable: '500000', vat: '0' }], warnings: ['rate_unknown'] })],
      ),
    );
    const summary = rowsOf(workbook.getWorksheet('Tong hop') as ExcelJS.Worksheet);
    expect(summary.find((r) => r[1] === OTHER)?.[2]).toBe(500000);
    const purchases = rowsOf(workbook.getWorksheet('Mua vao') as ExcelJS.Worksheet);
    expect(purchases[1]?.[9]).toBe('Thuế GTGT lệch giá trị trước thuế nhân thuế suất');

    // No such row when every sale has a known rate.
    const clean = rowsOf((await readBack(report([], [invoice('s')]))).getWorksheet('Tong hop') as ExcelJS.Worksheet);
    expect(clean.some((r) => r[1] === OTHER)).toBe(false);
  });

  it('keeps amounts beyond 15 digits as exact text and text as text', async () => {
    const workbook = await readBack(
      report(
        [
          invoice('a', {
            partyName: '=HYPERLINK("http://x","y")',
            series: '-1',
            rates: [{ rate: '10', taxable: '1234567890123456', vat: '123456789012345' }],
          }),
        ],
        [],
      ),
    );
    const sheet = workbook.getWorksheet('Mua vao') as ExcelJS.Worksheet;
    const row = sheet.getRow(2);
    expect(row.getCell(6).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(6).value).toBe('=HYPERLINK("http://x","y")');
    expect(row.getCell(3).value).toBe('-1');
    expect(row.getCell(8)).toMatchObject({ type: ExcelJS.ValueType.String, value: '1234567890123456' });
    expect(row.getCell(9)).toMatchObject({ type: ExcelJS.ValueType.Number, value: 123456789012345 });
    // An empty but available sales side has only its header and the total row.
    const sales = rowsOf(workbook.getWorksheet('Ban ra') as ExcelJS.Worksheet);
    expect(sales.slice(1)).toEqual([[undefined, undefined, undefined, undefined, undefined, 'Tổng cộng', undefined, 0, 0]]);
  });
});
