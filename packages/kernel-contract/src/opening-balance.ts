// Opening balances from Excel (issue #320): the trial balance at a date, read from the template in the browser and
// sent as plain strings, checked by the finance module and posted as one opening entry. The module decides every rule;
// the SPA only shows the answer.
import { z } from 'zod';
import { zId, zLocalDate, zMoney } from './schemas.ts';

// A trial balance of a small firm has tens to a few hundred accounts; the cap keeps a request well under the API's
// body limit.
export const OPENING_BALANCE_MAX_ROWS = 1000;

// One row of the sheet as read, cells as text. An amount is a number cell's stored value as is, or a text cell after
// normalizeAmountText; the module parses and checks it. rowNo is the sheet's row number, for messages.
// The party (#689) is optional and only for receivables (131) and payables (331) rows: a customer or vendor by tax
// code, or by name when it has none. A template without the party columns sends neither.
export const zOpeningBalanceRow = z.object({
  rowNo: z.number().int().positive(),
  accountCode: z.string().max(50),
  accountName: z.string().max(200),
  debit: z.string().max(50),
  credit: z.string().max(50),
  partyTaxCode: z.string().max(50).optional(),
  partyName: z.string().max(200).optional(),
});
export type OpeningBalanceRow = z.infer<typeof zOpeningBalanceRow>;

export const zOpeningBalanceImport = z.object({
  // The balances as at the end of this day; the entry is dated on it.
  asOf: zLocalDate,
  rows: z.array(zOpeningBalanceRow).max(OPENING_BALANCE_MAX_ROWS),
  // Each legal entity has its own opening entry (#1280): legalEntityId as in zLegalEntityChoice.
  legalEntityId: zId.optional(),
});
export type OpeningBalanceImport = z.infer<typeof zOpeningBalanceImport>;

// Problems of one row. An amount is a whole number of VND, as text or a number cell.
export const OPENING_ROW_ERRORS = [
  // Amounts but no account code.
  'ACCOUNT_MISSING',
  // Not an account of the org's chart of accounts.
  'ACCOUNT_UNKNOWN',
  // An account the org no longer uses.
  'ACCOUNT_INACTIVE',
  // The same account on more than one row (for 131 and 331, the same account and party).
  'ACCOUNT_DUPLICATE',
  // A party on an account that is not a receivable or a payable (131, 331 and their sub-accounts).
  'PARTY_NOT_ALLOWED',
  // A party tax code that is not one (10 digits, 10 digits and a 3-digit branch, or 12 digits).
  'PARTY_TAX_CODE_INVALID',
  // Not a number.
  'AMOUNT_INVALID',
  'AMOUNT_NEGATIVE',
  // VND has no decimals.
  'AMOUNT_FRACTION',
  'AMOUNT_TOO_LARGE',
] as const;
export type OpeningRowError = (typeof OPENING_ROW_ERRORS)[number];

// Problems of the entry as a whole.
export const OPENING_ENTRY_ERRORS = [
  // No row has an amount.
  'NO_BALANCES',
  // Total debit and total credit differ.
  'UNBALANCED',
  // The org already has an opening entry that is not reversed.
  'OPENING_EXISTS',
  // Other entries are dated on or before the date: the opening balances must come first.
  'AFTER_ENTRIES',
] as const;
export type OpeningEntryError = (typeof OPENING_ENTRY_ERRORS)[number];

const zWholeAmount = z.string().regex(/^-?\d{1,24}$/, 'whole amount');

export const zOpeningBalancePreview = z.object({
  asOf: zLocalDate,
  rows: z.array(
    z.object({
      rowNo: z.number().int().positive(),
      accountCode: z.string(),
      // The name in the chart of accounts, or the one in the file when the code is not in the chart.
      accountName: z.string(),
      // Parsed amounts, or null when the cell is not a valid amount.
      debit: zMoney.nullable(),
      credit: zMoney.nullable(),
      // The row's party as read (#689): the tax code normalized when it is valid, as written otherwise.
      partyTaxCode: z.string().nullable(),
      partyName: z.string().nullable(),
      // No amount on either side: the row is left out of the entry.
      skipped: z.boolean(),
      errors: z.array(z.enum(OPENING_ROW_ERRORS)),
    }),
  ),
  // Whole VND. Each amount fits an amount column, but their sum over many rows may not, so no 16-digit limit here.
  totals: z.object({ debit: zWholeAmount, credit: zWholeAmount, difference: zWholeAmount }),
  errors: z.array(z.enum(OPENING_ENTRY_ERRORS)),
  // The opening entry in force (not reversed), which must be reversed before another is posted.
  openingEntry: z.object({ id: zId, entryDate: zLocalDate }).nullable(),
  // The earliest entry that is not an opening entry or its reversal.
  firstEntryDate: zLocalDate.nullable(),
  // The number of journal lines the entry would have.
  lines: z.number().int().nonnegative(),
  ok: z.boolean(),
});
export type OpeningBalancePreview = z.infer<typeof zOpeningBalancePreview>;

// A text cell as people type amounts in Vietnam: spaces and thousands separators ("1.500.000", "1,500,000",
// "1 500 000") are dropped, since VND has no decimals; a lone "-" means none. Anything else is returned compacted for
// the module to judge ("1.5" is refused there as a fraction, "1,5" as not a number). Number cells never go through
// this: their stored value is sent as it is, so 1.125 stays a fraction instead of becoming 1125.
// The first group has no leading zero: "0.500" is a fraction, not five hundred.
const GROUPED = /^[1-9]\d{0,2}(?:([.,])\d{3})(?:\1\d{3})*$/;
export function normalizeAmountText(text: string): string {
  const compact = text.replace(/[\s  ]/g, '');
  if (compact === '' || compact === '-') return '';
  return GROUPED.test(compact) ? compact.replace(/[.,]/g, '') : compact;
}
