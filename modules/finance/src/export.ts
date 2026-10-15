// Excel export for the accountant: one row per debit/credit pair (Nợ/Có), the layout most Vietnamese
// accounting software imports for "chứng từ nghiệp vụ khác". Not a vendor-specific template.
//
// Two rules keep the file safe to open:
// - Money is exact. A numeric cell is used only when the double Excel stores shows the same decimal
//   (at most 15 significant digits, and the shortest double string equals the amount); otherwise the
//   amount is written as a text cell holding the exact decimal string. See `moneyCell`.
// - No text cell is read as a formula. Every text value that starts with a formula trigger is prefixed
//   with a single quote (OWASP "CSV Injection"), and text columns carry the Text number format. See
//   `safeText`.
//
// There is no CSV export. If one is added, it must use `safeText` and `moneyCell` (or the same rules).
import ExcelJS from 'exceljs';
import { Decimal, money, toMoney } from '@crove/l10n-vn';
import type { JournalEntryView } from './queries.ts';

// Excel keeps 15 significant digits of a number; anything longer is silently changed on entry.
const EXCEL_SIGNIFICANT_DIGITS = 15;

// OWASP CSV Injection: cells starting with these characters may be interpreted as formulas.
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export type MoneyCell =
  | { kind: 'number'; value: number; numFmt: string }
  | { kind: 'text'; value: string };

/**
 * Chooses how to store an amount. The decimal is never rounded through a JavaScript number: the number
 * is used only after checking that it converts back to the identical decimal and fits in Excel's 15
 * significant digits, so Excel shows and sums the exact amount. Larger amounts become text, exact.
 */
export function moneyCell(amount: string): MoneyCell {
  const exact = money(toMoney(money(amount)));
  if (exact.isZero()) return { kind: 'number', value: 0, numFmt: '#,##0' };
  const canonical = exact.toFixed();
  if (exact.precision(true) <= EXCEL_SIGNIFICANT_DIGITS) {
    const asNumber = Number(canonical);
    if (Number.isFinite(asNumber) && new Decimal(String(asNumber)).eq(exact)) {
      const places = exact.decimalPlaces();
      return { kind: 'number', value: asNumber, numFmt: places === 0 ? '#,##0' : `#,##0.${'0'.repeat(places)}` };
    }
  }
  return { kind: 'text', value: canonical };
}

/** Neutralizes spreadsheet formula injection in a user- or vendor-controlled text value. */
export function safeText(value: string | null | undefined): string {
  const text = value ?? '';
  return text.length > 0 && FORMULA_TRIGGERS.has(text.charAt(0)) ? `'${text}` : text;
}

const TEXT_FORMAT = '@';

export async function buildJournalWorkbook(entries: JournalEntryView[], orgName: string): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Crove';
  const sheet = workbook.addWorksheet('But toan');
  sheet.columns = [
    { header: 'Ngày hạch toán', key: 'entryDate', width: 14 },
    { header: 'Ngày hóa đơn', key: 'invoiceDate', width: 14 },
    { header: 'Ký hiệu HĐ', key: 'series', width: 12 },
    { header: 'Số HĐ', key: 'number', width: 12 },
    { header: 'MST nhà cung cấp', key: 'taxCode', width: 16 },
    { header: 'Tên nhà cung cấp', key: 'partyName', width: 36 },
    { header: 'Diễn giải', key: 'memo', width: 40 },
    { header: 'TK Nợ', key: 'debitAccount', width: 8 },
    { header: 'TK Có', key: 'creditAccount', width: 8 },
    { header: 'Số tiền', key: 'amount', width: 22 },
  ];
  const textKeys = ['entryDate', 'invoiceDate', 'series', 'number', 'taxCode', 'partyName', 'memo', 'debitAccount', 'creditAccount'];

  for (const entry of entries) {
    const credits = entry.lines.filter((l) => !money(l.credit).isZero());
    const debits = entry.lines.filter((l) => !money(l.debit).isZero());
    // Purchase entries have a single credit (331); pair each debit with it. Otherwise list lines as they are.
    const pairs =
      credits.length === 1 && credits[0]
        ? debits.map((d) => ({ debitAccount: d.accountCode, creditAccount: credits[0]?.accountCode ?? '', amount: d.debit }))
        : entry.lines.map((l) =>
            money(l.debit).isZero()
              ? { debitAccount: '', creditAccount: l.accountCode, amount: l.credit }
              : { debitAccount: l.accountCode, creditAccount: '', amount: l.debit },
          );
    for (const pair of pairs) {
      const amount = moneyCell(pair.amount);
      const row = sheet.addRow({
        entryDate: safeText(entry.entryDate),
        invoiceDate: safeText(entry.document?.issueDate),
        series: safeText(entry.document?.series),
        number: safeText(entry.document?.number),
        taxCode: safeText(entry.document?.partyTaxCode),
        partyName: safeText(entry.document?.partyName),
        memo: safeText(entry.description),
        debitAccount: safeText(pair.debitAccount),
        creditAccount: safeText(pair.creditAccount),
        amount: amount.value,
      });
      for (const key of textKeys) row.getCell(key).numFmt = TEXT_FORMAT;
      const amountCell = row.getCell('amount');
      if (amount.kind === 'number') {
        amountCell.numFmt = amount.numFmt;
      } else {
        // Exact decimal kept as text (more digits than Excel can hold); aligned like a number.
        amountCell.numFmt = TEXT_FORMAT;
        amountCell.alignment = { horizontal: 'right' };
      }
    }
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  workbook.title = `But toan ${orgName}`;
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
