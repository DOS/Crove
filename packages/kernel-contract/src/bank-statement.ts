// Bank statement import (issue #326, ADR-0021 section 6): the lines of a bank's Excel or CSV export, read in the
// browser and sent as plain strings, then checked and deduplicated by the finance module. The module decides every
// rule; the SPA only finds the columns and shows the answer.
import { z } from 'zod';
import { zVoucherCode } from './cash-voucher.ts';
import { zAccountCode, zId, zLocalDate, zMoney, zVoucherAmount, zVoucherType } from './schemas.ts';

// A month of a busy account has a few thousand lines; the cap keeps a request well under the API's body limit.
export const BANK_IMPORT_MAX_ROWS = 5000;

// One line of the file as read, cells as text: a number cell's stored value as is (an Excel date is its serial
// number), a text cell as typed. moneyIn is the statement's credit ("ghi có"), moneyOut its debit ("ghi nợ"); a file
// with one signed amount column sends it as moneyIn. balance and reference are '' when the file has no such column.
// rowNo is the file's row number, for messages.
export const zBankStatementRow = z.object({
  rowNo: z.number().int().positive(),
  date: z.string().max(40),
  description: z.string().max(1000),
  moneyIn: z.string().max(50),
  moneyOut: z.string().max(50),
  balance: z.string().max(50),
  reference: z.string().max(100),
});
export type BankStatementRow = z.infer<typeof zBankStatementRow>;

export const zBankStatementImport = z.object({
  // A bank account of the org: a 112 account or a sub-account under one.
  bankAccount: zAccountCode,
  filename: z.string().max(200),
  rows: z.array(zBankStatementRow).min(1).max(BANK_IMPORT_MAX_ROWS),
  // The legal entity whose books the lines go to (#1280), as in zLegalEntityChoice.
  legalEntityId: zId.optional(),
});
export type BankStatementImport = z.infer<typeof zBankStatementImport>;

export const BANK_ROW_ERRORS = [
  // Not a day: dd/mm/yyyy (a time may follow), yyyy-mm-dd, or an Excel date.
  'DATE_INVALID',
  // Not a number, negative where a side is expected, more than 2 decimals, or too large.
  'AMOUNT_INVALID',
  // Neither money in nor money out.
  'AMOUNT_MISSING',
  // Both money in and money out on one line.
  'AMOUNT_BOTH',
  'BALANCE_INVALID',
] as const;
export type BankRowError = (typeof BANK_ROW_ERRORS)[number];

// new: stored by the import. duplicate: the account already has this line (same reference, or same date, amount,
// balance and occurrence), or the file repeats it. ambiguous: no reference and no balance, and an earlier import has a
// line of the same date and amount; stored, flagged for a person to decide.
export const BANK_LINE_STATUSES = ['new', 'duplicate', 'ambiguous'] as const;
export type BankLineStatus = (typeof BANK_LINE_STATUSES)[number];

export const zBankImportPreview = z.object({
  bankAccount: z.string(),
  // The file's order as found: statements list either the oldest or the newest line first.
  order: z.enum(['oldest_first', 'newest_first']),
  rows: z.array(
    z.object({
      rowNo: z.number().int().positive(),
      date: zLocalDate.nullable(),
      description: z.string(),
      // Signed: money in positive, money out negative. Null when the row has an amount error.
      amount: zMoney.nullable(),
      balance: zMoney.nullable(),
      reference: z.string().nullable(),
      // Null for a row with errors.
      status: z.enum(BANK_LINE_STATUSES).nullable(),
      errors: z.array(z.enum(BANK_ROW_ERRORS)),
    }),
  ),
  counts: z.object({
    new: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
  // Where the account's running balance would not follow from the lines once these are stored: the line's balance
  // is not the balance before it plus its amount. rowNo is the file row, or null for a line stored earlier. A break
  // means a line is missing, doubled or out of order; the import goes ahead and the screen shows it.
  breaks: z.array(z.object({ date: zLocalDate, rowNo: z.number().int().positive().nullable(), expected: zMoney, balance: zMoney })),
  from: zLocalDate.nullable(),
  to: zLocalDate.nullable(),
  // No row has an error: the import can go ahead.
  ok: z.boolean(),
});
export type BankImportPreview = z.infer<typeof zBankImportPreview>;

export const zBankImportResult = z.object({
  importId: zId,
  counts: zBankImportPreview.shape.counts,
  breaks: zBankImportPreview.shape.breaks,
});
export type BankImportResult = z.infer<typeof zBankImportResult>;

// A batch of bank transactions from a feed (ADR-0039, #2044): one bank account of one legal entity, each line as the
// provider reports it, in any order. The finance module checks and stores them as it does a statement's lines
// (ADR-0021 section 6). Every line carries the bank's reference, which makes its key: a feed pulls overlapping windows
// and may start mid-day, where the balance key's occurrence count would store a line twice or drop one, so a line
// without a reference is not a feed line. An adapter maps the bank's own reference (the one statement files print),
// so a transaction that comes again, from the feed or in a file, is stored once. The worker sends it
// (finance.bank.ingest, a system command); people never do.
export const BANK_FEED_MAX_LINES = 5000;
export const zBankFeedLine = z.object({
  date: zLocalDate,
  description: z.string().max(1000),
  // Signed: money in positive, money out negative; at most 2 decimals, never zero.
  amount: zMoney,
  balance: zMoney.nullable(),
  reference: z.string().trim().min(1).max(100),
});
export type BankFeedLine = z.infer<typeof zBankFeedLine>;
export const zBankFeedIngest = z.strictObject({
  bankAccount: zAccountCode,
  legalEntityId: zId,
  // The adapter the lines came from, as a channel connection names its provider (ADR-0025).
  source: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  lines: z.array(zBankFeedLine).min(1).max(BANK_FEED_MAX_LINES),
});
export type BankFeedIngest = z.infer<typeof zBankFeedIngest>;

// What became of a statement line (#326, stage 2a): nothing yet, a báo Có or báo Nợ proposal waiting for approval, or
// the posted voucher that settles it. A voucher whose entry was reversed settles nothing, so its line is open again.
export const zBankLineState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open') }),
  z.object({ status: z.literal('proposed'), proposalId: zId }),
  z.object({ status: z.literal('matched'), voucherId: zId, code: zVoucherCode }),
]);
export type BankLineState = z.infer<typeof zBankLineState>;

export const zBankLine = z.object({
  id: zId,
  date: zLocalDate,
  description: z.string(),
  amount: zMoney,
  balance: zMoney.nullable(),
  reference: z.string().nullable(),
  ambiguous: z.boolean(),
  importId: zId,
  state: zBankLineState,
});
export type BankLine = z.infer<typeof zBankLine>;

// The stored lines of one bank account for a period, oldest first.
export const zBankLines = z.object({
  bankAccount: z.string(),
  from: zLocalDate,
  to: zLocalDate,
  lines: z.array(zBankLine),
  // Money in and out over the period.
  moneyIn: zMoney,
  moneyOut: zMoney,
});
export type BankLines = z.infer<typeof zBankLines>;

// Why a party is suggested for a statement line, strongest first (finance domain/bank-match.ts): its tax code is in the
// description; an invoice of the line's amount is named there; its name is there; its open balance equals the amount.
export const BANK_MATCH_REASONS = ['tax_code', 'invoice', 'name', 'balance'] as const;
export type BankMatchReason = (typeof BANK_MATCH_REASONS)[number];

export const zBankLineCandidate = z.object({
  party: z.object({ id: zId, name: z.string(), taxCode: z.string().nullable() }),
  reason: z.enum(BANK_MATCH_REASONS),
  invoice: z.object({ series: z.string(), number: z.string() }).optional(),
});
export type BankLineCandidate = z.infer<typeof zBankLineCandidate>;

// The báo Có or báo Nợ a statement line makes (finance.bank.line_voucher), for the voucher form: the line, the voucher's
// fixed fields (type, date, bank account and amount follow the line) and the party suggested, if one stands out.
// voucher is null when the line cannot make one: an amount with fractions of a dong.
export const zBankLineVoucher = z.object({
  bankAccount: zAccountCode,
  line: zBankLine,
  voucher: z
    .object({
      type: zVoucherType,
      date: zLocalDate,
      amount: zVoucherAmount,
      // Lý do: the statement's description, cut to what a voucher holds.
      description: z.string().min(1).max(300),
      // 131 for money in, 331 for money out.
      counterAccount: zAccountCode,
    })
    .nullable(),
  suggested: zBankLineCandidate.nullable(),
  candidates: z.array(zBankLineCandidate),
});
export type BankLineVoucher = z.infer<typeof zBankLineVoucher>;

// The open statement lines of each bank account (no voucher, none waiting for approval), which the Inbox lists as lines
// to resolve (#326, stage 2b): how many, how many were flagged as ambiguous at import, and the oldest one's date.
export const zBankOpenLines = z.object({
  accounts: z.array(z.object({ bankAccount: z.string(), open: z.number().int().nonnegative(), ambiguous: z.number().int().nonnegative(), oldest: zLocalDate })),
});
export type BankOpenLines = z.infer<typeof zBankOpenLines>;

// A text cell of an amount as banks print them, made plain for the module. Spaces, a "VND", "đ" or "₫" suffix and a
// leading "+" are dropped; "" or "-" means none. With both "." and "," the one written last is the decimal point
// ("1,500,000.50", "1.500.000,50"). With one kind only, groups of three are thousands ("1.500.000", "1,500"), and a
// lone comma followed by other than three digits is a decimal comma ("1,5"). Anything else is returned compacted for
// the module to judge. Number cells never go through this: their stored value is sent as it is.
const STATEMENT_GROUPED = /^-?[1-9]\d{0,2}(?:([.,])\d{3})(?:\1\d{3})*$/;
export function normalizeStatementAmount(text: string): string {
  let compact = text.replace(/[\s  ]/g, '').replace(/(?:VND|VNĐ|đ|₫)$/i, '');
  if (compact.startsWith('+')) compact = compact.slice(1);
  if (compact === '' || compact === '-') return '';
  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    return compact.split(group).join('').replace(decimal, '.');
  }
  if (STATEMENT_GROUPED.test(compact)) return compact.replace(/[.,]/g, '');
  if (lastComma >= 0 && compact.indexOf(',') === lastComma) return compact.replace(',', '.');
  return compact;
}
