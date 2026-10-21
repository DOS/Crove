// X against recorded answers (shapes from the X API v2 docs: OAuth 2.0, POST /2/tweets, POST /2/media/upload); no
// live call.
import { describe, expect, it } from 'vitest';
import { XConnector, XPublisher, XRefresher, comparableText, newOAuthAttempt, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { clientId: 'M1M5R3BMVy13QmpScXkzTUt5OE46MTpjaQ', clientSecret: 'test-x-secret-not-real' };
const USER = '1580661436147937281';
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
    // A wrong client secret keeps the connections.
    const misconfigured = x({ 'POST api.x.com/2/oauth2/token': [{ status: 401, body: { error: 'invalid_client', error_description: 'Missing valid authorization header' } }] });
    expect(await new XRefresher(APP, misconfigured.fetchImpl).refresh(SECRET)).toEqual({ failed: 'invalid_client' });
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

  it('sets the alt text of each described image before the post, and posts nothing when that fails', async () => {
    const described = { ...image, altText: `Mặt tiền tiệm bánh ${'a'.repeat(1200)}` };
    const { fetchImpl, calls } = x({
      'POST api.x.com/2/media/upload': [{ body: { data: { id: '1146654567674912769' } } }, { body: { data: { id: '1146654567674912770' } } }],
      'POST api.x.com/2/media/metadata': [{ body: {} }],
      'POST api.x.com/2/tweets': [{ status: 201, body: { data: { id: '1445880548472328192' } } }],
    });
    const result = await new XPublisher(APP, fetchImpl).publish(input({ content: { ...input().content, media: [described, { ...image, fileId: 'f-2' }] } }));
    expect(result).toMatchObject({ kind: 'accepted', externalId: '1445880548472328192' });
    expect(calls.map((c) => c.route)).toEqual(['POST api.x.com/2/media/upload', 'POST api.x.com/2/media/metadata', 'POST api.x.com/2/media/upload', 'POST api.x.com/2/tweets']);
    const meta = calls[1]?.body as { id: string; metadata: { alt_text: { text: string } } };
    expect(meta.id).toBe('1146654567674912769');
    expect(meta.metadata.alt_text.text).toHaveLength(1000);
    const failed = x({ 'POST api.x.com/2/media/upload': [{ body: { data: { id: '1146654567674912769' } } }], 'POST api.x.com/2/media/metadata': [{ status: 503, body: {} }] });
    expect(await new XPublisher(APP, failed.fetchImpl).publish(input({ content: { ...input().content, media: [described] } }))).toMatchObject({ kind: 'rejected' });
    expect(failed.calls.some((c) => c.route === 'POST api.x.com/2/tweets')).toBe(false);
  });

  it('posts nothing for a video with images, an empty post or an unreadable image', async () => {
    const none = x({});
    const publisher = new XPublisher(APP, none.fetchImpl);
    expect(await publisher.publish(input({ content: { ...input().content, media: [{ ...image, mime: 'video/mp4' }, image] } }))).toMatchObject({ kind: 'rejected', code: 'ONE_VIDEO_REQUIRED' });
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

  describe('video', () => {
    const MB4 = 4 * 1024 * 1024;
    const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: MB4 + 10, altText: null };
    const withClip = (over: Partial<PublishInput> = {}) => input({ content: { ...input().content, media: [clip] }, readMedia: async () => new Uint8Array(MB4 + 10), ...over });
    const quick = { processingWaitMs: 1000, pollMinMs: 0 };
    const MEDIA = '1880000000000000001';

    it('uploads in chunks, waits for processing, then posts the video once', async () => {
      const { fetchImpl, calls } = x({
        'POST api.x.com/2/media/upload/initialize': [{ body: { data: { id: MEDIA, media_key: `7_${MEDIA}`, expires_after_secs: 86_400 } } }],
        [`POST api.x.com/2/media/upload/${MEDIA}/append`]: [{ body: {} }, { body: {} }],
        [`POST api.x.com/2/media/upload/${MEDIA}/finalize`]: [{ body: { data: { id: MEDIA, processing_info: { state: 'pending', check_after_secs: 0 } } } }],
        'GET api.x.com/2/media/upload': [{ body: { data: { processing_info: { state: 'in_progress', check_after_secs: 0, progress_percent: 40 } } } }, { body: { data: { processing_info: { state: 'succeeded', progress_percent: 100 } } } }],
        'POST api.x.com/2/tweets': [{ status: 201, body: { data: { id: '1445880548472328300', text: 'x' } } }],
      });
      const publisher = new XPublisher(APP, fetchImpl, quick);
      expect(publisher.callTimeoutMs).toBeGreaterThan(300_000);
      expect(publisher.callTimeoutMs).toBeLessThan(600_000);
      expect(await publisher.publish(withClip())).toEqual({ kind: 'accepted', externalId: '1445880548472328300', url: 'https://x.com/i/status/1445880548472328300' });
      expect(calls[0]?.body).toEqual({ media_type: 'video/mp4', total_bytes: MB4 + 10, media_category: 'tweet_video' });
      const appends = calls.filter((c) => c.route.endsWith('/append')).map((c) => c.body as FormData);
      expect(appends.map((f) => f.get('segment_index'))).toEqual(['0', '1']);
      expect(appends.map((f) => (f.get('media') as Blob).size)).toEqual([MB4, 10]);
      expect(calls.find((c) => c.route === 'GET api.x.com/2/media/upload')?.url.searchParams.get('command')).toBe('STATUS');
      expect(calls.at(-1)?.body).toEqual({ text: 'Khai trương chi nhánh mới & ưu đãi\n\nhttps://example.com/a', media: { media_ids: [MEDIA] } });
    });

    it('stops before posting once the call budget is spent, and keeps waiting on a status check without processing info', async () => {
      const spent = x({ 'POST api.x.com/2/media/upload/initialize': [{ body: { data: { id: MEDIA } } }] });
      expect(await new XPublisher(APP, spent.fetchImpl, { ...quick, budgetMs: 0 }).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'transient', code: 'VIDEO_TOO_SLOW' });
      expect(spent.calls.map((c) => c.route)).toEqual(['POST api.x.com/2/media/upload/initialize']);
      const blank = x({
        'POST api.x.com/2/media/upload/initialize': [{ body: { data: { id: MEDIA } } }],
        [`POST api.x.com/2/media/upload/${MEDIA}/append`]: [{ body: {} }, { body: {} }],
        [`POST api.x.com/2/media/upload/${MEDIA}/finalize`]: [{ body: { data: { processing_info: { state: 'pending', check_after_secs: 0 } } } }],
        'GET api.x.com/2/media/upload': [{ body: {} }, { body: { data: { processing_info: { state: 'succeeded' } } } }],
        'POST api.x.com/2/tweets': [{ status: 201, body: { data: { id: '1445880548472328301' } } }],
      });
      expect(await new XPublisher(APP, blank.fetchImpl, quick).publish(withClip())).toMatchObject({ kind: 'accepted', externalId: '1445880548472328301' });
      expect(blank.calls.filter((c) => c.route === 'GET api.x.com/2/media/upload')).toHaveLength(2);
    });

    it('posts nothing when processing fails, outlasts the wait, or a chunk is refused', async () => {
      const init = { 'POST api.x.com/2/media/upload/initialize': [{ body: { data: { id: MEDIA } } }] };
      const failed = x({
        ...init,
        [`POST api.x.com/2/media/upload/${MEDIA}/append`]: [{ body: {} }, { body: {} }],
        [`POST api.x.com/2/media/upload/${MEDIA}/finalize`]: [{ body: { data: { processing_info: { state: 'failed', error: { message: 'InvalidMedia' } } } } }],
      });
      expect(await new XPublisher(APP, failed.fetchImpl, quick).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'VIDEO_PROCESSING_FAILED', message: 'InvalidMedia' });
      const slow = x({
        'POST api.x.com/2/media/upload/initialize': [{ body: { data: { id: MEDIA } } }],
        [`POST api.x.com/2/media/upload/${MEDIA}/append`]: [{ body: {} }, { body: {} }],
        [`POST api.x.com/2/media/upload/${MEDIA}/finalize`]: [{ body: { data: { processing_info: { state: 'in_progress', check_after_secs: 0 } } } }],
        'GET api.x.com/2/media/upload': Array.from({ length: 200 }, () => ({ body: { data: { processing_info: { state: 'in_progress', check_after_secs: 0 } } } })),
      });
      expect(await new XPublisher(APP, slow.fetchImpl, { processingWaitMs: 20, pollMinMs: 5 }).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'transient', code: 'VIDEO_STILL_PROCESSING' });
      const refused = x({ 'POST api.x.com/2/media/upload/initialize': [{ body: { data: { id: MEDIA } } }], [`POST api.x.com/2/media/upload/${MEDIA}/append`]: [{ status: 503, body: {} }] });
      expect(await new XPublisher(APP, refused.fetchImpl, quick).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'transient' });
      for (const run of [failed, slow, refused]) expect(run.calls.some((c) => c.route === 'POST api.x.com/2/tweets')).toBe(false);
    });
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
    const long = x({ 'POST api.x.com/2/tweets': [{ status: 403, body: { title: 'Forbidden', detail: 'Your Tweet text is too long.', type: 'about:blank', status: 403 } }] });
    expect(await new XPublisher(APP, long.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TEXT_TOO_LONG' });
    const upload = x({ 'POST api.x.com/2/media/upload': [{ status: 503, body: {} }] });
    expect(await new XPublisher(APP, upload.fetchImpl).publish(input({ content: { ...input().content, media: [image] } }))).toMatchObject({ kind: 'rejected', error: 'transient' });
    expect(upload.calls.map((c) => c.route)).toEqual(['POST api.x.com/2/media/upload']);
  });

  it('treats a lost answer to the post as unknown and finds the post among the account’s latest by its text', async () => {
    const { fetchImpl, calls } = x({
      'POST api.x.com/2/tweets': [{ status: 503, body: {} }],
      'GET api.x.com/2/users/1580661436147937281/tweets': [
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
    // A bare link X turned into t.co still matches; a host on a rare TLD makes a miss unknown, not missing.
    const bare = x({ 'GET api.x.com/2/users/1580661436147937281/tweets': [{ body: { data: [{ id: '1445880548472328193', text: 'ghé https://t.co/zz nhé', created_at: new Date().toISOString() }] } }, { body: { data: [] } }] });
    const content = { body: 'ghé crove.vn/gia nhé', title: null, linkUrl: null, media: [] };
    expect(await new XPublisher(APP, bare.fetchImpl).reconcile({ ...window, content })).toMatchObject({ found: true, externalId: '1445880548472328193' });
    expect(await new XPublisher(APP, bare.fetchImpl).reconcile({ ...window, content: { ...content, body: 'ghé crove.studio nhé' } })).toEqual({ found: 'unknown' });
    // An image-only post has nothing to match by.
    expect(await publisher.reconcile({ ...window, content: { body: '', title: null, linkUrl: null, media: [image] } })).toEqual({ found: 'unknown' });
  });

  it('compares text the way X returns it', () => {
    expect(comparableText('a &lt;b&gt; &amp; c https://t.co/x')).toBe('a <b> & c');
    expect(comparableText('&amp;lt;')).toBe('&lt;');
    expect(comparableText('Việt'.normalize('NFD'))).toBe('Việt');
  });
});

describe('X post counts (#797)', () => {
  const POST = '1445880548472328192';
  const metricsInput = { externalAccountId: USER, secret: SECRET, externalId: POST };

  it('reads nothing unless the deployment turns it on, since X bills every read', () => {
    expect(new XPublisher(APP).metrics).toBeUndefined();
    expect(new XPublisher(APP, undefined, {}, { metrics: true }).metrics).toBeTypeOf('function');
  });

  it('maps public_metrics, counting quotes with reposts', async () => {
    const { fetchImpl, calls } = x({ 'GET api.x.com/2/tweets/1445880548472328192': [{ body: { data: { id: POST, public_metrics: { like_count: 12, reply_count: 3, retweet_count: 4, quote_count: 1, bookmark_count: 2, impression_count: 900 } } } }] });
    expect(await new XPublisher(APP, fetchImpl, {}, { metrics: true }).metrics?.(metricsInput)).toEqual({ metrics: { reactions: 12, comments: 3, shares: 5, saves: 2, impressions: 900 } });
    expect(calls[0]?.url.searchParams.get('tweet.fields')).toBe('public_metrics');
  });

  it('tells a deleted post, a dead token and an outage apart', async () => {
    const ask = (answer: { status?: number; body?: unknown }) => new XPublisher(APP, x({ 'GET api.x.com/2/tweets/1445880548472328192': [answer] }).fetchImpl, {}, { metrics: true }).metrics?.(metricsInput);
    expect(await ask({ body: { errors: [{ title: 'Not Found Error', type: 'https://api.x.com/2/problems/resource-not-found' }] } })).toEqual({ refused: 'gone' });
    expect(await ask({ status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401 } })).toEqual({ refused: 'token_expired' });
    expect(await ask({ status: 503, body: {} })).toBeNull();
  });
});

describe('X followers (#819)', () => {
  it('reads followers only on the metrics switch, for the connected account', async () => {
    expect(new XPublisher(APP).accountMetrics).toBeUndefined();
    const { fetchImpl, calls } = x({ 'GET api.x.com/2/users/me': [{ body: { data: { id: USER, public_metrics: { followers_count: 321, following_count: 5 } } } }, { body: { data: { id: '999', public_metrics: { followers_count: 1 } } } }] });
    const publisher = new XPublisher(APP, fetchImpl, {}, { metrics: true });
    expect(await publisher.accountMetrics?.({ externalAccountId: USER, secret: SECRET })).toEqual({ followers: 321 });
    expect(calls[0]?.url.searchParams.get('user.fields')).toBe('public_metrics');
    // Another account answered (a token for someone else): nothing kept.
    expect(await publisher.accountMetrics?.({ externalAccountId: USER, secret: SECRET })).toBeNull();
  });
});

describe('X remove (#860)', () => {
  const POST = '1445880548472328192';
  const DELETE = `DELETE api.x.com/2/tweets/${POST}`;
  const remove = (fetchImpl: Fetch, externalId = POST) => new XPublisher(APP, fetchImpl).remove({ externalAccountId: USER, secret: SECRET, externalId });

  it('deletes the post with the account token', async () => {
    const { fetchImpl, calls } = x({ [DELETE]: [{ body: { data: { deleted: true } } }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
    expect(calls.map((c) => [c.route, c.headers.get('authorization')])).toEqual([[DELETE, 'Bearer x-access-1']]);
  });

  it('counts a post X no longer has as removed, and an answer that deleted nothing as unclear', async () => {
    const gone = x({ [DELETE]: [{ status: 404, body: { title: 'Not Found Error', detail: 'Could not find tweet', type: 'https://api.x.com/2/problems/resource-not-found' } }] });
    expect(await remove(gone.fetchImpl)).toEqual({ kind: 'removed' });
    const kept = x({ [DELETE]: [{ body: { data: { deleted: false } } }] });
    expect(await remove(kept.fetchImpl)).toEqual({ kind: 'unknown', code: 'NOT_DELETED' });
  });

  it('maps an expired token, a rate limit and a server error, and calls nothing for a malformed id', async () => {
    const expired = x({ [DELETE]: [{ status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' } }] });
    expect(await remove(expired.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const reset = Math.floor(Date.now() / 1000) + 900;
    const limited = x({ [DELETE]: [{ status: 429, body: { title: 'Too Many Requests', type: 'about:blank', status: 429 }, headers: { 'x-rate-limit-reset': String(reset) } }] });
    expect(await remove(limited.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'rate_limited', retryAt: new Date(reset * 1000) });
    const down = x({ [DELETE]: [{ status: 503, body: { title: 'Service Unavailable', type: 'about:blank', status: 503 } }] });
    expect(await remove(down.fetchImpl)).toMatchObject({ kind: 'unknown' });
    const none = x({});
    expect(await remove(none.fetchImpl, 'not-a-post')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(none.calls).toHaveLength(0);
  });
});
