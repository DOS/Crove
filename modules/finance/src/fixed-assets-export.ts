// Excel export of the register of fixed assets and prepaid costs (#919) for the accountant: one row per entry with its
// accounts, schedule, what was posted and what is left (sổ tài sản cố định, bảng phân bổ chi phí trả trước). Same cell
// rules as the other exports (export.ts): amounts exact through moneyCell, text never read as a formula. Labels stay
// Vietnamese in every locale.
import ExcelJS from 'exceljs';
import type { FixedAsset } from '@crove/kernel-contract';
import { setMoneyCell as setMoney, setTextCell as setText } from './export.ts';

const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

export async function buildFixedAssetsWorkbook(assets: readonly FixedAsset[], orgName: string): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Crove';
  workbook.title = `Sổ tài sản cố định và chi phí trả trước ${orgName}`;
  const sheet = workbook.addWorksheet('Sổ tài sản');
  sheet.columns = [
    { key: 'kind', width: 18 },
    { key: 'name', width: 40 },
    { key: 'asset', width: 12 },
    { key: 'accumulated', width: 12 },
    { key: 'expense', width: 12 },
    { key: 'cost', width: 18 },
    { key: 'start', width: 12 },
    { key: 'months', width: 10 },
    { key: 'last', width: 12 },
    { key: 'posted', width: 18 },
    { key: 'remaining', width: 18 },
    { key: 'lastPosted', width: 14 },
    { key: 'ended', width: 36 },
  ];
  const head = sheet.addRow([]);
  const titles: Record<string, string> = {
    kind: 'Loại',
    name: 'Tên tài sản',
    asset: 'TK tài sản',
    accumulated: 'TK hao mòn',
    expense: 'TK chi phí',
    cost: 'Nguyên giá',
    start: 'Tháng bắt đầu',
    months: 'Số tháng',
    last: 'Tháng cuối',
    posted: 'Đã khấu hao, phân bổ',
    remaining: 'Giá trị còn lại',
    lastPosted: 'Đã ghi đến tháng',
    ended: 'Dừng',
  };
  for (const [key, title] of Object.entries(titles)) setText(head.getCell(key), title);
  head.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const a of assets) {
    const row = sheet.addRow([]);
    setText(row.getCell('kind'), a.kind === 'fixed_asset' ? 'Tài sản cố định' : 'Chi phí trả trước');
    setText(row.getCell('name'), a.name);
    setText(row.getCell('asset'), a.assetAccount);
    setText(row.getCell('accumulated'), a.accumulatedAccount ?? '');
    setText(row.getCell('expense'), a.expenseAccount);
    setMoney(row.getCell('cost'), a.cost);
    setText(row.getCell('start'), monthLabel(a.startMonth));
    row.getCell('months').value = a.months;
    setText(row.getCell('last'), monthLabel(a.lastMonth));
    setMoney(row.getCell('posted'), a.posted);
    setMoney(row.getCell('remaining'), a.remaining);
    setText(row.getCell('lastPosted'), a.lastPostedMonth ? monthLabel(a.lastPostedMonth) : '');
    setText(row.getCell('ended'), a.ended ? `Từ sau tháng ${monthLabel(a.ended.month)}: ${a.ended.reason}` : '');
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
