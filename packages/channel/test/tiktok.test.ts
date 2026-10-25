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
  it("reads a video's counts with video.list, asked for only when the app has the Display API (#744)", async () => {
    expect(new URL(new TikTokConnector(APP).authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null })).searchParams.get('scope')).toBe('user.info.basic,video.publish');
    expect(new URL(new TikTokConnector({ ...APP, videoList: true }).authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null })).searchParams.get('scope')).toBe('user.info.basic,video.publish,video.list');
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/video/query/': [
        { body: { data: { videos: [{ id: '7300000000000000001', view_count: 1200, like_count: 80, comment_count: 6, share_count: 3 }] }, error: ok } },
        { status: 401, body: { error: { code: 'access_token_invalid', message: 'expired' } } },
        { status: 403, body: { error: { code: 'scope_not_authorized', message: 'no video.list' } } },
      ],
    });
    const publisher = new TikTokPublisher({ ...APP, videoList: true }, fetchImpl);
    const ask = { externalAccountId: OPEN_ID, secret: SECRET, externalId: '7300000000000000001' };
    expect(await publisher.metrics(ask)).toEqual({ metrics: { views: 1200, reactions: 80, comments: 6, shares: 3 } });
    expect(calls[0]?.body).toEqual({ filters: { video_ids: ['7300000000000000001'] } });
    expect(await publisher.metrics(ask)).toEqual({ refused: 'token_expired' });
    // Without the scope (or for a private post with no id), no counts and no error.
    expect(await publisher.metrics(ask)).toBeNull();
    expect(await publisher.metrics({ ...ask, externalId: 'v_pub_abc' })).toBeNull();
  });

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

  it('posts photos through content/init from their URLs, with the text as the description (#710)', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator()],
      'POST open.tiktokapis.com/v2/post/publish/content/init/': [{ body: { data: { publish_id: 'p_pub_url~v2.123' }, error: ok } }],
    });
    const photos = [
      { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 4, altText: null },
      { fileId: 'f-2', mime: 'image/webp', sizeBytes: 4, altText: null },
    ];
    const url = async (fileId: string) => `https://media.crove.example/${fileId}`;
    const content = { body: 'Bộ ảnh bánh mới', title: null, linkUrl: 'https://tiembanh.example/', media: photos };
    expect(await new TikTokPublisher(APP, fetchImpl).publish(input({ content, mediaUrl: url, settings: { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComments: true } }))).toEqual({ kind: 'pending', externalRef: 'p_pub_url~v2.123', checkAfterSeconds: 30 });
    expect(calls[1]?.body).toEqual({
      post_info: { description: 'Bộ ảnh bánh mới\n\nhttps://tiembanh.example/', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, auto_add_music: false },
      source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: ['https://media.crove.example/f-1', 'https://media.crove.example/f-2'] },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
    });
  });

  it('refuses photos it cannot send before any call, and explains an unverified media domain (#710)', async () => {
    const none = tiktok({});
    const publisher = new TikTokPublisher(APP, none.fetchImpl);
    const jpeg = { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 4, altText: null };
    const photos = (media: PublishInput['content']['media']) => ({ body: 'Ảnh', title: null, linkUrl: null, media });
    expect(await publisher.publish(input({ content: photos([jpeg]) }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(await publisher.publish(input({ content: photos([{ ...jpeg, mime: 'image/png' }]), mediaUrl: async () => 'https://m.example/a' }))).toMatchObject({ kind: 'rejected', code: 'IMAGE_TYPE_NOT_ALLOWED' });
    expect(await publisher.publish(input({ content: photos(Array.from({ length: 36 }, (_, i) => ({ ...jpeg, fileId: `f-${i}` }))), mediaUrl: async () => 'https://m.example/a' }))).toMatchObject({ kind: 'rejected', code: 'TOO_MANY_MEDIA' });
    expect(await publisher.publish(input({ content: photos([jpeg]), settings: {} }))).toMatchObject({ kind: 'rejected', code: 'PRIVACY_REQUIRED' });
    expect(none.calls).toHaveLength(0);

    const unverified = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator()],
      'POST open.tiktokapis.com/v2/post/publish/content/init/': [{ status: 403, body: { error: { code: 'url_ownership_unverified', message: 'Please verify the ownership of the URL prefix or domain.' } } }],
    });
    const refused = await new TikTokPublisher(APP, unverified.fetchImpl).publish(input({ content: photos([jpeg]), mediaUrl: async () => 'https://m.example/a' }));
    expect(refused).toMatchObject({ kind: 'rejected', error: 'permission', code: 'url_ownership_unverified' });
    expect(refused.kind === 'rejected' && refused.message).toContain('media domain must be verified');
  });

  it('sends a frame cover as video_cover_timestamp_ms, and refuses an image cover with nothing sent (#642)', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator()],
      'POST open.tiktokapis.com/v2/post/publish/video/init/': [{ body: { data: { publish_id: 'v_pub_file~v2-1.124', upload_url: UPLOAD }, error: ok } }],
      'PUT open-upload.tiktokapis.com/video/': [{ status: 201 }],
    });
    const frame = input({ settings: { privacyLevel: 'SELF_ONLY', cover: { atMs: 1500 } } });
    expect(await new TikTokPublisher(APP, fetchImpl).publish(frame)).toMatchObject({ kind: 'pending', externalRef: 'v_pub_file~v2-1.124' });
    expect(calls[1]?.body).toMatchObject({ post_info: { privacy_level: 'SELF_ONLY', video_cover_timestamp_ms: 1500 } });
    const none = tiktok({});
    expect(await new TikTokPublisher(APP, none.fetchImpl).publish(input({ settings: { privacyLevel: 'SELF_ONLY', cover: { fileId: 'c-1' } } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' });
    expect(none.calls).toHaveLength(0);
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

// Commercial content and AI labels (#1078): post_info.brand_content_toggle, brand_organic_toggle and is_aigc from TikTok's
// Content Posting API reference ("Direct Post", "Photo Post": is_aigc beside post_info), and the content sharing
// guidelines' rule that branded content cannot be private.
describe('TikTokPublisher content disclosure', () => {
  const init = (id: string) => ({ body: { data: { publish_id: id, upload_url: UPLOAD }, error: ok } });

  it('sends your brand, branded content and the AI label in the video init', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator(), creator(), creator()],
      'POST open.tiktokapis.com/v2/post/publish/video/init/': [init('v_pub_file~v2-1.201'), init('v_pub_file~v2-1.202'), init('v_pub_file~v2-1.203')],
      'PUT open-upload.tiktokapis.com/video/': [{ status: 201 }, { status: 201 }, { status: 201 }],
    });
    const publisher = new TikTokPublisher(APP, fetchImpl);
    const base = { title: 'Khai trương #banh', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: true, disable_stitch: true };
    const source = { source: 'FILE_UPLOAD', video_size: 4, chunk_size: 4, total_chunk_count: 1 };
    const inits = () => calls.filter((c) => c.route.endsWith('/video/init/'));

    expect(await publisher.publish(input({ settings: { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComments: true, tiktok: { commercial: true, brandedContent: true, aiGenerated: true } } }))).toMatchObject({ kind: 'pending', externalRef: 'v_pub_file~v2-1.201' });
    expect(inits()[0]?.body).toEqual({ post_info: { ...base, brand_content_toggle: true, brand_organic_toggle: false, is_aigc: true }, source_info: source });

    await publisher.publish(input({ settings: { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComments: true, tiktok: { commercial: true, yourBrand: true } } }));
    expect(inits()[1]?.body).toEqual({ post_info: { ...base, brand_content_toggle: false, brand_organic_toggle: true }, source_info: source });

    // The AI label alone, on a private post (only branded content may not be private).
    await publisher.publish(input({ settings: { privacyLevel: 'SELF_ONLY', allowComments: true, tiktok: { aiGenerated: true } } }));
    expect(inits()[2]?.body).toEqual({ post_info: { ...base, privacy_level: 'SELF_ONLY', brand_content_toggle: false, brand_organic_toggle: false, is_aigc: true }, source_info: source });
  });

  it('sends the brand toggles in post_info and is_aigc beside it for photos', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator(['MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'])],
      'POST open.tiktokapis.com/v2/post/publish/content/init/': [{ body: { data: { publish_id: 'p_pub_url~v2.201' }, error: ok } }],
    });
    const content = { body: 'Bộ ảnh bánh mới', title: null, linkUrl: null, media: [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 4, altText: null }] };
    const settings = { privacyLevel: 'MUTUAL_FOLLOW_FRIENDS', tiktok: { commercial: true, yourBrand: true, brandedContent: true, aiGenerated: true } };
    expect(await new TikTokPublisher(APP, fetchImpl).publish(input({ content, settings, mediaUrl: async (id) => `https://media.crove.example/${id}` }))).toMatchObject({ kind: 'pending', externalRef: 'p_pub_url~v2.201' });
    expect(calls[1]?.body).toEqual({
      post_info: { description: 'Bộ ảnh bánh mới', privacy_level: 'MUTUAL_FOLLOW_FRIENDS', disable_comment: true, auto_add_music: false, brand_content_toggle: true, brand_organic_toggle: true },
      source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: ['https://media.crove.example/f-1'] },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
      is_aigc: true,
    });
  });

  it('refuses branded content that is private, a disclosure with no choice, a bad shape and a draft for the app, with nothing sent', async () => {
    const none = tiktok({});
    const publisher = new TikTokPublisher({ ...APP, inbox: true }, none.fetchImpl);
    const code = async (settings: Record<string, unknown>) => {
      const result = await publisher.publish(input({ settings }));
      return result.kind === 'rejected' ? result.code : result.kind;
    };
    expect(await code({ privacyLevel: 'SELF_ONLY', tiktok: { commercial: true, brandedContent: true } })).toBe('TIKTOK_BRANDED_PRIVATE');
    expect(await code({ privacyLevel: 'SELF_ONLY', tiktok: { brandedContent: true, yourBrand: true } })).toBe('TIKTOK_BRANDED_PRIVATE');
    expect(await code({ privacyLevel: 'PUBLIC_TO_EVERYONE', tiktok: { commercial: true } })).toBe('TIKTOK_COMMERCIAL_CHOOSE');
    expect(await code({ privacyLevel: 'PUBLIC_TO_EVERYONE', tiktok: { brandedContent: 'yes' } })).toBe('TIKTOK_DISCLOSURE_INVALID');
    expect(await code({ privacyLevel: 'PUBLIC_TO_EVERYONE', tiktok: { paid: true } })).toBe('TIKTOK_DISCLOSURE_INVALID');
    expect(await code({ privacyLevel: 'PUBLIC_TO_EVERYONE', tiktok: [] })).toBe('TIKTOK_DISCLOSURE_INVALID');
    expect(await code({ tiktokMode: 'inbox', tiktok: { aiGenerated: true } })).toBe('TIKTOK_DISCLOSURE_INBOX');
    expect(none.calls).toHaveLength(0);
  });
});

// Inbox mode (#903): shapes from TikTok's Content Posting API reference, "Upload" (post/publish/inbox/video/init,
// scope video.upload) and "Get Post Status" (SEND_TO_USER_INBOX).
describe('TikTokPublisher in inbox mode', () => {
  const INBOX = 'v_inbox_file~v2.123456789';
  // A deployment that turned inbox mode on (CHANNEL_TIKTOK_INBOX).
  const INBOX_APP = { ...APP, inbox: true };
  const inbox = (over: Partial<PublishInput> = {}) => input({ settings: { tiktokMode: 'inbox' }, ...over });

  it('asks for video.upload only where the deployment turned inbox mode on', () => {
    const scope = (app: typeof APP & { inbox?: boolean; videoList?: boolean }) => new URL(new TikTokConnector(app).authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null })).searchParams.get('scope');
    expect(scope(APP)).toBe('user.info.basic,video.publish');
    expect(scope({ ...APP, inbox: false })).toBe('user.info.basic,video.publish');
    expect(scope(INBOX_APP)).toBe('user.info.basic,video.publish,video.upload');
    expect(scope({ ...INBOX_APP, videoList: true })).toBe('user.info.basic,video.publish,video.upload,video.list');
  });

  it('refuses an inbox draft with nothing sent where the deployment has not turned inbox mode on', async () => {
    const none = tiktok({});
    const publisher = new TikTokPublisher(APP, none.fetchImpl);
    expect(publisher.refusal({ tiktokMode: 'inbox' })).toBe('TIKTOK_INBOX_NOT_ENABLED');
    expect(publisher.refusal({ privacyLevel: 'SELF_ONLY' })).toBeNull();
    expect(new TikTokPublisher(INBOX_APP).refusal({ tiktokMode: 'inbox' })).toBeNull();
    expect(await publisher.publish(inbox())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TIKTOK_INBOX_NOT_ENABLED' });
    const jpeg = { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 4, altText: null };
    expect(await publisher.publish(inbox({ content: { body: 'Ảnh', title: null, linkUrl: null, media: [jpeg] }, mediaUrl: async () => 'https://m.example/a' }))).toMatchObject({ code: 'TIKTOK_INBOX_NOT_ENABLED' });
    expect(none.calls).toHaveLength(0);
  });

  it('opens an inbox upload with the source only, with no privacy level or creator query, and sends the bytes in chunks', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/inbox/video/init/': [{ body: { data: { publish_id: INBOX, upload_url: UPLOAD }, error: ok } }],
      'PUT open-upload.tiktokapis.com/video/': [{ status: 206 }, { status: 201 }],
    });
    // Two chunks: 64 MB, then the remaining 66 MB in the last one (TikTok takes up to 128 MB there).
    const size = 130 * 1024 * 1024;
    const chunk = 64 * 1024 * 1024;
    const content = { ...input().content, media: [{ ...video, sizeBytes: size }] };
    expect(await new TikTokPublisher(INBOX_APP, fetchImpl).publish(inbox({ content, readMedia: async () => new Uint8Array(size) }))).toEqual({ kind: 'pending', externalRef: INBOX, checkAfterSeconds: 30 });
    expect(calls.map((c) => c.route)).toEqual(['POST open.tiktokapis.com/v2/post/publish/inbox/video/init/', 'PUT open-upload.tiktokapis.com/video/', 'PUT open-upload.tiktokapis.com/video/']);
    expect(calls[0]?.body).toEqual({ source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: 2 } });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer act.token-1');
    expect(calls[1]?.headers.get('content-range')).toBe(`bytes 0-${chunk - 1}/${size}`);
    expect(calls[2]?.headers.get('content-range')).toBe(`bytes ${chunk}-${size - 1}/${size}`);
    expect(calls[2]?.headers.get('content-type')).toBe('video/mp4');
  });

  it('ends the status check at SEND_TO_USER_INBOX: a draft in the app, with no post id', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/status/fetch/': [
        { body: { data: { status: 'PROCESSING_UPLOAD', uploaded_bytes: 2 }, error: ok } },
        { body: { data: { status: 'SEND_TO_USER_INBOX' }, error: ok } },
      ],
    });
    const publisher = new TikTokPublisher(APP, fetchImpl);
    const ref = { externalAccountId: OPEN_ID, secret: SECRET, externalRef: INBOX };
    expect(await publisher.status(ref)).toEqual({ kind: 'pending', externalRef: INBOX, checkAfterSeconds: 30 });
    expect(await publisher.status(ref)).toEqual({ kind: 'accepted', externalId: INBOX, url: null, sentToApp: true });
    expect(calls[1]?.body).toEqual({ publish_id: INBOX });
  });

  it('asks for a reconnect when the connection lacks video.upload, where direct mode keeps reading it as a dead token', async () => {
    const scopeless = { status: 401, body: { error: { code: 'scope_not_authorized', message: "The access_token does not bear user's grant on video.upload scope", log_id: 'log-2' } } };
    const missing = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/inbox/video/init/': [scopeless] });
    const refused = await new TikTokPublisher(INBOX_APP, missing.fetchImpl).publish(inbox());
    expect(refused).toMatchObject({ kind: 'rejected', error: 'permission', code: 'CHANNEL_SCOPE_MISSING', httpStatus: 401 });
    expect(missing.calls.some((c) => c.route.startsWith('PUT'))).toBe(false);
    const direct = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [scopeless] });
    expect(await new TikTokPublisher(APP, direct.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'scope_not_authorized' });
  });

  it('explains the cap on drafts waiting in the TikTok inbox', async () => {
    const full = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/inbox/video/init/': [{ status: 403, body: { error: { code: 'spam_risk_too_many_pending_share', message: 'The daily upload cap from the API is reached for the current user.' } } }] });
    const refused = await new TikTokPublisher(INBOX_APP, full.fetchImpl).publish(inbox());
    expect(refused).toMatchObject({ kind: 'rejected', error: 'permission', code: 'spam_risk_too_many_pending_share' });
    expect(refused.kind === 'rejected' && refused.message).toContain('post or delete some in the TikTok app');
  });

  it('sends photos to the inbox with MEDIA_UPLOAD and their description only', async () => {
    const { fetchImpl, calls } = tiktok({ 'POST open.tiktokapis.com/v2/post/publish/content/init/': [{ body: { data: { publish_id: 'p_inbox_url~v2.1' }, error: ok } }] });
    const content = { body: 'Bộ ảnh bánh mới', title: null, linkUrl: null, media: [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 4, altText: null }] };
    const result = await new TikTokPublisher(INBOX_APP, fetchImpl).publish(inbox({ content, mediaUrl: async (id) => `https://media.crove.example/${id}` }));
    expect(result).toEqual({ kind: 'pending', externalRef: 'p_inbox_url~v2.1', checkAfterSeconds: 30 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      post_info: { description: 'Bộ ảnh bánh mới' },
      source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: ['https://media.crove.example/f-1'] },
      post_mode: 'MEDIA_UPLOAD',
      media_type: 'PHOTO',
    });
  });

  it('ignores privacy and interaction settings, and refuses a cover or an unknown mode with nothing sent', async () => {
    const leftover = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/inbox/video/init/': [{ body: { data: { publish_id: INBOX, upload_url: UPLOAD }, error: ok } }],
      'PUT open-upload.tiktokapis.com/video/': [{ status: 201 }],
    });
    expect(await new TikTokPublisher(INBOX_APP, leftover.fetchImpl).publish(inbox({ settings: { tiktokMode: 'inbox', privacyLevel: 'PUBLIC_TO_EVERYONE', allowComments: true } }))).toMatchObject({ kind: 'pending' });
    expect(leftover.calls[0]?.body).toEqual({ source_info: { source: 'FILE_UPLOAD', video_size: 4, chunk_size: 4, total_chunk_count: 1 } });
    const none = tiktok({});
    const publisher = new TikTokPublisher(INBOX_APP, none.fetchImpl);
    expect(await publisher.publish(inbox({ settings: { tiktokMode: 'inbox', cover: { atMs: 1000 } } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' });
    expect(await publisher.publish(input({ settings: { tiktokMode: 'draft', privacyLevel: 'SELF_ONLY' } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TIKTOK_MODE_INVALID' });
    expect(none.calls).toHaveLength(0);
  });

  it('keeps direct mode as it was when the mode is set to direct', async () => {
    const { fetchImpl, calls } = tiktok({
      'POST open.tiktokapis.com/v2/post/publish/creator_info/query/': [creator()],
      'POST open.tiktokapis.com/v2/post/publish/video/init/': [{ body: { data: { publish_id: 'v_pub_file~v2-1.126', upload_url: UPLOAD }, error: ok } }],
      'PUT open-upload.tiktokapis.com/video/': [{ status: 201 }],
    });
    expect(await new TikTokPublisher(APP, fetchImpl).publish(input({ settings: { tiktokMode: 'direct', privacyLevel: 'SELF_ONLY', allowComments: true } }))).toMatchObject({ kind: 'pending', externalRef: 'v_pub_file~v2-1.126' });
    expect(calls[1]?.body).toMatchObject({ post_info: { privacy_level: 'SELF_ONLY', disable_comment: false } });
  });
});

describe('TikTokPublisher late ids (#1475)', () => {
  const STATUS = 'POST open.tiktokapis.com/v2/post/publish/status/fetch/';
  const QUERY = 'POST open.tiktokapis.com/v2/video/query/';
  const ask = (over: Record<string, unknown> = {}) => ({ externalAccountId: OPEN_ID, secret: SECRET, externalRef: 'v_pub_file~v2-1.123', scopes: ['user.info.basic', 'video.publish'], ...over });
  const complete = (ids: string) => ({ raw: `{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${ids}]},"error":{"code":"ok"}}` });

  it('reads the public id once moderation gives it, as written, and only the status: no post call', async () => {
    const { fetchImpl, calls } = tiktok({ [STATUS]: [{ body: { data: { status: 'PUBLISH_COMPLETE' }, error: ok } }, complete('7300000000000000001')] });
    const publisher = new TikTokPublisher(APP, fetchImpl);
    expect(await publisher.lateId(ask())).toEqual({ kind: 'posted_without_id' });
    expect(await publisher.lateId(ask())).toEqual({ kind: 'posted', externalId: '7300000000000000001', url: null });
    expect(calls.map((c) => c.route)).toEqual([STATUS, STATUS]);
    expect(calls[1]?.body).toEqual({ publish_id: 'v_pub_file~v2-1.123' });
  });

  it('takes the first id of a draft the creator made several posts from, and its address with video.list', async () => {
    const { fetchImpl, calls } = tiktok({
      [STATUS]: [complete('7300000000000000002, 7300000000000000003'), complete('7300000000000000004'), complete('7300000000000000005')],
      [QUERY]: [
        { body: { data: { videos: [{ id: '7300000000000000002', share_url: 'https://www.tiktok.com/@tiembanhb/video/7300000000000000002' }] }, error: ok } },
        { body: { data: { videos: [{ id: '7300000000000000004', share_url: 'https://www.tiktok.com.evil.example/video/1' }] }, error: ok } },
        { status: 500, body: {} },
      ],
    });
    const publisher = new TikTokPublisher({ ...APP, videoList: true }, fetchImpl);
    const listed = ask({ externalRef: 'v_inbox_file~v2.123456789', scopes: ['user.info.basic', 'video.publish', 'video.list'] });
    expect(await publisher.lateId(listed)).toEqual({ kind: 'posted', externalId: '7300000000000000002', url: 'https://www.tiktok.com/@tiembanhb/video/7300000000000000002' });
    expect(calls[1]?.body).toEqual({ filters: { video_ids: ['7300000000000000002'] } });
    // An address off tiktok.com, or none at all: the id is kept without one.
    expect(await publisher.lateId(listed)).toEqual({ kind: 'posted', externalId: '7300000000000000004', url: null });
    expect(await publisher.lateId(listed)).toEqual({ kind: 'posted', externalId: '7300000000000000005', url: null });
  });

  it('waits on a draft still in the inbox, stops on FAILED or a publish_id TikTok refuses, and tells a dead token from an outage', async () => {
    const { fetchImpl } = tiktok({
      [STATUS]: [
        { body: { data: { status: 'SEND_TO_USER_INBOX' }, error: ok } },
        { body: { data: { status: 'FAILED', fail_reason: 'publish_cancelled' }, error: ok } },
        { status: 400, body: { error: { code: 'invalid_publish_id', message: 'The publish_id does not exist.' } } },
        { status: 401, body: { error: { code: 'access_token_invalid', message: 'expired' } } },
        { status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Too many requests.' } } },
        { status: 503, body: {} },
      ],
    });
    const publisher = new TikTokPublisher(APP, fetchImpl);
    expect(await publisher.lateId(ask())).toEqual({ kind: 'waiting' });
    expect(await publisher.lateId(ask())).toEqual({ kind: 'failed', code: 'publish_cancelled' });
    expect(await publisher.lateId(ask())).toEqual({ kind: 'failed', code: 'invalid_publish_id' });
    expect(await publisher.lateId(ask())).toEqual({ kind: 'refused' });
    expect(await publisher.lateId(ask())).toBeNull();
    expect(await publisher.lateId(ask())).toBeNull();
  });

  it('asks nothing with an unreadable secret or a malformed publish_id', async () => {
    const { fetchImpl, calls } = tiktok({});
    const publisher = new TikTokPublisher(APP, fetchImpl);
    expect(await publisher.lateId(ask({ secret: '{}' }))).toEqual({ kind: 'refused' });
    expect(await publisher.lateId(ask({ externalRef: 'not a publish id' }))).toEqual({ kind: 'failed', code: 'BAD_PUBLISH_ID' });
    expect(calls).toHaveLength(0);
  });
});
