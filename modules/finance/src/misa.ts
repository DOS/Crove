// Vouchers in the Excel import templates of MISA SME (issue #317). The firm keeps its system of record (decision
// D10); Crove hands it purchase and sales vouchers in the layout MISA's "Tệp > Nhập khẩu từ Excel" reads.
//
// Every column of a template is one entry of its `columns` array below: the header exactly as MISA's template
// spells it (MISA matches columns by header name) and the rule that fills it. To follow the partner's real
// template, edit that array; nothing else knows the column order. Sources, versions and which headers are
// confirmed: docs/integrations/misa-sme-import.md.
//
// A voucher with several invoice lines is several rows: the voucher columns repeat and the line columns change
// (MISA's rule for multi-line vouchers). Cells that name a MISA catalog entry (vendor, customer, item, unit,
// employee codes) are left blank: Crove cannot know the firm's codes, and an unknown code makes MISA refuse the row.
//
// Values follow the same safety rules as the journal export (export.ts): amounts are exact (`decimalCell`) and
// text is written as inert string cells.
import ExcelJS from 'exceljs';
import {
  FIXED_ASSETS,
  PAYABLE_ACCOUNT,
  VAT_INPUT_ASSETS,
  VAT_INPUT_GOODS,
  fixedAssetVat,
  money,
  sum,
  type DecimalValue,
} from '@crove/l10n-vn';
import { canonical, roundToCurrency } from './domain/money.ts';
import { decimalCell, textCell } from './export.ts';

// ---------------------------------------------------------------------------------------------------------------
// Inputs

export interface VoucherParty {
  name: string;
  taxCode: string | null;
  address: string | null;
}

export interface VoucherInvoice {
  series: string;
  number: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface VoucherLine {
  lineNo: number;
  description: string;
  unit: string | null;
  quantity: string | null;
  unitPrice: string | null;
  /** Pre-tax line amount, signed (a trade discount line is negative). */
  amount: string;
  /** As on the invoice: "10%", "8%", "0%", "KCT", "KKKNT", "KHAC:5.26%", or null when unknown. */
  vatRate: string | null;
}

/** An approved purchase document with its journal entry (VND only: Crove refuses other currencies). */
export interface PurchaseVoucher {
  entryId: string;
  /** Journal entry date, YYYY-MM-DD. */
  entryDate: string;
  description: string;
  invoice: VoucherInvoice;
  vendor: VoucherParty;
  /** VAT total of the document. */
  vatAmount: string;
  lines: Array<VoucherLine & { debitAccount: string }>;
}

/**
 * A sales voucher. There is no sales data on main yet (sales e-invoices are issue #313); this shape is what the
 * sales export needs from it, so #313 only has to load it.
 */
export interface SalesVoucher {
  entryId: string;
  entryDate: string;
  description: string;
  invoice: VoucherInvoice;
  customer: VoucherParty;
  /** Debit account of the sale, 131 when not paid at once. */
  receivableAccount: string;
  /** Output VAT account, 3331 in the TT133 chart Crove uses. */
  vatAccount: string;
  vatAmount: string;
  lines: Array<VoucherLine & { revenueAccount: string }>;
}

// ---------------------------------------------------------------------------------------------------------------
// VAT rates and amounts

/** MISA's codes for "% thuế GTGT" (template cell notes): 0, 5, 8, 10, KCT, KKKNT, KHAC. */
export type MisaVatCode = '0' | '5' | '8' | '10' | 'KCT' | 'KKKNT' | 'KHAC';

export interface MisaVatRate {
  /** null: the invoice gave no rate Crove understands; the cell stays blank and must be checked. */
  code: MisaVatCode | null;
  /** "Tỷ lệ tính thuế (Thuế suất KHAC)", only with KHAC. */
  otherRate: string | null;
  /** Percent used to spread the VAT over the lines; null when unknown. */
  percent: DecimalValue | null;
}

const STANDARD_RATES = new Set(['0', '5', '8', '10']);

/** Maps an invoice VAT rate (TSuat of Decree 123 e-invoices, or what extraction read) to MISA's code. */
export function misaVatRate(rate: string | null): MisaVatRate {
  const text = (rate ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (text === 'KCT' || text === 'KKKNT') return { code: text, otherRate: null, percent: money(0) };
  const other = /^KHAC(?::(\d{1,3}(?:\.\d+)?)%?)?$/.exec(text);
  if (other) {
    const ratio = other[1] === undefined ? null : money(other[1]);
    return ratio && ratio.greaterThan(0) && ratio.lessThanOrEqualTo(100)
      ? { code: 'KHAC', otherRate: canonical(ratio), percent: ratio }
      : { code: 'KHAC', otherRate: null, percent: null };
  }
  const plain = /^(\d{1,3}(?:\.\d+)?)%?$/.exec(text);
  if (plain?.[1] !== undefined) {
    const percent = money(plain[1]);
    const key = canonical(percent);
    if (STANDARD_RATES.has(key)) return { code: key as MisaVatCode, otherRate: null, percent };
    if (percent.greaterThan(0) && percent.lessThanOrEqualTo(100)) return { code: 'KHAC', otherRate: key, percent };
  }
  return { code: null, otherRate: null, percent: null };
}

/**
 * Spreads a VAT total over lines so the line amounts add up to it exactly. Each line gets its amount times its
 * rate, rounded to whole VND; the rounding difference (an invoice rounds VAT per rate, not per line) goes to the
 * largest line with a positive rate, else to the largest line whose rate is unknown, else to the largest line.
 */
export function allocateVat(lines: ReadonlyArray<{ amount: string; percent: DecimalValue | null }>, total: string): string[] {
  const target = money(total);
  if (lines.length === 0) {
    if (!target.isZero()) throw new Error(`VAT ${total} has no line to carry it`);
    return [];
  }
  const estimates = lines.map((l) => (l.percent ? roundToCurrency(money(l.amount).times(l.percent).dividedBy(100), 'VND') : money(0)));
  const residual = target.minus(sum(estimates));
  if (!residual.isZero()) {
    const largest = (keep: (l: { percent: DecimalValue | null }) => boolean): number => {
      let best = -1;
      lines.forEach((l, i) => {
        if (!keep(l)) return;
        if (best === -1 || money(l.amount).abs().greaterThan(money(lines[best]?.amount).abs())) best = i;
      });
      return best;
    };
    let index = largest((l) => l.percent !== null && l.percent.greaterThan(0));
    if (index === -1) index = largest((l) => l.percent === null);
    if (index === -1) index = largest(() => true);
    estimates[index] = (estimates[index] ?? money(0)).plus(residual);
  }
  return estimates.map(canonical);
}

// ---------------------------------------------------------------------------------------------------------------
// Rows: one per voucher line

export interface MisaRow<V, L> {
  voucher: V;
  line: L;
  /** "Số chứng từ (*)" */
  voucherNo: string;
  vat: MisaVatRate;
  vatAmount: string;
  vatAccount: string;
}

export type PurchaseRow = MisaRow<PurchaseVoucher, PurchaseVoucher['lines'][number]>;
export type SalesRow = MisaRow<SalesVoucher, SalesVoucher['lines'][number]>;

/**
 * "Số chứng từ (*)", at most 20 characters. Crove has no voucher numbering, so the number comes from the journal
 * entry: a prefix and the last 12 hex digits of its id (the random part of a UUIDv7). The same entry always gets
 * the same number, so importing a period twice does not create a second voucher under a new number.
 */
export function misaVoucherNo(prefix: string, entryId: string): string {
  return `${prefix}${entryId.replace(/-/g, '').slice(-12).toUpperCase()}`;
}

export const PURCHASE_VOUCHER_PREFIX = 'CRMDV';
export const SALES_VOUCHER_PREFIX = 'CRBH';

/**
 * Purchase rows. Input VAT is split between 1331 and 1332 (fixed assets) with the rule the journal used
 * (`fixedAssetVat`), then spread over the lines of each account, so MISA posts the same VAT accounts and amounts.
 */
export function purchaseRows(voucher: PurchaseVoucher): PurchaseRow[] {
  const voucherNo = misaVoucherNo(PURCHASE_VOUCHER_PREFIX, voucher.entryId);
  const vat = money(voucher.vatAmount);
  const assetVat = fixedAssetVat(voucher.lines, vat);
  const rates = voucher.lines.map((l) => misaVatRate(l.vatRate));
  const vatAmounts: string[] = Array.from({ length: voucher.lines.length }, () => '0');
  const pools: Array<{ account: string; total: DecimalValue; isMember: (debitAccount: string) => boolean }> = [
    { account: VAT_INPUT_GOODS, total: vat.minus(assetVat), isMember: (a) => a !== FIXED_ASSETS },
    { account: VAT_INPUT_ASSETS, total: assetVat, isMember: (a) => a === FIXED_ASSETS },
  ];
  for (const pool of pools) {
    const members = voucher.lines.flatMap((l, i) => (pool.isMember(l.debitAccount) ? [i] : []));
    const amounts = allocateVat(
      members.map((i) => ({ amount: voucher.lines[i]?.amount ?? '0', percent: rates[i]?.percent ?? null })),
      canonical(pool.total),
    );
    members.forEach((lineIndex, k) => {
      vatAmounts[lineIndex] = amounts[k] ?? '0';
    });
  }
  return voucher.lines.map((line, i) => ({
    voucher,
    line,
    voucherNo,
    vat: rates[i] ?? misaVatRate(null),
    vatAmount: vatAmounts[i] ?? '0',
    vatAccount: line.debitAccount === FIXED_ASSETS ? VAT_INPUT_ASSETS : VAT_INPUT_GOODS,
  }));
}

/** Sales rows: the output VAT is spread over the lines the same way. */
export function salesRows(voucher: SalesVoucher): SalesRow[] {
  const voucherNo = misaVoucherNo(SALES_VOUCHER_PREFIX, voucher.entryId);
  const rates = voucher.lines.map((l) => misaVatRate(l.vatRate));
  const amounts = allocateVat(
    voucher.lines.map((l, i) => ({ amount: l.amount, percent: rates[i]?.percent ?? null })),
    voucher.vatAmount,
  );
  return voucher.lines.map((line, i) => ({
    voucher,
    line,
    voucherNo,
    vat: rates[i] ?? misaVatRate(null),
    vatAmount: amounts[i] ?? '0',
    vatAccount: voucher.vatAccount,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Templates: the column mapping

export type MisaValue =
  | { kind: 'blank' }
  | { kind: 'text'; value: string }
  /** An exact decimal string, written as a number when Excel can hold it exactly. */
  | { kind: 'decimal'; value: string }
  /** YYYY-MM-DD, written as an Excel date (dd/mm/yyyy). */
  | { kind: 'date'; value: string };

export interface MisaColumn<Row> {
  /** The header exactly as in MISA's template. */
  header: string;
  /** MISA's length limit from the template's cell note; longer text is cut so the row is not refused. */
  maxLength?: number;
  cell: (row: Row) => MisaValue;
}

export interface MisaTemplate<Row> {
  /** MISA's template file this follows, for the docs and the file name. */
  id: string;
  sheetName: string;
  columns: ReadonlyArray<MisaColumn<Row>>;
}

const blank = (): MisaValue => ({ kind: 'blank' });
const text = (value: string | null | undefined): MisaValue => (value ? { kind: 'text', value } : { kind: 'blank' });
const decimal = (value: string | null | undefined): MisaValue => (value ? { kind: 'decimal', value } : { kind: 'blank' });
const date = (value: string): MisaValue => ({ kind: 'date', value });
const fixed = (value: string): MisaValue => ({ kind: 'decimal', value });

/** "% thuế GTGT": the numeric codes as numbers (as typed into the template), the others as text. */
function vatCode(vat: MisaVatRate): MisaValue {
  if (vat.code === null) return blank();
  return STANDARD_RATES.has(vat.code) ? fixed(vat.code) : text(vat.code);
}

/**
 * MISA SME "Chứng từ mua dịch vụ" (Mua hàng > Chứng từ mua dịch vụ), template
 * Chung_tu_mua_dich_vu_chua_thanh_toan_VND.xls: a purchase not paid yet, in VND. Crove posts purchases as
 * Nợ expense or asset accounts, Nợ 1331/1332, Có 331, which is this voucher. Lines are not received into a
 * warehouse (that is the goods purchase template, not used yet).
 */
export const MISA_SME_PURCHASE_SERVICE: MisaTemplate<PurchaseRow> = {
  id: 'Chung_tu_mua_dich_vu_chua_thanh_toan_VND',
  sheetName: 'Chứng từ mua dịch vụ',
  columns: [
    { header: 'Hiển thị trên sổ', cell: blank }, // blank: both the financial and the management books
    { header: 'Phương thức thanh toán', cell: blank }, // blank: not paid yet
    { header: 'Là CP mua hàng', cell: blank },
    { header: 'Ngày hạch toán (*)', cell: (r) => date(r.voucher.entryDate) },
    { header: 'Ngày chứng từ (*)', cell: (r) => date(r.voucher.entryDate) },
    { header: 'Số chứng từ (*)', maxLength: 20, cell: (r) => text(r.voucherNo) },
    { header: 'Mã nhà cung cấp', cell: blank }, // MISA catalog code
    { header: 'Tên nhà cung cấp', maxLength: 128, cell: (r) => text(r.voucher.vendor.name) },
    { header: 'Địa chỉ', maxLength: 255, cell: (r) => text(r.voucher.vendor.address) },
    { header: 'Diễn giải/Lý do chi/Nội dung thanh toán', maxLength: 255, cell: (r) => text(r.voucher.description) },
    { header: 'NV mua hàng', cell: blank }, // MISA catalog code
    { header: 'Mã dịch vụ (*)', cell: blank }, // MISA catalog code: the accountant fills it before importing
    { header: 'Tên dịch vụ', maxLength: 255, cell: (r) => text(r.line.description) },
    { header: 'TK chi phí/TK kho', cell: (r) => text(r.line.debitAccount) },
    { header: 'TK công nợ/TK tiền', cell: () => text(PAYABLE_ACCOUNT) },
    { header: 'Đối tượng', cell: blank }, // MISA catalog code
    { header: 'ĐVT', cell: blank }, // MISA catalog code (unit)
    { header: 'Số lượng', cell: (r) => decimal(r.line.quantity) },
    { header: 'Đơn giá', cell: (r) => decimal(r.line.unitPrice) },
    { header: 'Thành tiền', cell: (r) => fixed(r.line.amount) },
    { header: '% thuế GTGT', cell: (r) => vatCode(r.vat) },
    { header: 'Tỷ lệ tính thuế (Thuế suất KHAC)', cell: (r) => decimal(r.vat.otherRate) },
    { header: 'Tiền thuế GTGT', cell: (r) => fixed(r.vatAmount) },
    { header: 'TK thuế GTGT', cell: (r) => text(r.vatAccount) },
    { header: 'Mẫu số HĐ', cell: blank }, // not stored by Crove (KHMSHDon)
    { header: 'Ký hiệu HĐ', cell: (r) => text(r.voucher.invoice.series) },
    { header: 'Số hóa đơn', maxLength: 25, cell: (r) => text(r.voucher.invoice.number) },
    { header: 'Ngày hóa đơn', cell: (r) => date(r.voucher.invoice.date) },
    { header: 'Nhóm HHDV mua vào', cell: blank }, // MISA code of the input VAT group
    { header: 'Mã NCC', cell: blank }, // MISA catalog code
    { header: 'Tên NCC', maxLength: 128, cell: (r) => text(r.voucher.vendor.name) },
    { header: 'Mã số thuế NCC', maxLength: 20, cell: (r) => text(r.voucher.vendor.taxCode) },
    { header: 'Địa chỉ NCC', maxLength: 255, cell: (r) => text(r.voucher.vendor.address) },
  ],
};

/**
 * MISA SME "Chứng từ bán hàng" (Bán hàng > Chứng từ bán hàng), template Ban_hang_VND.xls: a domestic sale in VND,
 * not collected yet, with its invoice already issued (the e-invoice comes from Crove's provider, issue #313), no
 * warehouse issue.
 */
export const MISA_SME_SALES: MisaTemplate<SalesRow> = {
  id: 'Ban_hang_VND',
  sheetName: 'Chứng từ bán hàng',
  columns: [
    { header: 'Hiển thị trên sổ', cell: blank }, // blank: both books
    { header: 'Hình thức bán hàng', cell: blank }, // blank: domestic sale
    { header: 'Phương thức thanh toán', cell: blank }, // blank: not collected yet
    { header: 'Kiêm phiếu xuất kho', cell: () => fixed('0') }, // 0: no warehouse issue (blank would mean 1)
    { header: 'XK vào khu phi thuế quan và các TH được coi như XK', cell: blank },
    { header: 'Lập kèm hóa đơn', cell: () => fixed('1') },
    { header: 'Đã lập hóa đơn', cell: () => fixed('1') }, // the e-invoice is already issued
    { header: 'Ngày hạch toán (*)', cell: (r) => date(r.voucher.entryDate) },
    { header: 'Ngày chứng từ (*)', cell: (r) => date(r.voucher.entryDate) },
    { header: 'Số chứng từ (*)', maxLength: 20, cell: (r) => text(r.voucherNo) },
    { header: 'Số phiếu xuất', cell: blank },
    { header: 'Lý do xuất', cell: blank },
    { header: 'Số hóa đơn', maxLength: 25, cell: (r) => text(r.voucher.invoice.number) },
    { header: 'Ngày hóa đơn', cell: (r) => date(r.voucher.invoice.date) },
    { header: 'Mã khách hàng', cell: blank }, // MISA catalog code
    { header: 'Tên khách hàng', maxLength: 128, cell: (r) => text(r.voucher.customer.name) },
    { header: 'Địa chỉ', maxLength: 255, cell: (r) => text(r.voucher.customer.address) },
    { header: 'Mã số thuế', maxLength: 50, cell: (r) => text(r.voucher.customer.taxCode) },
    { header: 'Diễn giải', maxLength: 255, cell: (r) => text(r.voucher.description) },
    { header: 'Nộp vào TK', cell: blank },
    { header: 'NV bán hàng', cell: blank }, // MISA catalog code
    { header: 'Mã hàng (*)', cell: blank }, // MISA catalog code: the accountant fills it before importing
    { header: 'Tên hàng', maxLength: 255, cell: (r) => text(r.line.description) },
    { header: 'Hàng khuyến mại', cell: blank },
    { header: 'TK Tiền/Chi phí/Nợ (*)', maxLength: 20, cell: (r) => text(r.voucher.receivableAccount) },
    { header: 'TK Doanh thu/Có (*)', maxLength: 20, cell: (r) => text(r.line.revenueAccount) },
    { header: 'ĐVT', cell: blank }, // MISA catalog code (unit)
    { header: 'Số lượng', cell: (r) => decimal(r.line.quantity) },
    { header: 'Đơn giá sau thuế', cell: blank },
    { header: 'Đơn giá', cell: (r) => decimal(r.line.unitPrice) },
    { header: 'Thành tiền', cell: (r) => fixed(r.line.amount) },
    { header: 'Tỷ lệ CK (%)', cell: blank },
    { header: 'Tiền chiết khấu', cell: blank },
    { header: 'TK chiết khấu', cell: blank },
    { header: 'Giá tính thuế XK', cell: blank },
    { header: '% thuế XK', cell: blank },
    { header: 'Tiền thuế XK', cell: blank },
    { header: 'TK thuế XK', cell: blank },
    { header: '% thuế GTGT', cell: (r) => vatCode(r.vat) },
    { header: 'Tỷ lệ tính thuế (Thuế suất KHAC)', cell: (r) => decimal(r.vat.otherRate) },
    { header: 'Tiền thuế GTGT', cell: (r) => fixed(r.vatAmount) },
    { header: 'TK thuế GTGT', cell: (r) => text(r.vatAccount) },
    { header: 'HH không TH trên tờ khai thuế GTGT', cell: blank },
    { header: 'Kho', cell: blank },
    { header: 'TK giá vốn', cell: blank },
    { header: 'TK Kho', cell: blank },
    { header: 'Đơn giá vốn', cell: blank },
    { header: 'Tiền vốn', cell: blank },
    { header: 'Hàng hóa giữ hộ/bán hộ', cell: blank },
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// Workbook

const TEXT_FORMAT = '@';
const DATE_FORMAT = 'dd/mm/yyyy';

function clip(value: string, maxLength: number | undefined): string {
  if (maxLength === undefined) return value;
  const chars = Array.from(value);
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') : value;
}

function excelDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`not a date: ${value}`);
  // UTC midnight: ExcelJS turns it into a whole serial day, with no time zone shift.
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** One sheet named as MISA's template, its header row, then one row per voucher line. */
export async function buildMisaWorkbook<Row>(template: MisaTemplate<Row>, rows: readonly Row[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Crove';
  const sheet = workbook.addWorksheet(template.sheetName);
  sheet.addRow(template.columns.map((c) => c.header));
  sheet.getRow(1).font = { bold: true };
  template.columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = Math.min(Math.max(c.header.length + 2, 12), 40);
  });
  for (const row of rows) {
    const excelRow = sheet.addRow([]);
    template.columns.forEach((column, i) => {
      const value = column.cell(row);
      const cell = excelRow.getCell(i + 1);
      if (value.kind === 'text') {
        cell.value = textCell(clip(value.value, column.maxLength));
        cell.numFmt = TEXT_FORMAT;
      } else if (value.kind === 'date') {
        cell.value = excelDate(value.value);
        cell.numFmt = DATE_FORMAT;
      } else if (value.kind === 'decimal') {
        const number = decimalCell(value.value);
        cell.value = number.value;
        if (number.kind === 'number') {
          cell.numFmt = number.numFmt;
        } else {
          cell.numFmt = TEXT_FORMAT;
          cell.alignment = { horizontal: 'right' };
        }
      }
    });
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
