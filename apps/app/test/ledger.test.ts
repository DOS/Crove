// The ledger reports screen's period picker and balance display (issue #321).
import { describe, expect, it } from 'vitest';
import { LEDGER_PERIOD_PATTERN } from '@crove/kernel-contract';
import { b02Comparison, balanceSide, columnAmount, defaultLedgerPeriod, ledgerPeriodKey, switchLedgerKind } from '../src/lib/ledger.ts';

describe('ledger period picker', () => {
  it('builds the period the server expects', () => {
    expect(ledgerPeriodKey({ kind: 'month', year: 2026, index: 9 })).toBe('2026-09');
    expect(ledgerPeriodKey({ kind: 'quarter', year: 2026, index: 3 })).toBe('2026-Q3');
    expect(ledgerPeriodKey({ kind: 'year', year: 2026, index: 7 })).toBe('2026');
    for (const kind of ['month', 'quarter', 'year'] as const) {
      for (let index = 1; index <= (kind === 'month' ? 12 : 4); index++) expect(ledgerPeriodKey({ kind, year: 2026, index })).toMatch(LEDGER_PERIOD_PATTERN);
    }
  });

  it('defaults to the month before today, across a year end', () => {
    expect(defaultLedgerPeriod(new Date(2026, 9, 17))).toEqual({ kind: 'month', year: 2026, index: 9 });
    expect(defaultLedgerPeriod(new Date(2026, 0, 5))).toEqual({ kind: 'month', year: 2025, index: 12 });
  });

  it('keeps the same time when switching kinds', () => {
    expect(switchLedgerKind({ kind: 'month', year: 2026, index: 8 }, 'quarter')).toEqual({ kind: 'quarter', year: 2026, index: 3 });
    expect(switchLedgerKind({ kind: 'quarter', year: 2026, index: 4 }, 'month')).toEqual({ kind: 'month', year: 2026, index: 10 });
    expect(switchLedgerKind({ kind: 'month', year: 2025, index: 8 }, 'year')).toEqual({ kind: 'year', year: 2025, index: 1 });
    expect(switchLedgerKind({ kind: 'year', year: 2025, index: 1 }, 'quarter')).toEqual({ kind: 'quarter', year: 2025, index: 1 });
    const same = { kind: 'year' as const, year: 2026, index: 1 };
    expect(switchLedgerKind(same, 'year')).toBe(same);
  });
});

describe('balanceSide', () => {
  it('reads a signed balance as a debit or credit side', () => {
    expect(balanceSide('1980000')).toEqual({ side: 'debit', amount: '1980000' });
    expect(balanceSide('-1980000')).toEqual({ side: 'credit', amount: '1980000' });
    expect(balanceSide('-0.5')).toEqual({ side: 'credit', amount: '0.5' });
    expect(balanceSide('0')).toEqual({ side: null, amount: '0' });
    expect(balanceSide('-0')).toEqual({ side: null, amount: '0' });
  });
});

describe('statement comparison columns (#2090)', () => {
  const lastYear = { period: '2025-09', amounts: { '24': '900000' } };
  const previous = { period: '2026-08', amounts: { '24': '1800000' } };
  const startOfYear = { asOf: '2025-12-31', amounts: { '200': '100000' } };

  it('reads B02 against the same period last year, and against the period before when it is picked', () => {
    const comparison = { startOfYear, lastYear, previous };
    expect(b02Comparison(comparison, 'last_year')).toEqual({ kind: 'last_year', ...lastYear });
    expect(b02Comparison(comparison, 'previous')).toEqual({ kind: 'previous', ...previous });
  });

  it('falls back to last year where there is no period before (a year), and to nothing before the first year', () => {
    expect(b02Comparison({ startOfYear, lastYear: { period: '2025', amounts: {} }, previous: null }, 'previous')).toEqual({ kind: 'last_year', period: '2025', amounts: {} });
    expect(b02Comparison({ startOfYear: null, lastYear: null, previous: null }, 'last_year')).toBeNull();
    expect(b02Comparison({ startOfYear: null, lastYear: null, previous }, 'last_year')).toBeNull();
  });

  it('reads a line the column has nothing on as 0', () => {
    expect(columnAmount(lastYear.amounts, '24')).toBe('900000');
    expect(columnAmount(lastYear.amounts, '60')).toBe('0');
  });
});
