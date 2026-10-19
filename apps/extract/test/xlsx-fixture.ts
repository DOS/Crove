// Test helper: writes small .xlsx workbooks part by part (shared or inline strings, number and date cells, a custom
// date format), the way Excel and the libraries behind web exports do. Node built-ins only (through zip-fixture), so
// the kernel tests and the e2e spec import it too.
import { buildZip, type ZipEntrySpec } from './zip-fixture.ts';

// A cell: text, a number (its exact digits), an Excel date serial shown with a date format, or empty.
export type XlsxCell = string | number | { date: number } | { formula: string; cached: string } | null;

export interface XlsxOptions {
  sheetName?: string;
  // Text cells as shared strings (Excel's default) or inline strings (what many web exporters write).
  strings?: 'shared' | 'inline';
  // The date style: a built-in format (14, d/m/yyyy) or a custom one like the portal's dd/MM/yyyy.
  dateFormat?: 'builtin' | 'custom';
  date1904?: boolean;
  // Extra parts (for hostile workbooks).
  extra?: ZipEntrySpec[];
  // Replace a generated part's content.
  override?: Partial<Record<string, string>>;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function buildXlsx(rows: XlsxCell[][], options: XlsxOptions = {}): Uint8Array<ArrayBuffer> {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const inline = options.strings === 'inline';
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          if (cell === null || cell === '') return '';
          const ref = `${columnName(c)}${r + 1}`;
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
          if (typeof cell === 'object' && 'date' in cell) return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
          if (typeof cell === 'object') return `<c r="${ref}" t="str"><f>${escape(cell.formula)}</f><v>${escape(cell.cached)}</v></c>`;
          if (inline) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(cell)}</t></is></c>`;
          let index = sharedIndex.get(cell);
          if (index === undefined) {
            index = shared.length;
            shared.push(cell);
            sharedIndex.set(cell, index);
          }
          return `<c r="${ref}" t="s"><v>${index}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const dateFmt = options.dateFormat === 'custom' ? 164 : 14;
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${options.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets><sheet name="${escape(options.sheetName ?? 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${options.dateFormat === 'custom' ? '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/MM/yyyy"/></numFmts>' : ''}<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="${dateFmt}" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  if (!inline) {
    parts['xl/sharedStrings.xml'] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${escape(s)}</t></si>`).join('')}</sst>`;
  }
  for (const [name, content] of Object.entries(options.override ?? {})) if (content !== undefined) parts[name] = content;
  return buildZip([...Object.entries(parts).map(([name, data]) => ({ name, data })), ...(options.extra ?? [])]);
}

// The purchase list as the portal exports it (docs/integrations/tax-portal-invoice-list.md, from recorded exports of
// 2026-09): two empty rows, the title on row 3, the date range on row 4, an empty row, the header on row 6; one sheet
// named "sheet 1", inline strings (Apache POI).
export const PORTAL_TITLE_ROWS: XlsxCell[][] = [[], [], ['DANH SÁCH HÓA ĐƠN'], ['Từ ngày 01/09/2026 đến ngày 30/09/2026'], []];
// The "Hóa đơn điện tử" tab (có mã and không mã): 19 columns, the same for purchases and sales.
export const PORTAL_HEADER: XlsxCell[] = [
  'STT',
  'Ký hiệu mẫu số',
  'Ký hiệu hóa đơn',
  'Số hóa đơn',
  'Ngày lập',
  'MST người bán/MST người xuất hàng',
  'Tên người bán/Tên người xuất hàng',
  'MST người mua/MST người nhận hàng',
  'Tên người mua/Tên người nhận hàng',
  'Địa chỉ người mua',
  'Tổng tiền chưa thuế',
  'Tổng tiền thuế',
  'Tổng tiền chiết khấu thương mại',
  'Tổng tiền phí',
  'Tổng tiền thanh toán',
  'Đơn vị tiền tệ',
  'Tỷ giá',
  'Trạng thái hóa đơn',
  'Kết quả kiểm tra hóa đơn',
];
// The purchase export of the "máy tính tiền" tab: 17 columns, no fee, currency or exchange rate.
export const PORTAL_SCO_HEADER: XlsxCell[] = [
  'STT',
  'Ký hiệu mẫu số',
  'Ký hiệu hóa đơn',
  'Số hóa đơn',
  'Ngày lập',
  'MST người bán/MST người xuất hàng',
  'Tên người bán/Tên người xuất hàng',
  'Địa chỉ người bán',
  'MST người mua/MST người nhận hàng',
  'Tên người mua/Tên người nhận hàng',
  'Căn cước công dân',
  'Tổng tiền chưa thuế',
  'Tổng tiền thuế',
  'Tổng tiền chiết khấu thương mại',
  'Tổng tiền thanh toán',
  'Trạng thái hóa đơn',
  'Kết quả kiểm tra hóa đơn',
];

export interface PortalInvoiceSpec {
  template?: string | number;
  series: string;
  number: string | number;
  date: string;
  sellerTaxCode: string;
  sellerName?: string;
  buyerTaxCode?: string | null;
  subtotal?: string | number;
  vat?: string | number;
  total?: string | number;
  currency?: string;
  status?: string;
  check?: string;
}

// The buyer of the fixture invoices (apps/extract/test/fixtures/einvoice-basic.xml).
export const FIXTURE_BUYER = '0309876546';

// One data row under PORTAL_HEADER.
export function portalRow(n: number, invoice: PortalInvoiceSpec): XlsxCell[] {
  return [
    n,
    invoice.template ?? 1,
    invoice.series,
    invoice.number,
    invoice.date,
    invoice.sellerTaxCode,
    invoice.sellerName ?? 'CÔNG TY TNHH NHÀ CUNG CẤP',
    invoice.buyerTaxCode === undefined ? FIXTURE_BUYER : invoice.buyerTaxCode,
    'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU',
    '2 Đường Thử, TP Hồ Chí Minh',
    invoice.subtotal ?? null,
    invoice.vat ?? null,
    0,
    0,
    invoice.total ?? null,
    invoice.currency ?? 'VND',
    '1.0',
    invoice.status ?? 'Hóa đơn mới',
    invoice.check ?? 'Đã cấp mã hóa đơn',
  ];
}

export function portalListXlsx(invoices: PortalInvoiceSpec[], options: XlsxOptions = {}): Uint8Array<ArrayBuffer> {
  return buildXlsx([...PORTAL_TITLE_ROWS, PORTAL_HEADER, ...invoices.map((inv, i) => portalRow(i + 1, inv))], { sheetName: 'sheet 1', strings: 'inline', ...options });
}
