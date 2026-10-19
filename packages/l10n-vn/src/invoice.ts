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
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface InvoiceCheck {
  id: string;
  status: CheckStatus;
  message: string;
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
    checks.push({ id: 'currency', status: 'fail', message: `Hóa đơn bằng ${invoice.currency}; chưa hỗ trợ ghi sổ ngoại tệ` });
  }
  const linesTotal = sum(invoice.lines.map(lineContribution));

  checks.push(
    approxEqual(linesTotal, invoice.subtotal, '0')
      ? { id: 'lines_sum', status: 'pass', message: 'Tổng các dòng khớp tiền trước thuế' }
      : {
          id: 'lines_sum',
          status: 'fail',
          message: `Tổng các dòng (${toMoney(linesTotal)}) lệch tiền trước thuế (${invoice.subtotal})`,
        },
  );

  checks.push(
    approxEqual(money(invoice.subtotal).plus(money(invoice.vatTotal)), invoice.total, '0')
      ? { id: 'total', status: 'pass', message: 'Tiền trước thuế + VAT khớp tổng thanh toán' }
      : { id: 'total', status: 'fail', message: 'Tiền trước thuế + VAT lệch tổng thanh toán' },
  );

  if (invoice.taxBreakdown.length > 0) {
    const vat = sum(invoice.taxBreakdown.map((t) => t.vatAmount));
    checks.push(
      approxEqual(vat, invoice.vatTotal, '0')
        ? { id: 'vat_breakdown', status: 'pass', message: 'Bảng thuế suất khớp tổng VAT' }
        : { id: 'vat_breakdown', status: 'fail', message: 'Bảng thuế suất lệch tổng VAT' },
    );
  }

  const seller = parseTaxCode(invoice.seller.taxCode);
  if (!seller) {
    checks.push({ id: 'seller_tax_code', status: 'warn', message: 'Không đọc được MST người bán' });
  } else if (seller.checksumValid === false) {
    checks.push({ id: 'seller_tax_code', status: 'warn', message: `MST người bán ${seller.normalized} sai số kiểm tra` });
  } else {
    checks.push({ id: 'seller_tax_code', status: 'pass', message: `MST người bán ${seller.normalized} hợp lệ` });
  }

  if (!isCalendarDate(invoice.issueDate)) {
    checks.push({ id: 'issue_date', status: 'fail', message: 'Ngày lập hóa đơn không hợp lệ' });
  } else if (invoice.issueDate > today) {
    checks.push({ id: 'issue_date', status: 'warn', message: 'Ngày lập hóa đơn ở tương lai' });
  } else {
    checks.push({ id: 'issue_date', status: 'pass', message: `Ngày lập ${invoice.issueDate}` });
  }

  if (invoice.source === 'einvoice_xml') {
    checks.push(
      invoice.taxAuthorityCode
        ? { id: 'tax_authority_code', status: 'pass', message: 'Có mã của cơ quan thuế' }
        : { id: 'tax_authority_code', status: 'warn', message: 'Không có mã của cơ quan thuế' },
    );
    checks.push({
      id: 'signature',
      status: 'warn',
      message: invoice.hasSignature ? 'Có chữ ký số, chưa xác minh với nguồn chính thức' : 'Không có chữ ký số',
    });
  } else {
    checks.push({ id: 'source', status: 'warn', message: 'Đọc bằng AI từ ảnh/PDF, cần người kiểm tra' });
  }
  return checks;
}
