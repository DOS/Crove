// Excel export of a period's financial statements (issue #154) for the accountant: B01-DNN at the period's last day
// and B02-DNN for the period, one sheet each, with the comparison columns of the screen (#2090): B01's start of year,
// and B02 for the same period of the previous year and, for a month or a quarter, for the period right before. A
// comparison that does not exist (before the year 2000) has no column. The line codes and the account mapping are a DRAFT nobody has verified
// (domain/tt133-reports.ts), so each sheet says so on its first line, and lists the balances no line reads. Same cell
// rules as the other exports (export.ts): amounts exact through moneyCell, text never read as a formula. Labels stay
// Vietnamese in every locale.
import ExcelJS from 'exceljs';
import { setMoneyCell as setMoney, setTextCell as setText } from './export.ts';
import type { ColumnAmounts, FinancialStatements, StatementLine, UnmappedRow } from './statements.ts';

export const DRAFT_NOTICE = 'BẢN NHÁP: mã chỉ tiêu và cách lấy số liệu từ tài khoản chưa được kế toán kiểm tra; không dùng để nộp.';

// A column beside the period's own: its heading, and the amount of each line by code (a line the column's period has no
// entries for reads 0).
interface ComparisonColumn {
  header: string;
  amounts: ColumnAmounts;
}

function statementSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  title: string,
  column: string,
  lines: readonly StatementLine[],
  unmapped: readonly UnmappedRow[],
  comparisons: readonly ComparisonColumn[] = [],
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { key: 'label', width: 64 },
    { key: 'code', width: 10 },
    { key: 'amount', width: 22 },
    ...comparisons.map((_, i) => ({ key: `compare${i}`, width: 28 })),
  ];
  const notice = sheet.addRow([]);
  setText(notice.getCell('label'), DRAFT_NOTICE);
  notice.font = { bold: true, color: { argb: 'FFB45309' } };
  const heading = sheet.addRow([]);
  setText(heading.getCell('label'), title);
  heading.font = { bold: true };
  const head = sheet.addRow([]);
  setText(head.getCell('label'), 'Chỉ tiêu');
  setText(head.getCell('code'), 'Mã số');
  setText(head.getCell('amount'), column);
  comparisons.forEach((c, i) => setText(head.getCell(`compare${i}`), c.header));
  head.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  for (const line of lines) {
    const row = sheet.addRow([]);
    setText(row.getCell('label'), line.label);
    setText(row.getCell('code'), line.code);
    setMoney(row.getCell('amount'), line.amount);
    comparisons.forEach((c, i) => setMoney(row.getCell(`compare${i}`), c.amounts[line.code] ?? '0'));
    if (line.total) row.font = { bold: true };
  }
  if (unmapped.length > 0) {
    sheet.addRow([]);
    const warn = sheet.addRow([]);
    setText(warn.getCell('label'), 'Cảnh báo: các số dư dưới đây chưa được chỉ tiêu nào đọc, báo cáo chưa đầy đủ (số dư Nợ dương, Có âm)');
    warn.font = { bold: true };
    for (const u of unmapped) {
      const row = sheet.addRow([]);
      setText(row.getCell('label'), [u.accountName, u.partyName].filter(Boolean).join(', ') || u.accountCode);
      setText(row.getCell('code'), u.accountCode);
      setMoney(row.getCell('amount'), u.amount);
    }
  }
  return sheet;
}

// brand: the product name users see (BRAND_NAME, #1045), as the file's creator.
export async function buildStatementsWorkbook(statements: FinancialStatements, orgName: string, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `Báo cáo tài chính ${statements.period.period} ${orgName}`;
  const { startOfYear, lastYear, previous } = statements.comparison;
  const b01 = statementSheet(
    workbook,
    'B01-DNN',
    `Báo cáo tình hình tài chính (B01-DNN) tại ngày ${statements.b01.asOf}`,
    `Số cuối kỳ (${statements.b01.asOf})`,
    statements.b01.lines,
    statements.b01.unmapped,
    startOfYear ? [{ header: `Số đầu năm (${startOfYear.asOf})`, amounts: startOfYear.amounts }] : [],
  );
  if (!statements.b01.balanced) {
    const note = b01.addRow([]);
    setText(note.getCell('label'), 'Cảnh báo: tổng tài sản (mã 200) và tổng nguồn vốn (mã 500) không bằng nhau');
    note.font = { bold: true };
  }
  statementSheet(
    workbook,
    'B02-DNN',
    `Báo cáo kết quả hoạt động kinh doanh (B02-DNN), kỳ ${statements.period.period} (${statements.b02.from} đến ${statements.b02.to})`,
    `Kỳ này`,
    statements.b02.lines,
    statements.b02.unmapped,
    [
      ...(lastYear ? [{ header: `${statements.period.kind === 'year' ? 'Năm trước' : 'Cùng kỳ năm trước'} (${lastYear.period})`, amounts: lastYear.amounts }] : []),
      ...(previous ? [{ header: `Kỳ liền trước (${previous.period})`, amounts: previous.amounts }] : []),
    ],
  );
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
