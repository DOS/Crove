// Fiscal year archive packages on the ledger screen (issue #922): who may archive, which years are offered, and when a
// request counts as stalled.
import { describe, expect, it } from 'vitest';
import type { YearArchive } from '@crove/kernel-contract';
import { archivableYears, canArchiveYears, isStalled, lastLockedYear } from '../src/lib/year-archive.ts';

const NOW = Date.parse('2026-10-21T10:00:00Z');
const built = (year: number): YearArchive => ({ year, state: 'built', requestedAt: null, builtAt: '2026-01-10T00:00:00Z', manifestSha256: 'a'.repeat(64), parts: 27, documents: 2 });
const requested = (year: number, minutesAgo: number): YearArchive => ({
  year,
  state: 'requested',
  requestedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  builtAt: null,
  manifestSha256: null,
  parts: null,
  documents: null,
});

describe('year archive helpers', () => {
  it('lets only owners archive', () => {
    expect(['owner', 'admin', 'member', 'viewer', null].map((r) => canArchiveYears(r))).toEqual([true, false, false, false, false]);
  });

  it('counts a year as locked only through the 31st of December', () => {
    expect(lastLockedYear('2025-12-31')).toBe(2025);
    expect(lastLockedYear('2026-09-30')).toBe(2025);
    expect(lastLockedYear('2025-11-30')).toBe(2024);
    expect(lastLockedYear(null)).toBeNull();
    expect(lastLockedYear('2000-06-30')).toBeNull();
  });

  it('offers locked years newest first, without built years or a request still in progress', () => {
    expect(archivableYears(null, [], NOW)).toEqual([]);
    expect(archivableYears('2025-12-31', [], NOW).slice(0, 3)).toEqual([2025, 2024, 2023]);
    expect(archivableYears('2025-12-31', [], NOW)).toHaveLength(10);
    expect(archivableYears('2025-12-31', [built(2025), requested(2024, 5)], NOW).slice(0, 2)).toEqual([2023, 2022]);
    // A request the worker has not recorded within an hour may be asked again.
    expect(archivableYears('2025-12-31', [requested(2025, 61)], NOW)[0]).toBe(2025);
    expect(archivableYears('2001-12-31', [], NOW)).toEqual([2001, 2000]);
  });

  it('treats a request as stalled after an hour', () => {
    expect(isStalled(requested(2025, 59), NOW)).toBe(false);
    expect(isStalled(requested(2025, 60), NOW)).toBe(true);
    expect(isStalled(built(2025), NOW)).toBe(false);
  });
});
