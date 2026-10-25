// Zalo OA against recorded answers (shapes from Zalo's OA API docs); no live call.
import { describe, expect, it } from 'vitest';
import { newOAuthAttempt, ZaloOaConnector, ZaloOaPublisher, ZaloOaRefresher, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { appId: '4318000000000000001', appSecret: 'test-zalo-secret-not-real' };
const REDIRECT = 'https://crove.example/channels/oauth/zalo_oa/callback';
const SECRET = JSON.stringify({ accessToken: 'zalo-access-1', refreshToken: 'zalo-refresh-1' });

function zalo(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; headers: Headers; form: URLSearchParams; json: unknown; multipart: FormData | null; query: URLSearchParams }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      route,
      headers,
      form: new URLSearchParams(headers.get('content-type')?.includes('urlencoded') ? body : ''),
      json: headers.get('content-type')?.includes('json') ? JSON.parse(body) : null,
      multipart: init?.body instanceof FormData ? init.body : null,
      query: url.searchParams,
    });
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

  // A post with one image is the article it was before #943: the image is the cover alone, comments on.
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

  // #1045: an article with no author set is signed with the product name users see (BRAND_NAME).
  it('signs an article with no author set by the configured default author', async () => {
    const { fetchImpl, calls } = zalo({
      'POST openapi.zalo.me/v2.0/article/create': [{ body: { error: 0, data: { token: 'tok-9' } } }],
      'POST openapi.zalo.me/v2.0/article/verify': [{ body: { error: 0, data: { id: 'art-9' } } }],
    });
    await new ZaloOaPublisher({ ...APP, defaultAuthor: 'Tên Mới' }, fetchImpl).publish(input());
    expect(calls[0]?.json).toMatchObject({ author: 'Tên Mới' });
  });

  it('sends every image in order: the first as the cover, the others after the text, captioned with their alt text (#943)', async () => {
    const { fetchImpl, calls } = zalo({
      'POST openapi.zalo.me/v2.0/article/create': [{ body: { error: 0, data: { token: 'tok-4' } } }],
      'POST openapi.zalo.me/v2.0/article/verify': [{ body: { error: 0, data: { id: 'art-4' } } }],
    });
    const media = [
      { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 500_000, altText: 'Mặt tiền cửa hàng' },
      { fileId: 'f-2', mime: 'image/png', sizeBytes: 300_000, altText: 'Quầy bánh mì' },
      { fileId: 'f-3', mime: 'image/jpeg', sizeBytes: 1024 * 1024, altText: null },
      { fileId: 'f-4', mime: 'image/webp', sizeBytes: 200_000, altText: '  Bàn ghế ngoài trời ' },
    ];
    const asked: string[] = [];
    const publish = input({
      content: { ...input().content, media },
      mediaUrl: async (fileId) => {
        asked.push(fileId);
        return `https://bucket.example/${fileId}?sig=1`;
      },
    });
    expect(await new ZaloOaPublisher(APP, fetchImpl).publish(publish)).toEqual({ kind: 'accepted', externalId: 'art-4', url: null });
    expect(asked).toEqual(['f-1', 'f-2', 'f-3', 'f-4']);
    // Still one article and one check: Zalo fetches the images itself.
    expect(calls.map((c) => c.route)).toEqual(['POST openapi.zalo.me/v2.0/article/create', 'POST openapi.zalo.me/v2.0/article/verify']);
    expect(calls[0]?.json).toMatchObject({
      cover: { cover_type: 'photo', photo_url: 'https://bucket.example/f-1?sig=1', status: 'show' },
      body: [
        { type: 'text', content: 'Khai trương chi nhánh mới.' },
        { type: 'text', content: 'Giảm 20% tuần đầu.' },
        { type: 'text', content: 'https://example.com/a' },
        { type: 'image', url: 'https://bucket.example/f-2?sig=1', caption: 'Quầy bánh mì' },
        { type: 'image', url: 'https://bucket.example/f-3?sig=1' },
        { type: 'image', url: 'https://bucket.example/f-4?sig=1', caption: 'Bàn ghế ngoài trời' },
      ],
      comment: 'show',
    });
  });

  it('turns comments off when settings.comments is false, and keeps them on otherwise (#943)', async () => {
    const { fetchImpl, calls } = zalo({
      'POST openapi.zalo.me/v2.0/article/create': [{ body: { error: 0, data: { token: 'tok-5' } } }, { body: { error: 0, data: { token: 'tok-6' } } }],
      'POST openapi.zalo.me/v2.0/article/verify': [{ body: { error: 0, data: { id: 'art-5' } } }, { body: { error: 0, data: { id: 'art-6' } } }],
    });
    const publisher = new ZaloOaPublisher(APP, fetchImpl);
    await publisher.publish(input({ settings: { comments: false } }));
    await publisher.publish(input({ settings: { comments: true } }));
    expect(calls[0]?.json).toMatchObject({ comment: 'hide' });
    expect(calls[2]?.json).toMatchObject({ comment: 'show' });
  });

  it('creates nothing for more than 10 images, an image over 1 MB, or an image without a URL (#943)', async () => {
    const { fetchImpl, calls } = zalo({});
    const publisher = new ZaloOaPublisher(APP, fetchImpl);
    const image = (i: number, sizeBytes = 100_000) => ({ fileId: `f-${i}`, mime: 'image/jpeg', sizeBytes, altText: null });
    expect(await publisher.publish(input({ content: { ...input().content, media: Array.from({ length: 11 }, (_, i) => image(i)) } }))).toMatchObject({ kind: 'rejected', code: 'TOO_MANY_MEDIA' });
    expect(await publisher.publish(input({ content: { ...input().content, media: [image(1), image(2, 1024 * 1024 + 1)] } }))).toMatchObject({ kind: 'rejected', code: 'IMAGE_TOO_LARGE' });
    const third = input({ content: { ...input().content, media: [image(1), image(2), image(3)] }, mediaUrl: async (fileId) => (fileId === 'f-3' ? null : `https://bucket.example/${fileId}`) });
    expect(await publisher.publish(third)).toMatchObject({ kind: 'rejected', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
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

// Video articles (#1429), against answers shaped like Zalo's OA content docs (upload_video/preparevideo, then
// upload_video/verify, then article/create with type video).
describe('ZaloOaPublisher video articles', () => {
  const UPLOAD = 'POST openapi.zalo.me/v2.0/article/upload_video/preparevideo';
  const CHECK = 'GET openapi.zalo.me/v2.0/article/upload_video/verify';
  const CREATE = 'POST openapi.zalo.me/v2.0/article/create';
  const VERIFY = 'POST openapi.zalo.me/v2.0/article/verify';
  const SLICE = 'GET openapi.zalo.me/v2.0/article/getslice';
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 12_000_000, altText: null, durationSeconds: 42 };
  const content = { body: 'Mở bán bánh trung thu.\n\nĐặt trước giảm 10%.', title: 'Bánh trung thu 2026', linkUrl: null, media: [clip] };
  const input = (over: Partial<PublishInput> = {}): PublishInput => ({
    externalAccountId: '579745863508352884',
    secret: SECRET,
    content,
    readMedia: async (fileId) => {
      if (fileId !== 'v-1') throw new Error('only the video is read');
      return bytes;
    },
    mediaUrl: async (fileId) => `https://bucket.example/${fileId}?sig=1`,
    settings: { cover: { fileId: 'c-1' } },
    callKey: 'call-1',
    contentHash: `sha256:${'0'.repeat(64)}`,
    ...over,
  });
  const fast = { pollMs: 0 };
  const ready = { body: { error: 0, message: 'Success', data: { status: 1, video_id: 'f9377bde4e9ba7c5fe8', status_message: 'Video is ready', convert_percent: 100 } } };
  const converting = { body: { error: 0, message: 'Success', data: { status: 3, video_id: 'f9377bde4e9ba7c5fe8', status_message: 'Video is being converted', convert_percent: 0 } } };

  it('uploads the video once, waits for its video_id, creates one video article and returns its id', async () => {
    const { fetchImpl, calls } = zalo({
      [UPLOAD]: [{ body: { error: 0, message: 'Success', data: { token: 'vtok-1' } } }],
      [CHECK]: [converting, ready],
      [CREATE]: [{ body: { error: 0, data: { token: 'tok-v1' } } }],
      [VERIFY]: [{ body: { error: 0, data: { id: 'art-v1' } } }],
    });
    expect(await new ZaloOaPublisher(APP, fetchImpl, fast).publish(input())).toEqual({ kind: 'accepted', externalId: 'art-v1', url: null });
    expect(calls.map((c) => c.route)).toEqual([UPLOAD, CHECK, CHECK, CREATE, VERIFY]);
    // The file goes up as the multipart field `file`; the check sends the upload's token as a header.
    const file = calls[0]?.multipart?.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(bytes);
    expect(calls[0]?.headers.get('access_token')).toBe('zalo-access-1');
    expect(calls[1]?.headers.get('token')).toBe('vtok-1');
    expect(calls[1]?.headers.get('access_token')).toBe('zalo-access-1');
    expect(calls[3]?.json).toEqual({
      type: 'video',
      title: 'Bánh trung thu 2026',
      description: 'Mở bán bánh trung thu.',
      video_id: 'f9377bde4e9ba7c5fe8',
      avatar: 'https://bucket.example/c-1?sig=1',
      status: 'show',
      comment: 'show',
    });
    expect(calls[4]?.json).toEqual({ token: 'tok-v1' });
  });

  it('asks for the thumbnail URL again right before article/create, since a presigned URL lives a minute (#1429 review)', async () => {
    const { fetchImpl, calls } = zalo({
      [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-5' } } }],
      [CHECK]: [converting, ready],
      [CREATE]: [{ body: { error: 0, data: { token: 'tok-v5' } } }],
      [VERIFY]: [{ body: { error: 0, data: { id: 'art-v5' } } }],
    });
    // Each URL names how many Zalo calls were made before it was asked for.
    const minted: string[] = [];
    const mediaUrl = async (fileId: string) => {
      const url = `https://bucket.example/${fileId}?after=${calls.length}`;
      minted.push(url);
      return url;
    };
    expect(await new ZaloOaPublisher(APP, fetchImpl, fast).publish(input({ mediaUrl }))).toEqual({ kind: 'accepted', externalId: 'art-v5', url: null });
    // One check before the upload, one after the video is ready; the article names the second.
    expect(minted).toEqual(['https://bucket.example/c-1?after=0', 'https://bucket.example/c-1?after=3']);
    expect(calls[3]?.json).toMatchObject({ avatar: 'https://bucket.example/c-1?after=3' });
    // A URL the storage cannot give by then is transient: nothing is visible yet.
    const again = zalo({ [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-6' } } }], [CHECK]: [ready] });
    let asked = 0;
    const gone = async (fileId: string) => (++asked === 1 ? `https://bucket.example/${fileId}` : null);
    expect(await new ZaloOaPublisher(APP, again.fetchImpl, fast).publish(input({ mediaUrl: gone }))).toEqual({ kind: 'rejected', error: 'transient', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(again.calls.some((c) => c.route === CREATE)).toBe(false);
  });

  it('cuts the description to 300 characters and turns comments off when settings.comments is false', async () => {
    const { fetchImpl, calls } = zalo({
      [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-2' } } }],
      [CHECK]: [ready],
      [CREATE]: [{ body: { error: 0, data: { token: 'tok-v2' } } }],
      [VERIFY]: [{ body: { error: 0, data: {} } }],
    });
    const long = { ...content, body: `${'á'.repeat(400)}\nphần sau` };
    const result = await new ZaloOaPublisher(APP, fetchImpl, fast).publish(input({ content: long, settings: { cover: { fileId: 'c-1' }, comments: false } }));
    // Zalo still processing the article is pending, as for an image article.
    expect(result).toEqual({ kind: 'pending', externalRef: 'tok-v2', checkAfterSeconds: 20 });
    expect(calls[2]?.json).toMatchObject({ description: 'á'.repeat(300), comment: 'hide' });
  });

  it('creates no article for a video still processing when the wait ends; the next attempt uploads again', async () => {
    const { fetchImpl, calls } = zalo({ [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-3' } } }], [CHECK]: [converting, converting] });
    const result = await new ZaloOaPublisher(APP, fetchImpl, { pollMs: 0, processingWaitMs: 0 }).publish(input());
    expect(result).toEqual({ kind: 'rejected', error: 'transient', code: 'ZALO_VIDEO_PROCESSING' });
    expect(calls.map((c) => c.route)).toEqual([UPLOAD, CHECK]);
    // A spent budget stops before the article too.
    const late = zalo({ [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-4' } } }], [CHECK]: [ready] });
    expect(await new ZaloOaPublisher(APP, late.fetchImpl, { pollMs: 0, budgetMs: 0 }).publish(input())).toEqual({ kind: 'rejected', error: 'transient', code: 'ZALO_VIDEO_PROCESSING' });
    expect(late.calls.some((c) => c.route === CREATE)).toBe(false);
  });

  it('refuses a video Zalo locked, failed or deleted, with its own code and no article', async () => {
    for (const [status, code] of [
      [2, 'ZALO_VIDEO_LOCKED'],
      [4, 'ZALO_VIDEO_FAILED'],
      [5, 'ZALO_VIDEO_DELETED'],
    ] as const) {
      const { fetchImpl, calls } = zalo({ [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-5' } } }], [CHECK]: [{ body: { error: 0, data: { status, status_message: 'Video failed', convert_error_code: 1 } } }] });
      expect(await new ZaloOaPublisher(APP, fetchImpl, fast).publish(input())).toEqual({ kind: 'rejected', error: 'bad_request', code, message: 'Video failed' });
      expect(calls.some((c) => c.route === CREATE)).toBe(false);
    }
  });

  it('turns an upload or check failure into a rejection, since nothing is visible yet', async () => {
    const down = zalo({ [UPLOAD]: [{ status: 502, body: {} }] });
    expect(await new ZaloOaPublisher(APP, down.fetchImpl, fast).publish(input())).toEqual({ kind: 'rejected', error: 'transient', code: 'HTTP_502' });
    const dead = zalo({ [UPLOAD]: [{ body: { error: -216, message: 'Access token is invalid' } }] });
    expect(await new ZaloOaPublisher(APP, dead.fetchImpl, fast).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired', code: '-216' });
    const lost = zalo({ [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-6' } } }], [CHECK]: [{ status: 503, body: {} }] });
    expect(await new ZaloOaPublisher(APP, lost.fetchImpl, fast).publish(input())).toEqual({ kind: 'rejected', error: 'transient', code: 'HTTP_503' });
    expect([...down.calls, ...dead.calls, ...lost.calls].some((c) => c.route === CREATE)).toBe(false);
  });

  it('refuses before any call a video without a cover image, without a public URL, of another type, over 50 MB or beside an image', async () => {
    const { fetchImpl, calls } = zalo({});
    const publisher = new ZaloOaPublisher(APP, fetchImpl, fast);
    expect(await publisher.publish(input({ settings: {} }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'ZALO_VIDEO_COVER_REQUIRED' });
    expect(await publisher.publish(input({ settings: { cover: { atMs: 1000 } } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' });
    // Local disk: the video could be uploaded, but Zalo fetches the thumbnail from a public URL.
    expect(await publisher.publish(input({ mediaUrl: async () => null }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(await publisher.publish(input({ content: { ...content, media: [{ ...clip, mime: 'video/quicktime' }] } }))).toMatchObject({ kind: 'rejected', code: 'VIDEO_TYPE' });
    expect(await publisher.publish(input({ content: { ...content, media: [{ ...clip, sizeBytes: 50 * 1024 * 1024 + 1 }] } }))).toMatchObject({ kind: 'rejected', code: 'VIDEO_TOO_LARGE' });
    const image = { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 500_000, altText: null };
    expect(await publisher.publish(input({ content: { ...content, media: [image, clip] } }))).toMatchObject({ kind: 'rejected', code: 'ONE_VIDEO_REQUIRED' });
    expect(await publisher.publish(input({ content: { ...content, title: '  ' } }))).toMatchObject({ kind: 'rejected', code: 'TITLE_REQUIRED' });
    expect(await publisher.publish(input({ readMedia: async () => Promise.reject(new Error('gone')) }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(calls).toHaveLength(0);
  });

  // The job records an unclear article/create as unknown and reconciles before anything else (reconcile_only): the
  // recorded answers below are that path, and the article is found once, never created a second time.
  it('answers unknown when article/create fails, then finds the article through getslice among video articles', async () => {
    const { fetchImpl, calls } = zalo({
      [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-7' } } }],
      [CHECK]: [ready],
      [CREATE]: [{ status: 502, body: {} }],
      [SLICE]: [{ body: { error: 0, message: 'Success', data: { medias: [{ id: 'art-old', type: 'video', title: 'Bánh trung thu 2026', create_date: Date.now() - 365 * 86_400_000 }, { id: 'art-v7', type: 'video', title: 'Bánh trung thu 2026', status: 'show', create_date: Date.now() - 30_000 }], total: 2 } } }],
    });
    const publisher = new ZaloOaPublisher(APP, fetchImpl, fast);
    expect(await publisher.publish(input())).toEqual({ kind: 'unknown', code: 'HTTP_502', message: 'Zalo answered 502' });
    const window = { externalAccountId: '579745863508352884', secret: SECRET, callKey: 'call-1', contentHash: `sha256:${'0'.repeat(64)}`, content, settings: { cover: { fileId: 'c-1' } }, after: new Date(Date.now() - 600_000), before: new Date() };
    expect(await publisher.reconcile(window)).toEqual({ found: true, externalId: 'art-v7', url: null });
    const slice = calls.find((c) => c.route === SLICE);
    expect(Object.fromEntries(slice?.query ?? [])).toEqual({ offset: '0', limit: '20', type: 'video' });
    expect(calls.filter((c) => c.route === CREATE)).toHaveLength(1);
  });

  it('reports pending, never a rejection, once the video article was created', async () => {
    const { fetchImpl } = zalo({
      [UPLOAD]: [{ body: { error: 0, data: { token: 'vtok-8' } } }],
      [CHECK]: [ready],
      [CREATE]: [{ body: { error: 0, data: { token: 'tok-v8' } } }],
      [VERIFY]: [{ body: { error: -216, message: 'Access token is invalid' } }],
    });
    expect(await new ZaloOaPublisher(APP, fetchImpl, fast).publish(input())).toEqual({ kind: 'pending', externalRef: 'tok-v8', checkAfterSeconds: 20 });
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
