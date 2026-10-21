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

// The digital signatures of an e-invoice XML (#674), verified in the crove-extract sandbox: the seller's XML-DSig
// signature and, for an invoice with a tax authority code (MCCQT), the tax authority's. The same lists are the wire
// contract in @crove/extract-contract (its tests compare them).
//   verified        every signature the invoice must carry is valid, covers the invoice data that was read, and its
//                   certificate chains to a Vietnamese national root CA shipped with Crove (no revocation check)
//   unverified      a signature is missing, broken, does not cover the data, or its certificate is not trusted;
//                   reason says which. A warning: the invoice is still read, and approving it asks for a confirmation
//   not_applicable  nothing to verify: a cash register invoice the law lets go unsigned, or an invoice read by AI
export const SIGNATURE_STATUSES = ['verified', 'unverified', 'not_applicable'] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];
export const SIGNATURE_REASONS = [
  // The seller's signature.
  'missing',
  'malformed',
  'ambiguous',
  'not_covering',
  'digest_mismatch',
  'bad_signature',
  'unsupported_algorithm',
  'no_certificate',
  'untrusted_certificate',
  'certificate_expired',
  'signer_mismatch',
  // The tax authority's signature on an invoice with a tax authority code.
  'tax_authority_missing',
  'tax_authority_invalid',
  'tax_authority_untrusted',
  // not_applicable: a cash register invoice (series type M) with no signature.
  'cash_register',
] as const;
export type SignatureReason = (typeof SIGNATURE_REASONS)[number];

export interface InvoiceSignature {
  status: SignatureStatus;
  // Why it is unverified or not applicable; null when verified.
  reason: SignatureReason | null;
  // The seller's certificate: its common name and its issuer's, when a certificate was read.
  signer: string | null;
  issuer: string | null;
  // When the seller signed: the signed SigningTime property, else the invoice date. ISO 8601.
  signedAt: string | null;
}

const SIGNATURE_MESSAGES: Record<SignatureReason, string> = {
  missing: 'Không có chữ ký số của người bán',
  malformed: 'Chữ ký số không đọc được theo chuẩn XML-DSig',
  ambiguous: 'Tệp có nhiều phần hóa đơn hoặc nhiều chữ ký người bán nên không xác định được phần đã ký',
  not_covering: 'Chữ ký số không bao phủ phần dữ liệu hóa đơn được đọc',
  digest_mismatch: 'Nội dung hóa đơn không khớp chữ ký số (có thể đã bị sửa sau khi ký)',
  bad_signature: 'Chữ ký số không hợp lệ với chứng thư số kèm theo',
  unsupported_algorithm: 'Chữ ký số dùng thuật toán chưa hỗ trợ',
  no_certificate: 'Chữ ký số không kèm chứng thư số của người ký',
  untrusted_certificate: 'Chứng thư số không do tổ chức chứng thực được Root CA quốc gia công nhận cấp',
  certificate_expired: 'Chứng thư số không còn hiệu lực tại thời điểm ký',
  signer_mismatch: 'Chứng thư số cấp cho mã số thuế khác người bán',
  tax_authority_missing: 'Có mã của cơ quan thuế nhưng thiếu chữ ký số của cơ quan thuế',
  tax_authority_invalid: 'Chữ ký số của cơ quan thuế không hợp lệ hoặc không bao phủ mã và dữ liệu hóa đơn',
  tax_authority_untrusted: 'Chưa xác minh được tổ chức cấp chứng thư số của cơ quan thuế',
  cash_register: 'Hóa đơn khởi tạo từ máy tính tiền, không bắt buộc chữ ký số',
};

// What the Inbox and the checks say about a signature verification.
export function signatureMessage(signature: InvoiceSignature): string {
  if (signature.status === 'verified') {
    return signature.signer ? `Chữ ký số hợp lệ, đã xác minh (người ký: ${signature.signer})` : 'Chữ ký số hợp lệ, đã xác minh';
  }
  if (signature.reason) return SIGNATURE_MESSAGES[signature.reason];
  return signature.status === 'unverified' ? 'Chưa xác minh được chữ ký số' : 'Không cần xác minh chữ ký số';
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
  // Set by the e-invoice XML parser (#674); an invoice read by AI has none, and nothing to verify.
  signature?: InvoiceSignature | undefined;
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
    // Verified in the sandbox (#674). An unverified signature is a warning, never a failed check: it must not block
    // the invoice, and the Inbox asks the approver to confirm it instead. Without a verification (an answer from a
    // sandbox older than #674) it stays a warning, as before.
    const signature = invoice.signature;
    checks.push(
      signature
        ? { id: 'signature', status: signature.status === 'unverified' ? 'warn' : 'pass', message: signatureMessage(signature) }
        : { id: 'signature', status: 'warn', message: invoice.hasSignature ? 'Có chữ ký số, chưa xác minh với nguồn chính thức' : 'Không có chữ ký số' },
    );
  } else {
    checks.push({ id: 'source', status: 'warn', message: 'Đọc bằng AI từ ảnh/PDF, cần người kiểm tra' });
  }
  return checks;
}
