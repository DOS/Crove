// The VAT working screen's period picker (issue #316).
import { describe, expect, it } from 'vitest';
import { VAT_PERIOD_PATTERN } from '@crove/kernel-contract';
import { defaultPeriod, periodKey, switchKind, yearOptions } from '../src/lib/vat.ts';

describe('VAT period picker', () => {
  it('builds the period the server expects', () => {
    expect(periodKey({ kind: 'month', year: 2026, index: 9 })).toBe('2026-09');
    expect(periodKey({ kind: 'month', year: 2026, index: 12 })).toBe('2026-12');
    expect(periodKey({ kind: 'quarter', year: 2026, index: 3 })).toBe('2026-Q3');
    for (let index = 1; index <= 12; index++) expect(periodKey({ kind: 'month', year: 2026, index })).toMatch(VAT_PERIOD_PATTERN);
    for (let index = 1; index <= 4; index++) expect(periodKey({ kind: 'quarter', year: 2026, index })).toMatch(VAT_PERIOD_PATTERN);
  });

  it('defaults to the period before today, across a year end', () => {
    expect(defaultPeriod('month', new Date(2026, 9, 17))).toEqual({ kind: 'month', year: 2026, index: 9 });
    expect(defaultPeriod('month', new Date(2026, 0, 5))).toEqual({ kind: 'month', year: 2025, index: 12 });
    expect(defaultPeriod('quarter', new Date(2026, 9, 17))).toEqual({ kind: 'quarter', year: 2026, index: 3 });
    expect(defaultPeriod('quarter', new Date(2026, 2, 31))).toEqual({ kind: 'quarter', year: 2025, index: 4 });
  });

  it('keeps the same time when switching between month and quarter', () => {
    expect(switchKind({ kind: 'month', year: 2026, index: 8 }, 'quarter')).toEqual({ kind: 'quarter', year: 2026, index: 3 });
    expect(switchKind({ kind: 'quarter', year: 2026, index: 4 }, 'month')).toEqual({ kind: 'month', year: 2026, index: 10 });
    const same = { kind: 'month' as const, year: 2026, index: 1 };
    expect(switchKind(same, 'month')).toBe(same);
  });

  it('offers this year and the five before it', () => {
    expect(yearOptions(new Date(2026, 9, 17))).toEqual([2026, 2025, 2024, 2023, 2022, 2021]);
  });
});
