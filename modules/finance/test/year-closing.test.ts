// Year-end closing entries (#889) as pure functions: classes 5 to 8 to 911, then 911 to 4212.
import { describe, expect, it } from 'vitest';
import { closingLines, closingResult } from '../src/domain/year-closing.ts';

const b = (accountCode: string, debit: string, credit: string) => ({ accountCode, debit, credit });

describe('year-end closing', () => {
  it('closes revenue and costs to 911 and a profit to 4212', () => {
    const lines = closingLines([
      b('6422', '600000', '0'),
      b('511', '0', '1000000'),
      b('632', '250000', '50000'),
      b('131', '1000000', '0'),
      b('711', '0', '0'),
    ]);
    expect(lines).toEqual([
      { account: '511', debit: '1000000', credit: '0' },
      { account: '911', debit: '0', credit: '1000000' },
      { account: '911', debit: '800000', credit: '0' },
      { account: '632', debit: '0', credit: '200000' },
      { account: '6422', debit: '0', credit: '600000' },
      { account: '911', debit: '200000', credit: '0' },
      { account: '4212', debit: '0', credit: '200000' },
    ]);
    expect(closingResult(lines)).toBe('200000');
    // Every line on one side, and the entry balances.
    const sum = (side: 'debit' | 'credit') => lines.reduce((t, l) => t + Number(l[side]), 0);
    expect(sum('debit')).toBe(sum('credit'));
  });

  it('closes a loss to the debit of 4212, sub-accounts on their own lines', () => {
    const lines = closingLines([b('5111', '0', '300000'), b('6422.VP', '500000', '0')]);
    expect(lines).toEqual([
      { account: '5111', debit: '300000', credit: '0' },
      { account: '911', debit: '0', credit: '300000' },
      { account: '911', debit: '500000', credit: '0' },
      { account: '6422.VP', debit: '0', credit: '500000' },
      { account: '4212', debit: '200000', credit: '0' },
      { account: '911', debit: '0', credit: '200000' },
    ]);
    expect(closingResult(lines)).toBe('-200000');
  });

  it('clears a balance left on 911 into the result, and has nothing to close for a closed year', () => {
    expect(closingLines([b('911', '0', '50000')])).toEqual([
      { account: '911', debit: '50000', credit: '0' },
      { account: '4212', debit: '0', credit: '50000' },
    ]);
    expect(closingLines([b('511', '100', '100'), b('331', '0', '5000')])).toEqual([]);
  });
});
