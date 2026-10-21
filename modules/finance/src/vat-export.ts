// Excel export of a period's VAT working (issue #316) for the accountant: a summary sheet with the form 01/GTGT
// indicators and the totals by rate, then one sheet per side listing each invoice by rate (one row per invoice and
// rate, as on a purchase or sales listing). Same cell rules as the journal export (export.ts): amounts exact through
// moneyCell, text never read as a formula. Headers and labels stay Vietnamese in every locale: the file goes to
// Vietnamese accountants and their software.
import ExcelJS from 'exceljs';
import { money } from '@crove/l10n-vn';
import { setMoneyCell as setMoney, setTextCell as setText } from './export.ts';
import type { VatRate } from './domain/vat-return.ts';
import type { VatInvoiceView, VatReport, VatSide, VatWarning } from './vat.ts';

export const VAT_RATE_LABELS: Readonly<Record<VatRate, string>> = {
  '0': '0%',
  '5': '5%',
  '8': '8%',
  '10': '10%',
  KCT: 'Không chịu thuế',
  KKKNT: 'Không kê khai, tính nộp thuế',
  other: 'Chưa rõ thuế suất',
};

export const VAT_WARNING_LABELS: Readonly<Record<VatWarning, string>> = {
  rate_unknown: 'Có dòng chưa rõ thuế suất',
  rate_split: 'Thuế GTGT chia theo thuế suất là số ước tính',
  reduced_rate_outside_period: 'Thuế suất 8% ngoài thời gian được giảm thuế',
  lines_mismatch: 'Tổng các dòng lệch tiền trước thuế của hóa đơn; số tổng cộng theo các dòng',
  vat_mismatch: 'Thuế GTGT lệch giá trị trước thuế nhân thuế suất',
  declared_late: 'Hóa đơn của kỳ trước, ghi sổ và kê khai vào kỳ này vì tháng của hóa đơn đã khóa sổ',
  check_payment: 'Đạt ngưỡng phải thanh toán không dùng tiền mặt mà chưa rõ đã thanh toán qua ngân hàng: kiểm tra chứng từ trước khi khấu trừ',
};

function invoiceSheet(workbook: ExcelJS.Workbook, name: string, side: VatSide, partyHeader: string, taxCodeHeader: string): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: 'STT', key: 'no', width: 6 },
    { header: 'Ngày hóa đơn', key: 'issueDate', width: 14 },
    { header: 'Ký hiệu HĐ', key: 'series', width: 12 },
    { header: 'Số HĐ', key: 'number', width: 12 },
    { header: taxCodeHeader, key: 'taxCode', width: 16 },
    { header: partyHeader, key: 'partyName', width: 36 },
    { header: 'Thuế suất', key: 'rate', width: 16 },
    { header: 'Giá trị chưa có thuế', key: 'taxable', width: 22 },
    { header: 'Thuế GTGT', key: 'vat', width: 20 },
    { header: 'Ghi chú', key: 'note', width: 40 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (!side.available) {
    const row = sheet.addRow([]);
    setText(row.getCell('partyName'), 'Chưa nhập mã số thuế của tổ chức nên Crove chưa nhận ra hóa đơn bán ra');
    return;
  }
  side.documents.forEach((doc: VatInvoiceView, index) => {
    const note = doc.warnings.map((w) => VAT_WARNING_LABELS[w]).join('; ');
    for (const rate of doc.rates) {
      const row = sheet.addRow([]);
      row.getCell('no').value = index + 1;
      setText(row.getCell('issueDate'), doc.issueDate);
      setText(row.getCell('series'), doc.series);
      setText(row.getCell('number'), doc.number);
      setText(row.getCell('taxCode'), doc.partyTaxCode);
      setText(row.getCell('partyName'), doc.partyName);
      setText(row.getCell('rate'), VAT_RATE_LABELS[rate.rate]);
      setMoney(row.getCell('taxable'), rate.taxable);
      setMoney(row.getCell('vat'), rate.vat);
      setText(row.getCell('note'), note);
    }
  });
  const total = sheet.addRow([]);
  setText(total.getCell('partyName'), 'Tổng cộng');
  setMoney(total.getCell('taxable'), side.totals.taxable);
  setMoney(total.getCell('vat'), side.totals.vat);
  total.font = { bold: true };
}

export async function buildVatWorkbook(report: VatReport, orgName: string): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Crove';
  workbook.title = `Tờ khai GTGT ${report.period.period} ${orgName}`;

  const summary = workbook.addWorksheet('Tổng hợp');
  summary.columns = [
    { key: 'code', width: 10 },
    { key: 'label', width: 70 },
    { key: 'taxable', width: 22 },
    { key: 'vat', width: 20 },
  ];
  const heading = summary.addRow([]);
  setText(heading.getCell('label'), `Kỳ ${report.period.period} (${report.period.from} đến ${report.period.to})`);
  heading.font = { bold: true };

  summary.addRow([]);
  const formHead = summary.addRow([]);
  setText(formHead.getCell('code'), 'Chỉ tiêu');
  setText(formHead.getCell('label'), 'Tờ khai 01/GTGT');
  setText(formHead.getCell('taxable'), 'Số tiền');
  formHead.font = { bold: true };
  for (const indicator of report.indicators) {
    const row = summary.addRow([]);
    setText(row.getCell('code'), `[${indicator.code}]`);
    setText(row.getCell('label'), indicator.label);
    setMoney(row.getCell('taxable'), indicator.amount);
  }
  const note = summary.addRow([]);
  setText(note.getCell('label'), 'Chỉ tiêu [25] (thuế GTGT được khấu trừ) do kế toán xác định; hàng hóa 8% kê khai thêm phụ lục giảm thuế GTGT.');
  // Sales at a rate Crove cannot place are in the totals but in no indicator (issue #358).
  const otherSales = report.output.totals.byRate.find((r) => r.rate === 'other')?.taxable ?? '0';
  if (!money(otherSales).isZero()) {
    const row = summary.addRow([]);
    setText(row.getCell('label'), 'Doanh thu bán ra chưa rõ thuế suất, không nằm trong chỉ tiêu nào: kiểm tra các hóa đơn đó trước khi nộp tờ khai');
    setMoney(row.getCell('taxable'), otherSales);
  }

  for (const [title, side] of [
    ['Hóa đơn bán ra theo thuế suất', report.output],
    ['Hóa đơn mua vào theo thuế suất', report.input],
  ] as const) {
    summary.addRow([]);
    const head = summary.addRow([]);
    setText(head.getCell('label'), title);
    setText(head.getCell('taxable'), 'Giá trị chưa có thuế');
    setText(head.getCell('vat'), 'Thuế GTGT');
    head.font = { bold: true };
    for (const rate of side.totals.byRate) {
      const row = summary.addRow([]);
      setText(row.getCell('label'), VAT_RATE_LABELS[rate.rate]);
      setMoney(row.getCell('taxable'), rate.taxable);
      setMoney(row.getCell('vat'), rate.vat);
    }
    const total = summary.addRow([]);
    setText(total.getCell('label'), side.available ? `Tổng cộng (${side.totals.documents} hóa đơn)` : 'Chưa nhập mã số thuế của tổ chức nên Crove chưa nhận ra hóa đơn bán ra');
    setMoney(total.getCell('taxable'), side.totals.taxable);
    setMoney(total.getCell('vat'), side.totals.vat);
    total.font = { bold: true };
  }

  invoiceSheet(workbook, 'Bán ra', report.output, 'Tên người mua', 'MST người mua');
  invoiceSheet(workbook, 'Mua vào', report.input, 'Tên người bán', 'MST người bán');
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
