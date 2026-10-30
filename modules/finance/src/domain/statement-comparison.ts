// SPDX-License-Identifier: AGPL-3.0-only
// The periods the financial statements are read against (#2090): B01-DNN's start-of-year column is its balances at the
// end of the previous year, and B02-DNN's comparison column is the same period of the previous year (the only one for a
// year) or, for a month or a quarter, the period right before it as a second choice. A period before the first year
// the ledger accepts (2000, LEDGER_PERIOD_PATTERN) has none, so the column is left out rather than read as zeros.
import { ledgerPeriod, type LedgerPeriod } from './ledger-reports.ts';

const FIRST_YEAR = 2000;

export interface ComparisonPlan {
  // The last day of the previous year: B01's start-of-year balances are the ones at that date.
  startOfYear: string | null;
  // The same month, quarter or year of the previous year.
  lastYear: LedgerPeriod | null;
  // The month or quarter right before this one; a year has none, its previous year is `lastYear`.
  previous: LedgerPeriod | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function comparisonPlan(period: LedgerPeriod): ComparisonPlan {
  const year = Number(period.from.slice(0, 4));
  const earlier = year - 1 >= FIRST_YEAR;
  const suffix = period.period.slice(4);
  const lastYear = earlier ? ledgerPeriod(`${year - 1}${suffix}`) : null;
  let previous: LedgerPeriod | null = null;
  if (period.kind === 'month') {
    const month = Number(suffix.slice(1));
    if (month > 1) previous = ledgerPeriod(`${year}-${pad(month - 1)}`);
    else if (earlier) previous = ledgerPeriod(`${year - 1}-12`);
  } else if (period.kind === 'quarter') {
    const quarter = Number(suffix.slice(2));
    if (quarter > 1) previous = ledgerPeriod(`${year}-Q${quarter - 1}`);
    else if (earlier) previous = ledgerPeriod(`${year - 1}-Q4`);
  }
  return { startOfYear: earlier ? `${year - 1}-12-31` : null, lastYear, previous };
}
