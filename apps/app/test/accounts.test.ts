// The chart of accounts on screen (#319): what pickers offer, where a sub-account may go, and the settings list.
import { describe, expect, it } from 'vitest';
import { accountLabel, parentChoices, pickableAccounts, subAccounts, type ChartAccount } from '../src/lib/accounts.ts';

const tt133 = (code: string, name: string): ChartAccount => ({ code, name, parentCode: null, rootCode: code, active: true, custom: false });
const own = (code: string, parentCode: string, rootCode: string, active = true): ChartAccount => ({ code, name: `TK ${code}`, parentCode, rootCode, active, custom: true });

const CHART: ChartAccount[] = [
  tt133('112', 'Tiền gửi ngân hàng'),
  own('1121', '112', '112'),
  own('1121.ACB', '1121', '112', false),
  own('1121.VCB', '1121', '112'),
  tt133('6422', 'Chi phí quản lý doanh nghiệp'),
];

describe('chart of accounts on screen', () => {
  it('offers accounts in use, and keeps a deactivated one the line or vendor already has', () => {
    expect(pickableAccounts(CHART).map((a) => a.code)).toEqual(['112', '1121', '1121.VCB', '6422']);
    expect(pickableAccounts(CHART, '1121.ACB').map((a) => a.code)).toEqual(['112', '1121', '1121.ACB', '1121.VCB', '6422']);
    // A code the chart does not know yet (the list is still loading) still shows.
    expect(pickableAccounts([], '6422').map((a) => accountLabel(a))).toEqual(['6422']);
  });

  it('puts sub-accounts only under accounts in use without a tag', () => {
    expect(parentChoices(CHART).map((a) => a.code)).toEqual(['112', '1121', '6422']);
  });

  it('lists the org sub-accounts, inactive ones included', () => {
    expect(subAccounts(CHART).map((a) => a.code)).toEqual(['1121', '1121.ACB', '1121.VCB']);
    expect(accountLabel(CHART[0] as ChartAccount)).toBe('112 · Tiền gửi ngân hàng');
  });
});
