// Proof of non-cash payment for deducting input VAT (#917). A purchase at or above a threshold, VAT included, may have
// its input VAT deducted only with a non-cash payment document. Sources, from the published summaries of the texts
// and not checked against the texts themselves; the partner's accountant must confirm the figures and dates (#61):
// - from 2025-07-01: 5 million VND, Law on VAT No. 48/2024/QH15 (deduction of input VAT, Article 14) and its Decree
//   181/2025/ND-CP;
// - before: 20 million VND, Circular 219/2013/TT-BTC, Article 15.
// The threshold applies per invoice by its invoice date. Several invoices from one seller on one day that add up past
// the threshold, which the rules also catch, are left to the accountant.
import { money, type Money } from '@crove/l10n-vn';

export interface NonCashThreshold {
  // First invoice date the threshold applies to; null for the earliest rule.
  from: string | null;
  amount: Money;
  source: string;
}

// Newest first. A new rule goes on top with its effective date.
export const NON_CASH_THRESHOLDS: readonly NonCashThreshold[] = [
  { from: '2025-07-01', amount: '5000000', source: 'Law on VAT 48/2024/QH15 Art. 14; Decree 181/2025/ND-CP' },
  { from: null, amount: '20000000', source: 'Circular 219/2013/TT-BTC Art. 15' },
];

export function nonCashThreshold(invoiceDate: string, rules: readonly NonCashThreshold[] = NON_CASH_THRESHOLDS): NonCashThreshold {
  const rule = rules.find((r) => r.from === null || r.from <= invoiceDate);
  if (!rule) throw new Error(`no non-cash payment threshold for ${invoiceDate}`);
  return rule;
}

// How the invoice says it was paid (HTTToan of the e-invoice, free text): bank when it names only a non-cash way, cash
// when it names only cash, unknown otherwise (empty, both, offsetting, anything else), which the accountant checks.
export type PaymentMethodKind = 'bank' | 'cash' | 'unknown';

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();

const CASH = new Set(['tm', 'tien mat']);
const BANK = new Set(['ck', 'chuyen khoan', 'chuyen khoan ngan hang', 'ngan hang', 'the', 'quet the', 'the ngan hang', 'nh']);

export function paymentMethodKind(method: string | null): PaymentMethodKind {
  if (!method) return 'unknown';
  const parts = fold(method)
    .split(/[/,;+&]|\bhoac\b|\bva\b/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return 'unknown';
  if (parts.every((p) => BANK.has(p))) return 'bank';
  if (parts.every((p) => CASH.has(p))) return 'cash';
  return 'unknown';
}

// Whether an input invoice needs proof of non-cash payment checked: at or above the threshold of its date and not
// shown as paid by bank.
export function needsPaymentCheck(invoice: { issueDate: string; total: Money; paymentMethod: string | null }, rules?: readonly NonCashThreshold[]): boolean {
  const threshold = nonCashThreshold(invoice.issueDate, rules);
  return money(invoice.total).greaterThanOrEqualTo(money(threshold.amount)) && paymentMethodKind(invoice.paymentMethod) !== 'bank';
}
