// Zalo OA against recorded answers (shapes from Zalo's OA API docs); no live call.
import { describe, expect, it } from 'vitest';
import { newOAuthAttempt, ZaloOaConnector, ZaloOaPublisher, ZaloOaRefresher, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { appId: '4318000000000000001', appSecret: 'test-zalo-secret-not-real' };
const REDIRECT = 'https://crove.example/channels/oauth/zalo_oa/callback';
const SECRET = JSON.stringify({ accessToken: 'zalo-access-1', refreshToken: 'zalo-refresh-1' });

function zalo(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; headers: Headers; form: URLSearchParams; json: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ route, headers, form: new URLSearchParams(headers.get('content-type')?.includes('urlencoded') ? body : ''), json: headers.get('content-type')?.includes('json') ? JSON.parse(body) : null });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: -1, message: `no answer for ${route}` } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

describe('ZaloOaConnector', () => {
  it('sends the OA admin to Zalo with a PKCE challenge, and connects the OA the code is for', async () => {
    const { fetchImpl, calls } = zalo({
      'POST oauth.zaloapp.com/v4/oa/access_token': [{ body: { access_token: 'zalo-access-1', refresh_token: 'zalo-refresh-1', expires_in: '90000' } }],
      'GET openapi.zalo.me/v2.0/oa/getoa': [{ body: { error: 0, message: 'Success', data: { oa_id: '579745863508352884', name: 'Tiệm Bánh B' } } }],
    });
    const connector = new ZaloOaConnector(APP, fetchImpl);
    expect(connector.pkce).toBe(true);
    const attempt = newOAuthAttempt(true);
    const url = new URL(connector.authorizeUrl({ state: attempt.state, redirectUri: REDIRECT, codeChallenge: attempt.codeChallenge }));
    expect(`${url.origin}${url.pathname}`).toBe('https://oauth.zaloapp.com/v4/oa/permission');
    expect(Object.fromEntries(url.searchParams)).toEqual({ app_id: APP.appId, redirect_uri: REDIRECT, code_challenge: attempt.codeChallenge, state: attempt.state });

    const before = Date.now();
    const [account] = await connector.exchange({ code: 'zalo-code', redirectUri: REDIRECT, codeVerifier: attempt.codeVerifier });
    expect(account).toMatchObject({ provider: 'zalo_oa', externalAccountId: '579745863508352884', displayName: 'Tiệm Bánh B', secret: SECRET });
    expect(account?.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 90_000_000);
    // The secret goes in the secret_key header, the verifier and code in the form; the token in the access_token header.
    expect(calls[0]?.headers.get('secret_key')).toBe(APP.appSecret);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ app_id: APP.appId, code: 'zalo-code', grant_type: 'authorization_code', code_verifier: attempt.codeVerifier });
    expect(calls[1]?.headers.get('access_token')).toBe('zalo-access-1');
  });

  it('maps a refused code to invalid_grant', async () => {
    const { fetchImpl } = zalo({ 'POST oauth.zaloapp.com/v4/oa/access_token': [{ status: 400, body: { error: -14019, error_name: 'Invalid code', error_description: 'Invalid code' } }] });
    await expect(new ZaloOaConnector(APP, fetchImpl).exchange({ code: 'used', redirectUri: REDIRECT, codeVerifier: 'v'.repeat(43) })).rejects.toMatchObject({ kind: 'invalid_grant' });
  });
});

describe('ZaloOaRefresher', () => {
  it('trades the single-use refresh token for a new pair', async () => {
    const { fetchImpl, calls } = zalo({ 'POST oauth.zaloapp.com/v4/oa/access_token': [{ body: { access_token: 'zalo-access-2', refresh_token: 'zalo-refresh-2', expires_in: '90000' } }] });
    const result = await new ZaloOaRefresher(APP, fetchImpl).refresh(SECRET);
    expect(result).toMatchObject({ secret: JSON.stringify({ accessToken: 'zalo-access-2', refreshToken: 'zalo-refresh-2' }) });
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ app_id: APP.appId, refresh_token: 'zalo-refresh-1', grant_type: 'refresh_token' });
  });

  it('tells a refused refresh token apart from an outage', async () => {
    const refused = zalo({ 'POST oauth.zaloapp.com/v4/oa/access_token': [{ status: 400, body: { error: -14020, error_description: 'Invalid refresh token' } }] });
    expect(await new ZaloOaRefresher(APP, refused.fetchImpl).refresh(SECRET)).toEqual({ refused: '-14020' });
    const down = zalo({ 'POST oauth.zaloapp.com/v4/oa/access_token': [{ status: 503, body: {} }] });
    expect(await new ZaloOaRefresher(APP, down.fetchImpl).refresh(SECRET)).toEqual({ failed: '503' });
    // A rate limit, or an error code Crove does not know, is not a dead token: the next sweep tries again.
    const limited = zalo({ 'POST oauth.zaloapp.com/v4/oa/access_token': [{ status: 429, body: { error: -32, message: 'Too many requests' } }] });
    expect(await new ZaloOaRefresher(APP, limited.fetchImpl).refresh(SECRET)).toEqual({ failed: '-32' });
    const odd = zalo({ 'POST oauth.zaloapp.com/v4/oa/access_token': [{ body: { error: -9999, message: 'Something else' } }] });
    expect(await new ZaloOaRefresher(APP, odd.fetchImpl).refresh(SECRET)).toEqual({ failed: '-9999' });
    const named = zalo({ 'POST oauth.zaloapp.com/v4/oa/access_token': [{ body: { error: -14001, error_description: 'Refresh token is expired' } }] });
    expect(await new ZaloOaRefresher(APP, named.fetchImpl).refresh(SECRET)).toEqual({ refused: '-14001' });
  });
});

describe('ZaloOaPublisher', () => {
  const input = (over: Partial<PublishInput> = {}): PublishInput => ({
    externalAccountId: '579745863508352884',
    secret: SECRET,
    content: { body: 'Khai trương chi nhánh mới.\n\nGiảm 20% tuần đầu.', title: 'Khai trương', linkUrl: 'https://example.com/a', media: [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 500_000, altText: null }] },
    readMedia: async () => {
      throw new Error('Zalo fetches the cover itself');
    },
    mediaUrl: async () => 'https://bucket.example/f-1?sig=1',
    settings: {},
    callKey: 'call-1',
    contentHash: `sha256:${'0'.repeat(64)}`,
    ...over,
  });

  it('creates the article with its cover and text, and returns its id once Zalo has processed it', async () => {
    const { fetchImpl, calls } = zalo({
      'POST openapi.zalo.me/v2.0/article/create': [{ body: { error: 0, data: { token: 'tok-1' } } }],
      'POST openapi.zalo.me/v2.0/article/verify': [{ body: { error: 0, data: { id: 'art-1' } } }],
    });
    expect(await new ZaloOaPublisher(APP, fetchImpl).publish(input())).toEqual({ kind: 'accepted', externalId: 'art-1', url: null });
    expect(calls[0]?.json).toEqual({
      type: 'normal',
      title: 'Khai trương',
      author: 'Crove',
      cover: { cover_type: 'photo', photo_url: 'https://bucket.example/f-1?sig=1', status: 'show' },
      description: 'Khai trương chi nhánh mới.',
      body: [
        { type: 'text', content: 'Khai trương chi nhánh mới.' },
        { type: 'text', content: 'Giảm 20% tuần đầu.' },
        { type: 'text', content: 'https://example.com/a' },
      ],
      status: 'show',
      comment: 'show',
    });
    expect(calls[1]?.json).toEqual({ token: 'tok-1' });
  });

  it('reports a token still processing as pending and finishes it on the status check', async () => {
    const { fetchImpl } = zalo({
      'POST openapi.zalo.me/v2.0/article/create': [{ body: { error: 0, data: { token: 'tok-2' } } }],
      'POST openapi.zalo.me/v2.0/article/verify': [{ body: { error: 0, data: {} } }, { body: { error: 0, data: { id: 'art-2' } } }],
    });
    const publisher = new ZaloOaPublisher(APP, fetchImpl);
    expect(await publisher.publish(input())).toEqual({ kind: 'pending', externalRef: 'tok-2', checkAfterSeconds: 20 });
    expect(await publisher.status({ externalAccountId: '579745863508352884', secret: SECRET, externalRef: 'tok-2' })).toEqual({ kind: 'accepted', externalId: 'art-2', url: null });
  });

  it('creates nothing without a cover URL, a cover or a title, and maps a refused token', async () => {
    const { fetchImpl, calls } = zalo({ 'POST openapi.zalo.me/v2.0/article/create': [{ body: { error: -216, message: 'Access token is invalid' } }] });
    const publisher = new ZaloOaPublisher(APP, fetchImpl);
    expect(await publisher.publish(input({ mediaUrl: async () => null }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(await publisher.publish(input({ content: { ...input().content, media: [] } }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_REQUIRED' });
    expect(await publisher.publish(input({ content: { ...input().content, title: ' ' } }))).toMatchObject({ kind: 'rejected', code: 'TITLE_REQUIRED' });
    expect(calls).toHaveLength(0);
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired', code: '-216' });
  });

  it('answers unknown when Zalo fails while creating, and reconciles by title', async () => {
    const down = zalo({ 'POST openapi.zalo.me/v2.0/article/create': [{ status: 502, body: {} }] });
    expect((await new ZaloOaPublisher(APP, down.fetchImpl).publish(input())).kind).toBe('unknown');
    const window = { externalAccountId: '579745863508352884', secret: SECRET, callKey: 'call-1', contentHash: `sha256:${'0'.repeat(64)}`, content: input().content, after: new Date(Date.now() - 600_000), before: new Date() };
    // Last week's article with the same title is not this one.
    const listing = zalo({
      'GET openapi.zalo.me/v2.0/article/getslice': [
        { body: { error: 0, data: { medias: [{ id: 'art-8', title: 'Khai trương', create_date: Date.now() - 7 * 86_400_000 }, { id: 'art-9', title: 'Khai trương', create_date: Date.now() - 120_000 }] } } },
        { body: { error: 0, data: { medias: [{ id: 'art-8', title: 'Khai trương', create_date: Date.now() - 7 * 86_400_000 }] } } },
        { body: { error: 0, data: { medias: [{ id: 'art-7', title: 'Khai trương' }] } } },
      ],
    });
    const publisher = new ZaloOaPublisher(APP, listing.fetchImpl);
    expect(await publisher.reconcile(window)).toEqual({ found: true, externalId: 'art-9', url: null });
    expect(await publisher.reconcile(window)).toEqual({ found: false });
    expect(await publisher.reconcile(window)).toEqual({ found: 'unknown' });
  });

  it('never answers a rejection once the article was created, and ends a status check Zalo refuses', async () => {
    const { fetchImpl } = zalo({
      'POST openapi.zalo.me/v2.0/article/create': [{ body: { error: 0, data: { token: 'tok-3' } } }],
      'POST openapi.zalo.me/v2.0/article/verify': [{ body: { error: -216, message: 'Access token is invalid' } }, { status: 400, body: { error: -201, message: 'Article failed' } }],
    });
    const publisher = new ZaloOaPublisher(APP, fetchImpl);
    expect(await publisher.publish(input())).toEqual({ kind: 'pending', externalRef: 'tok-3', checkAfterSeconds: 20 });
    expect(await publisher.status({ externalAccountId: '579745863508352884', secret: SECRET, externalRef: 'tok-3' })).toMatchObject({ kind: 'rejected', error: 'bad_request' });
  });
});

describe('ZaloOaPublisher metrics', () => {
  const metricsInput = { externalAccountId: '579745863508352884', secret: SECRET, externalId: 'a1b2c3d4e5' };

  it('reads the views and shares of an article, as numbers or numeric strings', async () => {
    const { fetchImpl, calls } = zalo({ 'GET openapi.zalo.me/v2.0/article/getdetail': [{ body: { error: 0, message: 'Success', data: { id: 'a1b2c3d4e5', total_view: '1520', total_share: 7 } } }] });
    expect(await new ZaloOaPublisher(APP, fetchImpl).metrics(metricsInput)).toEqual({ metrics: { views: 1520, shares: 7 } });
    expect(calls[0]?.headers.get('access_token')).toBe('zalo-access-1');
  });

  it('reports no counts when Zalo gives none, maps a refused token, and retries an outage later', async () => {
    const empty = zalo({ 'GET openapi.zalo.me/v2.0/article/getdetail': [{ body: { error: 0, message: 'Success', data: { id: 'a1b2c3d4e5' } } }] });
    expect(await new ZaloOaPublisher(APP, empty.fetchImpl).metrics(metricsInput)).toEqual({ metrics: {} });
    const dead = zalo({ 'GET openapi.zalo.me/v2.0/article/getdetail': [{ body: { error: -216, message: 'Access token is invalid' } }] });
    expect(await new ZaloOaPublisher(APP, dead.fetchImpl).metrics(metricsInput)).toEqual({ refused: 'token_expired' });
    const down = zalo({ 'GET openapi.zalo.me/v2.0/article/getdetail': [{ status: 502, body: {} }] });
    expect(await new ZaloOaPublisher(APP, down.fetchImpl).metrics(metricsInput)).toBeNull();
  });
});
