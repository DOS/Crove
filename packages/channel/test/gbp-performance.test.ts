// A Google Business Profile location's performance (#1477) against recorded answers, in the shape of the Business
// Profile Performance API's reference (locations.fetchMultiDailyMetricsTimeSeries); no live call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_BUSINESS_HOSTS, GoogleBusinessPublisher, PERFORMANCE_DAYS, type Fetch } from '../src/index.ts';

const APP = { clientId: '123456789-testclientid0001.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const SECRET = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
const LOCATION = 'accounts/1001/locations/2002';
const ROUTE = 'GET businessprofileperformance.googleapis.com/v1/locations/2002:fetchMultiDailyMetricsTimeSeries';

function google(answers: { status?: number; body: unknown }[]) {
  const calls: { route: string; query: URLSearchParams; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ route: `${init?.method ?? 'GET'} ${url.host}${decodeURIComponent(url.pathname)}`, query: url.searchParams, auth: new Headers(init?.headers).get('authorization') });
    const answer = answers.shift() ?? { status: 500, body: { error: { code: 500, message: 'no answer', status: 'INTERNAL' } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const day = (iso: string) => {
  const [year, month, d] = iso.split('-').map(Number);
  return { year, month, day: d };
};
const series = (metric: string, values: [string, string | undefined][], extra: Record<string, unknown> = {}) => ({
  dailyMetric: metric,
  ...extra,
  timeSeries: { datedValues: values.map(([d, value]) => ({ date: day(d), ...(value === undefined ? {} : { value }) })) },
});

describe('GoogleBusinessPublisher.accountMetrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T08:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the last 14 days up to yesterday in one call and sums the four figures per day, views from the four impression series', async () => {
    const { fetchImpl, calls } = google([
      {
        body: {
          multiDailyMetricTimeSeries: [
            {
              dailyMetricTimeSeries: [
                series('CALL_CLICKS', [['2026-10-20', '3'], ['2026-10-21', undefined]]),
                series('BUSINESS_DIRECTION_REQUESTS', [['2026-10-20', '5'], ['2026-10-21', '1']]),
                series('WEBSITE_CLICKS', [['2026-10-20', '7']]),
                series('BUSINESS_IMPRESSIONS_DESKTOP_MAPS', [['2026-10-20', '10']]),
                series('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', [['2026-10-20', '20']]),
                series('BUSINESS_IMPRESSIONS_MOBILE_MAPS', [['2026-10-20', '30'], ['2026-10-21', '2']]),
                series('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', [['2026-10-20', '40']]),
                // A metric Crove does not ask for, a breakdown and a day out of the range are not counted.
                series('BUSINESS_BOOKINGS', [['2026-10-20', '99']]),
                series('CALL_CLICKS', [['2026-10-20', '50']], { dailySubEntityType: { dayOfWeek: 'MONDAY' } }),
                series('WEBSITE_CLICKS', [['2026-10-25', '9'], ['2026-10-10', '9']]),
              ],
            },
          ],
        },
      },
    ]);
    const publisher = new GoogleBusinessPublisher(APP, fetchImpl);
    expect(await publisher.accountMetrics({ externalAccountId: LOCATION, secret: SECRET })).toEqual({
      followers: null,
      performance: {
        '2026-10-20': { calls: 3, directions: 5, websiteClicks: 7, views: 100 },
        '2026-10-21': { calls: 0, directions: 1, websiteClicks: 0, views: 2 },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe(ROUTE);
    expect(calls[0]?.auth).toBe('Bearer ya29.token-1');
    expect(calls[0]?.query.getAll('dailyMetrics')).toEqual([
      'CALL_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
      'WEBSITE_CLICKS',
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    ]);
    // Inclusive, 14 days: 2026-10-11 to 2026-10-24.
    expect(PERFORMANCE_DAYS).toBe(14);
    const q = calls[0]!.query;
    expect([q.get('dailyRange.start_date.year'), q.get('dailyRange.start_date.month'), q.get('dailyRange.start_date.day')]).toEqual(['2026', '10', '11']);
    expect([q.get('dailyRange.end_date.year'), q.get('dailyRange.end_date.month'), q.get('dailyRange.end_date.day')]).toEqual(['2026', '10', '24']);
    expect(GOOGLE_BUSINESS_HOSTS).toContain('businessprofileperformance.googleapis.com');
  });

  it('gives no days for an empty answer and no answer for a malformed one', async () => {
    const { fetchImpl } = google([
      { body: {} },
      { body: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [series('CALL_CLICKS', [['2026-10-20', '-1']])] }] } },
      { body: { multiDailyMetricTimeSeries: 'nope' } },
    ]);
    const publisher = new GoogleBusinessPublisher(APP, fetchImpl);
    expect(await publisher.accountMetrics({ externalAccountId: LOCATION, secret: SECRET })).toEqual({ followers: null, performance: {} });
    expect(await publisher.accountMetrics({ externalAccountId: LOCATION, secret: SECRET })).toBeNull();
    expect(await publisher.accountMetrics({ externalAccountId: LOCATION, secret: SECRET })).toBeNull();
  });

  it('says when the token or the permission is refused, and waits on a quota or an outage', async () => {
    const { fetchImpl, calls } = google([
      { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } },
      { status: 403, body: { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } },
      { status: 429, body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } },
      { status: 403, body: { error: { code: 403, message: 'Quota exceeded', status: 'PERMISSION_DENIED', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } } },
      { status: 503, body: { error: { code: 503, message: 'unavailable', status: 'UNAVAILABLE' } } },
    ]);
    const publisher = new GoogleBusinessPublisher(APP, fetchImpl);
    const read = () => publisher.accountMetrics({ externalAccountId: LOCATION, secret: SECRET });
    expect(await read()).toEqual({ refused: 'token_expired' });
    expect(await read()).toEqual({ refused: 'permission' });
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    // A secret without tokens is refused, and a name that is not a location is never asked for.
    expect(await publisher.accountMetrics({ externalAccountId: LOCATION, secret: '{}' })).toEqual({ refused: 'token_expired' });
    expect(await publisher.accountMetrics({ externalAccountId: 'locations/2002', secret: SECRET })).toBeNull();
    expect(calls).toHaveLength(5);
  });
});
