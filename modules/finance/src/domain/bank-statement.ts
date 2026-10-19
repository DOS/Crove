// Bank statement import (issue #326, ADR-0021 section 6), as pure functions: the rows of a bank's export are parsed
// (dates, signed amounts, balances, references), put oldest first, given their dedupe keys, classified against what
// the account already has, and checked for breaks in the running balance. The command (../bank.ts) supplies the
// stored facts and inserts what this calls new or ambiguous; the database's unique key on (account, dedupe_key) is the
// last word on duplicates.
// Amounts go through decimal.js, never JS numbers.
import { isCalendarDate, type BankImportPreview, type BankLineStatus, type BankRowError, type BankStatementImport } from '@crove/kernel-contract';
import { Decimal, type DecimalValue, type Money } from '@crove/l10n-vn';
import { AMOUNT_LIMIT } from './money.ts';

// A row that parsed: position is its place in the file once put oldest first (1-based).
export interface StatementLine {
  rowNo: number;
  position: number;
  date: string;
  description: string;
  // Signed: money in positive, money out negative.
  amount: Money;
  balance: Money | null;
  reference: string | null;
}

// What the account already has, as the classification needs it: the dedupe keys among the file's keys, and the date
// and amount (`${date}|${amount}`) of its stored lines in the file's date range.
export interface StoredFacts {
  keys: ReadonlySet<string>;
  dateAmounts: ReadonlySet<string>;
}

// A stored line of the account, for the running balance check.
export interface StoredChainLine {
  date: string;
  amount: Money;
  balance: Money | null;
}

const FIRST_DAY = '2000-01-01';
const LAST_DAY = '2099-12-31';
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

function calendarDay(year: string, month: string, day: string): string | null {
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isCalendarDate(iso) && iso >= FIRST_DAY && iso <= LAST_DAY ? iso : null;
}

// A statement date: dd/mm/yyyy (or with "-" or "."), optionally followed by a time, as Vietnamese banks print it;
// yyyy-mm-dd; or an Excel date cell's serial number (days since 1899-12-30, a fraction being the time of day). The
// serial is a count of days, not money, so a JS number is fine for it.
export function parseStatementDate(raw: string): string | null {
  const text = raw.trim();
  const serial = /^(\d{5})(?:\.\d+)?$/.exec(text);
  if (serial?.[1]) {
    const iso = new Date(EXCEL_EPOCH_MS + Number.parseInt(serial[1], 10) * DAY_MS).toISOString().slice(0, 10);
    return iso >= FIRST_DAY && iso <= LAST_DAY ? iso : null;
  }
  const vn = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(text);
  if (vn?.[1] && vn[2] && vn[3]) return calendarDay(vn[3], vn[2], vn[1]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(text);
  if (iso?.[1] && iso[2] && iso[3]) return calendarDay(iso[1], iso[2], iso[3]);
  return null;
}

// A plain decimal, optionally with an exponent: a number cell's stored value or a text cell after
// normalizeStatementAmount. The exponent is bounded, so the parse stays cheap.
const PLAIN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/;

// One amount cell: null when empty; at most 2 decimals and within an amount column. Banks print VND whole and foreign
// currencies in cents.
export function parseStatementAmount(raw: string): { ok: true; value: DecimalValue | null } | { ok: false } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (!PLAIN.test(text)) return { ok: false };
  const value: DecimalValue = new Decimal(text);
  // Size before scale, so a huge exponent is never expanded into digits.
  if (value.abs().greaterThanOrEqualTo(AMOUNT_LIMIT) || value.decimalPlaces() > 2) return { ok: false };
  return { ok: true, value };
}

const canonical = (value: DecimalValue) => value.toFixed();

type Parsed = { ok: true; rowNo: number; date: string; description: string; amount: Money; balance: Money | null; reference: string | null } | { ok: false; rowNo: number; errors: BankRowError[] };

function parseRow(row: BankStatementImport['rows'][number]): Parsed {
  const errors: BankRowError[] = [];
  const date = parseStatementDate(row.date);
  if (date === null) errors.push('DATE_INVALID');
  const moneyIn = parseStatementAmount(row.moneyIn);
  const moneyOut = parseStatementAmount(row.moneyOut);
  let amount: DecimalValue | null = null;
  if (!moneyIn.ok || !moneyOut.ok) {
    errors.push('AMOUNT_INVALID');
  } else {
    const credit = moneyIn.value && !moneyIn.value.isZero() ? moneyIn.value : null;
    const debit = moneyOut.value && !moneyOut.value.isZero() ? moneyOut.value : null;
    if (credit && debit) errors.push('AMOUNT_BOTH');
    else if (!credit && !debit) errors.push('AMOUNT_MISSING');
    // A debit column may print its amounts negative; the side decides the sign.
    else amount = credit ?? (debit as DecimalValue).abs().negated();
  }
  const balance = parseStatementAmount(row.balance);
  if (!balance.ok) errors.push('BALANCE_INVALID');
  if (errors.length > 0 || date === null || amount === null || !balance.ok) return { ok: false, rowNo: row.rowNo, errors };
  const reference = row.reference.trim();
  return {
    ok: true,
    rowNo: row.rowNo,
    date,
    description: row.description.trim(),
    amount: canonical(amount),
    balance: balance.value ? canonical(balance.value) : null,
    reference: reference === '' ? null : reference,
  };
}

type Line = Omit<StatementLine, 'position'>;

// Statements list either the oldest or the newest line first. The first and last dates tell; on a single day the
// running balance does (each line's balance is the previous one plus its amount, read in the right direction).
export function statementOrder(lines: readonly Line[]): 'oldest_first' | 'newest_first' {
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last || first.date < last.date) return 'oldest_first';
  if (first.date > last.date) return 'newest_first';
  let forward = 0;
  let backward = 0;
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1] as Line;
    const b = lines[i] as Line;
    if (a.balance === null || b.balance === null) continue;
    if (new Decimal(a.balance).plus(b.amount).equals(b.balance)) forward++;
    if (new Decimal(b.balance).plus(a.amount).equals(a.balance)) backward++;
  }
  return backward > forward ? 'newest_first' : 'oldest_first';
}

// The dedupe key of each line, oldest first (ADR-0021 section 6): ref:<reference>; else, with a balance,
// bal:<date>|<amount>|<balance>|<n>, n counting the earlier lines of the file with the same date, amount and balance
// (so "+X, -X, +X" on one day keeps both +X lines, and an overlapping re-import gives each the same key again); else
// null.
export function dedupeKeys(lines: readonly Line[]): Array<string | null> {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    if (line.reference) return `ref:${line.reference}`;
    if (line.balance === null) return null;
    const tuple = `${line.date}|${line.amount}|${line.balance}`;
    const n = seen.get(tuple) ?? 0;
    seen.set(tuple, n + 1);
    return `bal:${tuple}|${n}`;
  });
}

// new, duplicate (the account or the file already has the key) or ambiguous (no key, and a stored line has the same
// date and amount). Identical lines without a key inside one file are all new: each has its own place in the file.
export function classify(lines: readonly Line[], keys: ReadonlyArray<string | null>, stored: StoredFacts): BankLineStatus[] {
  const inFile = new Set<string>();
  return lines.map((line, i) => {
    const key = keys[i] ?? null;
    if (key !== null) {
      if (stored.keys.has(key) || inFile.has(key)) return 'duplicate';
      inFile.add(key);
      return 'new';
    }
    return stored.dateAmounts.has(`${line.date}|${line.amount}`) ? 'ambiguous' : 'new';
  });
}

export interface BalanceBreak {
  date: string;
  rowNo: number | null;
  expected: Money;
  balance: Money;
}

// Walks the account's lines in order and reports each line whose balance is not the previous balance plus its
// amount. A line without a balance carries the running total on; the first balance starts it.
export function balanceBreaks(chain: ReadonlyArray<{ date: string; amount: Money; balance: Money | null; rowNo: number | null }>): BalanceBreak[] {
  const breaks: BalanceBreak[] = [];
  let running = null as DecimalValue | null;
  for (const line of chain) {
    const next: DecimalValue | null = running === null ? null : running.plus(line.amount);
    if (line.balance === null) {
      running = next;
      continue;
    }
    if (next !== null && !next.equals(line.balance)) breaks.push({ date: line.date, rowNo: line.rowNo, expected: canonical(next), balance: line.balance });
    running = new Decimal(line.balance);
  }
  return breaks;
}

export interface StatementCheck {
  preview: BankImportPreview;
  // The lines to store (new and ambiguous), oldest first, with their keys.
  lines: Array<StatementLine & { key: string | null; ambiguous: boolean }>;
  // Every parsed line's key, for looking up the stored ones.
  keys: string[];
}

// The rows of a file, parsed and put oldest first, with their keys. Rows with errors are kept for the preview.
export function readStatement(input: BankStatementImport) {
  const parsed = input.rows.map(parseRow);
  const valid = parsed.filter((p): p is Extract<Parsed, { ok: true }> => p.ok).map(({ ok: _ok, ...line }) => line);
  const order = statementOrder(valid);
  const oldestFirst = order === 'newest_first' ? [...valid].reverse() : valid;
  const keys = dedupeKeys(oldestFirst);
  return { parsed, order, lines: oldestFirst, keys };
}

// The whole check: statuses against the stored facts, and the running balance of the stored lines (`before`: the last
// stored line before the file's first day, then the stored lines of the file's days, in order) followed, day by day, by
// the lines this import stores.
export function checkStatement(input: BankStatementImport, stored: StoredFacts, chain: { before: StoredChainLine | null; within: readonly StoredChainLine[] }): StatementCheck {
  const { parsed, order, lines, keys } = readStatement(input);
  const statuses = classify(lines, keys, stored);
  const byRow = new Map(lines.map((line, i) => [line.rowNo, { line, key: keys[i] ?? null, status: statuses[i] as BankLineStatus }]));
  const rows = parsed.map((p) => {
    if (!p.ok) return { rowNo: p.rowNo, date: null, description: '', amount: null, balance: null, reference: null, status: null, errors: p.errors };
    const found = byRow.get(p.rowNo);
    return { rowNo: p.rowNo, date: p.date, description: p.description, amount: p.amount, balance: p.balance, reference: p.reference, status: found?.status ?? null, errors: [] };
  });
  const toStore = lines
    .map((line, i) => ({ ...line, position: i + 1, key: keys[i] ?? null, status: statuses[i] as BankLineStatus }))
    .filter((line) => line.status !== 'duplicate')
    .map(({ status, ...line }) => ({ ...line, ambiguous: status === 'ambiguous' }));
  // Stored lines first within a day (they came earlier), then this file's, each in order.
  const merged = [
    ...(chain.before ? [{ ...chain.before, rowNo: null, group: 0, seq: -1 }] : []),
    ...chain.within.map((line, seq) => ({ ...line, rowNo: null, group: 0, seq })),
    ...toStore.map((line, seq) => ({ date: line.date, amount: line.amount, balance: line.balance, rowNo: line.rowNo, group: 1, seq })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.group - b.group || a.seq - b.seq));
  const counts = { new: 0, duplicate: 0, ambiguous: 0, invalid: 0 };
  for (const row of rows) {
    if (row.status === null) counts.invalid++;
    else counts[row.status]++;
  }
  const dates = lines.map((l) => l.date);
  return {
    preview: {
      bankAccount: input.bankAccount,
      order,
      rows,
      counts,
      breaks: balanceBreaks(merged),
      from: dates.length > 0 ? (dates.reduce((a, b) => (a < b ? a : b)) as string) : null,
      to: dates.length > 0 ? (dates.reduce((a, b) => (a > b ? a : b)) as string) : null,
      ok: counts.invalid === 0 && lines.length > 0,
    },
    lines: toStore,
    keys: keys.filter((k): k is string => k !== null),
  };
}
