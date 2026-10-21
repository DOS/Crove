// The tax calendar rules (issue #921): each obligation's periods and due dates across year boundaries, the weekend
// rule, a fiscal year that is not the calendar year, the periods a rule covers, and what the profile turns on.
import { describe, expect, it } from 'vitest';
import { TAX_OBLIGATIONS, TAX_RULES, afterWeekend, taxDues, type TaxProfileSettings } from '../src/tax-calendar.ts';

const profile = (over: Partial<TaxProfileSettings> = {}): TaxProfileSettings => ({
  obligations: [],
  vatFilingPeriod: null,
  pitFilingPeriod: null,
  fiscalYearEndMonth: 12,
  ...over,
});
const dues = (p: TaxProfileSettings, from: string, to: string) => taxDues(p, from, to).map((d) => [d.obligation, d.period, d.dueDate]);

describe('tax calendar rules', () => {
  it('moves a Saturday or a Sunday to the next Monday', () => {
    expect(afterWeekend('2026-09-19')).toBe('2026-09-21');
    expect(afterWeekend('2026-09-20')).toBe('2026-09-21');
    expect(afterWeekend('2026-10-20')).toBe('2026-10-20');
    expect(() => afterWeekend('2026-02-30')).toThrow(/not a calendar date/);
  });

  it('dues the monthly VAT and PIT returns on the 20th of the next month, across the year end and the weekend', () => {
    const p = profile({ vatFilingPeriod: 'month', obligations: ['pit_withholding'], pitFilingPeriod: 'month' });
    expect(dues(p, '2026-09-01', '2026-09-30')).toEqual([
      // 20 September 2026 is a Sunday.
      ['vat_return', '2026-08', '2026-09-21'],
      ['pit_withholding', '2026-08', '2026-09-21'],
    ]);
    expect(dues(p, '2026-12-21', '2027-01-31')).toEqual([
      ['vat_return', '2026-11', '2026-12-21'],
      ['pit_withholding', '2026-11', '2026-12-21'],
      ['vat_return', '2026-12', '2027-01-20'],
      ['pit_withholding', '2026-12', '2027-01-20'],
    ]);
  });

  it('dues a quarterly return on the last day of the next quarter first month', () => {
    const p = profile({ vatFilingPeriod: 'quarter', obligations: ['pit_withholding'], pitFilingPeriod: 'quarter' });
    // 31 October 2026 is a Saturday: the third quarter is due on Monday 2 November.
    expect(dues(p, '2026-10-01', '2026-11-30')).toEqual([
      ['vat_return', '2026-Q3', '2026-11-02'],
      ['pit_withholding', '2026-Q3', '2026-11-02'],
    ]);
    // 31 January 2027 is a Sunday.
    expect(dues(p, '2027-01-01', '2027-02-28')).toEqual([
      ['vat_return', '2026-Q4', '2027-02-01'],
      ['pit_withholding', '2026-Q4', '2027-02-01'],
    ]);
  });

  it('dues the provisional CIT on the 30th after each quarter of the fiscal year, and the year-end filings after it', () => {
    const calendar = profile({ obligations: ['cit_provisional', 'cit_finalization', 'pit_finalization', 'financial_statements'] });
    expect(dues(calendar, '2026-10-01', '2026-10-31')).toEqual([['cit_provisional', '2026-Q3', '2026-10-30']]);
    expect(dues(calendar, '2027-01-01', '2027-04-30')).toEqual([
      // 30 January 2027 is a Saturday.
      ['cit_provisional', '2026-Q4', '2027-02-01'],
      ['cit_finalization', '2026', '2027-03-31'],
      ['pit_finalization', '2026', '2027-03-31'],
      ['financial_statements', '2026', '2027-03-31'],
      ['cit_provisional', '2027-Q1', '2027-04-30'],
    ]);
    // 90 days after 31 December 2027 is 30 March 2028, a leap year.
    expect(dues(calendar, '2028-03-01', '2028-03-31').filter(([o]) => o === 'financial_statements')).toEqual([['financial_statements', '2027', '2028-03-30']]);
  });

  it('counts a fiscal year ending in March by its own quarters, and names it by the year it ends in', () => {
    const march = profile({ obligations: ['cit_provisional', 'cit_finalization', 'pit_finalization'], fiscalYearEndMonth: 3 });
    // Fiscal year 2027 runs from April 2026 to March 2027: its first quarter ends in June 2026.
    const july = taxDues(march, '2026-07-01', '2026-07-31');
    expect(july.map((d) => [d.obligation, d.period, d.periodStart, d.periodEnd, d.dueDate])).toEqual([['cit_provisional', '2027-Q1', '2026-04-01', '2026-06-30', '2026-07-30']]);
    // Its finalization is due at the end of June 2027; the PIT finalization stays on the calendar year.
    expect(dues(march, '2027-03-01', '2027-06-30')).toEqual([
      ['pit_finalization', '2026', '2027-03-31'],
      ['cit_provisional', '2027-Q4', '2027-04-30'],
      ['cit_finalization', '2027', '2027-06-30'],
    ]);
  });

  it('lists the license fee for the years it was due, and not from 2026', () => {
    const p = profile({ obligations: ['license_fee'] });
    expect(dues(p, '2025-01-01', '2025-12-31')).toEqual([['license_fee', '2025', '2025-01-30']]);
    expect(dues(p, '2026-01-01', '2027-12-31')).toEqual([]);
  });

  it('lists only what the profile turns on', () => {
    expect(dues(profile(), '2026-01-01', '2026-12-31')).toEqual([]);
    // PIT withholding needs its frequency; the VAT return follows the org's VAT filing period.
    expect(dues(profile({ obligations: ['pit_withholding', 'vat_return'] }), '2026-01-01', '2026-12-31')).toEqual([]);
    expect(() => taxDues(profile({ fiscalYearEndMonth: 13 }), '2026-01-01', '2026-01-31')).toThrow(/not a month/);
  });

  it('gives every obligation a rule with its legal basis, none confirmed yet', () => {
    for (const obligation of TAX_OBLIGATIONS) expect(TAX_RULES.some((r) => r.obligation === obligation), obligation).toBe(true);
    for (const rule of TAX_RULES) {
      expect(rule.legalBasis.length).toBeGreaterThan(10);
      expect(rule.confirmed).toBe(false);
    }
  });
});
