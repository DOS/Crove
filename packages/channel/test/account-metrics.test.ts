// What each adapter reads about a connected account once a day (#645), against recorded answers (shapes from each
// platform's docs); no live call.
import { describe, expect, it } from 'vitest';
import { BlueskyPublisher, FacebookPagePublisher, InstagramPublisher, YouTubePublisher, ZaloOaPublisher, type Fetch } from '../src/index.ts';

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

describe('accountMetrics', () => {
  it('reads a Facebook Page\'s followers, falling back to its likes, and says when the token or permission is refused', async () => {
    const page = '111222333';
    const secret = JSON.stringify({ accessToken: 'page-token-1' });
    const ok = routes({ [`GET graph.facebook.com/v24.0/${page}`]: [{ body: { followers_count: 1520, fan_count: 1400 } }, { body: { fan_count: 980 } }] });
    const fb = new FacebookPagePublisher(META, ok.fetchImpl);
    expect(await fb.accountMetrics({ externalAccountId: page, secret })).toEqual({ followers: 1520 });
    expect(await fb.accountMetrics({ externalAccountId: page, secret })).toEqual({ followers: 980 });
    expect(ok.calls[0]?.query.get('fields')).toBe('followers_count,fan_count');
    expect(ok.calls[0]?.authorization).toBe('Bearer page-token-1');
    const refused = routes({ [`GET graph.facebook.com/v24.0/${page}`]: [{ status: 400, body: { error: { message: 'expired', code: 190 } } }, { status: 403, body: { error: { message: 'no', code: 10 } } }, { status: 500, body: {} }] });
    const fb2 = new FacebookPagePublisher(META, refused.fetchImpl);
    expect(await fb2.accountMetrics({ externalAccountId: page, secret })).toEqual({ refused: 'token_expired' });
    expect(await fb2.accountMetrics({ externalAccountId: page, secret })).toEqual({ refused: 'permission' });
    expect(await fb2.accountMetrics({ externalAccountId: page, secret })).toBeNull();
    expect(await fb2.accountMetrics({ externalAccountId: 'x', secret })).toBeNull();
  });

  it("reads an Instagram account's followers and yesterday's reach, and followers alone without insights", async () => {
    const ig = '17841400000000001';
    const secret = JSON.stringify({ accessToken: 'page-token-1', pageId: '111' });
    const { fetchImpl, calls } = routes({
      [`GET graph.facebook.com/v24.0/${ig}`]: [{ body: { followers_count: 2300 } }, { body: { followers_count: 2301 } }],
      [`GET graph.facebook.com/v24.0/${ig}/insights`]: [
        { body: { data: [{ name: 'reach', period: 'day', values: [{ value: 410 }, { value: 455 }] }] } },
        { status: 400, body: { error: { message: 'missing permission', code: 10 } } },
      ],
    });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    expect(await publisher.accountMetrics({ externalAccountId: ig, secret })).toEqual({ followers: 2300, reach: 455 });
    expect(calls[1]?.query.get('metric')).toBe('reach');
    expect(calls[1]?.query.get('period')).toBe('day');
    expect(await publisher.accountMetrics({ externalAccountId: ig, secret })).toEqual({ followers: 2301, reach: null });
  });

  it("reads a Bluesky account's followers from the public AppView, only for the same account", async () => {
    const did = 'did:plc:abc123xyz';
    const { fetchImpl, calls } = routes({
      'GET public.api.bsky.app/xrpc/app.bsky.actor.getProfile': [{ body: { did, followersCount: 77 } }, { body: { did: 'did:plc:other', followersCount: 5 } }],
    });
    const publisher = new BlueskyPublisher(fetchImpl);
    expect(await publisher.accountMetrics({ externalAccountId: did, secret: '{}' })).toEqual({ followers: 77 });
    expect(calls[0]?.query.get('actor')).toBe(did);
    expect(calls[0]?.authorization).toBeNull();
    expect(await publisher.accountMetrics({ externalAccountId: did, secret: '{}' })).toBeNull();
  });

  it("reads a YouTube channel's subscribers, none when the channel hides them", async () => {
    const channel = 'UC1234567890abcdefghijkl';
    const secret = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
    const { fetchImpl, calls } = routes({
      'GET www.googleapis.com/youtube/v3/channels': [
        { body: { items: [{ id: channel, statistics: { subscriberCount: '15400', hiddenSubscriberCount: false } }] } },
        { body: { items: [{ id: channel, statistics: { hiddenSubscriberCount: true } }] } },
        { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } },
      ],
    });
    const publisher = new YouTubePublisher({ clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' }, fetchImpl);
    expect(await publisher.accountMetrics({ externalAccountId: channel, secret })).toEqual({ followers: 15400 });
    expect(calls[0]?.query.get('part')).toBe('statistics');
    expect(calls[0]?.query.get('mine')).toBe('true');
    expect(await publisher.accountMetrics({ externalAccountId: channel, secret })).toEqual({ followers: null });
    expect(await publisher.accountMetrics({ externalAccountId: channel, secret })).toEqual({ refused: 'token_expired' });
  });

  it("reads a Zalo OA's followers from its profile, only for the same OA", async () => {
    const oa = '579745863508352884';
    const secret = JSON.stringify({ accessToken: 'zalo-access-1', refreshToken: 'zalo-refresh-1' });
    const { fetchImpl } = routes({
      'GET openapi.zalo.me/v2.0/oa/getoa': [{ body: { error: 0, message: 'Success', data: { oa_id: oa, name: 'Tiệm Bánh B', num_follower: 3120 } } }, { body: { error: 0, message: 'Success', data: { oa_id: '1', num_follower: 9 } } }],
    });
    const publisher = new ZaloOaPublisher({ appId: '4318000000000000001', appSecret: 'test-zalo-secret-not-real' }, fetchImpl);
    expect(await publisher.accountMetrics({ externalAccountId: oa, secret })).toEqual({ followers: 3120 });
    expect(await publisher.accountMetrics({ externalAccountId: oa, secret })).toBeNull();
  });
});
