// The ledger reports screen's period picker (issue #321): a month ("2026-09"), a quarter ("2026-Q3") or a year
// ("2026"). Months and quarters work as on the VAT screen (lib/vat.ts); the server checks the period again
// (zLedgerPeriod). The default is the month before the one containing today, the month the accountant checks.
import { z } from 'zod';
import { readSearch, type Defined } from './search.ts';
import { defaultPeriod, periodChoiceOf, periodKey, switchKind, yearOptions } from './vat.ts';

export type LedgerPeriodKind = 'month' | 'quarter' | 'year';

export interface LedgerPeriodChoice {
  kind: LedgerPeriodKind;
  year: number;
  // 1-12 for a month, 1-4 for a quarter; unused for a year.
  index: number;
}

export function ledgerPeriodKey(choice: LedgerPeriodChoice): string {
  return choice.kind === 'year' ? String(choice.year) : periodKey({ kind: choice.kind, year: choice.year, index: choice.index });
}

export function defaultLedgerPeriod(today: Date = new Date()): LedgerPeriodChoice {
  return defaultPeriod('month', today);
}

// The same time seen as another kind: a month becomes its quarter, a quarter its first month, and a year its first
// month or quarter.
export function switchLedgerKind(choice: LedgerPeriodChoice, kind: LedgerPeriodKind): LedgerPeriodChoice {
  if (kind === choice.kind) return choice;
  if (kind === 'year') return { kind, year: choice.year, index: 1 };
  if (choice.kind === 'year') return { kind, year: choice.year, index: 1 };
  return switchKind({ kind: choice.kind, year: choice.year, index: choice.index }, kind);
}

// A period key as the address carries it, read back into a choice (#1513): a year, a quarter or a month the pickers
// offer, else null.
export function ledgerChoiceOf(key: string, today: Date = new Date()): LedgerPeriodChoice | null {
  if (!/^\d{4}$/.test(key)) return periodChoiceOf(key, today);
  const year = Number(key);
  return yearOptions(today).includes(year) ? { kind: 'year', year, index: 1 } : null;
}

export const LEDGER_TABS = ['trialBalance', 'generalLedger', 'parties', 'statements'] as const;
export type LedgerTab = (typeof LEDGER_TABS)[number];

// The router reads a digits-only value as a number (?period=2026 or ?account=1121 typed by hand), so a whole number
// counts as its digits.
const digitsOrText = z.union([z.string(), z.int().nonnegative().transform(String)]);

// ?period=&report=&account= of the ledger screen (#1513): the period, the tab and the general ledger's account, each
// left out for its default (the month before this one, the trial balance, the period's first account). Not ?tab=, which
// the Social screen's search reducer types for its own tabs.
const zLedgerSearch = z.object({
  period: digitsOrText.refine((key) => ledgerChoiceOf(key) !== null).optional().catch(undefined),
  report: z.enum(LEDGER_TABS).optional().catch(undefined),
  account: digitsOrText.refine((code) => /^[0-9A-Za-z._-]{3,50}$/.test(code)).optional().catch(undefined),
});
export type LedgerSearch = Defined<z.output<typeof zLedgerSearch>>;
export const parseLedgerSearch = (search: Record<string, unknown>): LedgerSearch => readSearch(zLedgerSearch, search);

// A signed balance (debit minus credit) as its side and its size: positive is a debit balance.
export function balanceSide(balance: string): { side: 'debit' | 'credit' | null; amount: string } {
  const negative = balance.startsWith('-');
  const amount = negative ? balance.slice(1) : balance;
  if (/^0(\.0*)?$/.test(amount)) return { side: null, amount: '0' };
  return { side: negative ? 'credit' : 'debit', amount };
}
