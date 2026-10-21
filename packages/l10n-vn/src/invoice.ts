import { approxEqual, money, sum, toMoney, type Money } from './money.ts';
import { parseTaxCode } from './tax-code.ts';

// Normalized purchase invoice, produced by the e-invoice XML parser or by AI extraction.
export interface InvoiceParty {
  name: string;
  taxCode: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

// TChat in the e-invoice XML: 1 goods/services, 2 promotion, 3 trade discount, 4 note.
export type LineNature = 'goods' | 'promotion' | 'discount' | 'note';

export interface InvoiceLine {
  lineNo: number;
  nature: LineNature;
  code: string | null;
  description: string;
  unit: string | null;
  quantity: Money | null;
  unitPrice: Money | null;
  amount: Money;
  vatRate: string | null;
}

export interface TaxBreakdown {
  rate: string;
  taxableAmount: Money;
  vatAmount: Money;
}

// The invoice an e-invoice corrects (issue #916), from its TTHDLQuan block: a replacement (thay thế) takes the
// original's place, an adjustment (điều chỉnh) changes its amounts by the difference it carries. The original is named
// by its template, series, number and issue date.
export interface RelatedInvoice {
  kind: 'replacement' | 'adjustment';
  template: string | null;
  series: string;
  number: string;
  issueDate: string | null;
  note: string | null;
}

export interface ParsedInvoice {
  source: 'einvoice_xml' | 'ai';
  invoiceType: string | null;
  template: string | null;
  series: string;
  number: string;
  issueDate: string;
  currency: string;
  exchangeRate: Money | null;
  paymentMethod: string | null;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  taxBreakdown: TaxBreakdown[];
  subtotal: Money;
  vatTotal: Money;
  total: Money;
  totalInWords: string | null;
  taxAuthorityCode: string | null;
  hasSignature: boolean;
  // Set only on a replacement or an adjustment invoice whose XML names the invoice it corrects.
  related?: RelatedInvoice | undefined;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

// id names the check (stable, BLOCKING_CHECK_IDS refers to it); code names its outcome and wording (one of
// INVOICE_CHECK_CODES in @crove/kernel-contract, issue #677), with params filling the wording. message is the
// Vietnamese sentence, kept for older readers and as the fallback.
export interface InvoiceCheck {
  id: string;
  status: CheckStatus;
  message: string;
  code: string;
  params?: Record<string, string>;
}

// Normalized invoice identifiers used for storage and duplicate detection.
export function normalizeSeries(series: string): string {
  return series.trim().toUpperCase().replace(/\s+/g, '');
}

export function normalizeNumber(number: string): string {
  const trimmed = number.trim().replace(/\s+/g, '');
  return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, '') : trimmed.toUpperCase();
}

// Signed contribution of a line to the pre-tax subtotal.
export function lineContribution(line: InvoiceLine): Money {
  if (line.nature === 'note' || line.nature === 'promotion') return '0';
  const amount = money(line.amount);
  return toMoney(line.nature === 'discount' && amount.isPositive() ? amount.negated() : amount);
}

// YYYY-MM-DD that names a real day, year 0001 or later (PostgreSQL rejects year 0000 in date input).
// Never throws (toISOString() does on an Invalid Date).
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value < '0001-01-01') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Deterministic checks. Confidence comes from these, never from a model's self-assessment.
export function checkInvoice(
  invoice: ParsedInvoice,
  today: string = new Date().toISOString().slice(0, 10),
  baseCurrency = 'VND',
): InvoiceCheck[] {
  const checks: InvoiceCheck[] = [];
  if (invoice.currency.toUpperCase() !== baseCurrency) {
    // The code as read can be any text (an XML element, a model's answer): only its start is shown.
    const currency = Array.from(invoice.currency.trim()).slice(0, 20).join('');
    checks.push({ id: 'currency', status: 'fail', code: 'currency.unsupported', params: { currency }, message: `Hóa đơn bằng ${currency}; chưa hỗ trợ ghi sổ ngoại tệ` });
  }
  const linesTotal = sum(invoice.lines.map(lineContribution));

  checks.push(
    approxEqual(linesTotal, invoice.subtotal, '0')
      ? { id: 'lines_sum', status: 'pass', code: 'lines_sum.ok', message: 'Tổng các dòng khớp tiền trước thuế' }
      : {
          id: 'lines_sum',
          status: 'fail',
          code: 'lines_sum.mismatch',
          params: { lines: toMoney(linesTotal), subtotal: invoice.subtotal },
          message: `Tổng các dòng (${toMoney(linesTotal)}) lệch tiền trước thuế (${invoice.subtotal})`,
        },
  );

  checks.push(
    approxEqual(money(invoice.subtotal).plus(money(invoice.vatTotal)), invoice.total, '0')
      ? { id: 'total', status: 'pass', code: 'total.ok', message: 'Tiền trước thuế + VAT khớp tổng thanh toán' }
      : { id: 'total', status: 'fail', code: 'total.mismatch', message: 'Tiền trước thuế + VAT lệch tổng thanh toán' },
  );

  if (invoice.taxBreakdown.length > 0) {
    const vat = sum(invoice.taxBreakdown.map((t) => t.vatAmount));
    checks.push(
      approxEqual(vat, invoice.vatTotal, '0')
        ? { id: 'vat_breakdown', status: 'pass', code: 'vat_breakdown.ok', message: 'Bảng thuế suất khớp tổng VAT' }
        : { id: 'vat_breakdown', status: 'fail', code: 'vat_breakdown.mismatch', message: 'Bảng thuế suất lệch tổng VAT' },
    );
  }

  const seller = parseTaxCode(invoice.seller.taxCode);
  if (!seller) {
    checks.push({ id: 'seller_tax_code', status: 'warn', code: 'seller_tax_code.unreadable', message: 'Không đọc được MST người bán' });
  } else if (seller.checksumValid === false) {
    checks.push({
      id: 'seller_tax_code',
      status: 'warn',
      code: 'seller_tax_code.checksum',
      params: { taxCode: seller.normalized },
      message: `MST người bán ${seller.normalized} sai số kiểm tra`,
    });
  } else {
    checks.push({ id: 'seller_tax_code', status: 'pass', code: 'seller_tax_code.ok', params: { taxCode: seller.normalized }, message: `MST người bán ${seller.normalized} hợp lệ` });
  }

  if (!isCalendarDate(invoice.issueDate)) {
    checks.push({ id: 'issue_date', status: 'fail', code: 'issue_date.invalid', message: 'Ngày lập hóa đơn không hợp lệ' });
  } else if (invoice.issueDate > today) {
    checks.push({ id: 'issue_date', status: 'warn', code: 'issue_date.future', message: 'Ngày lập hóa đơn ở tương lai' });
  } else {
    checks.push({ id: 'issue_date', status: 'pass', code: 'issue_date.ok', params: { date: invoice.issueDate }, message: `Ngày lập ${invoice.issueDate}` });
  }

  if (invoice.source === 'einvoice_xml') {
    checks.push(
      invoice.taxAuthorityCode
        ? { id: 'tax_authority_code', status: 'pass', code: 'tax_authority_code.present', message: 'Có mã của cơ quan thuế' }
        : { id: 'tax_authority_code', status: 'warn', code: 'tax_authority_code.missing', message: 'Không có mã của cơ quan thuế' },
    );
    checks.push({
      id: 'signature',
      status: 'warn',
      code: invoice.hasSignature ? 'signature.unverified' : 'signature.missing',
      message: invoice.hasSignature ? 'Có chữ ký số, chưa xác minh với nguồn chính thức' : 'Không có chữ ký số',
    });
  } else {
    checks.push({ id: 'source', status: 'warn', code: 'source.ai', message: 'Đọc bằng AI từ ảnh/PDF, cần người kiểm tra' });
  }
  return checks;
}
