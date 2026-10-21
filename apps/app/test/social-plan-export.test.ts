import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/lib/bank-statement.ts';
import { importRows, unguard } from '../src/lib/social-import.ts';
import { monthOf, parsePlanSearch, PLAN_EXPORT_MAX_DAYS, planPrintPath, planRange } from '../src/lib/social-plan-export.ts';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';

describe('content plan export (#978)', () => {
  it('starts on the month the calendar shows', () => {
    expect(monthOf(new Date(2026, 9, 22))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthOf(new Date(2028, 1, 10))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('sends the days picked as local midnights, at most 92 days, never backwards', () => {
    expect(planRange('2026-11-01', '2026-11-30')).toEqual({ from: new Date(2026, 10, 1).toISOString(), to: new Date(2026, 11, 1).toISOString() });
    expect(planRange('2026-11-01', '2026-11-01')).toEqual({ from: new Date(2026, 10, 1).toISOString(), to: new Date(2026, 10, 2).toISOString() });
    const last = new Date(2026, 10, PLAN_EXPORT_MAX_DAYS);
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(planRange('2026-11-01', day(last))).not.toBeNull();
    expect(planRange('2026-11-01', day(new Date(2026, 10, PLAN_EXPORT_MAX_DAYS + 1)))).toBeNull();
    expect(planRange('2026-11-02', '2026-11-01')).toBeNull();
    expect(planRange('', '2026-11-01')).toBeNull();
  });

  it("carries the range and the filters to the print layout's address and back", () => {
    const path = planPrintPath('cong-ty-a', { from: '2026-11-01', to: '2026-11-30', channels: [C1, C2], labels: [] });
    expect(path).toBe(`/o/cong-ty-a/print/social-plan?from=2026-11-01&to=2026-11-30&channels=${C1}%2C${C2}`);
    const search = Object.fromEntries(new URL(path, 'https://app.test').searchParams);
    expect(parsePlanSearch(search)).toEqual({ from: '2026-11-01', to: '2026-11-30', channels: [C1, C2], labels: [] });
    // Anything that is not a date or an id is left out.
    expect(parsePlanSearch({ from: '1/11/2026', to: 20261130, channels: `x,${C1.toUpperCase()},${C1}`, labels: 'drop table' })).toEqual({ channels: [C1], labels: [] });
  });

  it("drops the export's formula guard when a plan comes back through the import", () => {
    expect(unguard("'- Giảm 20%")).toBe('- Giảm 20%');
    expect(unguard("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unguard("'Tết")).toBe("'Tết");
    expect(unguard('- Giảm')).toBe('- Giảm');
    const csv = '\uFEFFtext,title,link,channels,time,status,labels,assignee,post_id\r\n"\'- Giảm 20%, tuần đầu",\'+ Ưu đãi,,Quán A,2099-11-01 09:00,scheduled,"Tết, Khai trương",Lan,p1\r\n';
    const rows = importRows(parseCsv(csv), [{ id: 'fb1', displayName: 'Quán A', provider: 'facebook_page', status: 'active' }], new Date(2026, 9, 22).getTime());
    expect(rows).toEqual([{ row: 2, body: '- Giảm 20%, tuần đầu', title: '+ Ưu đãi', link: '', connectionIds: ['fb1'], plannedAt: new Date(2099, 10, 1, 9, 0).toISOString(), problems: [] }]);
  });
});
