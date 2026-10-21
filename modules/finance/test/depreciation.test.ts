import { describe, expect, it } from 'vitest';
import { addMonths, firstOfMonth, lastMonth, monthAmount, monthsBetween, remainingValue } from '../src/domain/depreciation.ts';

const asset = (cost: string, months: number, endedMonth: string | null = null) => ({ cost, startMonth: '2026-10-01', months, endedMonth });

describe('straight-line depreciation and allocation (#919)', () => {
  it('counts months across years', () => {
    expect(monthsBetween('2026-10-01', '2027-01-01')).toBe(3);
    expect(monthsBetween('2026-10-01', '2026-09-01')).toBe(-1);
    expect(addMonths('2026-10-01', 35)).toBe('2029-09-01');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(lastMonth(asset('1', 36))).toBe('2029-09-01');
    expect(firstOfMonth('2026-10-21')).toBe('2026-10-01');
  });

  it('gives each month the cost over the months, rounded down, and the remainder to the last month', () => {
    const a = asset('10000000', 3);
    const amounts = [0, 1, 2].map((k) => monthAmount(a, addMonths('2026-10-01', k)));
    expect(amounts).toEqual(['3333333', '3333333', '3333334']);
    expect(amounts.reduce((acc, v) => acc + Number(v), 0)).toBe(10000000);
    // A cost with a fraction of a dong still adds up exactly.
    const b = asset('1000.5', 4);
    const parts = [0, 1, 2, 3].map((k) => monthAmount(b, addMonths('2026-10-01', k)));
    expect(parts).toEqual(['250', '250', '250', '250.5']);
    // An even split has no remainder.
    expect(monthAmount(asset('36000000', 36), '2029-09-01')).toBe('1000000');
  });

  it('counts nothing before the start, after the last month, or after an early end', () => {
    const a = asset('12000000', 12);
    expect(monthAmount(a, '2026-09-01')).toBe('0');
    expect(monthAmount(a, '2027-10-01')).toBe('0');
    const ended = asset('12000000', 12, '2026-12-01');
    expect(monthAmount(ended, '2026-12-01')).toBe('1000000');
    expect(monthAmount(ended, '2027-01-01')).toBe('0');
  });

  it('leaves what was not posted as the remaining value', () => {
    expect(remainingValue('12000000', ['1000000', '1000000'])).toBe('10000000');
    expect(remainingValue('1000', [])).toBe('1000');
  });
});
