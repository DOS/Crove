// Who follows an account on Instagram and Threads (#1146), against recorded answers in the shape of Meta's insights
// references (follower_demographics, total_value with one breakdown per call); no live call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { audienceOf, audienceSlices, InstagramPublisher, ThreadsPublisher, type Fetch } from '../src/index.ts';

// Answers per "METHOD host/path" in order; records each call.
function routes(answers: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; query: URLSearchParams; authorization: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    calls.push({ route, query: url.searchParams, authorization: new Headers(init?.headers).get('authorization') });
    const answer = answers[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, code: 1 } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const META = { appSecret: 'test-app-secret-not-real' };
const IG = '17841400000000001';
const IG_TOKEN = 'ig-page-token-not-real';
const IG_SECRET = JSON.stringify({ accessToken: IG_TOKEN, pageId: '111' });
const TH = '17841400000000777';
const TH_TOKEN = 'threads-token-not-real';
const TH_SECRET = JSON.stringify({ accessToken: TH_TOKEN });
const IG_ROUTE = `GET graph.facebook.com/v24.0/${IG}`;
const IG_INSIGHTS = `GET graph.facebook.com/v24.0/${IG}/insights`;
const TH_INSIGHTS = `GET graph.threads.net/v1.0/${TH}/threads_insights`;

// A follower_demographics answer: Instagram names the timeframe first in dimension_keys; Threads names the breakdown
// alone.
const demographics = (breakdown: string, results: [string, number][], timeframe = true) => ({
  body: {
    data: [
      {
        name: 'follower_demographics',
        period: 'lifetime',
        total_value: {
          breakdowns: [
            {
              dimension_keys: timeframe ? ['timeframe', breakdown] : [breakdown],
              results: results.map(([key, value]) => ({ dimension_values: timeframe ? ['THIS_MONTH', key] : [key], value })),
            },
          ],
        },
        id: `${IG}/insights/follower_demographics/lifetime`,
      },
    ],
  },
});
const AGE: [string, number][] = [['25-34', 620], ['18-24', 410], ['35-44', 150], ['13-17', 12], ['65+', 3]];
const GENDER: [string, number][] = [['F', 780], ['M', 400], ['U', 15]];
const CITIES: [string, number][] = [['Ho Chi Minh City, Ho Chi Minh', 520], ['Hanoi, Hanoi', 300], ['Da Nang, Da Nang', 90]];
const COUNTRIES: [string, number][] = [['VN', 1100], ['US', 40], ['JP', 22]];
const AUDIENCE = {
  age: [{ key: '25-34', count: 620 }, { key: '18-24', count: 410 }, { key: '35-44', count: 150 }, { key: '13-17', count: 12 }, { key: '65+', count: 3 }],
  gender: [{ key: 'F', count: 780 }, { key: 'M', count: 400 }, { key: 'U', count: 15 }],
  cities: [{ key: 'Ho Chi Minh City, Ho Chi Minh', count: 520 }, { key: 'Hanoi, Hanoi', count: 300 }, { key: 'Da Nang, Da Nang', count: 90 }],
  countries: [{ key: 'VN', count: 1100 }, { key: 'US', count: 40 }, { key: 'JP', count: 22 }],
};
const expired = { status: 400, body: { error: { message: `Error validating access token: Session has expired`, type: 'OAuthException', code: 190, error_subcode: 463 } } };
const denied = { status: 403, body: { error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 } } };

describe('Instagram follower demographics (#1146)', () => {
  const logged: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    logged.length = 0;
  });
  const capture = () => {
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
  };

  it('asks one breakdown per call with 100 followers or more, and keeps the followers and reach', async () => {
    const { fetchImpl, calls } = routes({
      [IG_ROUTE]: [{ body: { followers_count: 1240 } }],
      [IG_INSIGHTS]: [{ body: { data: [{ name: 'reach', period: 'day', values: [{ value: 455 }] }] } }, demographics('age', AGE), demographics('gender', GENDER), demographics('city', CITIES), demographics('country', COUNTRIES)],
    });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    expect(await publisher.accountMetrics({ externalAccountId: IG, secret: IG_SECRET, audience: true })).toEqual({ followers: 1240, reach: 455, audience: AUDIENCE });
    const asked = calls.filter((c) => c.query.get('metric') === 'follower_demographics');
    expect(asked.map((c) => c.query.get('breakdown'))).toEqual(['age', 'gender', 'city', 'country']);
    for (const c of asked) {
      expect(c.route).toBe(IG_INSIGHTS);
      expect(c.query.get('period')).toBe('lifetime');
      expect(c.query.get('metric_type')).toBe('total_value');
      expect(c.query.get('timeframe')).toBe('this_month');
      // The token goes in the header, never the address; and the metric takes no since or until.
      expect(c.authorization).toBe(`Bearer ${IG_TOKEN}`);
      expect([...c.query.keys()].sort()).toEqual(['appsecret_proof', 'breakdown', 'metric', 'metric_type', 'period', 'timeframe']);
    }
  });

  it('does not ask unless told to', async () => {
    const { fetchImpl, calls } = routes({ [IG_ROUTE]: [{ body: { followers_count: 1240 } }], [IG_INSIGHTS]: [{ body: { data: [] } }] });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    expect(await publisher.accountMetrics({ externalAccountId: IG, secret: IG_SECRET })).toEqual({ followers: 1240, reach: null });
    expect(calls.some((c) => c.query.get('metric') === 'follower_demographics')).toBe(false);
  });

  it('gives null under 100 followers, without asking, and keeps the followers', async () => {
    const { fetchImpl, calls } = routes({ [IG_ROUTE]: [{ body: { followers_count: 57 } }], [IG_INSIGHTS]: [{ body: { data: [{ name: 'reach', values: [{ value: 12 }] }] } }] });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    expect(await publisher.accountMetrics({ externalAccountId: IG, secret: IG_SECRET, audience: true })).toEqual({ followers: 57, reach: 12, audience: null });
    expect(calls.some((c) => c.query.get('metric') === 'follower_demographics')).toBe(false);
  });

  it('gives null when Meta still answers that there are too few followers, or with nothing', async () => {
    // Meta counts followers apart from followers_count and may hold the breakdowns back near 100.
    const few = { status: 400, body: { error: { message: '(#100) Insufficient followers for demographics', type: 'OAuthException', code: 100 } } };
    const { fetchImpl } = routes({ [IG_ROUTE]: [{ body: { followers_count: 101 } }], [IG_INSIGHTS]: [{ body: { data: [] } }, few, few, { body: { data: [] } }, few] });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    expect(await publisher.accountMetrics({ externalAccountId: IG, secret: IG_SECRET, audience: true })).toEqual({ followers: 101, reach: null, audience: null });
  });

  it('gives null without instagram_manage_insights on an older connection, asking once, and keeps the followers', async () => {
    const { fetchImpl, calls } = routes({ [IG_ROUTE]: [{ body: { followers_count: 2300 } }], [IG_INSIGHTS]: [denied, denied] });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    expect(await publisher.accountMetrics({ externalAccountId: IG, secret: IG_SECRET, audience: true })).toEqual({ followers: 2300, reach: null, audience: null });
    expect(calls.filter((c) => c.query.get('metric') === 'follower_demographics')).toHaveLength(1);
  });

  it('keeps the breakdowns that came when another fails', async () => {
    const down = { status: 500, body: { error: { message: 'An unknown error occurred', code: 1 } } };
    const { fetchImpl } = routes({ [IG_ROUTE]: [{ body: { followers_count: 1240 } }], [IG_INSIGHTS]: [{ body: { data: [] } }, demographics('age', AGE), down, down, demographics('country', COUNTRIES)] });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    expect(await publisher.accountMetrics({ externalAccountId: IG, secret: IG_SECRET, audience: true })).toEqual({ followers: 1240, reach: null, audience: { age: AUDIENCE.age, gender: [], cities: [], countries: AUDIENCE.countries } });
  });

  it('maps an expired token like the other account metrics, and logs or returns no token', async () => {
    capture();
    const first = routes({ [IG_ROUTE]: [expired] });
    expect(await new InstagramPublisher(META, first.fetchImpl, { waitMs: 0, pollMs: 0 }).accountMetrics({ externalAccountId: IG, secret: IG_SECRET, audience: true })).toEqual({ refused: 'token_expired' });
    const later = routes({ [IG_ROUTE]: [{ body: { followers_count: 1240 } }], [IG_INSIGHTS]: [{ body: { data: [] } }, expired] });
    const result = await new InstagramPublisher(META, later.fetchImpl, { waitMs: 0, pollMs: 0 }).accountMetrics({ externalAccountId: IG, secret: IG_SECRET, audience: true });
    expect(result).toEqual({ refused: 'token_expired' });
    expect(later.calls.filter((c) => c.query.get('metric') === 'follower_demographics')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(IG_TOKEN);
    expect(logged.join('\n')).not.toContain(IG_TOKEN);
  });
});

describe('Threads follower demographics (#1146)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks one breakdown per call on threads_insights with 100 followers or more', async () => {
    const { fetchImpl, calls } = routes({
      [TH_INSIGHTS]: [
        { body: { data: [{ name: 'followers_count', total_value: { value: 1240 } }] } },
        demographics('age', AGE, false),
        demographics('gender', GENDER, false),
        demographics('city', CITIES, false),
        demographics('country', COUNTRIES, false),
      ],
    });
    expect(await new ThreadsPublisher(fetchImpl).accountMetrics({ externalAccountId: TH, secret: TH_SECRET, audience: true })).toEqual({ followers: 1240, audience: AUDIENCE });
    const asked = calls.slice(1);
    expect(asked.map((c) => [c.query.get('metric'), c.query.get('breakdown')])).toEqual([
      ['follower_demographics', 'age'],
      ['follower_demographics', 'gender'],
      ['follower_demographics', 'city'],
      ['follower_demographics', 'country'],
    ]);
    for (const c of asked) {
      expect([...c.query.keys()].sort()).toEqual(['breakdown', 'metric']);
      expect(c.authorization).toBe(`Bearer ${TH_TOKEN}`);
    }
  });

  it('gives null under 100 followers without asking, and does not ask unless told to', async () => {
    const few = routes({ [TH_INSIGHTS]: [{ body: { data: [{ name: 'followers_count', total_value: { value: 99 } }] } }] });
    expect(await new ThreadsPublisher(few.fetchImpl).accountMetrics({ externalAccountId: TH, secret: TH_SECRET, audience: true })).toEqual({ followers: 99, audience: null });
    expect(few.calls).toHaveLength(1);
    const plain = routes({ [TH_INSIGHTS]: [{ body: { data: [{ name: 'followers_count', total_value: { value: 1240 } }] } }] });
    expect(await new ThreadsPublisher(plain.fetchImpl).accountMetrics({ externalAccountId: TH, secret: TH_SECRET })).toEqual({ followers: 1240 });
    expect(plain.calls).toHaveLength(1);
  });

  it('gives null when the demographics are refused, and keeps the followers', async () => {
    const { fetchImpl, calls } = routes({ [TH_INSIGHTS]: [{ body: { data: [{ name: 'followers_count', total_value: { value: 1240 } }] } }, denied] });
    expect(await new ThreadsPublisher(fetchImpl).accountMetrics({ externalAccountId: TH, secret: TH_SECRET, audience: true })).toEqual({ followers: 1240, audience: null });
    expect(calls).toHaveLength(2);
  });

  it('maps an expired token like the other account metrics', async () => {
    const first = routes({ [TH_INSIGHTS]: [expired] });
    expect(await new ThreadsPublisher(first.fetchImpl).accountMetrics({ externalAccountId: TH, secret: TH_SECRET, audience: true })).toEqual({ refused: 'token_expired' });
    const later = routes({ [TH_INSIGHTS]: [{ body: { data: [{ name: 'followers_count', total_value: { value: 1240 } }] } }, demographics('age', AGE, false), expired] });
    expect(await new ThreadsPublisher(later.fetchImpl).accountMetrics({ externalAccountId: TH, secret: TH_SECRET, audience: true })).toEqual({ refused: 'token_expired' });
  });
});

describe('audienceSlices (#1146)', () => {
  it('finds the breakdown by its key, adds up a key given twice, keeps the ten largest cities and drops bad entries', () => {
    const cities: [string, number][] = Array.from({ length: 14 }, (_, i) => [`City ${String(i).padStart(2, '0')}`, 100 - i]);
    const answer = demographics('city', [...cities, ['City 00', 5], ['', 9], ['x'.repeat(101), 50], ['Bad\u0000name', 40], ['Zero', 0]]).body;
    const results = answer.data[0]?.total_value.breakdowns[0]?.results as unknown[];
    results.push({ dimension_values: ['THIS_MONTH', 'Fraction'], value: 1.5 }, { dimension_values: ['THIS_MONTH', 7], value: 3 }, null);
    const slices = audienceSlices(answer, 'city');
    expect(slices).toHaveLength(10);
    expect(slices[0]).toEqual({ key: 'City 00', count: 105 });
    expect(slices.at(-1)).toEqual({ key: 'City 09', count: 91 });
    expect(audienceSlices(answer, 'age')).toEqual([]);
    // A short code longer than 40 characters is not a country.
    expect(audienceSlices(demographics('country', [['VN', 3], ['y'.repeat(41), 9]]).body, 'country')).toEqual([{ key: 'VN', count: 3 }]);
    for (const junk of [null, {}, { data: 'x' }, { data: [{ name: 'other' }] }, { data: [{ name: 'follower_demographics', total_value: { breakdowns: 'x' } }] }]) expect(audienceSlices(junk, 'age')).toEqual([]);
    expect(audienceOf({})).toBeNull();
    expect(audienceOf({ gender: [{ key: 'F', count: 1 }] })).toEqual({ age: [], gender: [{ key: 'F', count: 1 }], cities: [], countries: [] });
  });
});
