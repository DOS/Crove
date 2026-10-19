// Bank statements (issue #326): reading a bank's Excel or CSV export in the browser and finding its columns by their
// headers, so any bank's file can be imported without a preset. Cells go to the kernel as text (number cells as
// stored, amounts typed as text made plain by normalizeStatementAmount); the finance module decides every rule.
import { BANK_IMPORT_MAX_ROWS, normalizeStatementAmount, type BankStatementRow } from '@crove/kernel-contract';
import { readFirstSheet, type SheetCell, type SheetRows } from './xlsx.ts';

export const STATEMENT_COLUMNS = ['date', 'description', 'moneyIn', 'moneyOut', 'amount', 'balance', 'reference'] as const;
export type StatementColumn = (typeof STATEMENT_COLUMNS)[number];

// The 0-based column of each field (null when the file has none) and the header's row number. amount is one signed
// column, used when the file has no separate money in and money out columns.
export interface StatementMapping {
  headerRow: number;
  columns: Record<StatementColumn, number | null>;
}

// Lower case, no Vietnamese marks, single spaces: "Số tiền ghi Nợ" -> "so tien ghi no".
export function headerKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Words of the headers Vietnamese banks and their English exports use, most specific first. A header matches a field
// when it contains one of the field's words (or equals one marked exact).
const WORDS: Record<StatementColumn, { contains: string[]; exact?: string[] }> = {
  date: { contains: ['ngay giao dich', 'ngay gd', 'ngay hieu luc', 'ngay hach toan', 'ngay ghi so', 'transaction date', 'value date', 'posting date', 'ngay', 'date'] },
  moneyOut: { contains: ['ghi no', 'phat sinh no', 'so tien no', 'tien ra', 'rut ra', 'debit', 'withdraw'], exact: ['no'] },
  moneyIn: { contains: ['ghi co', 'phat sinh co', 'so tien co', 'tien vao', 'gui vao', 'credit', 'deposit'], exact: ['co'] },
  balance: { contains: ['so du', 'balance'] },
  reference: { contains: ['so tham chieu', 'ma giao dich', 'so giao dich', 'so but toan', 'ma gd', 'so ct', 'transaction id', 'reference', 'ref no'], exact: ['ref'] },
  description: { contains: ['noi dung', 'dien giai', 'mo ta', 'chi tiet', 'description', 'remark', 'narrative', 'details'] },
  amount: { contains: ['so tien', 'amount'] },
};
// Fields claimed in this order, so "so tien ghi no" goes to money out before amount can take it.
const CLAIM_ORDER: StatementColumn[] = ['date', 'balance', 'moneyOut', 'moneyIn', 'reference', 'description', 'amount'];

const cellText = (cell: SheetCell | undefined) => (cell?.value ?? '').trim();

function claim(headers: Map<number, string>): Record<StatementColumn, number | null> {
  const columns = Object.fromEntries(STATEMENT_COLUMNS.map((c) => [c, null])) as Record<StatementColumn, number | null>;
  const taken = new Set<number>();
  for (const field of CLAIM_ORDER) {
    const words = WORDS[field];
    for (const word of words.contains) {
      const hit = [...headers].find(([col, key]) => !taken.has(col) && (key === word || key.includes(word)));
      if (hit) {
        columns[field] = hit[0];
        taken.add(hit[0]);
        break;
      }
    }
    if (columns[field] === null && words.exact) {
      const hit = [...headers].find(([col, key]) => !taken.has(col) && words.exact?.includes(key));
      if (hit) {
        columns[field] = hit[0];
        taken.add(hit[0]);
      }
    }
  }
  return columns;
}

// The header row: the first of the first 30 rows that names a date and an amount (money in or out, or a signed
// amount). Banks put a title, the account and the period above it.
export function findColumns(rows: SheetRows): StatementMapping | null {
  const numbers = [...rows.keys()].sort((a, b) => a - b).slice(0, 30);
  for (const n of numbers) {
    const headers = new Map<number, string>();
    for (const [col, cell] of rows.get(n) ?? []) {
      const key = headerKey(cellText(cell));
      if (key) headers.set(col, key);
    }
    const columns = claim(headers);
    if (columns.date !== null && (columns.moneyIn !== null || columns.moneyOut !== null || columns.amount !== null)) {
      // A file with both sides needs no signed amount column.
      if (columns.moneyIn !== null || columns.moneyOut !== null) columns.amount = null;
      return { headerRow: n, columns };
    }
  }
  return null;
}

// The header text of every column of the header row, for choosing a column by hand.
export function headerLabels(rows: SheetRows, headerRow: number): Array<{ col: number; label: string }> {
  return [...(rows.get(headerRow) ?? [])]
    .map(([col, cell]) => ({ col, label: cellText(cell) }))
    .filter((h) => h.label !== '')
    .sort((a, b) => a.col - b.col);
}

// A number cell's stored value may carry an exponent (Excel writes 1E+16); a typed text never does, so a text such as
// "1e3" is sent as a value the module refuses instead of 1000.
function amountText(cell: SheetCell | undefined): string {
  if (!cell) return '';
  if (cell.kind === 'number') return cell.value;
  const text = normalizeStatementAmount(cell.value);
  return /[eE]/.test(text) ? '?' : text;
}

// The lines under the header: every row whose date cell holds a digit (a title, a blank or a "Tổng cộng" row below
// the lines has none). At most BANK_IMPORT_MAX_ROWS; null when the file has more.
export function statementRows(rows: SheetRows, mapping: StatementMapping): BankStatementRow[] | null {
  const { headerRow, columns } = mapping;
  const out: BankStatementRow[] = [];
  const cell = (row: Map<number, SheetCell>, col: number | null) => (col === null ? undefined : row.get(col));
  for (const n of [...rows.keys()].sort((a, b) => a - b)) {
    if (n <= headerRow) continue;
    const row = rows.get(n) ?? new Map<number, SheetCell>();
    const date = cellText(cell(row, columns.date));
    if (!/\d/.test(date)) continue;
    if (out.length === BANK_IMPORT_MAX_ROWS) return null;
    const signed = columns.amount !== null && columns.moneyIn === null && columns.moneyOut === null;
    out.push({
      rowNo: n,
      date: date.slice(0, 40),
      description: cellText(cell(row, columns.description)).slice(0, 1000),
      moneyIn: amountText(cell(row, signed ? columns.amount : columns.moneyIn)).slice(0, 50),
      moneyOut: signed ? '' : amountText(cell(row, columns.moneyOut)).slice(0, 50),
      balance: amountText(cell(row, columns.balance)).slice(0, 50),
      reference: cellText(cell(row, columns.reference)).slice(0, 100),
    });
  }
  return out;
}

// CSV as banks export it: comma, semicolon or tab separated (the one the first lines use most), double quotes around
// cells that hold one, "" for a quote inside. Every cell is text. Rows are numbered from 1, like a sheet.
export function parseCsv(text: string): SheetRows {
  const body = text.replace(/^﻿/, '');
  const sample = body.split(/\r?\n/).slice(0, 10).join('\n');
  const delimiter = [',', ';', '\t'].reduce((best, d) => (sample.split(d).length > sample.split(best).length ? d : best), ',');
  const rows: SheetRows = new Map();
  let row = new Map<number, SheetCell>();
  let col = 0;
  let value = '';
  let quoted = false;
  let rowNo = 1;
  const endCell = () => {
    if (value.trim() !== '') row.set(col, { kind: 'text', value });
    col++;
    value = '';
  };
  const endRow = () => {
    endCell();
    if (row.size > 0) rows.set(rowNo, row);
    rowNo++;
    row = new Map();
    col = 0;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') value += ch;
  }
  if (value !== '' || row.size > 0) endRow();
  return rows;
}

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;

// A picked file as rows: an .xlsx workbook's first sheet, else CSV (UTF-8, or UTF-16 with its byte order mark, as
// Excel saves "Unicode text").
export async function readStatementFile(bytes: Uint8Array, name: string): Promise<SheetRows> {
  if (/\.xlsx$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return readFirstSheet(bytes);
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  return parseCsv(new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(bytes));
}
