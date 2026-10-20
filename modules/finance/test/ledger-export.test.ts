// The ledger reports workbook (issue #321): the trial balance, the general ledger per top-level account and the
// receivables and payables per party; amounts exact (text beyond Excel's 15 digits) and no text read as a formula.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  accountLedger,
  buildLedgerWorkbook,
  ledgerPeriod,
  partyLedger,
  trialBalance,
  type ChartAccount,
  type LedgerBook,
  type OpeningBalance,
  type PeriodLine,
} from '../src/index.ts';
import { expectExcelSheetNames } from './sheet-names.ts';

const CHART: ChartAccount[] = [
  { code: '111', name: 'Tiền mặt', parentCode: null },
  { code: '133', name: 'Thuế GTGT được khấu trừ', parentCode: null },
  { code: '1331', name: 'Thuế GTGT được khấu trừ của hàng hóa, dịch vụ', parentCode: '133' },
  { code: '331', name: 'Phải trả cho người bán', parentCode: null },
  { code: '642', name: 'Chi phí quản lý kinh doanh', parentCode: null },
];
const VENDOR = '00000000-0000-7000-8000-000000000001';

function book(opening: OpeningBalance[], lines: PeriodLine[], vendorName = 'Công ty TNHH ABC'): LedgerBook {
  const parties = new Map([[VENDOR, { name: vendorName, taxCode: '0101234564' }]]);
  const tb = trialBalance(CHART, opening, lines);
  const ledgers = tb.rows
    .filter((r) => r.level === 0)
    .map((r) => {
      const ledger = accountLedger(CHART, opening, lines, r.accountCode);
      return {
        period: ledgerPeriod('2026-09'),
        ...ledger,
        lines: ledger.lines.map(({ partyId, ...l }) => ({ ...l, partyName: partyId ? (parties.get(partyId)?.name ?? null) : null })),
      };
    });
  return {
    period: ledgerPeriod('2026-09'),
    trialBalance: tb,
    receivables: partyLedger(CHART, opening, lines, '131', parties),
    payables: partyLedger(CHART, opening, lines, '331', parties),
    ledgers,
    lines: lines.length,
  };
}

const purchase = (amount: string, vat: string, total: string): PeriodLine[] => [
  { entryId: 'e1', entryDate: '2026-09-15', reference: 'C26TAB-1234', description: 'HĐ C26TAB-1234', reversal: false, lineNo: 1, accountCode: '642', partyId: null, debit: amount, credit: '0' },
  { entryId: 'e1', entryDate: '2026-09-15', reference: 'C26TAB-1234', description: 'HĐ C26TAB-1234', reversal: false, lineNo: 2, accountCode: '1331', partyId: null, debit: vat, credit: '0' },
  { entryId: 'e1', entryDate: '2026-09-15', reference: 'C26TAB-1234', description: 'HĐ C26TAB-1234', reversal: false, lineNo: 3, accountCode: '331', partyId: VENDOR, debit: '0', credit: total },
];

async function readBack(b: LedgerBook): Promise<ExcelJS.Workbook> {
  const bytes = await buildLedgerWorkbook(b, 'demo');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return workbook;
}

const rowsOf = (sheet: ExcelJS.Worksheet | undefined) => (sheet?.getRows(1, sheet.rowCount) ?? []).map((row) => (row.values as unknown[]).slice(1));

describe('buildLedgerWorkbook', () => {
  it('writes the trial balance, the general ledger and the parties', async () => {
    const opening: OpeningBalance[] = [
      { accountCode: '111', partyId: null, debit: '5000000', credit: '0' },
      { accountCode: '331', partyId: VENDOR, debit: '0', credit: '5000000' },
    ];
    const workbook = await readBack(book(opening, purchase('1800000', '180000', '1980000')));
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Cân đối phát sinh', 'Sổ cái', 'Phải thu', 'Phải trả']);
    expectExcelSheetNames(workbook);
    expect(workbook.title).toBe('Sổ sách 2026-09 demo');

    expect(rowsOf(workbook.getWorksheet('Cân đối phát sinh'))).toEqual([
      [undefined, 'Bảng cân đối số phát sinh, kỳ 2026-09 (2026-09-01 đến 2026-09-30)'],
      ['Số hiệu TK', 'Tên tài khoản', 'Dư Nợ đầu kỳ', 'Dư Có đầu kỳ', 'Phát sinh Nợ', 'Phát sinh Có', 'Dư Nợ cuối kỳ', 'Dư Có cuối kỳ'],
      ['111', 'Tiền mặt', 5000000, 0, 0, 0, 5000000, 0],
      ['133', 'Thuế GTGT được khấu trừ', 0, 0, 180000, 0, 180000, 0],
      ['1331', 'Thuế GTGT được khấu trừ của hàng hóa, dịch vụ', 0, 0, 180000, 0, 180000, 0],
      ['331', 'Phải trả cho người bán', 0, 5000000, 0, 1980000, 0, 6980000],
      ['642', 'Chi phí quản lý kinh doanh', 0, 0, 1800000, 0, 1800000, 0],
      [undefined, 'Tổng cộng', 5000000, 5000000, 1980000, 1980000, 6980000, 6980000],
    ]);

    const ledger = rowsOf(workbook.getWorksheet('Sổ cái'));
    expect(ledger[1]).toEqual(['Ngày ghi sổ', 'Số chứng từ', 'Diễn giải', 'TK', 'TK đối ứng', 'Đối tượng', 'Phát sinh Nợ', 'Phát sinh Có', 'Dư Nợ', 'Dư Có']);
    const start = ledger.findIndex((r) => r[2] === 'Tài khoản 331: Phải trả cho người bán');
    expect(ledger.slice(start, start + 5)).toEqual([
      [undefined, undefined, 'Tài khoản 331: Phải trả cho người bán'],
      [undefined, undefined, 'Số dư đầu kỳ', undefined, undefined, undefined, undefined, undefined, undefined, 5000000],
      ['2026-09-15', 'C26TAB-1234', 'HĐ C26TAB-1234', '331', '642, 1331', 'Công ty TNHH ABC', undefined, 1980000, undefined, 6980000],
      [undefined, undefined, 'Cộng phát sinh', undefined, undefined, undefined, 0, 1980000],
      [undefined, undefined, 'Số dư cuối kỳ', undefined, undefined, undefined, undefined, undefined, undefined, 6980000],
    ]);
    // One section per top-level account: 133 holds the 1331 line.
    expect(ledger.filter((r) => typeof r[2] === 'string' && r[2].startsWith('Tài khoản ')).map((r) => r[2])).toEqual([
      'Tài khoản 111: Tiền mặt',
      'Tài khoản 133: Thuế GTGT được khấu trừ',
      'Tài khoản 331: Phải trả cho người bán',
      'Tài khoản 642: Chi phí quản lý kinh doanh',
    ]);

    expect(rowsOf(workbook.getWorksheet('Phải trả'))).toEqual([
      [undefined, 'Công nợ phải trả người bán (TK 331), kỳ 2026-09 (2026-09-01 đến 2026-09-30)'],
      ['Mã số thuế', 'Nhà cung cấp', 'Số dư đầu kỳ', 'Phát sinh tăng', 'Phát sinh giảm', 'Số dư cuối kỳ'],
      ['0101234564', 'Công ty TNHH ABC', 5000000, 1980000, 0, 6980000],
      [undefined, 'Tổng cộng', 5000000, 1980000, 0, 6980000],
      [undefined, 'Số âm: khoản trả trước'],
    ]);
    expect(rowsOf(workbook.getWorksheet('Phải thu')).slice(2)).toEqual([[undefined, 'Tổng cộng', 0, 0, 0, 0], [undefined, 'Số âm: khoản trả trước']]);
  });

  it('keeps amounts exact: text beyond 15 significant digits', async () => {
    const workbook = await readBack(book([], purchase('12345678901234560', '1', '12345678901234561')));
    const tb = rowsOf(workbook.getWorksheet('Cân đối phát sinh'));
    const payable = tb.find((r) => r[0] === '331');
    expect(payable?.[5]).toBe('12345678901234561');
    expect(payable?.[7]).toBe('12345678901234561');
    const cell = workbook.getWorksheet('Cân đối phát sinh')?.getRow(tb.indexOf(payable ?? []) + 1).getCell(6);
    expect(cell?.numFmt).toBe('@');
  });

  it('writes a formula-like name as inert text', async () => {
    const workbook = await readBack(book([], purchase('100', '10', '110'), '=HYPERLINK("http://x","y")'));
    const sheet = workbook.getWorksheet('Phải trả');
    const cell = sheet?.getRow(3).getCell(2);
    expect(cell?.value).toBe('=HYPERLINK("http://x","y")');
    expect(cell?.type).toBe(ExcelJS.ValueType.String);
    expect(cell?.numFmt).toBe('@');
  });
});
