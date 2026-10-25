// The VAT working screen's period picker (issue #316).
import { describe, expect, it } from 'vitest';
import { VAT_PERIOD_PATTERN } from '@crove/kernel-contract';
import { canMarkFiled, canMarkPayment, carriedOutOf, deductAmount, deductParams, defaultPeriod, periodKey, roundDong, switchKind, wholeDong, yearOptions } from '../src/lib/vat.ts';

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

describe('VAT working: [25] in the XML and payment marks (#917)', () => {
  it('asks the server for 0, all of [24] or the suggestion', () => {
    expect(deductParams('none')).toEqual({});
    expect(deductParams('all')).toEqual({ deductInput: '1' });
    expect(deductParams('suggested')).toEqual({ deduct: 'suggested' });
  });
  it('lets owners, admins and members mark an invoice, not viewers', () => {
    expect(['owner', 'admin', 'member', 'viewer', null].map((r) => canMarkPayment(r))).toEqual([true, true, true, false, false]);
  });
});

describe('the return as filed (#1400)', () => {
  it('reads whole dong as typed, grouped or not, and refuses anything else', () => {
    expect(wholeDong('2.796.666')).toBe('2796666');
    expect(wholeDong('2796666')).toBe('2796666');
    expect(wholeDong('007')).toBe('7');
    expect(wholeDong('0')).toBe('0');
    for (const text of ['', '-1', '1.5', 'abc', '123456789012345']) expect(wholeDong(text), text).toBeNull();
  });

  it('works [43] out from [35], [25] and [22] as the form does, rounding [35] half up', () => {
    // [35] 166,668, [22] 2,880,000: 2,713,332 carried on.
    expect(carriedOutOf('166668.0000', '0', '2880000')).toBe('2713332');
    // Payable instead: nothing carried on.
    expect(carriedOutOf('166668', '0', '100000')).toBe('0');
    expect(carriedOutOf('100.5', '101', '0')).toBe('0');
    expect(carriedOutOf('100.4', '101', '0')).toBe('1');
    expect(roundDong('-0.5')).toBe('-1');
  });

  it('prefills [25] from the XML choice, and lets only owners and admins mark a return filed', () => {
    expect(deductAmount('none', '220000.4', '180000')).toBe('0');
    expect(deductAmount('all', '220000.5', '180000')).toBe('220001');
    expect(deductAmount('suggested', '220000', '180000.5')).toBe('180001');
    expect(['owner', 'admin', 'member', 'viewer', null].map(canMarkFiled)).toEqual([true, true, false, false, false]);
  });
});
