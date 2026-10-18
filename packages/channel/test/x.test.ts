// X against recorded answers (shapes from the X API v2 docs: OAuth 2.0, POST /2/tweets, POST /2/media/upload); no
// live call.
import { describe, expect, it } from 'vitest';
import { XConnector, XPublisher, XRefresher, comparableText, newOAuthAttempt, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { clientId: 'M1M5R3BMVy13QmpScXkzTUt5OE46MTpjaQ', clientSecret: 'test-x-secret-not-real' };
const USER = '2244994945';
const SECRET = JSON.stringify({ accessToken: 'x-access-1', refreshToken: 'x-refresh-1' });
const REDIRECT = 'https://crove.example/channels/oauth/x/callback';
const SCOPE = 'tweet.read tweet.write users.read media.write offline.access';

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
function x(routes: Record<string, Answer[]>) {
  const calls: { route: string; headers: Headers; body: unknown; url: URL }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = raw instanceof FormData ? raw : typeof raw === 'string' ? (headers.get('content-type')?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : raw;
    calls.push({ route, headers, url, body });
    const answer = routes[route]?.shift() ?? { status: 500, body: { title: 'Internal', detail: `no answer for ${route}`, type: 'about:blank', status: 500 } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', ...answer.headers } });
  };
  return { calls, fetchImpl };
}

const image = { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 3, altText: null };
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: USER,
  secret: SECRET,
  content: { body: 'Khai trương chi nhánh mới & ưu đãi', title: null, linkUrl: 'https://example.com/a', media: [] },
  readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});

describe('XConnector', () => {
  it('asks for the posting scopes with PKCE, exchanges as a confidential client and names the account', async () => {
    const { fetchImpl, calls } = x({
      'POST api.x.com/2/oauth2/token': [{ body: { token_type: 'bearer', access_token: 'x-access-1', refresh_token: 'x-refresh-1', expires_in: 7200, scope: SCOPE } }],
      'GET api.x.com/2/users/me': [{ body: { data: { id: USER, name: 'Tiệm Bánh B', username: 'tiembanhb' } } }],
    });
    const connector = new XConnector(APP, fetchImpl);
    const attempt = newOAuthAttempt(connector.pkce);
    const url = new URL(connector.authorizeUrl({ state: attempt.state, redirectUri: REDIRECT, codeChallenge: attempt.codeChallenge }));
    expect(`${url.origin}${url.pathname}`).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: APP.clientId, scope: SCOPE, code_challenge_method: 'S256', code_challenge: attempt.codeChallenge });
    const [account] = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: attempt.codeVerifier }, 1_000_000);
    expect(account).toMatchObject({ provider: 'x', externalAccountId: USER, displayName: 'Tiệm Bánh B (@tiembanhb)', secret: SECRET, expiresAt: new Date(1_000_000 + 7_200_000) });
    expect(calls[0]?.body).toEqual({ grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT, code_verifier: attempt.codeVerifier });
    expect(calls[0]?.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString('base64')}`);
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer x-access-1');
  });

  it('refuses a grant without media.write, a missing verifier and a used code', async () => {
    const narrow = x({ 'POST api.x.com/2/oauth2/token': [{ body: { access_token: 't', refresh_token: 'r', expires_in: 7200, scope: 'tweet.read tweet.write users.read offline.access' } }] });
    await expect(new XConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: 'v' })).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    await expect(new XConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const used = x({ 'POST api.x.com/2/oauth2/token': [{ status: 400, body: { error: 'invalid_request', error_description: 'Value passed for the authorization code was invalid.' } }] });
    await expect(new XConnector(APP, used.fetchImpl).exchange({ code: 'used', redirectUri: REDIRECT, codeVerifier: 'v' })).rejects.toMatchObject({ kind: 'invalid_grant', code: 'invalid_request' });
    const misconfigured = x({ 'POST api.x.com/2/oauth2/token': [{ status: 401, body: { error: 'invalid_client', error_description: 'Missing valid authorization header' } }] });
    await expect(new XConnector(APP, misconfigured.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: 'v' })).rejects.toMatchObject({ kind: 'provider', code: 'invalid_client' });
    expect(() => new XConnector({ clientId: 'short', clientSecret: 's' })).toThrow('invalid X client id');
  });
});

describe('XRefresher', () => {
  it('renews the two-hour token half an hour ahead, keeps the rotated refresh token, and tells a dead grant from an outage', async () => {
    const ok = x({ 'POST api.x.com/2/oauth2/token': [{ body: { access_token: 'x-access-2', refresh_token: 'x-refresh-2', expires_in: 7200 } }] });
    const refresher = new XRefresher(APP, ok.fetchImpl);
    expect(refresher.horizonSeconds).toBe(1800);
    expect(await refresher.refresh(SECRET)).toMatchObject({ secret: JSON.stringify({ accessToken: 'x-access-2', refreshToken: 'x-refresh-2' }) });
    expect(ok.calls[0]?.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'x-refresh-1' });
    const kept = x({ 'POST api.x.com/2/oauth2/token': [{ body: { access_token: 'x-access-3', expires_in: 7200 } }] });
    expect(await new XRefresher(APP, kept.fetchImpl).refresh(SECRET)).toMatchObject({ secret: JSON.stringify({ accessToken: 'x-access-3', refreshToken: 'x-refresh-1' }) });
    const dead = x({ 'POST api.x.com/2/oauth2/token': [{ status: 400, body: { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' } }] });
    expect(await new XRefresher(APP, dead.fetchImpl).refresh(SECRET)).toEqual({ refused: 'invalid_request' });
    const down = x({ 'POST api.x.com/2/oauth2/token': [{ status: 503, body: {} }] });
    expect(await new XRefresher(APP, down.fetchImpl).refresh(SECRET)).toEqual({ failed: '503' });
    expect(await refresher.refresh('{}')).toEqual({ refused: 'NO_REFRESH_TOKEN' });
  });
});

describe('XPublisher', () => {
  it('uploads each image, then posts the text with the link and the media ids', async () => {
    const { fetchImpl, calls } = x({
      'POST api.x.com/2/media/upload': [{ body: { data: { id: '1146654567674912769', media_key: '3_1146654567674912769' } } }, { body: { data: { id: '1146654567674912770' } } }],
      'POST api.x.com/2/tweets': [{ status: 201, body: { data: { id: '1445880548472328192', text: 'Khai trương' } } }],
    });
    const result = await new XPublisher(APP, fetchImpl).publish(input({ content: { ...input().content, media: [image, { ...image, fileId: 'f-2', mime: 'image/png' }] } }));
    expect(result).toEqual({ kind: 'accepted', externalId: '1445880548472328192', url: 'https://x.com/i/status/1445880548472328192' });
    const upload = calls[0]?.body as FormData;
    expect(upload.get('media_category')).toBe('tweet_image');
    expect((upload.get('media') as Blob).type).toBe('image/jpeg');
    expect(calls[2]?.body).toEqual({ text: 'Khai trương chi nhánh mới & ưu đãi\n\nhttps://example.com/a', media: { media_ids: ['1146654567674912769', '1146654567674912770'] } });
  });

  it('posts nothing for a video, an empty post or an unreadable image', async () => {
    const none = x({});
    const publisher = new XPublisher(APP, none.fetchImpl);
    expect(await publisher.publish(input({ content: { ...input().content, media: [{ ...image, mime: 'video/mp4' }] } }))).toMatchObject({ kind: 'rejected', code: 'VIDEO_NOT_SUPPORTED' });
    expect(await publisher.publish(input({ content: { body: ' ', title: null, linkUrl: null, media: [] } }))).toMatchObject({ kind: 'rejected', code: 'EMPTY_POST' });
    expect(
      await publisher.publish(
        input({
          content: { ...input().content, media: [image] },
          readMedia: async () => {
            throw new Error('gone');
          },
        }),
      ),
    ).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(none.calls).toHaveLength(0);
  });

  it('waits out the rate limit until X resets it, and treats a failed image upload as nothing posted', async () => {
    const reset = Math.floor(Date.now() / 1000) + 900;
    const limited = x({ 'POST api.x.com/2/tweets': [{ status: 429, headers: { 'x-rate-limit-reset': String(reset) }, body: { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank', status: 429 } }] });
    expect(await new XPublisher(APP, limited.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'rate_limited', retryAt: new Date(reset * 1000) });
    const capped = x({ 'POST api.x.com/2/tweets': [{ status: 429, body: { title: 'UsageCapExceeded', detail: 'Usage cap exceeded: Monthly product cap', type: 'https://api.x.com/2/problems/usage-capped', status: 429 } }] });
    expect(await new XPublisher(APP, capped.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'usage-capped' });
    const broke = x({ 'POST api.x.com/2/tweets': [{ status: 402, body: { title: 'Payment Required', detail: 'Your account has no credits left.', type: 'about:blank', status: 402 } }] });
    expect(await new XPublisher(APP, broke.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'permission', httpStatus: 402 });
    const dead = x({ 'POST api.x.com/2/tweets': [{ status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' } }] });
    expect(await new XPublisher(APP, dead.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const upload = x({ 'POST api.x.com/2/media/upload': [{ status: 503, body: {} }] });
    expect(await new XPublisher(APP, upload.fetchImpl).publish(input({ content: { ...input().content, media: [image] } }))).toMatchObject({ kind: 'rejected', error: 'transient' });
    expect(upload.calls.map((c) => c.route)).toEqual(['POST api.x.com/2/media/upload']);
  });

  it('treats a lost answer to the post as unknown and finds the post among the account’s latest by its text', async () => {
    const { fetchImpl, calls } = x({
      'POST api.x.com/2/tweets': [{ status: 503, body: {} }],
      'GET api.x.com/2/users/2244994945/tweets': [
        {
          body: {
            data: [
              { id: '1445880548472328190', text: 'Something else', created_at: new Date().toISOString() },
              { id: '1445880548472328192', text: 'Khai trương chi nhánh mới &amp; ưu đãi\n\nhttps://t.co/abc123 https://t.co/media1', created_at: new Date().toISOString() },
            ],
          },
        },
        { body: { meta: { result_count: 0 } } },
      ],
    });
    const publisher = new XPublisher(APP, fetchImpl);
    expect((await publisher.publish(input())).kind).toBe('unknown');
    const window = { externalAccountId: USER, secret: SECRET, callKey: 'call-1', contentHash: input().contentHash, content: input().content, after: new Date(Date.now() - 60_000), before: new Date() };
    expect(await publisher.reconcile(window)).toEqual({ found: true, externalId: '1445880548472328192', url: 'https://x.com/i/status/1445880548472328192' });
    expect(calls[1]?.url.searchParams.get('exclude')).toBe('replies,retweets');
    expect(await publisher.reconcile(window)).toEqual({ found: false });
    // An image-only post has nothing to match by.
    expect(await publisher.reconcile({ ...window, content: { body: '', title: null, linkUrl: null, media: [image] } })).toEqual({ found: 'unknown' });
  });

  it('compares text the way X returns it', () => {
    expect(comparableText('a &lt;b&gt; &amp; c https://t.co/x')).toBe('a <b> & c');
    expect(comparableText('Việt'.normalize('NFD'))).toBe('Việt');
  });
});
