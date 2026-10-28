// The team report on the Metrics tab (#1058): the period sent to the server, review times as they read, the file name.
import { describe, expect, it } from 'vitest';
import { durationOf, teamFilename, teamRange } from '../src/lib/social-team-report.ts';

describe('team report period (#1058)', () => {
  it('sends the days picked as [start of the first, start of the day after the last)', () => {
    const range = teamRange('2026-09-01', '2026-09-30');
    expect(range).toEqual({ from: new Date(2026, 8, 1).toISOString(), to: new Date(2026, 9, 1).toISOString() });
  });

  it('takes up to 366 days and refuses longer or reversed ranges', () => {
    expect(teamRange('2024-01-01', '2024-12-31')).not.toBeNull();
    expect(teamRange('2024-01-01', '2025-01-01')).toBeNull();
    expect(teamRange('2026-09-30', '2026-09-01')).toBeNull();
    expect(teamRange('', '2026-09-01')).toBeNull();
  });
});

describe('team report review time (#1058)', () => {
  it('reads in minutes under an hour, hours under two days, days after', () => {
    expect(durationOf(0)).toEqual({ unit: 'minutes', value: 0 });
    expect(durationOf(1500)).toEqual({ unit: 'minutes', value: 25 });
    expect(durationOf(16_200)).toEqual({ unit: 'hours', value: 4.5 });
    expect(durationOf(47 * 3600)).toEqual({ unit: 'hours', value: 47 });
    expect(durationOf(3 * 86_400 + 43_200)).toEqual({ unit: 'days', value: 3.5 });
  });

  it('names the file after the days picked', () => {
    expect(teamFilename('2026-09-01', '2026-09-30')).toBe('ludy-nhom-2026-09-01-den-2026-09-30.csv');
  });
});
