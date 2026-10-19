// Opening balances from Excel (issue #320): the template and reading a filled one back into the rows the kernel
// checks. The kernel decides every rule (accounts, amounts, totals, dates); this only moves cells into text.
import { OPENING_BALANCE_MAX_ROWS, normalizeAmountText, type OpeningBalanceRow } from '@crove/kernel-contract';
import { writeWorkbook, type SheetCell, type SheetRows } from './xlsx.ts';

export const OPENING_BALANCE_SOURCE = 'finance.opening_balance';

// The roles that may post opening balances (finance.opening_balance.post); the kernel checks again.
export function canImportOpeningBalance(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

// The template is Vietnamese whatever the interface language: it is a file format, read back by these headers.
export const TEMPLATE_HEADERS = ['Mã tài khoản', 'Tên tài khoản', 'Dư Nợ', 'Dư Có'] as const;
export const TEMPLATE_SHEET = 'Số dư đầu kỳ';
const GUIDE_SHEET = 'Hướng dẫn';
const GUIDE = [
  'Cách điền bảng số dư đầu kỳ',
  '1. Điền số dư cuối ngày của từng tài khoản vào cột "Dư Nợ" hoặc "Dư Có", bằng số nguyên đồng (không có phần thập phân).',
  '2. Dòng không có số dư được bỏ qua, nên có thể để nguyên các tài khoản không dùng.',
  '3. Tài khoản vừa có dư Nợ vừa có dư Có (ví dụ 131, 331 theo từng khách hàng) thì điền cả hai cột.',
  '4. Mỗi tài khoản chỉ xuất hiện một lần. Không đổi tên hoặc thứ tự các cột ở dòng đầu tiên.',
  '5. Tổng dư Nợ phải bằng tổng dư Có. Crove kiểm tra và hiện lỗi từng dòng trước khi ghi sổ.',
];

// Column widths: code, name, debit, credit.
const WIDTHS = [16, 48, 20, 20];

// The template, pre-filled with the org's chart of accounts and no amounts.
export function buildTemplate(accounts: ReadonlyArray<{ code: string; name: string }>): Uint8Array {
  return writeWorkbook([
    {
      name: TEMPLATE_SHEET,
      widths: WIDTHS,
      headerRows: 1,
      rows: [TEMPLATE_HEADERS, ...accounts.map((a) => [a.code, a.name])],
      textColumns: [0],
      amountColumns: [2, 3],
      formattedBlankRows: 20,
    },
    { name: GUIDE_SHEET, widths: [120], headerRows: 1, rows: GUIDE.map((line) => [line]) },
  ]);
}

export type SheetProblem = 'template' | 'empty' | 'too_many';
// extraColumns: some row has a cell after column D, which the import does not read (the screen says so).
export type SheetImport = { ok: true; rows: OpeningBalanceRow[]; extraColumns: boolean } | { ok: false; problem: SheetProblem };

const header = (text: string) => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
const MAX_CELL = 50;

// Text sent for a cell. A value too long for the wire is replaced by one the kernel refuses, never cut: a cut amount
// would be another number.
const bounded = (text: string) => (text.length > MAX_CELL ? '?' : text);
const codeOf = (cell: SheetCell | undefined) => bounded(cell?.value.trim() ?? '');
// A number cell's stored value may carry an exponent (Excel writes 1E+16); a typed text never does, so a text such as
// "1e3" is sent as a value the kernel refuses instead of 1000 (#366).
const amountOf = (cell: SheetCell | undefined) => {
  if (!cell) return '';
  if (cell.kind === 'number') return bounded(cell.value);
  const text = normalizeAmountText(cell.value);
  return /[eE]/.test(text) ? '?' : bounded(text);
};

// The rows of a filled template: row 1 must be the template's headers; every later row with any of the four cells
// filled is sent, with its sheet row number.
export function sheetToRows(sheet: SheetRows): SheetImport {
  const first = sheet.get(1);
  const matches = TEMPLATE_HEADERS.every((h, col) => header(first?.get(col)?.value ?? '') === header(h));
  if (!matches) return { ok: false, problem: 'template' };
  const rows: OpeningBalanceRow[] = [];
  let extraColumns = false;
  for (const rowNo of [...sheet.keys()].sort((a, b) => a - b)) {
    const cells = sheet.get(rowNo);
    for (const [col, cell] of cells ?? []) {
      if (col > 3 && cell.value.trim() !== '') extraColumns = true;
    }
    if (rowNo === 1) continue;
    const values = [0, 1, 2, 3].map((col) => cells?.get(col)?.value.trim() ?? '');
    if (values.every((v) => v === '')) continue;
    if (rows.length === OPENING_BALANCE_MAX_ROWS) return { ok: false, problem: 'too_many' };
    rows.push({
      rowNo,
      accountCode: codeOf(cells?.get(0)),
      accountName: (cells?.get(1)?.value.trim() ?? '').slice(0, 200),
      debit: amountOf(cells?.get(2)),
      credit: amountOf(cells?.get(3)),
    });
  }
  return rows.length === 0 ? { ok: false, problem: 'empty' } : { ok: true, rows, extraColumns };
}
