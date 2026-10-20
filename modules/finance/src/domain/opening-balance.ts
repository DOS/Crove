// Opening balances (issue #320), as pure functions: a trial balance at a date, read from the Excel template, checked
// row by row and as a whole, and turned into the lines of one opening entry. The command (../opening-balance.ts)
// supplies the chart of accounts and the facts of the ledger; it never posts what this refuses.
// Amounts are whole VND (no decimals), parsed with decimal.js, never JS numbers.
import type { OpeningBalanceImport, OpeningBalancePreview, OpeningEntryError, OpeningRowError } from '@crove/kernel-contract';
import { Decimal, parseTaxCode, type DecimalValue, type Money } from '@crove/l10n-vn';
import { AMOUNT_LIMIT, canonical, checkAmount, MoneyError } from './money.ts';

export const OPENING_BALANCE_SOURCE = 'finance.opening_balance';
export const OPENING_BALANCE_CURRENCY = 'VND';

// An account of the org's chart, as the check needs it.
export interface OpeningChartAccount {
  code: string;
  name: string;
  active: boolean;
}

export interface LedgerFacts {
  // The opening entry in force (not reversed), if any.
  openingEntry: { id: string; entryDate: string } | null;
  // The earliest entry that is not an opening entry or the reversal of one.
  firstEntryDate: string | null;
}

// The customer or vendor of a 131 or 331 row (#689): found or created by tax code, or by name when it has none.
export interface OpeningParty {
  taxCode: string | null;
  name: string;
}

export interface OpeningLine {
  lineNo: number;
  accountCode: string;
  debit: Money;
  credit: Money;
  party: OpeningParty | null;
}

// Receivables and payables, with their sub-accounts: the accounts a party balance is kept on, as the ledger's
// per-party report and the bank suggestions read them.
const PARTY_ACCOUNTS = ['131', '331'];
export const isPartyAccount = (code: string) => PARTY_ACCOUNTS.some((root) => code.startsWith(root));

type PartyRead = { party: OpeningParty | null; taxCode: string | null; name: string | null; error: 'PARTY_TAX_CODE_INVALID' | null };

// The party cells of a row: none when both are empty. A tax code is normalized like an invoice's; a name alone
// stands for a party without one.
function readParty(row: OpeningBalanceImport['rows'][number]): PartyRead {
  const rawCode = row.partyTaxCode?.trim() ?? '';
  const name = row.partyName?.trim().replace(/\s+/g, ' ') ?? '';
  if (rawCode === '' && name === '') return { party: null, taxCode: null, name: null, error: null };
  if (rawCode === '') return { party: { taxCode: null, name }, taxCode: null, name, error: null };
  const parsed = parseTaxCode(rawCode);
  if (!parsed) return { party: null, taxCode: rawCode, name: name || null, error: 'PARTY_TAX_CODE_INVALID' };
  return { party: { taxCode: parsed.normalized, name }, taxCode: parsed.normalized, name: name || null, error: null };
}

// Two rows name the same party when their tax codes match, or, without one, their names do (case aside).
const partyKey = (party: OpeningParty | null) => (party === null ? '' : party.taxCode ? `t:${party.taxCode}` : `n:${party.name.toLocaleLowerCase('vi')}`);

export interface OpeningCheck {
  preview: OpeningBalancePreview;
  lines: OpeningLine[];
}

// A plain decimal, optionally with an exponent: the value of a number cell (Excel writes 1E+16 for large ones) or a
// text cell after normalizeAmountText. The exponent is bounded, so the parse stays cheap.
const PLAIN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d{1,4})?$/;

export type AmountResult = { ok: true; value: Money } | { ok: false; error: Extract<OpeningRowError, `AMOUNT_${string}`> };

// One amount cell: empty is zero; otherwise a non-negative whole number of VND that fits an amount column.
export function parseOpeningAmount(raw: string): AmountResult {
  const text = raw.trim();
  if (text === '') return { ok: true, value: '0' };
  if (!PLAIN.test(text)) return { ok: false, error: 'AMOUNT_INVALID' };
  const value: DecimalValue = new Decimal(text);
  if (value.isZero()) return { ok: true, value: '0' };
  if (value.isNegative()) return { ok: false, error: 'AMOUNT_NEGATIVE' };
  // Size before scale, so a huge exponent is never expanded into digits.
  if (value.greaterThanOrEqualTo(AMOUNT_LIMIT)) return { ok: false, error: 'AMOUNT_TOO_LARGE' };
  if (!value.isInteger()) return { ok: false, error: 'AMOUNT_FRACTION' };
  try {
    return { ok: true, value: checkAmount(canonical(value), OPENING_BALANCE_CURRENCY) };
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    return { ok: false, error: error.code === 'AMOUNT_OVERFLOW' ? 'AMOUNT_TOO_LARGE' : 'AMOUNT_INVALID' };
  }
}

const zero = () => new Decimal(0);

// Checks a trial balance and builds the opening entry's lines, in row order: one line per side with an amount, so an
// account with both a debit and a credit balance (receivables from some customers, advances from others) keeps both.
// A row with no amount on either side is skipped without further checks (headings, accounts with no balance).
export function checkOpeningBalance(input: OpeningBalanceImport, chart: ReadonlyMap<string, OpeningChartAccount>, ledger: LedgerFacts): OpeningCheck {
  const rows = input.rows.map((row) => {
    const code = row.accountCode.trim();
    const debit = parseOpeningAmount(row.debit);
    const credit = parseOpeningAmount(row.credit);
    const errors: OpeningRowError[] = [];
    if (!debit.ok) errors.push(debit.error);
    if (!credit.ok && !errors.includes(credit.error)) errors.push(credit.error);
    const skipped = errors.length === 0 && debit.ok && credit.ok && debit.value === '0' && credit.value === '0';
    const account = chart.get(code);
    const party = readParty(row);
    if (!skipped) {
      if (code === '') errors.push('ACCOUNT_MISSING');
      else if (!account) errors.push('ACCOUNT_UNKNOWN');
      else if (!account.active) errors.push('ACCOUNT_INACTIVE');
      if (party.error) errors.push(party.error);
      if ((party.party || party.error) && code !== '' && !isPartyAccount(code)) errors.push('PARTY_NOT_ALLOWED');
    }
    return {
      rowNo: row.rowNo,
      accountCode: code,
      accountName: account?.name ?? row.accountName.trim(),
      debit: debit.ok ? debit.value : null,
      credit: credit.ok ? credit.value : null,
      partyTaxCode: party.taxCode,
      partyName: party.name,
      party: party.party,
      skipped,
      errors,
    };
  });

  // The same account on two rows is ambiguous (a typo, or a sum split by hand): every such row is flagged. A
  // receivable or payable may take one row per party (#689), plus one without a party (the unallocated rest).
  const key = (row: (typeof rows)[number]) => `${row.accountCode}|${partyKey(row.party)}`;
  const counts = new Map<string, number>();
  for (const row of rows) if (!row.skipped && row.accountCode !== '') counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  for (const row of rows) if (!row.skipped && (counts.get(key(row)) ?? 0) > 1) row.errors.push('ACCOUNT_DUPLICATE');

  let debitTotal = zero();
  let creditTotal = zero();
  for (const row of rows) {
    if (row.debit !== null) debitTotal = debitTotal.plus(row.debit);
    if (row.credit !== null) creditTotal = creditTotal.plus(row.credit);
  }

  const lines: OpeningLine[] = [];
  for (const row of rows) {
    if (row.skipped || row.debit === null || row.credit === null) continue;
    if (row.debit !== '0') lines.push({ lineNo: lines.length + 1, accountCode: row.accountCode, debit: row.debit, credit: '0', party: row.party });
    if (row.credit !== '0') lines.push({ lineNo: lines.length + 1, accountCode: row.accountCode, debit: '0', credit: row.credit, party: row.party });
  }

  const errors: OpeningEntryError[] = [];
  if (rows.every((r) => r.skipped)) errors.push('NO_BALANCES');
  else if (!debitTotal.equals(creditTotal)) errors.push('UNBALANCED');
  if (ledger.openingEntry) errors.push('OPENING_EXISTS');
  // Both are YYYY-MM-DD, so string order is date order. The opening balances are as at the end of asOf, so every
  // other entry must come on a later day.
  if (ledger.firstEntryDate !== null && ledger.firstEntryDate <= input.asOf) errors.push('AFTER_ENTRIES');

  const ok = errors.length === 0 && rows.every((r) => r.errors.length === 0);
  return {
    preview: {
      asOf: input.asOf,
      rows: rows.map(({ party: _party, ...row }) => row),
      totals: { debit: canonical(debitTotal), credit: canonical(creditTotal), difference: canonical(debitTotal.minus(creditTotal)) },
      errors,
      openingEntry: ledger.openingEntry,
      firstEntryDate: ledger.firstEntryDate,
      lines: ok ? lines.length : 0,
      ok,
    },
    lines: ok ? lines : [],
  };
}
