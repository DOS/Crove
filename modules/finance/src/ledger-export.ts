// Excel export of a period's ledger reports (issue #321) for the accountant, one workbook: the trial balance, the
// general ledger of every top-level account (each with its sub-accounts), then receivables and payables per party.
// Same cell rules as the journal export (export.ts): amounts exact through moneyCell, text never read as a formula.
// Headers and labels stay Vietnamese in every locale: the file goes to Vietnamese accountants and their software.
import ExcelJS from 'exceljs';
import { money } from '@crove/l10n-vn';
import { setMoneyCell as setMoney, setTextCell as setText } from './export.ts';
import type { PartyLedger } from './domain/ledger-reports.ts';
import type { LedgerBook } from './ledger-reports.ts';

const NO_PARTY = 'Chưa gắn đối tượng';

// A signed balance (debit minus credit) in the debit or the credit column.
function balanceCells(row: ExcelJS.Row, debitKey: string, creditKey: string, balance: string): void {
  const value = money(balance);
  if (value.isZero()) return;
  if (value.isNegative()) setMoney(row.getCell(creditKey), value.negated().toFixed());
  else setMoney(row.getCell(debitKey), value.toFixed());
}

function heading(sheet: ExcelJS.Worksheet, key: string, text: string): void {
  const row = sheet.addRow([]);
  setText(row.getCell(key), text);
  row.font = { bold: true };
}

function trialBalanceSheet(workbook: ExcelJS.Workbook, book: LedgerBook, range: string): void {
  const sheet = workbook.addWorksheet('Cân đối phát sinh');
  sheet.columns = [
    { key: 'code', width: 12 },
    { key: 'name', width: 48 },
    { key: 'openingDebit', width: 20 },
    { key: 'openingCredit', width: 20 },
    { key: 'debit', width: 20 },
    { key: 'credit', width: 20 },
    { key: 'closingDebit', width: 20 },
    { key: 'closingCredit', width: 20 },
  ];
  heading(sheet, 'name', `Bảng cân đối số phát sinh, ${range}`);
  const head = sheet.addRow([]);
  const labels: Array<[string, string]> = [
    ['code', 'Số hiệu TK'],
    ['name', 'Tên tài khoản'],
    ['openingDebit', 'Dư Nợ đầu kỳ'],
    ['openingCredit', 'Dư Có đầu kỳ'],
    ['debit', 'Phát sinh Nợ'],
    ['credit', 'Phát sinh Có'],
    ['closingDebit', 'Dư Nợ cuối kỳ'],
    ['closingCredit', 'Dư Có cuối kỳ'],
  ];
  for (const [key, label] of labels) setText(head.getCell(key), label);
  head.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  const amountKeys = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const;
  for (const r of book.trialBalance.rows) {
    const row = sheet.addRow([]);
    setText(row.getCell('code'), r.accountCode);
    setText(row.getCell('name'), r.accountName);
    // Sub-accounts indented under their parent.
    if (r.level > 0) row.getCell('name').alignment = { indent: r.level * 2 };
    for (const key of amountKeys) setMoney(row.getCell(key), r[key]);
    if (r.level === 0) row.font = { bold: true };
  }
  const total = sheet.addRow([]);
  setText(total.getCell('name'), 'Tổng cộng');
  for (const key of amountKeys) setMoney(total.getCell(key), book.trialBalance.totals[key]);
  total.font = { bold: true };
  if (!book.trialBalance.balanced) {
    const note = sheet.addRow([]);
    setText(note.getCell('name'), 'Cảnh báo: tổng Nợ và tổng Có không bằng nhau');
  }
}

function generalLedgerSheet(workbook: ExcelJS.Workbook, book: LedgerBook, range: string): void {
  const sheet = workbook.addWorksheet('Sổ cái');
  sheet.columns = [
    { key: 'date', width: 12 },
    { key: 'reference', width: 16 },
    { key: 'description', width: 44 },
    { key: 'account', width: 10 },
    { key: 'counter', width: 14 },
    { key: 'party', width: 32 },
    { key: 'debit', width: 18 },
    { key: 'credit', width: 18 },
    { key: 'balanceDebit', width: 18 },
    { key: 'balanceCredit', width: 18 },
  ];
  heading(sheet, 'description', `Sổ cái, ${range}`);
  const head = sheet.addRow([]);
  const labels: Array<[string, string]> = [
    ['date', 'Ngày ghi sổ'],
    ['reference', 'Số chứng từ'],
    ['description', 'Diễn giải'],
    ['account', 'TK'],
    ['counter', 'TK đối ứng'],
    ['party', 'Đối tượng'],
    ['debit', 'Phát sinh Nợ'],
    ['credit', 'Phát sinh Có'],
    ['balanceDebit', 'Dư Nợ'],
    ['balanceCredit', 'Dư Có'],
  ];
  for (const [key, label] of labels) setText(head.getCell(key), label);
  head.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  for (const ledger of book.ledgers) {
    sheet.addRow([]);
    heading(sheet, 'description', `Tài khoản ${ledger.account.code}: ${ledger.account.name}`);
    const opening = sheet.addRow([]);
    setText(opening.getCell('description'), 'Số dư đầu kỳ');
    balanceCells(opening, 'balanceDebit', 'balanceCredit', ledger.opening);
    for (const line of ledger.lines) {
      const row = sheet.addRow([]);
      setText(row.getCell('date'), line.entryDate);
      setText(row.getCell('reference'), line.reference);
      setText(row.getCell('description'), line.description);
      setText(row.getCell('account'), line.accountCode);
      setText(row.getCell('counter'), line.counterAccounts.join(', '));
      setText(row.getCell('party'), line.partyName);
      if (!money(line.debit).isZero()) setMoney(row.getCell('debit'), line.debit);
      if (!money(line.credit).isZero()) setMoney(row.getCell('credit'), line.credit);
      balanceCells(row, 'balanceDebit', 'balanceCredit', line.balance);
    }
    const turnover = sheet.addRow([]);
    setText(turnover.getCell('description'), 'Cộng phát sinh');
    setMoney(turnover.getCell('debit'), ledger.debit);
    setMoney(turnover.getCell('credit'), ledger.credit);
    turnover.font = { bold: true };
    const closing = sheet.addRow([]);
    setText(closing.getCell('description'), 'Số dư cuối kỳ');
    balanceCells(closing, 'balanceDebit', 'balanceCredit', ledger.closing);
    closing.font = { bold: true };
  }
}

function partySheet(workbook: ExcelJS.Workbook, name: string, title: string, ledger: PartyLedger, partyHeader: string): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { key: 'taxCode', width: 16 },
    { key: 'party', width: 44 },
    { key: 'opening', width: 20 },
    { key: 'increase', width: 20 },
    { key: 'decrease', width: 20 },
    { key: 'closing', width: 20 },
  ];
  heading(sheet, 'party', title);
  const head = sheet.addRow([]);
  const labels: Array<[string, string]> = [
    ['taxCode', 'Mã số thuế'],
    ['party', partyHeader],
    ['opening', 'Số dư đầu kỳ'],
    ['increase', 'Phát sinh tăng'],
    ['decrease', 'Phát sinh giảm'],
    ['closing', 'Số dư cuối kỳ'],
  ];
  for (const [key, label] of labels) setText(head.getCell(key), label);
  head.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  for (const r of ledger.rows) {
    const row = sheet.addRow([]);
    setText(row.getCell('taxCode'), r.partyTaxCode);
    setText(row.getCell('party'), r.partyId === null ? NO_PARTY : r.partyName);
    setMoney(row.getCell('opening'), r.opening);
    setMoney(row.getCell('increase'), r.increase);
    setMoney(row.getCell('decrease'), r.decrease);
    setMoney(row.getCell('closing'), r.closing);
  }
  const total = sheet.addRow([]);
  setText(total.getCell('party'), 'Tổng cộng');
  setMoney(total.getCell('opening'), ledger.totals.opening);
  setMoney(total.getCell('increase'), ledger.totals.increase);
  setMoney(total.getCell('decrease'), ledger.totals.decrease);
  setMoney(total.getCell('closing'), ledger.totals.closing);
  total.font = { bold: true };
  const note = sheet.addRow([]);
  setText(note.getCell('party'), 'Số âm: khoản trả trước');
}

// brand: the product name users see (BRAND_NAME, #1045), as the file's creator.
export async function buildLedgerWorkbook(book: LedgerBook, orgName: string, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `Sổ sách ${book.period.period} ${orgName}`;
  const range = `kỳ ${book.period.period} (${book.period.from} đến ${book.period.to})`;
  trialBalanceSheet(workbook, book, range);
  generalLedgerSheet(workbook, book, range);
  partySheet(workbook, 'Phải thu', `Công nợ phải thu khách hàng (TK 131), ${range}`, book.receivables, 'Khách hàng');
  partySheet(workbook, 'Phải trả', `Công nợ phải trả người bán (TK 331), ${range}`, book.payables, 'Nhà cung cấp');
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
