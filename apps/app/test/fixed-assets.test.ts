// The register form (#919): its defaults per kind, its checks and the input it sends, and the months offered for a
// depreciation.
import { describe, expect, it } from 'vitest';
import { defaultAccounts, fixedAssetFormProblem, fixedAssetInput, monthLabel, previousMonth, recentMonths, type FixedAssetForm } from '../src/lib/fixed-assets.ts';

const form = (over: Partial<FixedAssetForm> = {}): FixedAssetForm => ({
  kind: 'fixed_asset',
  name: 'Máy in',
  cost: '36.000.000',
  ...defaultAccounts('fixed_asset'),
  startMonth: '2026-10',
  months: '36',
  ...over,
});

describe('the fixed asset form', () => {
  it('sends a valid entry as the kernel takes it', () => {
    expect(fixedAssetFormProblem(form())).toBeNull();
    expect(fixedAssetInput(form())).toEqual({ kind: 'fixed_asset', name: 'Máy in', cost: '36000000', assetAccount: '2111', accumulatedAccount: '2141', expenseAccount: '6422', startMonth: '2026-10', months: 36 });
    const prepaid = form({ kind: 'prepaid_cost', ...defaultAccounts('prepaid_cost'), months: '12' });
    expect(fixedAssetFormProblem(prepaid)).toBeNull();
    expect(fixedAssetInput(prepaid).accumulatedAccount).toBeNull();
  });

  it('refuses a missing name, an amount that is not whole dong, accounts of the wrong kind and a bad schedule', () => {
    expect(fixedAssetFormProblem(form({ name: ' ' }))).toBe('name');
    expect(fixedAssetFormProblem(form({ cost: '0' }))).toBe('cost');
    expect(fixedAssetFormProblem(form({ cost: '-1000' }))).toBe('cost');
    expect(fixedAssetFormProblem(form({ accumulatedAccount: '' }))).toBe('accounts');
    expect(fixedAssetFormProblem(form({ kind: 'prepaid_cost' }))).toBe('accounts');
    expect(fixedAssetFormProblem(form({ expenseAccount: '511' }))).toBe('accounts');
    expect(fixedAssetFormProblem(form({ expenseAccount: '1541' }))).toBeNull();
    expect(fixedAssetFormProblem(form({ startMonth: '2026-13' }))).toBe('startMonth');
    expect(fixedAssetFormProblem(form({ months: '0' }))).toBe('months');
    expect(fixedAssetFormProblem(form({ months: '601' }))).toBe('months');
    expect(fixedAssetFormProblem(form({ months: '1.5' }))).toBe('months');
  });

  it('offers the months up to the one before today, newest first', () => {
    expect(previousMonth('2026-10-21')).toBe('2026-09');
    expect(previousMonth('2027-01-05')).toBe('2026-12');
    expect(recentMonths('2027-02', 3)).toEqual(['2027-02', '2027-01', '2026-12']);
    expect(monthLabel('2026-09')).toBe('09/2026');
  });
});
