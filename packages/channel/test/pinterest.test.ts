// Pinterest against recorded answers (shapes from the Pinterest API v5 docs: OAuth, boards, pins); no live call.
import { describe, expect, it } from 'vitest';
import { PinterestConnector, PinterestPublisher, PinterestRefresher, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { appId: '1500001', appSecret: 'test-pinterest-secret-not-real' };
const BOARD = '549755885175';
const SECRET = JSON.stringify({ accessToken: 'pina_access-1', refreshToken: 'pinr_refresh-1' });
const REDIRECT = 'https://crove.example/channels/oauth/pinterest/callback';
const SCOPE = 'boards:read,pins:read,pins:write,user_accounts:read';

type Answer = { status?: number; body?: unknown };
function pinterest(routes: Record<string, Answer[]>) {
  const calls: { route: string; url: URL; headers: Headers; body: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    calls.push({ route, url, headers, body: typeof raw === 'string' ? (headers.get('content-type')?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : raw });
    const answer = routes[route]?.shift() ?? { status: 500, body: { code: 1, message: `no answer for ${route}` } };
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const image = (fileId: string, altText: string | null = null) => ({ fileId, mime: 'image/jpeg', sizeBytes: 3, altText });
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: BOARD,
  secret: SECRET,
  content: { body: 'Bánh mì mới ra lò mỗi sáng', title: 'Thực đơn mùa xuân', linkUrl: 'https://shop.example/menu', media: [image('f-1', 'Ổ bánh mì giòn')] },
  readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});

describe('PinterestConnector', () => {
  it('asks for the pin scopes and makes one channel per public board, sharing the tokens', async () => {
    const { fetchImpl, calls } = pinterest({
      'POST /v5/oauth/token': [{ body: { access_token: 'pina_access-1', refresh_token: 'pinr_refresh-1', expires_in: 2_592_000, scope: SCOPE } }],
      'GET /v5/user_account': [{ body: { username: 'tiembanhb' } }],
      'GET /v5/boards': [{ body: { items: [{ id: BOARD, name: 'Thực đơn', privacy: 'PUBLIC' }, { id: '549755885176', name: 'Nháp', privacy: 'SECRET' }, { id: '549755885177', name: 'Khuyến mãi', privacy: 'PROTECTED' }] } }],
    });
    const connector = new PinterestConnector(APP, fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 's1', redirectUri: REDIRECT, codeChallenge: null }));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.pinterest.com/oauth/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: APP.appId, response_type: 'code', scope: SCOPE, state: 's1' });
    const accounts = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null }, 1_000_000);
    expect(accounts.map((a) => [a.externalAccountId, a.displayName])).toEqual([
      [BOARD, 'tiembanhb / Thực đơn'],
      ['549755885177', 'tiembanhb / Khuyến mãi'],
    ]);
    expect(accounts[0]).toMatchObject({ provider: 'pinterest', secret: SECRET, expiresAt: new Date(1_000_000 + 2_592_000_000) });
    expect(calls[0]?.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${APP.appId}:${APP.appSecret}`).toString('base64')}`);
    expect(calls[0]?.body).toEqual({ grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT, continuous_refresh: 'true' });
  });

  it('refuses a narrow grant, an account with no board, and a used code', async () => {
    const narrow = pinterest({ 'POST /v5/oauth/token': [{ body: { access_token: 'a', refresh_token: 'r', scope: 'boards:read,user_accounts:read' } }] });
    await expect(new PinterestConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    const empty = pinterest({
      'POST /v5/oauth/token': [{ body: { access_token: 'a', refresh_token: 'r', scope: SCOPE } }],
      'GET /v5/user_account': [{ body: { username: 'x' } }],
      'GET /v5/boards': [{ body: { items: [] } }],
    });
    await expect(new PinterestConnector(APP, empty.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied', code: 'NO_BOARD' });
    const used = pinterest({ 'POST /v5/oauth/token': [{ status: 400, body: { code: 1, message: 'Invalid authorization code' } }] });
    await expect(new PinterestConnector(APP, used.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    expect(() => new PinterestConnector({ appId: 'abc', appSecret: 's' })).toThrow('invalid Pinterest app id');
  });
});

describe('PinterestRefresher', () => {
  it('renews three days ahead, keeps the refresh token unless a new one comes, and tells a dead grant from an outage', async () => {
    const ok = pinterest({ 'POST /v5/oauth/token': [{ body: { access_token: 'pina_access-2', expires_in: 2_592_000 } }] });
    const refresher = new PinterestRefresher(APP, ok.fetchImpl);
    expect(refresher.horizonSeconds).toBe(3 * 86_400);
    expect(await refresher.refresh(SECRET)).toMatchObject({ secret: JSON.stringify({ accessToken: 'pina_access-2', refreshToken: 'pinr_refresh-1' }) });
    expect(ok.calls[0]?.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'pinr_refresh-1' });
    const dead = pinterest({ 'POST /v5/oauth/token': [{ status: 400, body: { code: 'invalid_grant', message: 'Refresh token expired' } }] });
    expect(await new PinterestRefresher(APP, dead.fetchImpl).refresh(SECRET)).toEqual({ refused: 'invalid_grant' });
    const down = pinterest({ 'POST /v5/oauth/token': [{ status: 503, body: {} }] });
    expect(await new PinterestRefresher(APP, down.fetchImpl).refresh(SECRET)).toEqual({ failed: '503' });
    expect(await refresher.refresh('{}')).toEqual({ refused: 'NO_REFRESH_TOKEN' });
  });
});

describe('PinterestPublisher', () => {
  it('pins one image to the board with the title, the text, the link and the alt text', async () => {
    const { fetchImpl, calls } = pinterest({ 'POST /v5/pins': [{ status: 201, body: { id: '813744226420795884' } }] });
    expect(await new PinterestPublisher(APP, fetchImpl).publish(input())).toEqual({ kind: 'accepted', externalId: '813744226420795884', url: 'https://www.pinterest.com/pin/813744226420795884/' });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer pina_access-1');
    expect(calls[0]?.body).toEqual({
      board_id: BOARD,
      title: 'Thực đơn mùa xuân',
      description: 'Bánh mì mới ra lò mỗi sáng',
      link: 'https://shop.example/menu',
      alt_text: 'Ổ bánh mì giòn',
      media_source: { source_type: 'image_base64', content_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
    });
  });

  it('pins 2 to 5 images as a carousel, and posts nothing for a video, too many images or an unreadable one', async () => {
    const { fetchImpl, calls } = pinterest({ 'POST /v5/pins': [{ body: { id: '813744226420795885' } }] });
    await new PinterestPublisher(APP, fetchImpl).publish(input({ content: { ...input().content, media: [image('a'), image('b')] } }));
    const sent = calls[0]?.body as { media_source: { source_type: string; items: unknown[] } } | undefined;
    if (!sent) throw new Error('no pin call');
    const source = sent.media_source;
    expect(source.source_type).toBe('multiple_image_base64');
    expect(source.items).toHaveLength(2);
    const none = pinterest({});
    const publisher = new PinterestPublisher(APP, none.fetchImpl);
    expect(await publisher.publish(input({ content: { ...input().content, media: [image('a'), { fileId: 'v', mime: 'video/mp4', sizeBytes: 1, altText: null }] } }))).toMatchObject({ kind: 'rejected', code: 'ONE_VIDEO_ALONE' });
    expect(await publisher.publish(input({ content: { ...input().content, media: ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => image(f)) } }))).toMatchObject({ kind: 'rejected', code: 'TOO_MANY_IMAGES' });
    expect(await publisher.publish(input({ readMedia: async () => Promise.reject(new Error('gone')) }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(none.calls).toHaveLength(0);
  });

  it('treats a lost answer as unknown and finds the pin on the board by its title, text and time', async () => {
    const lost = pinterest({ 'POST /v5/pins': [{ status: 502, body: {} }] });
    expect((await new PinterestPublisher(APP, lost.fetchImpl).publish(input())).kind).toBe('unknown');
    const at = new Date('2026-10-22T03:00:00.000Z');
    const { fetchImpl, calls } = pinterest({
      [`GET /v5/boards/${BOARD}/pins`]: [
        { body: { items: [{ id: '1', title: 'Khác', description: 'Bánh mì mới ra lò mỗi sáng', created_at: '2026-10-22T03:00:10' }, { id: '813744226420795884', title: 'Thực đơn mùa xuân', description: 'Bánh mì mới ra lò mỗi sáng', created_at: '2026-10-22T03:00:20' }] } },
      ],
    });
    const found = await new PinterestPublisher(APP, fetchImpl).reconcile({ externalAccountId: BOARD, secret: SECRET, callKey: 'call-1', contentHash: input().contentHash, content: input().content, after: at, before: new Date(at.getTime() + 60_000) });
    expect(found).toEqual({ found: true, externalId: '813744226420795884', url: 'https://www.pinterest.com/pin/813744226420795884/' });
    expect(calls[0]?.url.searchParams.get('page_size')).toBe('25');
    const window = { externalAccountId: BOARD, secret: SECRET, callKey: 'call-1', contentHash: input().contentHash, after: at, before: new Date(at.getTime() + 60_000) };
    // An image-only pin is never guessed, and a full page without it is not proof it is missing.
    const untouched = pinterest({});
    expect(await new PinterestPublisher(APP, untouched.fetchImpl).reconcile({ ...window, content: { ...input().content, title: null, body: '' } })).toEqual({ found: 'unknown' });
    expect(untouched.calls).toHaveLength(0);
    const full = pinterest({ [`GET /v5/boards/${BOARD}/pins`]: [{ body: { items: Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), title: 'x', description: 'y', created_at: '2026-10-22T03:00:10' })) } }] });
    expect(await new PinterestPublisher(APP, full.fetchImpl).reconcile({ ...window, content: input().content })).toEqual({ found: 'unknown' });
    const short = pinterest({ [`GET /v5/boards/${BOARD}/pins`]: [{ body: { items: [] } }] });
    expect(await new PinterestPublisher(APP, short.fetchImpl).reconcile({ ...window, content: input().content })).toEqual({ found: false });
  });

  it('maps rate limits, a dead token and a refused pin', async () => {
    const ask = async (answer: Answer) => new PinterestPublisher(APP, pinterest({ 'POST /v5/pins': [answer] }).fetchImpl).publish(input());
    expect(await ask({ status: 429, body: { code: 8, message: 'Rate limit exceeded' } })).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    expect(await ask({ status: 401, body: { code: 2, message: 'Authentication failed' } })).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(await ask({ status: 400, body: { code: 1, message: 'Invalid board' } })).toMatchObject({ kind: 'rejected', error: 'bad_request' });
  });

  it('reads impressions, saves and clicks, and tells a deleted pin apart', async () => {
    const { fetchImpl, calls } = pinterest({ 'GET /v5/pins/813744226420795884': [{ body: { id: '813744226420795884', pin_metrics: { lifetime_metrics: { impression: 1200, save: 40, outbound_click: 18, pin_click: 60 } } } }] });
    expect(await new PinterestPublisher(APP, fetchImpl).metrics({ externalAccountId: BOARD, secret: SECRET, externalId: '813744226420795884' })).toEqual({ metrics: { impressions: 1200, saves: 40, clicks: 18 } });
    expect(calls[0]?.url.searchParams.get('pin_metrics')).toBe('true');
    const gone = pinterest({ 'GET /v5/pins/813744226420795884': [{ status: 404, body: { code: 50, message: 'Pin not found' } }] });
    expect(await new PinterestPublisher(APP, gone.fetchImpl).metrics({ externalAccountId: BOARD, secret: SECRET, externalId: '813744226420795884' })).toEqual({ refused: 'gone' });
  });
});

describe('Pinterest video pins (#813)', () => {
  const UPLOAD = 'https://pinterest-media-upload.s3-accelerate.amazonaws.com/';
  const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: 'Lò bánh' };
  const videoInput = (settings: Record<string, unknown> = {}) => input({ content: { ...input().content, media: [clip] }, settings });
  const fast = { pollMs: 1, videoWaitMs: 1000 };
  function withUpload(routes: Record<string, Answer[]>, uploadStatus = 204) {
    const api = pinterest(routes);
    const uploads: { url: string; body: unknown }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      if (new URL(url).hostname.endsWith('amazonaws.com')) {
        uploads.push({ url, body: init?.body });
        return new Response(null, { status: uploadStatus });
      }
      return api.fetchImpl(url, init);
    };
    return { ...api, uploads, fetchImpl };
  }

  it('registers the upload, sends the bytes to the storage URL, waits for processing, and pins it with a cover frame', async () => {
    const t = withUpload({
      'POST /v5/media': [{ status: 201, body: { media_id: '12345', media_type: 'video', upload_url: UPLOAD, upload_parameters: { key: 'uploads/12345', policy: 'p', 'x-amz-signature': 's' } } }],
      'GET /v5/media/12345': [{ body: { media_id: '12345', status: 'processing' } }, { body: { media_id: '12345', status: 'succeeded' } }],
      'POST /v5/pins': [{ status: 201, body: { id: '813744226420795999' } }],
    });
    expect(await new PinterestPublisher(APP, t.fetchImpl, fast).publish(videoInput({ cover: { atMs: 2500 } }))).toMatchObject({ kind: 'accepted', externalId: '813744226420795999' });
    expect(t.calls[0]?.body).toEqual({ media_type: 'video' });
    const form = t.uploads[0]?.body as FormData;
    expect([form.get('key'), form.get('policy'), (form.get('file') as Blob).type]).toEqual(['uploads/12345', 'p', 'video/mp4']);
    const pinned = t.calls.at(-1)?.body as { media_source: unknown } | undefined;
    expect(pinned?.media_source).toEqual({ source_type: 'video_id', media_id: '12345', cover_image_key_frame_time: 2.5 });
  });

  it('posts nothing when the storage URL is elsewhere, processing fails or runs late', async () => {
    const elsewhere = withUpload({ 'POST /v5/media': [{ body: { media_id: '1', upload_url: 'https://evil.example/upload', upload_parameters: {} } }] });
    expect(await new PinterestPublisher(APP, elsewhere.fetchImpl, fast).publish(videoInput())).toMatchObject({ kind: 'rejected', code: 'UPLOAD_HOST' });
    const failed = withUpload({ 'POST /v5/media': [{ body: { media_id: '2', upload_url: UPLOAD, upload_parameters: {} } }], 'GET /v5/media/2': [{ body: { status: 'failed' } }] });
    expect(await new PinterestPublisher(APP, failed.fetchImpl, fast).publish(videoInput())).toMatchObject({ kind: 'rejected', code: 'VIDEO_PROCESSING_FAILED' });
    const slow = withUpload({ 'POST /v5/media': [{ body: { media_id: '3', upload_url: UPLOAD, upload_parameters: {} } }], 'GET /v5/media/3': Array.from({ length: 50 }, () => ({ body: { status: 'processing' } })) });
    expect(await new PinterestPublisher(APP, slow.fetchImpl, { pollMs: 5, videoWaitMs: 20 }).publish(videoInput())).toMatchObject({ kind: 'rejected', error: 'transient', code: 'VIDEO_PROCESSING_SLOW' });
    for (const t of [elsewhere, failed, slow]) expect(t.calls.some((c) => c.route === 'POST /v5/pins')).toBe(false);
  });
});