// Excel export for the accountant: one row per debit/credit pair (Nợ/Có), the layout most Vietnamese
// accounting software imports for "chứng từ nghiệp vụ khác". Not a vendor-specific template.
import ExcelJS from 'exceljs';
import { money, toMoney } from '@crove/l10n-vn';
import type { JournalEntryView } from './queries.ts';

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
    { header: 'Số tiền', key: 'amount', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };

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
      sheet.addRow({
        entryDate: entry.entryDate,
        invoiceDate: entry.document?.issueDate ?? '',
        series: entry.document?.series ?? '',
        number: entry.document?.number ?? '',
        taxCode: entry.document?.partyTaxCode ?? '',
        partyName: entry.document?.partyName ?? '',
        memo: entry.description,
        debitAccount: pair.debitAccount,
        creditAccount: pair.creditAccount,
        amount: Number(toMoney(money(pair.amount))),
      });
    }
  }
  sheet.getColumn('amount').numFmt = '#,##0';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  workbook.title = `But toan ${orgName}`;
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
