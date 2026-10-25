import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { money, sum } from '@crove/l10n-vn';
import {
  MISA_SME_CASH_PAYMENT,
  MISA_SME_CASH_RECEIPT,
  MISA_SME_PURCHASE_GOODS,
  MISA_SME_PURCHASE_SERVICE,
  MISA_SME_SALES,
  allocateVat,
  buildMisaWorkbook,
  cashRows,
  goodsPurchaseRows,
  misaVatRate,
  misaVoucherNo,
  purchaseRows,
  salesRows,
  servicePurchaseRows,
  type CashVoucher,
  type MisaTemplate,
  type PurchaseVoucher,
  type SalesVoucher,
} from '../src/misa.ts';
import { MISA_GOODS_DEFAULTS, accountParents, isStockAccount, resolveMisaGoodsCodes } from '@crove/kernel-contract';

// An org chart: the TT133 stock accounts and some sub-accounts, as finance.accounts.list gives them. 152.A and 152.AB
// are siblings under 152; 15212 was created under 152 before 1521 existed, so it is not 1521's child either.
const PARENTS = accountParents([
  { code: '152', parentCode: null },
  { code: '153', parentCode: null },
  { code: '156', parentCode: null },
  { code: '1521', parentCode: '152' },
  { code: '15212', parentCode: '152' },
  { code: '15215', parentCode: '1521' },
  { code: '152.A', parentCode: '152' },
  { code: '152.AB', parentCode: '152' },
  { code: '1561', parentCode: '156' },
  { code: '15611', parentCode: '1561' },
  { code: '156.HCM', parentCode: '156' },
]);

// Golden header rows, verbatim from the MISA SME templates (sources in docs/integrations/misa-sme-import.md).
// A change here is a change of the import file: check it against the partner's template first.
const PURCHASE_HEADERS = [
  'Hiển thị trên sổ',
  'Phương thức thanh toán',
  'Là CP mua hàng',
  'Ngày hạch toán (*)',
  'Ngày chứng từ (*)',
  'Số chứng từ (*)',
  'Mã nhà cung cấp',
  'Tên nhà cung cấp',
  'Địa chỉ',
  'Diễn giải/Lý do chi/Nội dung thanh toán',
  'NV mua hàng',
  'Mã dịch vụ (*)',
  'Tên dịch vụ',
  'TK chi phí/TK kho',
  'TK công nợ/TK tiền',
  'Đối tượng',
  'ĐVT',
  'Số lượng',
  'Đơn giá',
  'Thành tiền',
  '% thuế GTGT',
  'Tỷ lệ tính thuế (Thuế suất KHAC)',
  'Tiền thuế GTGT',
  'TK thuế GTGT',
  'Mẫu số HĐ',
  'Ký hiệu HĐ',
  'Số hóa đơn',
  'Ngày hóa đơn',
  'Nhóm HHDV mua vào',
  'Mã NCC',
  'Tên NCC',
  'Mã số thuế NCC',
  'Địa chỉ NCC',
];

// MISA SME 2026 Template/ImportExcel/Mua_hang_qua_kho_VND.xls, sheet "Chứng từ mua hàng nhập kho", row 1 (#1398,
// source S9 in docs/integrations/misa-sme-import.md).
const GOODS_HEADERS = [
  'Hiển thị trên sổ',
  'Hình thức mua hàng',
  'Phương thức thanh toán',
  'Nhận kèm hóa đơn',
  'Ngày hạch toán (*)',
  'Ngày chứng từ (*)',
  'Số phiếu nhập (*)',
  'Số chứng từ thanh toán',
  'Mẫu số HĐ',
  'Ký hiệu HĐ',
  'Số hóa đơn',
  'Ngày hóa đơn',
  'Mã nhà cung cấp',
  'Tên nhà cung cấp',
  'Người giao hàng',
  'Diễn giải',
  'NV mua hàng',
  'Mã hàng (*)',
  'Tên hàng',
  'Kho',
  'Hàng hóa giữ hộ/bán hộ',
  'TK kho (*)',
  'TK công nợ/TK tiền (*)',
  'ĐVT',
  'Số lượng',
  'Đơn giá',
  'Thành tiền',
  'Tỷ lệ CK',
  'Tiền chiết khấu',
  'Phí hàng về kho/Chi phí mua hàng',
  '% thuế GTGT',
  'Tỷ lệ tính thuế (Thuế suất KHAC)',
  'Tiền thuế GTGT',
  'TKĐƯ thuế GTGT',
  'TK thuế GTGT',
  'Nhóm HHDV mua vào',
  'Phí trước hải quan',
  'Giá tính thuế NK',
  '% thuế NK',
  'Tiền thuế NK',
  'TK thuế NK',
  '% thuế TTĐB',
  'Tiền thuế TTĐB',
  'TK thuế TTĐB',
];

const SALES_HEADERS = [
  'Hiển thị trên sổ',
  'Hình thức bán hàng',
  'Phương thức thanh toán',
  'Kiêm phiếu xuất kho',
  'XK vào khu phi thuế quan và các TH được coi như XK',
  'Lập kèm hóa đơn',
  'Đã lập hóa đơn',
  'Ngày hạch toán (*)',
  'Ngày chứng từ (*)',
  'Số chứng từ (*)',
  'Số phiếu xuất',
  'Lý do xuất',
  'Số hóa đơn',
  'Ngày hóa đơn',
  'Mã khách hàng',
  'Tên khách hàng',
  'Địa chỉ',
  'Mã số thuế',
  'Diễn giải',
  'Nộp vào TK',
  'NV bán hàng',
  'Mã hàng (*)',
  'Tên hàng',
  'Hàng khuyến mại',
  'TK Tiền/Chi phí/Nợ (*)',
  'TK Doanh thu/Có (*)',
  'ĐVT',
  'Số lượng',
  'Đơn giá sau thuế',
  'Đơn giá',
  'Thành tiền',
  'Tỷ lệ CK (%)',
  'Tiền chiết khấu',
  'TK chiết khấu',
  'Giá tính thuế XK',
  '% thuế XK',
  'Tiền thuế XK',
  'TK thuế XK',
  '% thuế GTGT',
  'Tỷ lệ tính thuế (Thuế suất KHAC)',
  'Tiền thuế GTGT',
  'TK thuế GTGT',
  'HH không TH trên tờ khai thuế GTGT',
  'Kho',
  'TK giá vốn',
  'TK Kho',
  'Đơn giá vốn',
  'Tiền vốn',
  'Hàng hóa giữ hộ/bán hộ',
];

const ENTRY_ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5c';

function purchase(overrides: Partial<PurchaseVoucher> = {}): PurchaseVoucher {
  return {
    entryId: ENTRY_ID,
    entryDate: '2026-09-30',
    description: 'Mua dịch vụ Công ty TNHH ABC HĐ C26TAA/123',
    invoice: { series: 'C26TAA', number: '123', date: '2026-09-29' },
    vendor: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
    vatAmount: '180000',
    lines: [
      { lineNo: 1, description: 'Phí dịch vụ tháng 9', unit: 'Tháng', quantity: '1', unitPrice: '1000000', amount: '1000000', vatRate: '10%', debitAccount: '6422' },
      { lineNo: 2, description: 'Gói lưu trữ', unit: 'Gói', quantity: '2', unitPrice: '500000', amount: '1000000', vatRate: '10%', debitAccount: '6422' },
      { lineNo: 3, description: 'Chiết khấu thương mại', unit: null, quantity: null, unitPrice: null, amount: '-200000', vatRate: '10%', debitAccount: '6422' },
    ],
    ...overrides,
  };
}

function line(lineNo: number, amount: string, vatRate: string | null, debitAccount = '6422'): PurchaseVoucher['lines'][number] {
  return { lineNo, description: `Dòng ${lineNo}`, unit: null, quantity: null, unitPrice: null, amount, vatRate, debitAccount };
}

function sale(overrides: Partial<SalesVoucher> = {}): SalesVoucher {
  return {
    entryId: ENTRY_ID,
    entryDate: '2026-10-05',
    description: 'Bán hàng Công ty CP XYZ HĐ C26TBB/45',
    invoice: { series: 'C26TBB', number: '45', date: '2026-10-05' },
    customer: { name: 'Công ty CP XYZ', taxCode: '0312345678', address: '2 Lê Lợi, TP.HCM' },
    receivableAccount: '131',
    vatAccount: '3331',
    vatAmount: '130000',
    lines: [
      { lineNo: 1, description: 'Tư vấn kế toán', unit: 'Tháng', quantity: '1', unitPrice: '1000000', amount: '1000000', vatRate: '8%', revenueAccount: '511' },
      { lineNo: 2, description: 'Phần mềm', unit: 'Bộ', quantity: '1', unitPrice: '500000', amount: '500000', vatRate: '10%', revenueAccount: '511' },
    ],
    ...overrides,
  };
}

async function readBack<Row>(template: MisaTemplate<Row>, rows: Row[]): Promise<ExcelJS.Worksheet> {
  const bytes = await buildMisaWorkbook(template, rows);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheet = workbook.getWorksheet(template.sheetName);
  if (!sheet) throw new Error('sheet missing');
  return sheet;
}

function rowValues(sheet: ExcelJS.Worksheet, rowNo: number, headers: string[]): Record<string, unknown> {
  const row = sheet.getRow(rowNo);
  return Object.fromEntries(headers.map((h, i) => [h, row.getCell(i + 1).value]));
}

describe('MISA SME templates: header rows (golden)', () => {
  it('purchase vouchers use the 33 columns of Chung_tu_mua_dich_vu_chua_thanh_toan_VND, in order', async () => {
    expect(MISA_SME_PURCHASE_SERVICE.columns.map((c) => c.header)).toEqual(PURCHASE_HEADERS);
    const sheet = await readBack(MISA_SME_PURCHASE_SERVICE, []);
    expect(sheet.name).toBe('Chứng từ mua dịch vụ');
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(PURCHASE_HEADERS);
    expect(sheet.rowCount).toBe(1);
  });

  it('sales vouchers use the 49 columns of Ban_hang_VND, in order', async () => {
    expect(MISA_SME_SALES.columns.map((c) => c.header)).toEqual(SALES_HEADERS);
    const sheet = await readBack(MISA_SME_SALES, []);
    expect(sheet.name).toBe('Chứng từ bán hàng');
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(SALES_HEADERS);
  });

  it('goods purchases use the 44 columns of Mua_hang_qua_kho_VND, in order (#1398)', async () => {
    expect(MISA_SME_PURCHASE_GOODS.columns.map((c) => c.header)).toEqual(GOODS_HEADERS);
    const sheet = await readBack(MISA_SME_PURCHASE_GOODS, []);
    expect(sheet.name).toBe('Chứng từ mua hàng nhập kho');
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(GOODS_HEADERS);
    expect(sheet.rowCount).toBe(1);
  });

  it('has no duplicate header in any purchase or sales template', () => {
    for (const template of [MISA_SME_PURCHASE_SERVICE.columns, MISA_SME_PURCHASE_GOODS.columns, MISA_SME_SALES.columns]) {
      expect(new Set(template.map((c) => c.header)).size).toBe(template.length);
    }
  });
});

describe('misaVatRate', () => {
  it('maps the standard rates to MISA numeric codes', () => {
    expect(misaVatRate('10%')).toMatchObject({ code: '10', otherRate: null });
    expect(misaVatRate('8%')).toMatchObject({ code: '8', otherRate: null });
    expect(misaVatRate('5%')).toMatchObject({ code: '5', otherRate: null });
    expect(misaVatRate('0%')).toMatchObject({ code: '0', otherRate: null });
    expect(misaVatRate(' 10 % ')).toMatchObject({ code: '10' });
    expect(misaVatRate('10')).toMatchObject({ code: '10' });
    expect(misaVatRate('10.00%')).toMatchObject({ code: '10' });
    expect(misaVatRate('10%').percent?.toFixed()).toBe('10');
  });

  it('maps exempt and untaxed lines to KCT and KKKNT, with no VAT', () => {
    expect(misaVatRate('KCT')).toMatchObject({ code: 'KCT', otherRate: null });
    expect(misaVatRate('kkknt')).toMatchObject({ code: 'KKKNT', otherRate: null });
    expect(misaVatRate('KCT').percent?.toFixed()).toBe('0');
  });

  it('maps other rates to KHAC with the ratio', () => {
    expect(misaVatRate('KHAC:5.26%')).toMatchObject({ code: 'KHAC', otherRate: '5.26' });
    expect(misaVatRate('KHAC:3%')).toMatchObject({ code: 'KHAC', otherRate: '3' });
    expect(misaVatRate('3.5%')).toMatchObject({ code: 'KHAC', otherRate: '3.5' });
    expect(misaVatRate('KHAC')).toEqual({ code: 'KHAC', otherRate: null, percent: null });
  });

  it('leaves an unknown rate blank rather than guessing (MISA reads a blank rate as 10%)', () => {
    for (const unknown of [null, '', 'x', '150%', '-5%', 'KHAC:0%']) {
      expect(misaVatRate(unknown), String(unknown)).toMatchObject({ percent: null });
    }
    expect(misaVatRate(null).code).toBeNull();
    expect(misaVatRate('150%').code).toBeNull();
  });
});

describe('allocateVat', () => {
  const pct = (rate: string | null) => misaVatRate(rate).percent;

  it('gives each line its amount times its rate when the invoice agrees', () => {
    expect(allocateVat([{ amount: '1000000', percent: pct('10%') }, { amount: '500000', percent: pct('8%') }], '140000')).toEqual(['100000', '40000']);
  });

  it('puts the rounding difference on the largest taxed line, so the lines add up to the invoice VAT', () => {
    // 3 x 33,333 at 10% = 3 x 3,333.3 -> 3,333 each, 9,999; the invoice rounds the total to 10,000.
    const lines = [33333, 33333, 33334].map((a) => ({ amount: String(a), percent: pct('10%') }));
    const vat = allocateVat(lines, '10000');
    expect(vat).toEqual(['3333', '3333', '3334']);
    expect(sum(vat).toFixed()).toBe('10000');
  });

  it('keeps exempt lines at zero and handles discounts (negative lines)', () => {
    const vat = allocateVat(
      [
        { amount: '1000000', percent: pct('10%') },
        { amount: '300000', percent: pct('KCT') },
        { amount: '-200000', percent: pct('10%') },
      ],
      '80000',
    );
    expect(vat).toEqual(['100000', '0', '-20000']);
  });

  it('puts VAT on a line with an unknown rate when no line has a known positive rate', () => {
    expect(allocateVat([{ amount: '100', percent: pct('KCT') }, { amount: '1000', percent: null }], '100')).toEqual(['0', '100']);
    expect(allocateVat([{ amount: '100', percent: pct('0%') }, { amount: '1000', percent: pct('0%') }], '0')).toEqual(['0', '0']);
  });

  it('gives no line VAT when the invoice has none, whatever rate the lines show', () => {
    expect(allocateVat([{ amount: '100', percent: pct('10%') }, { amount: '1000', percent: pct('10%') }], '0')).toEqual(['0', '0']);
  });

  it('refuses VAT with no line to carry it', () => {
    expect(allocateVat([], '0')).toEqual([]);
    expect(() => allocateVat([], '10')).toThrow(/no line/);
  });
});

describe('purchaseRows', () => {
  it('turns a multi-line invoice into one row per line under one voucher number', () => {
    const rows = purchaseRows(purchase());
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.voucherNo))).toEqual(new Set(['CRMDV6172839A4B5C']));
    expect(rows.map((r) => r.vatAmount)).toEqual(['100000', '100000', '-20000']);
    expect(rows.map((r) => r.vatAccount)).toEqual(['1331', '1331', '1331']);
    expect(sum(rows.map((r) => r.vatAmount)).eq(money('180000'))).toBe(true);
  });

  it('splits VAT between 1331 and 1332 (fixed assets) as the journal does', () => {
    // A 40,000,000 asset at 10% and 1,000,000 of services at 8%: 4,000,000 on 1332, 80,000 on 1331.
    const rows = purchaseRows(purchase({ vatAmount: '4080000', lines: [line(1, '40000000', '10%', '211'), line(2, '1000000', '8%', '6422')] }));
    expect(rows.map((r) => [r.vatAccount, r.vatAmount, r.vat.code])).toEqual([
      ['1332', '4000000', '10'],
      ['1331', '80000', '8'],
    ]);
  });

  it('carries mixed rates, exempt lines and KHAC through', () => {
    const rows = purchaseRows(
      purchase({
        vatAmount: '127600',
        lines: [line(1, '1000000', '10%'), line(2, '500000', '5%'), line(3, '200000', 'KCT'), line(4, '100000', 'KKKNT'), line(5, '50000', 'KHAC:5.2%')],
      }),
    );
    expect(rows.map((r) => [r.vat.code, r.vat.otherRate, r.vatAmount])).toEqual([
      ['10', null, '100000'],
      ['5', null, '25000'],
      ['KCT', null, '0'],
      ['KKKNT', null, '0'],
      ['KHAC', '5.2', '2600'],
    ]);
    expect(sum(rows.map((r) => r.vatAmount)).toFixed()).toBe('127600');
  });

  it('makes voucher numbers that fit MISA (20 characters) and stay the same for the same entry', () => {
    expect(misaVoucherNo('CRMDV', ENTRY_ID)).toBe('CRMDV6172839A4B5C');
    expect(misaVoucherNo('CRMDV', ENTRY_ID).length).toBeLessThanOrEqual(20);
    expect(misaVoucherNo('CRBH', ENTRY_ID).length).toBeLessThanOrEqual(20);
  });
});

describe('buildMisaWorkbook: purchase vouchers', () => {
  it('writes the voucher columns on every line, and the line columns per line', async () => {
    const sheet = await readBack(MISA_SME_PURCHASE_SERVICE, purchaseRows(purchase()));
    expect(sheet.rowCount).toBe(4);
    const first = rowValues(sheet, 2, PURCHASE_HEADERS);
    expect(first).toMatchObject({
      'Hiển thị trên sổ': null,
      'Phương thức thanh toán': null,
      'Số chứng từ (*)': 'CRMDV6172839A4B5C',
      'Mã nhà cung cấp': null,
      'Tên nhà cung cấp': 'Công ty TNHH ABC',
      'Địa chỉ': '1 Láng Hạ, Hà Nội',
      'Diễn giải/Lý do chi/Nội dung thanh toán': 'Mua dịch vụ Công ty TNHH ABC HĐ C26TAA/123',
      'Mã dịch vụ (*)': null,
      'Tên dịch vụ': 'Phí dịch vụ tháng 9',
      'TK chi phí/TK kho': '6422',
      'TK công nợ/TK tiền': '331',
      'ĐVT': null,
      'Số lượng': 1,
      'Đơn giá': 1000000,
      'Thành tiền': 1000000,
      '% thuế GTGT': 10,
      'Tỷ lệ tính thuế (Thuế suất KHAC)': null,
      'Tiền thuế GTGT': 100000,
      'TK thuế GTGT': '1331',
      'Mẫu số HĐ': null,
      'Ký hiệu HĐ': 'C26TAA',
      'Số hóa đơn': '123',
      'Nhóm HHDV mua vào': null,
      'Tên NCC': 'Công ty TNHH ABC',
      'Mã số thuế NCC': '0101234564',
      'Địa chỉ NCC': '1 Láng Hạ, Hà Nội',
    });
    // Dates are real Excel dates (dd/mm/yyyy), not text a locale could misread.
    const posting = sheet.getRow(2).getCell(PURCHASE_HEADERS.indexOf('Ngày hạch toán (*)') + 1);
    expect(posting.value).toEqual(new Date(Date.UTC(2026, 8, 30)));
    expect(posting.numFmt).toBe('dd/mm/yyyy');
    expect(first['Ngày chứng từ (*)']).toEqual(new Date(Date.UTC(2026, 8, 30)));
    expect(first['Ngày hóa đơn']).toEqual(new Date(Date.UTC(2026, 8, 29)));

    // The discount line: negative amount and VAT, the voucher columns repeated.
    const third = rowValues(sheet, 4, PURCHASE_HEADERS);
    expect(third).toMatchObject({ 'Số chứng từ (*)': 'CRMDV6172839A4B5C', 'Tên nhà cung cấp': 'Công ty TNHH ABC', 'Số lượng': null, 'Đơn giá': null, 'Thành tiền': -200000, 'Tiền thuế GTGT': -20000 });
  });

  it('keeps amounts exact: large and fractional amounts, unit prices with 8 decimals', async () => {
    const rows = purchaseRows(
      purchase({
        vatAmount: '0',
        lines: [
          { ...line(1, '1234567890123456.7891', '0%'), quantity: '3', unitPrice: '411522630041152.26303333' },
          { ...line(2, '1500000.5', '0%'), quantity: '1.5', unitPrice: '1000000.33333333' },
        ],
      }),
    );
    const sheet = await readBack(MISA_SME_PURCHASE_SERVICE, rows);
    const amount = PURCHASE_HEADERS.indexOf('Thành tiền') + 1;
    const price = PURCHASE_HEADERS.indexOf('Đơn giá') + 1;
    // Beyond Excel's 15 digits: exact text. Within: exact numbers.
    expect(sheet.getRow(2).getCell(amount).value).toBe('1234567890123456.7891');
    expect(sheet.getRow(2).getCell(price).value).toBe('411522630041152.26303333');
    expect(sheet.getRow(3).getCell(amount).value).toBe(1500000.5);
    expect(sheet.getRow(3).getCell(price).value).toBe(1000000.33333333);
    expect(sheet.getRow(3).getCell(PURCHASE_HEADERS.indexOf('Số lượng') + 1).value).toBe(1.5);
    expect(sheet.getRow(3).getCell(PURCHASE_HEADERS.indexOf('% thuế GTGT') + 1).value).toBe(0);
  });

  it('writes KCT, KKKNT and KHAC as text, with the KHAC ratio', async () => {
    const rows = purchaseRows(purchase({ vatAmount: '2600', lines: [line(1, '200000', 'KCT'), line(2, '100000', 'KKKNT'), line(3, '50000', 'KHAC:5.2%'), line(4, '10', null)] }));
    const sheet = await readBack(MISA_SME_PURCHASE_SERVICE, rows);
    const rate = PURCHASE_HEADERS.indexOf('% thuế GTGT') + 1;
    const ratio = PURCHASE_HEADERS.indexOf('Tỷ lệ tính thuế (Thuế suất KHAC)') + 1;
    expect([2, 3, 4, 5].map((r) => sheet.getRow(r).getCell(rate).value)).toEqual(['KCT', 'KKKNT', 'KHAC', null]);
    expect(sheet.getRow(4).getCell(ratio).value).toBe(5.2);
  });

  it('cuts text to MISA length limits and keeps formula-like text inert', async () => {
    const long = 'Dịch vụ '.repeat(60);
    const rows = purchaseRows(
      purchase({
        description: '=HYPERLINK("http://evil.example","x")',
        vendor: { name: '-2+3+cmd|"/C calc"!A0', taxCode: '0101234564-001', address: null },
        lines: [{ ...line(1, '1000', '10%'), description: long }],
        vatAmount: '100',
      }),
    );
    const sheet = await readBack(MISA_SME_PURCHASE_SERVICE, rows);
    const row = sheet.getRow(2);
    const at = (h: string) => row.getCell(PURCHASE_HEADERS.indexOf(h) + 1);
    expect(Array.from(String(at('Tên dịch vụ').value))).toHaveLength(255);
    expect(at('Diễn giải/Lý do chi/Nội dung thanh toán').value).toBe('=HYPERLINK("http://evil.example","x")');
    expect(at('Diễn giải/Lý do chi/Nội dung thanh toán').formula).toBeUndefined();
    expect(at('Tên nhà cung cấp').type).toBe(ExcelJS.ValueType.String);
    expect(at('Tên nhà cung cấp').numFmt).toBe('@');
    expect(at('Địa chỉ').value).toBeNull();
  });
});

describe('MISA item and warehouse codes for stock accounts (#1398)', () => {
  it('knows the stock accounts by their TT133 root: 152, 153, 156 and their sub-accounts', () => {
    expect(['152', '1521', '153', '156', '1561.HN', '15610'].every(isStockAccount)).toBe(true);
    expect(['151', '154', '155', '157', '211', '6422', '1331', '15'].some(isStockAccount)).toBe(false);
  });

  it('takes the account own codes, else its nearest parent with codes, else the default of its root', () => {
    const saved = [
      { accountCode: '156', itemCode: 'HANGHOA', warehouseCode: 'KHO01' },
      { accountCode: '1561', itemCode: 'HH-HN', warehouseCode: null },
    ];
    expect(resolveMisaGoodsCodes('1561', saved, PARENTS)).toEqual({ itemCode: 'HH-HN', warehouseCode: null, from: '1561' });
    expect(resolveMisaGoodsCodes('15611', saved, PARENTS)).toEqual({ itemCode: 'HH-HN', warehouseCode: null, from: '1561' });
    expect(resolveMisaGoodsCodes('156.HCM', saved, PARENTS)).toEqual({ itemCode: 'HANGHOA', warehouseCode: 'KHO01', from: '156' });
    expect(resolveMisaGoodsCodes('1521', saved, PARENTS)).toEqual({ ...MISA_GOODS_DEFAULTS['152'], from: null });
    expect(resolveMisaGoodsCodes('153', [], PARENTS)).toEqual({ itemCode: 'CCDC', warehouseCode: 'KCCDC', from: null });
    expect(resolveMisaGoodsCodes('6422', saved, PARENTS)).toBeNull();
  });

  it('follows the chart parent chain, not the code text: a code that merely starts with another is not its child', () => {
    const saved = [
      { accountCode: '152', itemCode: 'NVL-CHUNG', warehouseCode: 'KNVL' },
      { accountCode: '152.A', itemCode: 'NVL-A', warehouseCode: 'KHO-A' },
      { accountCode: '1521', itemCode: 'NVL-1521', warehouseCode: null },
    ];
    // 152.AB is a sibling of 152.A under 152: it takes 152's codes.
    expect(resolveMisaGoodsCodes('152.AB', saved, PARENTS)).toEqual({ itemCode: 'NVL-CHUNG', warehouseCode: 'KNVL', from: '152' });
    expect(resolveMisaGoodsCodes('152.A', saved, PARENTS)).toEqual({ itemCode: 'NVL-A', warehouseCode: 'KHO-A', from: '152.A' });
    // 15212 sits under 152, not under 1521; 15215 does sit under 1521.
    expect(resolveMisaGoodsCodes('15212', saved, PARENTS)).toEqual({ itemCode: 'NVL-CHUNG', warehouseCode: 'KNVL', from: '152' });
    expect(resolveMisaGoodsCodes('15215', saved, PARENTS)).toEqual({ itemCode: 'NVL-1521', warehouseCode: null, from: '1521' });
    // Without 152's codes, 152.AB and 15212 fall back to the defaults.
    const noRoot = saved.filter((s) => s.accountCode !== '152');
    expect(resolveMisaGoodsCodes('152.AB', noRoot, PARENTS)).toEqual({ ...MISA_GOODS_DEFAULTS['152'], from: null });
    expect(resolveMisaGoodsCodes('15212', noRoot, PARENTS)).toEqual({ ...MISA_GOODS_DEFAULTS['152'], from: null });
    // An account the chart does not know inherits from nobody, and a parent loop ends.
    expect(resolveMisaGoodsCodes('152.ZZ', saved, PARENTS)).toEqual({ ...MISA_GOODS_DEFAULTS['152'], from: null });
    const loop = accountParents([
      { code: '1529', parentCode: '1528' },
      { code: '1528', parentCode: '1529' },
    ]);
    expect(resolveMisaGoodsCodes('1529', [], loop)).toEqual({ ...MISA_GOODS_DEFAULTS['152'], from: null });
  });
});

describe('goods purchases: one invoice split between the goods and the services template (#1398)', () => {
  // Goods for 10,000,000 at 8% on 156, tools for 1,000,000 at 10% on 153, and a delivery fee of 300,000 at 10%.
  const mixed = () =>
    purchase({
      vatAmount: '930000',
      lines: [
        { ...line(1, '10000000', '8%', '156'), description: 'Thép cuộn', unit: 'Tấn', quantity: '2.5', unitPrice: '4000000' },
        { ...line(2, '1000000', '10%', '153'), description: 'Máy khoan' },
        { ...line(3, '300000', '10%', '6422'), description: 'Phí vận chuyển' },
      ],
    });

  it('puts the stock lines in the goods voucher and the rest in the services voucher, VAT adding up to the invoice', () => {
    const goods = goodsPurchaseRows(mixed(), [], PARENTS);
    const services = servicePurchaseRows(mixed());
    expect(goods.map((r) => [r.line.lineNo, r.voucherNo, r.goods.itemCode, r.goods.warehouseCode, r.vatAmount, r.vatAccount])).toEqual([
      [1, 'CRMH6172839A4B5C', 'HH', 'KHH', '800000', '1331'],
      [2, 'CRMH6172839A4B5C', 'CCDC', 'KCCDC', '100000', '1331'],
    ]);
    expect(services.map((r) => [r.line.lineNo, r.voucherNo, r.vatAmount])).toEqual([[3, 'CRMDV6172839A4B5C', '30000']]);
    expect(sum([...goods, ...services].map((r) => r.vatAmount)).toFixed()).toBe('930000');
  });

  it('gives a goods-only invoice no services rows and a services-only invoice no goods rows', () => {
    expect(servicePurchaseRows(purchase({ vatAmount: '80000', lines: [line(1, '1000000', '8%', '1521')] }))).toEqual([]);
    expect(goodsPurchaseRows(purchase(), [], PARENTS)).toEqual([]);
  });

  it('writes the goods voucher with the org codes, warehouse and stock account, exact amounts and inert text', async () => {
    const saved = [{ accountCode: '156', itemCode: 'THEP01', warehouseCode: 'KHO.HN' }];
    const voucher = mixed();
    voucher.vendor = { name: '=HYPERLINK("http://evil.example","x")', taxCode: '0101234564', address: '1 Láng Hạ' };
    const sheet = await readBack(MISA_SME_PURCHASE_GOODS, goodsPurchaseRows(voucher, saved, PARENTS));
    expect(sheet.rowCount).toBe(3);
    const first = rowValues(sheet, 2, GOODS_HEADERS);
    expect(first).toMatchObject({
      'Hiển thị trên sổ': null,
      'Hình thức mua hàng': null,
      'Phương thức thanh toán': null,
      'Nhận kèm hóa đơn': 1,
      'Số phiếu nhập (*)': 'CRMH6172839A4B5C',
      'Số chứng từ thanh toán': null,
      'Mẫu số HĐ': null,
      'Ký hiệu HĐ': 'C26TAA',
      'Số hóa đơn': '123',
      'Mã nhà cung cấp': null,
      'Tên nhà cung cấp': '=HYPERLINK("http://evil.example","x")',
      'Diễn giải': 'Mua dịch vụ Công ty TNHH ABC HĐ C26TAA/123',
      'Mã hàng (*)': 'THEP01',
      'Tên hàng': 'Thép cuộn',
      'Kho': 'KHO.HN',
      'TK kho (*)': '156',
      'TK công nợ/TK tiền (*)': '331',
      'ĐVT': null,
      'Số lượng': 2.5,
      'Đơn giá': 4000000,
      'Thành tiền': 10000000,
      '% thuế GTGT': 8,
      'Tiền thuế GTGT': 800000,
      'TKĐƯ thuế GTGT': null,
      'TK thuế GTGT': '1331',
      'Phí trước hải quan': null,
      'TK thuế TTĐB': null,
    });
    expect(first['Ngày hạch toán (*)']).toEqual(new Date(Date.UTC(2026, 8, 30)));
    expect(first['Ngày hóa đơn']).toEqual(new Date(Date.UTC(2026, 8, 29)));
    const vendor = sheet.getRow(2).getCell(GOODS_HEADERS.indexOf('Tên nhà cung cấp') + 1);
    expect(vendor.formula).toBeUndefined();
    expect(vendor.numFmt).toBe('@');
    // The tools line takes the default codes of 153: the org set codes for 156 only.
    expect(rowValues(sheet, 3, GOODS_HEADERS)).toMatchObject({ 'Mã hàng (*)': 'CCDC', 'Kho': 'KCCDC', 'TK kho (*)': '153', '% thuế GTGT': 10, 'Tiền thuế GTGT': 100000 });
  });

  it('leaves Kho blank for an account whose codes have no warehouse, and keeps large amounts exact', async () => {
    const voucher = purchase({ vatAmount: '0', lines: [{ ...line(1, '1234567890123456.7891', '0%', '1521'), quantity: '3', unitPrice: '411522630041152.26303333' }] });
    const sheet = await readBack(MISA_SME_PURCHASE_GOODS, goodsPurchaseRows(voucher, [{ accountCode: '152', itemCode: 'NVL01', warehouseCode: null }], PARENTS));
    const at = (h: string) => sheet.getRow(2).getCell(GOODS_HEADERS.indexOf(h) + 1).value;
    expect(at('Mã hàng (*)')).toBe('NVL01');
    expect(at('Kho')).toBeNull();
    expect(at('Thành tiền')).toBe('1234567890123456.7891');
    expect(at('Đơn giá')).toBe('411522630041152.26303333');
  });
});

describe('sales vouchers (same mapper, template Ban_hang_VND)', () => {
  it('writes one row per line with MISA flags, accounts and VAT', async () => {
    const rows = salesRows(sale());
    expect(rows.map((r) => [r.vat.code, r.vatAmount, r.vatAccount])).toEqual([
      ['8', '80000', '3331'],
      ['10', '50000', '3331'],
    ]);
    const sheet = await readBack(MISA_SME_SALES, rows);
    expect(sheet.rowCount).toBe(3);
    expect(rowValues(sheet, 2, SALES_HEADERS)).toMatchObject({
      'Kiêm phiếu xuất kho': 0,
      'Lập kèm hóa đơn': 1,
      'Đã lập hóa đơn': 1,
      'Ngày hạch toán (*)': new Date(Date.UTC(2026, 9, 5)),
      'Số chứng từ (*)': 'CRBH6172839A4B5C',
      'Số hóa đơn': '45',
      'Tên khách hàng': 'Công ty CP XYZ',
      'Mã số thuế': '0312345678',
      'Mã hàng (*)': null,
      'Tên hàng': 'Tư vấn kế toán',
      'TK Tiền/Chi phí/Nợ (*)': '131',
      'TK Doanh thu/Có (*)': '511',
      'Thành tiền': 1000000,
      '% thuế GTGT': 8,
      'Tiền thuế GTGT': 80000,
      'TK thuế GTGT': '3331',
      Kho: null,
    });
    expect(rowValues(sheet, 3, SALES_HEADERS)).toMatchObject({ 'Số chứng từ (*)': 'CRBH6172839A4B5C', 'Tên hàng': 'Phần mềm', '% thuế GTGT': 10, 'Tiền thuế GTGT': 50000 });
  });
});

// The cash templates (#657), verbatim from the MISA SME.NET "Phiếu thu" and "Phiếu chi" templates (source S6 in
// docs/integrations/misa-sme-import.md).
const RECEIPT_HEADERS = [
  'Hiển thị trên sổ',
  'Ngày hạch toán (*)',
  'Ngày chứng từ (*)',
  'Số chứng từ (*)',
  'Mã đối tượng',
  'Tên đối tượng',
  'Địa chỉ',
  'Lý do nộp',
  'Diễn giải lý do nộp',
  'Người nộp',
  'Nhân viên thu',
  'Kèm theo',
  'Diễn giải',
  'TK Nợ (*)',
  'TK Có (*)',
  'Số tiền',
  'Đối tượng',
  'TK ngân hàng',
];
const PAYMENT_HEADERS = [
  'Hiển thị trên sổ',
  'Ngày hạch toán (*)',
  'Ngày chứng từ (*)',
  'Số chứng từ (*)',
  'Mã đối tượng',
  'Tên đối tượng',
  'Địa chỉ',
  'Nhân viên',
  'Kèm theo',
  'Lý do chi',
  'Diễn giải lý do chi',
  'Người nhận',
  'Diễn giải',
  'TK Nợ (*)',
  'TK Có (*)',
  'Số tiền',
  'Đối tượng',
  'TK ngân hàng',
  'Diễn giải (Thuế)',
  'TK thuế GTGT',
  'Tiền thuế GTGT',
  '% thuế GTGT',
  'Tỷ lệ tính thuế (Thuế suất KHAC)',
  'Giá trị HHDV chưa thuế',
  'Ngày hóa đơn',
  'Số hóa đơn',
  'Mẫu số hóa đơn',
  'Ký hiệu hóa đơn',
  'Nhóm HHDV mua vào',
  'Mã nhà cung cấp',
  'Tên nhà cung cấp',
  'Mã số thuế nhà cung cấp',
];

function cashVoucher(overrides: Partial<CashVoucher> = {}): CashVoucher {
  return {
    type: 'cash_payment',
    code: 'PC00012',
    date: '2026-10-07',
    cashAccount: '1111',
    party: { name: 'Công ty TNHH ABC', taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
    personName: 'Nguyễn Văn An',
    description: 'Trả tiền hóa đơn tháng 9',
    lines: [
      { lineNo: 1, account: '331', amount: '1650000', memo: 'HĐ C26TAA/123' },
      { lineNo: 2, account: '6422', amount: '35000.5', memo: null },
    ],
    ...overrides,
  };
}

describe('MISA SME cash vouchers (#657)', () => {
  it('uses the 18 columns of Phiếu thu and the 32 of Phiếu chi, in order, without duplicates', async () => {
    expect(MISA_SME_CASH_RECEIPT.columns.map((c) => c.header)).toEqual(RECEIPT_HEADERS);
    expect(MISA_SME_CASH_PAYMENT.columns.map((c) => c.header)).toEqual(PAYMENT_HEADERS);
    for (const template of [MISA_SME_CASH_RECEIPT, MISA_SME_CASH_PAYMENT]) {
      expect(new Set(template.columns.map((c) => c.header)).size).toBe(template.columns.length);
      const sheet = await readBack(template, []);
      expect(sheet.name).toBe(template === MISA_SME_CASH_RECEIPT ? 'Phiếu thu' : 'Phiếu chi');
      expect(sheet.rowCount).toBe(1);
    }
  });

  it('writes a phiếu chi as one row per line: Dr the line, Cr the cash account, under one voucher number', async () => {
    const rows = cashRows(cashVoucher());
    expect(rows.map((r) => r.voucherNo)).toEqual(['CRPC00012', 'CRPC00012']);
    const sheet = await readBack(MISA_SME_CASH_PAYMENT, rows);
    expect(sheet.rowCount).toBe(3);
    expect(rowValues(sheet, 2, PAYMENT_HEADERS)).toMatchObject({
      'Hiển thị trên sổ': null,
      'Ngày hạch toán (*)': new Date(Date.UTC(2026, 9, 7)),
      'Ngày chứng từ (*)': new Date(Date.UTC(2026, 9, 7)),
      'Số chứng từ (*)': 'CRPC00012',
      'Mã đối tượng': null,
      'Tên đối tượng': 'Công ty TNHH ABC',
      'Địa chỉ': '1 Láng Hạ, Hà Nội',
      'Lý do chi': null,
      'Diễn giải lý do chi': 'Trả tiền hóa đơn tháng 9',
      'Người nhận': 'Nguyễn Văn An',
      'Diễn giải': 'HĐ C26TAA/123',
      'TK Nợ (*)': '331',
      'TK Có (*)': '1111',
      'Số tiền': 1650000,
      'Đối tượng': null,
      'TK thuế GTGT': null,
      'Tiền thuế GTGT': null,
      'Mã số thuế nhà cung cấp': null,
    });
    // A line without its own memo takes the voucher's reason; fractional amounts stay exact.
    expect(rowValues(sheet, 3, PAYMENT_HEADERS)).toMatchObject({ 'Số chứng từ (*)': 'CRPC00012', 'Diễn giải': 'Trả tiền hóa đơn tháng 9', 'TK Nợ (*)': '6422', 'TK Có (*)': '1111', 'Số tiền': 35000.5 });
  });

  it('writes a phiếu thu with the cash account debited, and a voucher with no party or person', async () => {
    const receipt = cashVoucher({ type: 'cash_receipt', code: 'PT00003', party: null, personName: null, description: 'Thu hoàn ứng', lines: [{ lineNo: 1, account: '141', amount: '2000000', memo: null }] });
    const sheet = await readBack(MISA_SME_CASH_RECEIPT, cashRows(receipt));
    expect(sheet.rowCount).toBe(2);
    expect(rowValues(sheet, 2, RECEIPT_HEADERS)).toMatchObject({
      'Số chứng từ (*)': 'CRPT00003',
      'Tên đối tượng': null,
      'Địa chỉ': null,
      'Lý do nộp': null,
      'Diễn giải lý do nộp': 'Thu hoàn ứng',
      'Người nộp': null,
      'Diễn giải': 'Thu hoàn ứng',
      'TK Nợ (*)': '1111',
      'TK Có (*)': '141',
      'Số tiền': 2000000,
    });
  });

  it('keeps voucher numbers within 20 characters and formula-like text inert', async () => {
    const rows = cashRows(cashVoucher({ code: 'PC1234567890123', description: '=HYPERLINK("http://x")', personName: 'x'.repeat(300) }));
    expect(rows[0]?.voucherNo.length).toBeLessThanOrEqual(20);
    const sheet = await readBack(MISA_SME_CASH_PAYMENT, rows);
    const values = rowValues(sheet, 2, PAYMENT_HEADERS);
    expect(values['Diễn giải lý do chi']).toBe('=HYPERLINK("http://x")');
    expect(String(values['Người nhận']).length).toBe(255);
  });
});
