// TikTok against recorded answers (shapes from TikTok's Login Kit and Content Posting API docs); no live call.
import { describe, expect, it } from 'vitest';
import { TikTokConnector, TikTokPublisher, TikTokRefresher, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { clientKey: 'awtestclientkey01', clientSecret: 'test-tiktok-secret-not-real' };
const OPEN_ID = '-000OpenIdOfTheCreator';
const SECRET = JSON.stringify({ accessToken: 'act.token-1', refreshToken: 'rft.token-1' });
const REDIRECT = 'https://crove.example/channels/oauth/tiktok/callback';
const UPLOAD = 'https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=Xza123';
const ok = { code: 'ok', message: '', log_id: 'log-1' };

// raw: the answer's text as TikTok writes it (64-bit ids a JS number cannot hold).
type Answer = { status?: number; body?: unknown; raw?: string };
function tiktok(routes: Record<string, Answer[]>) {
  const calls: { route: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    calls.push({ route, headers, body: typeof raw === 'string' ? (headers.get('content-type')?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : raw });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: `no answer for ${route}` } } };
    return new Response(answer.raw ?? (answer.body === undefined ? null : JSON.stringify(answer.body)), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const creator = (options = ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], extra: Record<string, unknown> = {}) => ({
  body: { data: { creator_username: 'tiembanhb', privacy_level_options: options, comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 600, ...extra }, error: ok },
});
const video = { fileId: 'f-1', mime: 'video/mp4', sizeBytes: 4, altText: null };
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: OPEN_ID,
  secret: SECRET,
  content: { body: 'Khai trương #banh', title: null, linkUrl: null, media: [video] },
  readMedia: async () => new Uint8Array([0, 0, 0, 1]),
  mediaUrl: async () => null,
  settings: { privacyLevel: 'SELF_ONLY', allowComments: true },
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});

describe('TikTokConnector', () => {
  it('asks for posting and connects the account with its tokens', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/oauth/token/': [{ body: { access_token: 'act.token-1', refresh_token: 'rft.token-1', expires_in: 86_400, open_id: OPEN_ID, scope: 'user.info.basic,video.publish', token_type: 'Bearer' } }],
      'GET open.tiktokapis.com/v2/user/info/': [{ body: { data: { user: { open_id: OPEN_ID, display_name: 'Tiệm Bánh B' } }, error: ok } }],
    });
    const connector = new TikTokConnector(APP, fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: null }));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish');
    const [account] = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null }, 1_000_000);
    expect(account).toMatchObject({ provider: 'tiktok', externalAccountId: OPEN_ID, displayName: 'Tiệm Bánh B', secret: SECRET, expiresAt: new Date(1_000_000 + 86_400_000) });
    expect(calls[0]?.body).toMatchObject({ client_key: APP.clientKey, grant_type: 'authorization_code', code: 'c' });
  });

  it('refuses a used code and a grant without posting', async () => {
    const used = tiktok({ 'POST open.tiktokapis.com/v2/oauth/token/': [{ body: { error: 'invalid_grant', error_description: 'Authorization code is expired.' } }] });
    await expect(new TikTokConnector(APP, used.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const narrow = tiktok({ 'POST open.tiktokapis.com/v2/oauth/token/': [{ body: { access_token: 'a', refresh_token: 'r', expires_in: 86_400, open_id: OPEN_ID, scope: 'user.info.basic' } }] });
    await expect(new TikTokConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied' });
  });
});

describe('TikTokRefresher', () => {
  it('renews two hours ahead, taking a rotated refresh token, and tells a dead grant from an outage', async () => {
    const good = tiktok({ 'POST open.tiktokapis.com/v2/oauth/token/': [{ body: { access_token: 'act.token-2', refresh_token: 'rft.token-2', expires_in: 86_400 } }] });
    const refresher = new TikTokRefresher(APP, good.fetchImpl);
    expect(refresher.horizonSeconds).toBe(7200);
    expect(await refresher.refresh(SECRET)).toMatchObject({ secret: JSON.stringify({ accessToken: 'act.token-2', refreshToken: 'rft.token-2' }) });
    const dead = tiktok({ 'POST open.tiktokapis.com/v2/oauth/token/': [{ body: { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' } }] });
    expect(await new TikTokRefresher(APP, dead.fetchImpl).refresh(SECRET)).toEqual({ refused: 'invalid_grant' });
    const down = tiktok({ 'POST open.tiktokapis.com/v2/oauth/token/': [{ status: 503, body: {} }] });
    expect(await new TikTokRefresher(APP, down.fetchImpl).refresh(SECRET)).toEqual({ failed: '503' });
  });
});

describe('TikTokPublisher', () => {
  it('checks the creator options, opens the upload with the chosen settings, sends the bytes and reports pending', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator()],
      'POST open.tiktokapis.com/v2/post/publish/video/init/': [{ body: { data: { publish_id: 'v_pub_file~v2-1.123', upload_url: UPLOAD }, error: ok } }],
      'PUT open-upload.tiktokapis.com/video/': [{ status: 201 }],
    });
    expect(await new TikTokPublisher(APP, fetchImpl).publish(input())).toEqual({ kind: 'pending', externalRef: 'v_pub_file~v2-1.123', checkAfterSeconds: 30 });
    expect(calls[1]?.body).toEqual({
      post_info: { title: 'Khai trương #banh', privacy_level: 'SELF_ONLY', disable_comment: false, disable_duet: true, disable_stitch: true },
      source_info: { source: 'FILE_UPLOAD', video_size: 4, chunk_size: 4, total_chunk_count: 1 },
    });
    expect(calls[2]?.headers.get('content-range')).toBe('bytes 0-3/4');
  });

  it('finishes on the status check, and ends one TikTok failed', async () => {
    const done = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/status/fetch/': [{ body: { data: { status: 'PROCESSING_UPLOAD' }, error: ok } }, { raw: '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok"}}' }] });
    const publisher = new TikTokPublisher(APP, done.fetchImpl);
    const ref = { externalAccountId: OPEN_ID, secret: SECRET, externalRef: 'v_pub_file~v2-1.123' };
    expect((await publisher.status(ref)).kind).toBe('pending');
    expect(await publisher.status(ref)).toEqual({ kind: 'accepted', externalId: '7300000000000000001', url: null });
    const privateDone = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/status/fetch/': [{ body: { data: { status: 'PUBLISH_COMPLETE' }, error: ok } }] });
    expect(await new TikTokPublisher(APP, privateDone.fetchImpl).status(ref)).toEqual({ kind: 'accepted', externalId: 'v_pub_file~v2-1.123', url: null });
    const failed = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/status/fetch/': [{ body: { data: { status: 'FAILED', fail_reason: 'video_pull_failed' }, error: ok } }] });
    expect(await new TikTokPublisher(APP, failed.fetchImpl).status(ref)).toMatchObject({ kind: 'rejected', code: 'video_pull_failed' });
  });

  it('stops checking a status TikTok refuses for good, and keeps checking through a rate limit or an outage', async () => {
    const ref = { externalAccountId: OPEN_ID, secret: SECRET, externalRef: 'v_pub_file~v2-1.123' };
    const refused = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/status/fetch/': [{ status: 400, body: { error: { code: 'invalid_publish_id', message: 'The publish_id does not exist.' } } }] });
    expect(await new TikTokPublisher(APP, refused.fetchImpl).status(ref)).toMatchObject({ kind: 'unknown', code: 'invalid_publish_id' });
    const limited = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/status/fetch/': [{ status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Too many requests.' } } }] });
    expect((await new TikTokPublisher(APP, limited.fetchImpl).status(ref)).kind).toBe('pending');
    const down = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/status/fetch/': [{ status: 503, body: {} }] });
    expect((await new TikTokPublisher(APP, down.fetchImpl).status(ref)).kind).toBe('pending');
  });

  it('refuses a video longer than the creator may post, before opening the upload', async () => {
    const short = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator(undefined, { max_video_post_duration_sec: 60 })] });
    expect(await new TikTokPublisher(APP, short.fetchImpl).publish(input({ content: { ...input().content, media: [{ ...video, durationSeconds: 61.5 }] } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'VIDEO_TOO_LONG' });
    expect(short.calls.some((c) => c.route.includes('/video/init/'))).toBe(false);
  });

  it('posts nothing without a chosen privacy level, or with one the account does not offer', async () => {
    const none = tiktok({});
    expect(await new TikTokPublisher(APP, none.fetchImpl).publish(input({ settings: {} }))).toMatchObject({ kind: 'rejected', code: 'PRIVACY_REQUIRED' });
    expect(none.calls).toHaveLength(0);
    const narrow = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator(['SELF_ONLY'])] });
    expect(await new TikTokPublisher(APP, narrow.fetchImpl).publish(input({ settings: { privacyLevel: 'PUBLIC_TO_EVERYONE' } }))).toMatchObject({ kind: 'rejected', error: 'permission', code: 'PRIVACY_NOT_ALLOWED' });
    expect(narrow.calls.some((c) => c.route.includes('/video/init/'))).toBe(false);
  });

  it('keeps an interaction off when the creator turned it off, and maps an unaudited app and a dead token', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator(['SELF_ONLY'], { comment_disabled: true })],
      'POST open.tiktokapis.com/v2/post/publish/video/init/': [{ status: 403, body: { error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'Please review our integration guidelines' } } }],
    });
    expect(await new TikTokPublisher(APP, fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'permission', code: 'unaudited_client_can_only_post_to_private_accounts' });
    expect(calls[1]?.body).toMatchObject({ post_info: { disable_comment: true } });
    const dead = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [{ status: 401, body: { error: { code: 'access_token_invalid', message: 'The access token is invalid or not found in the request.' } } }] });
    expect(await new TikTokPublisher(APP, dead.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
  });

  it('keeps the publish_id when the upload is cut off by its own timeout, within the job\'s', async () => {
    const { fetchImpl } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator()],
      'POST open.tiktokapis.com/v2/post/publish/video/init/': [{ body: { data: { publish_id: 'v_pub_file~v2-1.125', upload_url: UPLOAD }, error: ok } }],
    });
    const aborting: Fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'PUT') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return fetchImpl(input, init);
    };
    const publisher = new TikTokPublisher(APP, aborting);
    expect(publisher.callTimeoutMs).toBeGreaterThan(300_000);
    expect(publisher.callTimeoutMs).toBeLessThan(600_000);
    expect(await publisher.publish(input())).toEqual({ kind: 'pending', externalRef: 'v_pub_file~v2-1.125', checkAfterSeconds: 30 });
  });

  it('waits for the status check when the bytes did not all arrive', async () => {
    const { fetchImpl } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator()],
      'POST open.tiktokapis.com/v2/post/publish/video/init/': [{ body: { data: { publish_id: 'v_pub_file~v2-1.124', upload_url: UPLOAD }, error: ok } }],
      'PUT open-upload.tiktokapis.com/video/': [{ status: 502 }],
    });
    expect(await new TikTokPublisher(APP, fetchImpl).publish(input())).toEqual({ kind: 'pending', externalRef: 'v_pub_file~v2-1.124', checkAfterSeconds: 30 });
  });
});
