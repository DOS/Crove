// TT133/2016 suggestions for purchase invoices: debit account per line, VAT input account, payable.
import { money, sum, toMoney, type Money } from './money.ts';
import { lineContribution, type InvoiceLine, type ParsedInvoice } from './invoice.ts';
import { parseVatRate } from './vat-rate.ts';

export const PAYABLE_ACCOUNT = '331';
export const VAT_INPUT_GOODS = '1331';
export const VAT_INPUT_ASSETS = '1332';
export const FIXED_ASSETS = '211';
// 211 or one of its sub-accounts (2111, 211.XE): a sub-account's code starts with its parent's (#319).
export function isFixedAssetAccount(code: string): boolean {
  return code.startsWith(FIXED_ASSETS);
}
export const FIXED_ASSET_THRESHOLD = '30000000';

export interface AccountSuggestion {
  account: string;
  reason: string;
}

const RULES: Array<{ account: string; pattern: RegExp; reason: string }> = [
  { account: '6421', pattern: /quảng cáo|marketing|vận chuyển|giao hàng|hoa hồng|khuyến mãi|ads|facebook|google/i, reason: 'Chi phí bán hàng' },
  { account: '153', pattern: /công cụ|dụng cụ|bàn|ghế|kệ|tủ|dao|kéo|chuột|bàn phím/i, reason: 'Công cụ, dụng cụ' },
  { account: '152', pattern: /nguyên liệu|vật liệu|nguyên vật liệu|phụ liệu/i, reason: 'Nguyên liệu, vật liệu' },
  {
    account: '6422',
    pattern: /dịch vụ|phí|cước|điện|nước|internet|viễn thông|thuê|bảo trì|sửa chữa|phần mềm|hosting|tên miền|văn phòng phẩm|tư vấn|kế toán|kiểm toán/i,
    reason: 'Chi phí quản lý doanh nghiệp',
  },
  { account: '156', pattern: /hàng hóa|sản phẩm|hàng/i, reason: 'Hàng hóa' },
];

const ASSET_PATTERN = /máy|thiết bị|xe |ô tô|laptop|máy tính|server|điều hòa/i;

export function suggestDebitAccount(line: InvoiceLine, vendorDefault: string | null): AccountSuggestion {
  if (vendorDefault) return { account: vendorDefault, reason: 'Theo lần duyệt trước của nhà cung cấp này' };
  if (ASSET_PATTERN.test(line.description) && money(line.amount).greaterThanOrEqualTo(FIXED_ASSET_THRESHOLD)) {
    return { account: '211', reason: 'Giá trị từ 30 triệu, có thể là tài sản cố định' };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(line.description)) return { account: rule.account, reason: rule.reason };
  }
  return { account: '6422', reason: 'Mặc định chi phí quản lý doanh nghiệp' };
}

export interface ProposedLine {
  lineNo: number;
  description: string;
  unit: string | null;
  quantity: Money | null;
  unitPrice: Money | null;
  amount: Money;
  vatRate: string | null;
  debitAccount: string;
  reason: string;
}

export interface JournalLineDraft {
  lineNo: number;
  accountCode: string;
  debit: Money;
  credit: Money;
  memo: string;
}

// Lines that carry value for bookkeeping (notes and promotions with no amount are dropped).
export function bookableLines(invoice: ParsedInvoice, vendorDefault: string | null): ProposedLine[] {
  return invoice.lines
    .filter((l) => !money(lineContribution(l)).isZero())
    .map((l) => {
      const suggestion = suggestDebitAccount(l, vendorDefault);
      return {
        lineNo: l.lineNo,
        description: l.description,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: lineContribution(l),
        vatRate: l.vatRate,
        debitAccount: suggestion.account,
        reason: suggestion.reason,
      };
    });
}

// Purchase on credit: Dr expense/inventory lines, Dr input VAT, Cr payable (331) for the total.
export function buildPurchaseJournal(lines: ProposedLine[], vatTotal: Money, memo: string): JournalLineDraft[] {
  const byAccount = new Map<string, ReturnType<typeof money>>();
  for (const line of lines) {
    byAccount.set(line.debitAccount, (byAccount.get(line.debitAccount) ?? money(0)).plus(money(line.amount)));
  }
  const drafts: JournalLineDraft[] = [];
  let lineNo = 1;
  for (const [account, value] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (value.isZero()) continue;
    drafts.push(value.isNegative()
      ? { lineNo: lineNo++, accountCode: account, debit: '0', credit: toMoney(value.negated()), memo }
      : { lineNo: lineNo++, accountCode: account, debit: toMoney(value), credit: '0', memo });
  }
  const vat = money(vatTotal);
  const assetVat = fixedAssetVat(lines, vat);
  for (const [account, value] of [[VAT_INPUT_GOODS, vat.minus(assetVat)], [VAT_INPUT_ASSETS, assetVat]] as const) {
    if (value.isZero()) continue;
    drafts.push(value.isNegative()
      ? { lineNo: lineNo++, accountCode: account, debit: '0', credit: toMoney(value.negated()), memo: `Thuế GTGT ${memo}` }
      : { lineNo: lineNo++, accountCode: account, debit: toMoney(value), credit: '0', memo: `Thuế GTGT ${memo}` });
  }
  const net = sum(drafts.map((d) => money(d.debit).minus(money(d.credit))));
  if (!net.isZero()) {
    drafts.push(net.isPositive()
      ? { lineNo: lineNo++, accountCode: PAYABLE_ACCOUNT, debit: '0', credit: toMoney(net), memo }
      : { lineNo: lineNo++, accountCode: PAYABLE_ACCOUNT, debit: toMoney(net.negated()), credit: '0', memo });
  }
  return drafts;
}

// The VAT percent of a rate text (see parseVatRate); exempt, untaxed and unreadable rates count as 0.
export function vatPercent(rate: string | null): number {
  const parsed = parseVatRate(rate);
  return parsed.kind === 'unknown' ? 0 : Number(parsed.percent?.toFixed() ?? 0);
}

// Input VAT on fixed assets goes to 1332, the rest to 1331. For a mixed invoice the asset share is
// estimated from each asset line's rate, rounded to whole VND and capped at the invoice VAT.
export function fixedAssetVat(lines: Array<Pick<ProposedLine, 'debitAccount' | 'amount' | 'vatRate'>>, vat: ReturnType<typeof money>) {
  const assets = lines.filter((l) => isFixedAssetAccount(l.debitAccount));
  if (assets.length === 0 || vat.isZero()) return money(0);
  if (assets.length === lines.length) return vat;
  const estimate = sum(assets.map((l) => money(l.amount).times(vatPercent(l.vatRate)).dividedBy(100))).toDecimalPlaces(0);
  return vat.isPositive() ? minOf(maxOf(estimate, money(0)), vat) : maxOf(minOf(estimate, money(0)), vat);
}

function minOf(a: ReturnType<typeof money>, b: ReturnType<typeof money>) {
  return a.lessThan(b) ? a : b;
}

function maxOf(a: ReturnType<typeof money>, b: ReturnType<typeof money>) {
  return a.greaterThan(b) ? a : b;
}

// Sales e-invoices (issue #313): the org is the seller. TT133 posts a sale on credit as Dr 131 (receivable from the
// customer) for the total, Cr 511 (revenue) for the goods and services, Cr 3331 (output VAT) for the tax.
export const RECEIVABLE_ACCOUNT = '131';
export const REVENUE_ACCOUNT = '511';
export const VAT_OUTPUT = '3331';

// Every line of a sale is proposed to 511; the accountant may pick a sub-account (5111 goods, 5113 services) per line.
export function bookableSaleLines(invoice: ParsedInvoice): ProposedLine[] {
  return bookableLines(invoice, REVENUE_ACCOUNT).map((l) => ({ ...l, reason: 'Doanh thu bán hàng và cung cấp dịch vụ' }));
}

// Sale on credit: Cr revenue per account (a net discount becomes a debit), Cr output VAT, Dr receivable (131) for the
// total. `debitAccount` of a sale line is the account the line is posted to, here a revenue (credit) account.
export function buildSalesJournal(lines: ProposedLine[], vatTotal: Money, memo: string): JournalLineDraft[] {
  const byAccount = new Map<string, ReturnType<typeof money>>();
  for (const line of lines) {
    byAccount.set(line.debitAccount, (byAccount.get(line.debitAccount) ?? money(0)).plus(money(line.amount)));
  }
  const credits: Array<Omit<JournalLineDraft, 'lineNo'>> = [];
  const credit = (account: string, value: ReturnType<typeof money>, text: string) => {
    if (value.isZero()) return;
    credits.push(value.isNegative()
      ? { accountCode: account, debit: toMoney(value.negated()), credit: '0', memo: text }
      : { accountCode: account, debit: '0', credit: toMoney(value), memo: text });
  };
  for (const [account, value] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) credit(account, value, memo);
  credit(VAT_OUTPUT, money(vatTotal), `Thuế GTGT ${memo}`);
  // The receivable comes first, as an accountant writes a sale.
  const net = sum(credits.map((d) => money(d.credit).minus(money(d.debit))));
  const receivable: Array<Omit<JournalLineDraft, 'lineNo'>> = net.isZero()
    ? []
    : [net.isPositive()
        ? { accountCode: RECEIVABLE_ACCOUNT, debit: toMoney(net), credit: '0', memo }
        : { accountCode: RECEIVABLE_ACCOUNT, debit: '0', credit: toMoney(net.negated()), memo }];
  return [...receivable, ...credits].map((d, i) => ({ lineNo: i + 1, ...d }));
}

export function journalIsBalanced(lines: JournalLineDraft[]): boolean {
  return sum(lines.map((l) => money(l.debit).minus(money(l.credit)))).isZero() && lines.length >= 2;
}
