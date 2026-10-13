// Parser for Vietnamese e-invoice XML (Decree 123/2020/ND-CP, Circular 78/2021/TT-BTC, format of
// Decision 1450/QD-TCT). Deterministic, no LLM. Entity expansion is disabled and DOCTYPE is rejected.
import { XMLParser } from 'fast-xml-parser';
import { money, sum, toMoney } from './money.ts';
import { normalizeNumber, normalizeSeries, type InvoiceLine, type InvoiceParty, type LineNature, type ParsedInvoice, type TaxBreakdown } from './invoice.ts';

export class EInvoiceParseError extends Error {}

const MAX_XML_BYTES = 5 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  isArray: (name) => ['HHDVu', 'LTSuat', 'TTin'].includes(name),
});

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(node: unknown, key: string): string | null {
  if (!isNode(node)) return null;
  const value = node[key];
  if (value === undefined || value === null) return null;
  // Long values are truncated: a 5 MB file must not turn into megabyte-sized names in every listing.
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim().slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function amount(node: unknown, key: string): string | null {
  const raw = text(node, key);
  if (raw === null) return null;
  // Decree 123 XML uses "." as the decimal separator; anything else is rejected, never guessed.
  if (!/^-?\d{1,16}(\.\d{1,8})?$/.test(raw)) throw new EInvoiceParseError(`Số không hợp lệ ở thẻ ${key}: ${raw.slice(0, 40)}`);
  return toMoney(money(raw));
}

function findHDon(value: unknown, depth = 0): Node | null {
  if (!isNode(value) || depth > 6) return null;
  if (isNode(value.HDon)) return value.HDon;
  for (const child of Object.values(value)) {
    const found = findHDon(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function party(node: unknown): InvoiceParty {
  return {
    name: text(node, 'Ten') ?? text(node, 'HVTNMHang') ?? '',
    taxCode: text(node, 'MST'),
    address: text(node, 'DChi'),
    email: text(node, 'DCTDTu'),
    phone: text(node, 'SDThoai'),
  };
}

function nature(code: string | null): LineNature {
  switch (code) {
    case '2':
      return 'promotion';
    case '3':
      return 'discount';
    case '4':
      return 'note';
    default:
      return 'goods';
  }
}

export function looksLikeEInvoiceXml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  return /<\s*(\w+:)?HDon[\s>]/.test(head) || /<\s*(\w+:)?TDiep[\s>]/.test(head);
}

export function parseEInvoiceXml(bytes: Uint8Array): ParsedInvoice {
  if (bytes.byteLength > MAX_XML_BYTES) throw new EInvoiceParseError('Tệp XML quá lớn');
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new EInvoiceParseError('XML chứa DOCTYPE/ENTITY, bị từ chối');

  let tree: unknown;
  try {
    tree = parser.parse(xml);
  } catch (error) {
    throw new EInvoiceParseError(`Không đọc được XML: ${(error as Error).message}`);
  }
  const hdon = findHDon(tree);
  if (!hdon) throw new EInvoiceParseError('Không tìm thấy thẻ HDon (không phải hóa đơn điện tử)');
  const data = hdon.DLHDon;
  if (!isNode(data)) throw new EInvoiceParseError('Thiếu DLHDon');
  const general = data.TTChung;
  const content = data.NDHDon;
  if (!isNode(general) || !isNode(content)) throw new EInvoiceParseError('Thiếu TTChung hoặc NDHDon');

  const number = text(general, 'SHDon');
  const issueDate = text(general, 'NLap');
  if (!number || !issueDate) throw new EInvoiceParseError('Thiếu số hóa đơn hoặc ngày lập');

  const items = isNode(content.DSHHDVu) ? content.DSHHDVu.HHDVu : undefined;
  const lines: InvoiceLine[] = (Array.isArray(items) ? items : []).filter(isNode).map((item, index) => ({
    // Printed STT can repeat or skip; storage needs a unique, sequential line number.
    lineNo: index + 1,
    nature: nature(text(item, 'TChat')),
    code: text(item, 'MHHDVu'),
    description: text(item, 'THHDVu') ?? '',
    unit: text(item, 'DVTinh'),
    quantity: amount(item, 'SLuong'),
    unitPrice: amount(item, 'DGia'),
    amount: amount(item, 'ThTien') ?? '0',
    vatRate: text(item, 'TSuat'),
  }));

  const totals = content.TToan;
  const breakdownNodes = isNode(totals) && isNode(totals.THTTLTSuat) ? totals.THTTLTSuat.LTSuat : undefined;
  const taxBreakdown: TaxBreakdown[] = (Array.isArray(breakdownNodes) ? breakdownNodes : []).filter(isNode).map((n) => ({
    rate: text(n, 'TSuat') ?? '',
    taxableAmount: amount(n, 'ThTien') ?? '0',
    vatAmount: amount(n, 'TThue') ?? '0',
  }));

  const vatTotal = amount(totals, 'TgTThue') ?? toMoney(sum(taxBreakdown.map((t) => t.vatAmount)));
  const subtotal = amount(totals, 'TgTCThue') ?? toMoney(sum(taxBreakdown.map((t) => t.taxableAmount)));
  const total = amount(totals, 'TgTTTBSo') ?? toMoney(money(subtotal).plus(money(vatTotal)));

  return {
    source: 'einvoice_xml',
    invoiceType: text(general, 'THDon'),
    template: text(general, 'KHMSHDon'),
    series: normalizeSeries(text(general, 'KHHDon') ?? ''),
    number: normalizeNumber(number),
    issueDate: issueDate.slice(0, 10),
    currency: text(general, 'DVTTe') ?? 'VND',
    exchangeRate: amount(general, 'TGia'),
    paymentMethod: text(general, 'HTTToan'),
    seller: party(content.NBan),
    buyer: party(content.NMua),
    lines,
    taxBreakdown,
    subtotal,
    vatTotal,
    total,
    totalInWords: text(totals, 'TgTTTBChu'),
    taxAuthorityCode: typeof hdon.MCCQT === 'string' ? hdon.MCCQT : text(hdon, 'MCCQT'),
    hasSignature: hdon.DSCKS !== undefined,
  };
}
