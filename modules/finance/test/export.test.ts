import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { Decimal, type DecimalValue } from '@crove/l10n-vn';
import { buildJournalWorkbook, moneyCell, safeText } from '../src/export.ts';
import type { JournalEntryView } from '../src/queries.ts';

const AMOUNT_COLUMN = 10;

function entry(id: string, amount: string, overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id,
    entryDate: '2026-10-01',
    description: 'Mua văn phòng phẩm',
    sourceType: 'purchase_document',
    sourceId: id,
    lines: [
      { lineNo: 1, accountCode: '6422', accountName: 'Chi phí quản lý', debit: amount, credit: '0' },
      { lineNo: 2, accountCode: '331', accountName: 'Phải trả người bán', debit: '0', credit: amount },
    ],
    document: { series: '1C26TAA', number: '00000123', issueDate: '2026-09-30', partyName: 'Công ty TNHH ABC', partyTaxCode: '0101234565' },
    ...overrides,
  };
}

async function readBack(entries: JournalEntryView[]): Promise<ExcelJS.Worksheet> {
  const bytes = await buildJournalWorkbook(entries, 'demo');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheet = workbook.getWorksheet('But toan');
  if (!sheet) throw new Error('sheet missing');
  return sheet;
}

// Reads an amount cell back as a decimal without assuming its storage: text cells must hold the exact
// decimal string; numeric cells are read the way Excel and exceljs do (shortest double string).
function amountOf(cell: ExcelJS.Cell): { type: 'number' | 'text'; value: DecimalValue } {
  if (cell.type === ExcelJS.ValueType.Number) return { type: 'number', value: new Decimal(String(cell.value)) };
  if (cell.type === ExcelJS.ValueType.String) return { type: 'text', value: new Decimal(String(cell.value)) };
  throw new Error(`unexpected cell type ${cell.type}`);
}

describe('moneyCell', () => {
  it('keeps amounts Excel can hold exactly as numbers', () => {
    expect(moneyCell('1500000')).toEqual({ kind: 'number', value: 1500000, numFmt: '#,##0' });
    expect(moneyCell('1500000.5')).toEqual({ kind: 'number', value: 1500000.5, numFmt: '#,##0.0' });
    expect(moneyCell('12345678901.2345')).toEqual({ kind: 'number', value: 12345678901.2345, numFmt: '#,##0.0000' });
    expect(moneyCell('-250000')).toEqual({ kind: 'number', value: -250000, numFmt: '#,##0' });
    expect(moneyCell('0')).toEqual({ kind: 'number', value: 0, numFmt: '#,##0' });
  });
  it('writes amounts beyond 15 significant digits as exact text', () => {
    expect(moneyCell('1234567890123456.7891')).toEqual({ kind: 'text', value: '1234567890123456.7891' });
    expect(moneyCell('9007199254740993')).toEqual({ kind: 'text', value: '9007199254740993' });
    // 16 digits that a double happens to hold exactly still exceed what Excel keeps.
    expect(moneyCell('1234567890123456')).toEqual({ kind: 'text', value: '1234567890123456' });
    expect(moneyCell('-1234567890123456.7891')).toEqual({ kind: 'text', value: '-1234567890123456.7891' });
  });
});

describe('safeText', () => {
  it('prefixes values that start with a formula trigger', () => {
    for (const payload of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1:A2)', '\t=1', '\r=1', '=HYPERLINK("http://x","y")']) {
      expect(safeText(payload)).toBe(`'${payload}`);
    }
  });
  it('leaves normal values unchanged', () => {
    for (const value of ['Công ty TNHH ABC', '0101234565-001', '2026-10-01', 'a=b', ' =1', '']) {
      expect(safeText(value)).toBe(value);
    }
    expect(safeText(null)).toBe('');
    expect(safeText(undefined)).toBe('');
  });
});

describe('buildJournalWorkbook', () => {
  it('round-trips large and 4-decimal amounts exactly', async () => {
    const amounts = [
      '1234567890123456.7891', // 20 significant digits, the numeric(20,4) maximum shape
      '9999999999999999.9999',
      '9007199254740993', // not representable as a double
      '12345678901.2345', // 15 significant digits, 4 decimals
      '0.0001',
      '1500000',
    ];
    const sheet = await readBack(amounts.map((a, i) => entry(`e${i}`, a)));
    amounts.forEach((expected, i) => {
      const read = amountOf(sheet.getRow(i + 2).getCell(AMOUNT_COLUMN));
      expect(read.value.eq(new Decimal(expected)), `row ${i + 2}: ${read.value.toFixed()} vs ${expected}`).toBe(true);
      expect(read.type).toBe(new Decimal(expected).precision(true) > 15 ? 'text' : 'number');
    });
    // Text amounts hold the exact decimal string, not a rounded rendering.
    expect(sheet.getRow(2).getCell(AMOUNT_COLUMN).value).toBe('1234567890123456.7891');
    expect(sheet.getRow(5).getCell(AMOUNT_COLUMN).numFmt).toBe('#,##0.0000');
  });

  it('keeps negative amounts numeric and unprefixed', async () => {
    // Ledger lines are non-negative in the database; the export still must not turn a sign into text.
    const sheet = await readBack([entry('n', '-60.25')]);
    const cell = sheet.getRow(2).getCell(AMOUNT_COLUMN);
    expect(cell.type).toBe(ExcelJS.ValueType.Number);
    expect(cell.value).toBe(-60.25);
    expect(cell.numFmt).toBe('#,##0.00');
  });

  it('neutralizes formula payloads in descriptions, party names and invoice numbers', async () => {
    const hostile = entry('h', '1000', {
      description: '=HYPERLINK("http://evil.example","click")',
      document: { series: '+1C26', number: '@123', issueDate: '2026-09-30', partyName: '-2+3+cmd|"/C calc"!A0', partyTaxCode: '\t=1' },
    });
    const sheet = await readBack([hostile]);
    const row = sheet.getRow(2);
    const texts = [3, 4, 5, 6, 7].map((c) => row.getCell(c));
    for (const cell of texts) {
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(String(cell.value).startsWith("'")).toBe(true);
      expect(cell.formula).toBeUndefined();
    }
    expect(row.getCell(7).value).toBe(`'=HYPERLINK("http://evil.example","click")`);
    expect(row.getCell(6).value).toBe(`'-2+3+cmd|"/C calc"!A0`);
  });

  it('leaves normal values unchanged', async () => {
    const sheet = await readBack([entry('ok', '1500000')]);
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('2026-10-01');
    expect(row.getCell(3).value).toBe('1C26TAA');
    expect(row.getCell(4).value).toBe('00000123');
    expect(row.getCell(5).value).toBe('0101234565');
    expect(row.getCell(6).value).toBe('Công ty TNHH ABC');
    expect(row.getCell(7).value).toBe('Mua văn phòng phẩm');
    expect(row.getCell(8).value).toBe('6422');
    expect(row.getCell(9).value).toBe('331');
    expect(row.getCell(AMOUNT_COLUMN).value).toBe(1500000);
    expect(row.getCell(AMOUNT_COLUMN).numFmt).toBe('#,##0');
  });
});
