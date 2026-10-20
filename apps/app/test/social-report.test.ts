import { describe, expect, it } from 'vitest';
import { lastMonth, reportPeriod, reportUrl } from '../src/lib/social-report.ts';

describe('client report links (#643)', () => {
  it('suggests the previous calendar month, across a year end', () => {
    expect(lastMonth(new Date(2026, 9, 20))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(lastMonth(new Date(2026, 0, 5))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(lastMonth(new Date(2024, 2, 1))).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('covers the whole of both days in the browser zone', () => {
    const p = reportPeriod('2026-10-01', '2026-10-31');
    expect(p).not.toBeNull();
    const start = new Date(p?.periodStart as string);
    const end = new Date(p?.periodEnd as string);
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([2026, 9, 1, 0]);
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([2026, 10, 1, 0]);
    expect(reportPeriod('2026-10-05', '2026-10-05')).not.toBeNull();
  });

  it('refuses a missing date or a last day before the first', () => {
    expect(reportPeriod('', '2026-10-31')).toBeNull();
    expect(reportPeriod('2026-10-31', '2026-10-01')).toBeNull();
    expect(reportPeriod('31/10/2026', '2026-11-01')).toBeNull();
  });

  it('keeps the token after the #', () => {
    expect(reportUrl('https://app.crove.test', 'a'.repeat(43))).toBe(`https://app.crove.test/-/report#${'a'.repeat(43)}`);
  });
});
