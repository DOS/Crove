// A Google Business location's figures (#1477) as the Metrics tab sums them and the client report reads them back.
import { describe, expect, it } from 'vitest';
import { reportPerformance, sumDays } from '../src/lib/social-performance.ts';

describe('Google Business performance (#1477)', () => {
  it('sums the days of the window and keeps the latest', () => {
    expect(sumDays([])).toBeNull();
    expect(
      sumDays([
        { day: '2026-10-21', calls: 1, directions: 0, websiteClicks: 2, views: 30 },
        { day: '2026-10-20', calls: 3, directions: 5, websiteClicks: 7, views: 100 },
      ]),
    ).toEqual({ totals: { calls: 4, directions: 5, websiteClicks: 9, views: 130 }, lastDay: '2026-10-21' });
  });

  it("reads the report's list back, leaving out channels without a day and figures that are not counts", () => {
    expect(reportPerformance(null)).toEqual([]);
    expect(reportPerformance('x')).toEqual([]);
    expect(
      reportPerformance([
        { channel: 'Tiệm Bánh Quận 1', provider: 'google_business', days: 3, lastDay: '2026-10-31', totals: { calls: 10, directions: 3, websiteClicks: -1, views: '47' }, previous: { days: 1, totals: { calls: 4, directions: 4, websiteClicks: 4, views: 40 } } },
        { channel: 'Trống', provider: 'google_business', days: 0, lastDay: null, totals: {}, previous: null },
        { channel: 5, provider: 'google_business', days: 2 },
        'nope',
      ]),
    ).toEqual([
      {
        channel: 'Tiệm Bánh Quận 1',
        provider: 'google_business',
        days: 3,
        lastDay: '2026-10-31',
        totals: { calls: 10, directions: 3, websiteClicks: 0, views: 0 },
        previous: { days: 1, totals: { calls: 4, directions: 4, websiteClicks: 4, views: 40 } },
      },
    ]);
  });
});
