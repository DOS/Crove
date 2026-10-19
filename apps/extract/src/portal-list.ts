// Reader for the purchase-invoice list the tax authority's e-invoice portal exports (hoadondientu.gdt.gov.vn, "Tra cứu
// hóa đơn", "Hóa đơn điện tử mua vào", "Xuất Excel"), issue #465. Runs only inside a parser process (see sandbox.ts).
//
// The layout is not published and has changed with the portal's redesigns, so the reader finds the header row by its
// words instead of by position (docs/integrations/tax-portal-invoice-list.md lists the headers seen and which are
// confirmed): it looks in the first rows for the row that names the series, the number, the date and the seller's
// tax code, reads a second header row under it when the header is split in two (a "Thông tin người bán" group over
// "MST" and "Tên"), and maps every column by its words, ignoring diacritics, case and punctuation. A sheet without
// such a row is refused with a message that says which columns are missing, so a wrong file (the sales list, a
// MISA export, an edited copy) fails clearly instead of producing an empty or wrong list.
//
// Values are read as the portal writes them: dates as dd/mm/yyyy text or Excel dates, amounts as Excel numbers or as
// text with dot or comma thousands separators. A row that names no invoice (a blank or totals row) is ignored; a row
// that names one but cannot be read is reported by number and reason, never guessed.
import {
  EXTRACT_LIMITS,
  PORTAL_LIST_REQUIRED_FIELDS,
  type ExtractedPortalList,
  type PortalListField,
  type PortalListSkipReason,
} from '@crove/extract-contract';
import { Decimal, isCalendarDate, normalizeNumber, normalizeSeries, parseTaxCode, toMoney } from '@crove/l10n-vn';
import { readFirstSheet, serialToDate, XlsxError, type SheetCell, type SheetRow } from './xlsx.ts';

export class PortalListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalListError';
  }
}

// How far down the sheet the header row may be.
const HEADER_SEARCH_ROWS = 30;

// Lower case, no diacritics (đ becomes d), punctuation as spaces, single spaces.
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The words of each field's header, folded. A column takes the first field one of whose words it equals; failing
// that, the first field one of whose words it contains (in this order, so "ký hiệu mẫu số" is the template before
// "ký hiệu" can be the series, and "MST người bán" the seller before a bare "MST"). The portal's own JSON names
// (khmshdon, shdon, nbmst...) are accepted too, since tools that rebuild the list from its API use them.
const ALIASES: ReadonlyArray<readonly [PortalListField | 'buyer', readonly string[]]> = [
  ['template', ['ky hieu mau so', 'ky hieu mau so hoa don', 'mau so', 'mau so hoa don', 'ky hieu mau', 'khmshdon']],
  ['series', ['ky hieu hoa don', 'ky hieu', 'seri', 'serial', 'khhdon']],
  ['number', ['so hoa don', 'so hd', 'shdon']],
  ['issueDate', ['ngay lap', 'ngay lap hoa don', 'ngay hoa don', 'ngay phat hanh', 'tdlap', 'nlap']],
  [
    'sellerTaxCode',
    ['mst nguoi ban', 'ma so thue nguoi ban', 'mst nguoi ban mst nguoi xuat hang', 'mst nguoi xuat hang', 'mst ben ban', 'ma so thue ben ban', 'nbmst'],
  ],
  ['sellerName', ['ten nguoi ban', 'ten nguoi ban ten nguoi xuat hang', 'ten nguoi xuat hang', 'ten ben ban', 'ten don vi ban', 'nguoi ban', 'nbten']],
  ['buyerTaxCode', ['mst nguoi mua mst nguoi nhan hang', 'mst nguoi mua', 'ma so thue nguoi mua', 'mst nguoi nhan hang', 'nmmst']],
  ['buyer', ['ten nguoi mua', 'ten nguoi mua ten nguoi nhan hang', 'nmten']],
  ['subtotal', ['tong tien chua thue', 'tien chua thue', 'thanh tien chua thue', 'tong tien hang', 'tgtcthue']],
  ['vatAmount', ['tong tien thue', 'tien thue', 'tien thue gtgt', 'thue gtgt', 'tgtthue']],
  ['total', ['tong tien thanh toan', 'tong thanh toan', 'tong cong tien thanh toan', 'tien thanh toan', 'tgtttbso']],
  ['currency', ['don vi tien te', 'loai tien', 'tien te', 'dvtte']],
  ['status', ['trang thai hoa don', 'trang thai', 'tthai']],
  ['checkResult', ['ket qua kiem tra hoa don', 'ket qua kiem tra', 'ttxly']],
];

// Columns that sound like a field but are not one: "Tổng tiền chiết khấu thương mại" contains "tiền", "Tổng tiền phí"
// is not the total, "Số thứ tự" is not the number.
// "Địa chỉ người bán" names the seller but is not the name; "Tỷ giá" and "Căn cước công dân" are not read.
const NOT_FIELDS = ['chiet khau', 'tien phi', 'so thu tu', 'stt', 'lien quan', 'goc bi', 'dia chi', 'ty gia', 'can cuoc'];

// A bare "MST" or "Mã số thuế" names the seller when the sheet has no seller-specific column (some tools export the
// purchase list that way).
const BARE_TAX_CODE = ['mst', 'ma so thue'];

const FIELD_NAMES: Readonly<Record<PortalListField, string>> = {
  sellerTaxCode: 'MST người bán',
  series: 'Ký hiệu hóa đơn',
  number: 'Số hóa đơn',
  issueDate: 'Ngày lập',
  template: 'Ký hiệu mẫu số',
  sellerName: 'Tên người bán',
  buyerTaxCode: 'MST người mua',
  subtotal: 'Tổng tiền chưa thuế',
  vatAmount: 'Tổng tiền thuế',
  total: 'Tổng tiền thanh toán',
  currency: 'Đơn vị tiền tệ',
  status: 'Trạng thái hóa đơn',
  checkResult: 'Kết quả kiểm tra hóa đơn',
};

function cellText(cell: SheetCell | undefined): string {
  return cell ? cell.value.trim() : '';
}

interface ColumnMap {
  fields: Map<PortalListField, number>;
  headers: Map<PortalListField, string>;
  buyer: boolean;
}

function fieldFor(label: string): PortalListField | 'buyer' | null {
  if (label === '' || NOT_FIELDS.some((w) => label === w || label.includes(w))) return null;
  for (const [field, words] of ALIASES) if (words.includes(label)) return field;
  for (const [field, words] of ALIASES) {
    if (words.some((w) => w.length >= 4 && (label.startsWith(`${w} `) || label.endsWith(` ${w}`) || label.includes(` ${w} `)))) {
      // "ký hiệu" inside "ký hiệu mẫu số" is the template, matched above by equality; here it would be the series.
      if (field === 'series' && label.includes('mau')) continue;
      return field;
    }
  }
  return null;
}

// Maps the columns of a header row (and the row under it, for a split header). Each field takes the first column it
// matches; each column at most one field.
function mapColumns(top: SheetRow, sub: SheetRow | null): ColumnMap {
  const fields = new Map<PortalListField, number>();
  const headers = new Map<PortalListField, string>();
  let buyer = false;
  const columns = new Set<number>([...top.cells.keys(), ...(sub ? sub.cells.keys() : [])]);
  const bare: Array<{ column: number; header: string }> = [];
  for (const column of [...columns].sort((a, b) => a - b)) {
    // The lower header row names the column when the header is split; the upper row otherwise.
    const candidates = [cellText(sub?.cells.get(column)), cellText(top.cells.get(column))].filter((t) => t !== '');
    for (const header of candidates) {
      const label = fold(header);
      const field = fieldFor(label);
      if (field === 'buyer') {
        buyer = true;
        break;
      }
      if (field && !fields.has(field)) {
        fields.set(field, column);
        headers.set(field, header.slice(0, 200));
        break;
      }
      if (!field && BARE_TAX_CODE.includes(label)) {
        bare.push({ column, header: header.slice(0, 200) });
        break;
      }
    }
  }
  const first = bare[0];
  if (!fields.has('sellerTaxCode') && !buyer && !fields.has('buyerTaxCode') && first) {
    fields.set('sellerTaxCode', first.column);
    headers.set('sellerTaxCode', first.header);
  }
  return { fields, headers, buyer };
}

function score(map: ColumnMap): number {
  return PORTAL_LIST_REQUIRED_FIELDS.filter((f) => map.fields.has(f)).length;
}

interface Header {
  map: ColumnMap;
  headerRow: number;
  // Index in rows of the first data row.
  start: number;
}

function findHeader(rows: SheetRow[]): Header {
  let best: Header | null = null;
  let bestScore = 0;
  let bestMap: ColumnMap | null = null;
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i++) {
    const top = rows[i];
    if (!top) continue;
    const next = rows[i + 1];
    const single = mapColumns(top, null);
    // A split header: the next row adds fields the top row lacks (and holds no invoice number where the top names it).
    const split = next && next.rowNo === top.rowNo + 1 ? mapColumns(top, next) : null;
    // The next row may also be a complete header by itself (the title rows above it then add nothing).
    const useSplit = split !== null && next !== undefined && score(split) > score(single) && score(split) > score(mapColumns(next, null));
    const map = useSplit ? split : single;
    const s = score(map);
    if (s > bestScore) {
      bestScore = s;
      bestMap = map;
      best = { map, headerRow: top.rowNo, start: i + (useSplit ? 2 : 1) };
    }
    if (s === PORTAL_LIST_REQUIRED_FIELDS.length) break;
  }
  if (best && bestScore === PORTAL_LIST_REQUIRED_FIELDS.length) return best;
  if ((bestMap?.buyer || bestMap?.fields.has('buyerTaxCode')) && !bestMap.fields.has('sellerTaxCode')) {
    throw new PortalListError('Đây là danh sách hóa đơn bán ra; hãy tra cứu ở mục "Hóa đơn điện tử mua vào" rồi xuất lại');
  }
  if (bestMap && bestScore >= 2) {
    const missing = PORTAL_LIST_REQUIRED_FIELDS.filter((f) => !bestMap?.fields.has(f)).map((f) => FIELD_NAMES[f]);
    throw new PortalListError(
      `Không nhận ra bảng danh sách hóa đơn: thiếu cột ${missing.join(', ')}. Hãy tải lên đúng tệp Excel xuất từ hoadondientu.gdt.gov.vn, không sửa tiêu đề cột`,
    );
  }
  throw new PortalListError(
    'Không nhận ra bảng danh sách hóa đơn: không thấy dòng tiêu đề có các cột Ký hiệu hóa đơn, Số hóa đơn, Ngày lập, MST người bán. Hãy tải lên tệp Excel xuất từ hoadondientu.gdt.gov.vn (Tra cứu hóa đơn, Hóa đơn điện tử mua vào, Xuất Excel)',
  );
}

// dd/mm/yyyy (or with - or .), optionally followed by a time, or yyyy-mm-dd.
export function readDate(cell: SheetCell | undefined, date1904: boolean): string | null {
  if (!cell) return null;
  if (cell.kind === 'date' || cell.kind === 'number') {
    const value = Number(cell.value);
    // A plain number in a date column is a serial only in a plausible range (2000 to 2100).
    if (cell.kind === 'number' && !(value >= 36_526 && value <= 73_051)) return null;
    return serialToDate(cell.value, date1904);
  }
  const text = cell.value.trim();
  const vn = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(text);
  const date = vn ? `${vn[3]}-${(vn[2] ?? '').padStart(2, '0')}-${(vn[1] ?? '').padStart(2, '0')}` : iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  return date && isCalendarDate(date) ? date : null;
}

// An amount as the sheet holds it: an Excel number (its exact digits) or text with thousands separators. Vietnamese
// text uses dots for thousands and a comma for decimals; English text the other way round. A lone separator followed
// by exactly three digits is a thousands separator ("1.500" is one thousand five hundred dong, as the portal writes).
export function readAmount(cell: SheetCell | undefined): string | null | 'invalid' {
  if (!cell) return null;
  let text = cell.value.trim().replace(/\s|đ|₫|vnd/gi, '');
  if (text === '' || text === '-') return null;
  let negative = false;
  const parenthesized = /^\((.*)\)$/.exec(text);
  if (parenthesized) {
    negative = true;
    text = parenthesized[1] ?? '';
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  let plain: string;
  if (cell.kind === 'number' || cell.kind === 'date') {
    plain = text;
  } else if (text.includes('.') && text.includes(',')) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    plain = text.split(thousands).join('').replace(decimal, '.');
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(text)) {
    plain = text.replace(/[.,]/g, '');
  } else {
    plain = text.replace(',', '.');
  }
  if (!/^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(plain)) return 'invalid';
  let value: InstanceType<typeof Decimal>;
  try {
    value = new Decimal(plain);
  } catch {
    return 'invalid';
  }
  if (!value.isFinite() || value.abs().greaterThanOrEqualTo('1e16') || value.decimalPlaces() > 8) return 'invalid';
  return toMoney(negative ? value.negated() : value);
}

// A tax code as the sheet holds it. A number cell loses the leading zero of codes like 0100109107 (the portal formats
// them 0000000000), so a number is padded back to 10 digits, or 12 for an individual's code.
function readTaxCode(cell: SheetCell | undefined): string {
  const text = cellText(cell);
  if (cell?.kind === 'number' && /^\d{1,12}$/.test(text)) return text.length <= 10 ? text.padStart(10, '0') : text.padStart(12, '0');
  return text.replace(/[^\d-]/g, '');
}

function readText(cell: SheetCell | undefined, max: number): string | null {
  const text = cellText(cell).replace(/\s+/g, ' ');
  return text === '' ? null : text.slice(0, max);
}

function readCurrency(cell: SheetCell | undefined): string {
  const folded = fold(cellText(cell)).replace(/\s/g, '');
  if (folded === '' || folded === 'vnd' || folded === 'dong' || folded === 'vietnamdong') return 'VND';
  return /^[a-z]{3}$/.test(folded) ? folded.toUpperCase() : 'VND';
}

function readTemplate(cell: SheetCell | undefined): string | null {
  const text = cellText(cell).toUpperCase().replace(/\s+/g, '');
  return /^[0-9A-Z]{1,11}$/.test(text) ? text : null;
}

// "Từ ngày 01/09/2026 đến ngày 30/09/2026" and the buyer's tax code, when the rows above the header give them.
function readPreamble(rows: SheetRow[], date1904: boolean): Pick<ExtractedPortalList, 'listFrom' | 'listTo' | 'buyerTaxCode'> {
  let listFrom: string | null = null;
  let listTo: string | null = null;
  let buyerTaxCode: string | null = null;
  for (const row of rows) {
    const texts = [...row.cells.values()].map((c) => c.value);
    const line = texts.join(' ');
    const folded = fold(line);
    const range = /tu ngay (\d{1,2}) (\d{1,2}) (\d{4}) den ngay (\d{1,2}) (\d{1,2}) (\d{4})/.exec(folded);
    if (range && listFrom === null) {
      listFrom = readDate({ kind: 'text', value: `${range[1]}/${range[2]}/${range[3]}` }, date1904);
      listTo = readDate({ kind: 'text', value: `${range[4]}/${range[5]}/${range[6]}` }, date1904);
    }
    const tax = /\b(?:mst|ma so thue)(?! nguoi ban)(?: nguoi mua)?\s*(\d{10}(?: \d{3})?|\d{12})\b/.exec(folded);
    if (tax?.[1] && buyerTaxCode === null) buyerTaxCode = parseTaxCode(tax[1].replace(' ', '-'))?.normalized ?? null;
  }
  return { listFrom, listTo, buyerTaxCode };
}

export function readPortalList(bytes: Uint8Array): ExtractedPortalList {
  let sheet;
  try {
    sheet = readFirstSheet(bytes);
  } catch (error) {
    if (error instanceof XlsxError) throw new PortalListError(error.message);
    throw error;
  }
  const header = findHeader(sheet.rows);
  const { fields, headers } = header.map;
  const lastHeaderColumn = Math.max(...fields.values());
  const currencyColumn = fields.get('currency');
  // Columns from the currency on, where one source reports that rows of the "không mã" export carry one extra empty
  // cell (unconfirmed, docs/integrations/tax-portal-invoice-list.md): such a row is wider than the header and its
  // currency cell is empty, so the tail fields are read that many columns to the right. The key and amount columns
  // come before it and are read as they are.
  const TAIL: ReadonlySet<PortalListField> = new Set(['currency', 'status', 'checkResult']);
  const at = (row: SheetRow, field: PortalListField) => {
    const column = fields.get(field);
    if (column === undefined) return undefined;
    if (currencyColumn !== undefined && TAIL.has(field) && column >= currencyColumn) {
      const overflow = Math.max(...row.cells.keys()) - lastHeaderColumn;
      if (overflow > 0 && overflow <= 2 && cellText(row.cells.get(currencyColumn)) === '') return row.cells.get(column + overflow);
    }
    return row.cells.get(column);
  };
  const rows: ExtractedPortalList['rows'] = [];
  const skipped: ExtractedPortalList['skipped'] = [];
  let skippedCount = 0;
  const skip = (rowNo: number, reason: PortalListSkipReason) => {
    skippedCount += 1;
    if (skipped.length < EXTRACT_LIMITS.maxPortalListSkipped) skipped.push({ rowNo, reason });
  };
  for (const row of sheet.rows.slice(header.start)) {
    const rawTax = readTaxCode(at(row, 'sellerTaxCode'));
    const rawNumber = cellText(at(row, 'number'));
    const rawSeries = cellText(at(row, 'series'));
    // A blank, totals or footnote row names no invoice.
    if (rawNumber === '' && rawSeries === '' && rawTax === '') continue;
    if (rawNumber === '') {
      skip(row.rowNo, 'no_number');
      continue;
    }
    if (rawSeries === '') {
      skip(row.rowNo, 'no_series');
      continue;
    }
    if (rawTax === '') {
      skip(row.rowNo, 'no_tax_code');
      continue;
    }
    const taxCode = parseTaxCode(rawTax);
    if (!taxCode) {
      skip(row.rowNo, 'bad_tax_code');
      continue;
    }
    const issueDate = readDate(at(row, 'issueDate'), sheet.date1904);
    if (!issueDate) {
      skip(row.rowNo, 'bad_date');
      continue;
    }
    const series = normalizeSeries(rawSeries);
    const number = normalizeNumber(rawNumber.replace(/\.0+$/, ''));
    if (series.length > 20 || number.length > 20) {
      skip(row.rowNo, 'too_long');
      continue;
    }
    const subtotal = readAmount(at(row, 'subtotal'));
    const vatAmount = readAmount(at(row, 'vatAmount'));
    const total = readAmount(at(row, 'total'));
    if (subtotal === 'invalid' || vatAmount === 'invalid' || total === 'invalid') {
      skip(row.rowNo, 'bad_amount');
      continue;
    }
    if (rows.length >= EXTRACT_LIMITS.maxPortalListRows) {
      throw new PortalListError(`Danh sách có hơn ${EXTRACT_LIMITS.maxPortalListRows} hóa đơn; hãy xuất từng khoảng ngày ngắn hơn`);
    }
    rows.push({
      rowNo: row.rowNo,
      sellerTaxCode: taxCode.normalized,
      sellerName: readText(at(row, 'sellerName'), 500) ?? '',
      buyerTaxCode: parseTaxCode(readTaxCode(at(row, 'buyerTaxCode')))?.normalized ?? null,
      template: readTemplate(at(row, 'template')),
      series,
      number,
      issueDate,
      currency: readCurrency(at(row, 'currency')),
      subtotal,
      vatAmount,
      total,
      statusLabel: readText(at(row, 'status'), 200),
      checkResult: readText(at(row, 'checkResult'), 200),
    });
  }
  return {
    sheetName: sheet.name,
    headerRow: header.headerRow,
    columns: [...headers].map(([field, text]) => ({ field, header: text })),
    ...readPreamble(sheet.rows.filter((r) => r.rowNo < header.headerRow), sheet.date1904),
    rows,
    skipped,
    skippedCount,
  };
}
