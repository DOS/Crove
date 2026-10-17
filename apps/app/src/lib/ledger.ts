// The ledger reports screen's period picker (issue #321): a month ("2026-09"), a quarter ("2026-Q3") or a year
// ("2026"). Months and quarters work as on the VAT screen (lib/vat.ts); the server checks the period again
// (zLedgerPeriod). The default is the month before the one containing today, the month the accountant checks.
import { defaultPeriod, periodKey, switchKind } from './vat.ts';

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

// A signed balance (debit minus credit) as its side and its size: positive is a debit balance.
export function balanceSide(balance: string): { side: 'debit' | 'credit' | null; amount: string } {
  const negative = balance.startsWith('-');
  const amount = negative ? balance.slice(1) : balance;
  if (/^0(\.0*)?$/.test(amount)) return { side: null, amount: '0' };
  return { side: negative ? 'credit' : 'debit', amount };
}
