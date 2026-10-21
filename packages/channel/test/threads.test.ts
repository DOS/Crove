// Threads against recorded answers (shapes from Meta's Threads API docs); no live call.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ThreadsConnector, ThreadsPublisher, ThreadsRefresher, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { appId: '987654321', appSecret: 'test-threads-secret-not-real' };
const USER = '17841400000000777';
const SECRET = JSON.stringify({ accessToken: 'threads-token-1' });
const REDIRECT = 'https://crove.example/channels/oauth/threads/callback';

function threads(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; form: Record<string, string>; query: URLSearchParams; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    // The quota read (#743) is kept apart, so the other calls keep their order.
    if (route.endsWith('/threads_publishing_limit')) {
      const answer = routes[route]?.shift();
      if (answer) return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 500 });
    }
    calls.push({ route, form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')), query: url.searchParams, auth: new Headers(init?.headers).get('authorization') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, code: 1 } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const ref = (container: string, text: string) => `${container}.${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: USER,
  secret: SECRET,
  content: { body: 'Khai trương!', title: null, linkUrl: null, media: [] },
  readMedia: async () => new Uint8Array(),
  mediaUrl: async (fileId) => `https://bucket.example/${fileId}`,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});
const fast = { waitMs: 0, pollMs: 0 };

describe('ThreadsConnector', () => {
  it('connects the Threads profile with a long-lived token and its expiry', async () => {
    const { fetchImpl, calls } = threads({
      'POST /oauth/access_token': [{ body: { access_token: 'short', user_id: USER } }],
      'GET /access_token': [{ body: { access_token: 'long-token', token_type: 'bearer', expires_in: 5_184_000 } }],
      'GET /v1.0/me': [{ body: { id: USER, username: 'quan.a' } }],
    });
    const connector = new ThreadsConnector(APP, fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: null }));
    expect(`${url.origin}${url.pathname}`).toBe('https://threads.net/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_content_publish,threads_manage_replies,threads_manage_insights');
    const before = Date.now();
    const [account] = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null });
    expect(account).toMatchObject({ provider: 'threads', externalAccountId: USER, displayName: '@quan.a', secret: JSON.stringify({ accessToken: 'long-token' }) });
    expect(account?.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 5_184_000_000);
    expect(calls[0]?.form).toMatchObject({ grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT });
    expect(calls[2]?.auth).toBe('Bearer long-token');
  });

  it('maps a refused code to invalid_grant', async () => {
    const { fetchImpl } = threads({ 'POST /oauth/access_token': [{ status: 400, body: { error: { message: 'Invalid code', code: 100 } } }] });
    await expect(new ThreadsConnector(APP, fetchImpl).exchange({ code: 'used', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
  });
});

describe('ThreadsRefresher', () => {
  it('renews a week ahead, and tells a dead token from an outage', async () => {
    const ok = threads({ 'GET /refresh_access_token': [{ body: { access_token: 'renewed', expires_in: 5_184_000 } }] });
    const refresher = new ThreadsRefresher(ok.fetchImpl);
    expect(refresher.horizonSeconds).toBe(7 * 86_400);
    expect(await refresher.refresh(SECRET)).toMatchObject({ secret: JSON.stringify({ accessToken: 'renewed' }) });
    expect(ok.calls[0]?.query.get('grant_type')).toBe('th_refresh_token');
    const dead = threads({ 'GET /refresh_access_token': [{ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } }] });
    expect(await new ThreadsRefresher(dead.fetchImpl).refresh(SECRET)).toEqual({ refused: '190' });
    const down = threads({ 'GET /refresh_access_token': [{ status: 503, body: {} }] });
    expect(await new ThreadsRefresher(down.fetchImpl).refresh(SECRET)).toEqual({ failed: '503' });
  });
});

describe('ThreadsPublisher', () => {
  it("reads a post's views, likes, replies and shares from its insights (#744)", async () => {
    const { fetchImpl, calls } = threads({
      'GET /v1.0/18100000000000001/insights': [
        {
          body: {
            data: [
              { name: 'views', values: [{ value: 900 }] },
              { name: 'likes', values: [{ value: 40 }] },
              { name: 'replies', values: [{ value: 5 }] },
              { name: 'reposts', values: [{ value: 2 }] },
              { name: 'quotes', values: [{ value: 1 }] },
              { name: 'shares', total_value: { value: 3 } },
            ],
          },
        },
        { status: 400, body: { error: { message: 'Unsupported request', code: 100 } } },
      ],
    });
    const publisher = new ThreadsPublisher(fetchImpl, fast);
    const ask = { externalAccountId: USER, secret: SECRET, externalId: '18100000000000001' };
    expect(await publisher.metrics(ask)).toEqual({ metrics: { views: 900, reactions: 40, comments: 5, shares: 6 } });
    expect(calls[0]?.query.get('metric')).toBe('views,likes,replies,reposts,quotes,shares');
    expect(await publisher.metrics(ask)).toBeNull();
    expect(await publisher.metrics({ ...ask, externalId: 'not-a-post' })).toEqual({ refused: 'gone' });
  });

  it('waits hours with nothing created when the publishing quota is used up (#743)', async () => {
    const { fetchImpl, calls } = threads({ [`GET /v1.0/${USER}/threads_publishing_limit`]: [{ body: { data: [{ quota_usage: 250, config: { quota_total: 250, quota_duration: 86400 } }] } }] });
    expect(await new ThreadsPublisher(fetchImpl, fast).publish(input())).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'QUOTA_EXHAUSTED' });
    expect(calls).toEqual([]);
  });

  it('publishes a text post through a container, once', async () => {
    const { fetchImpl, calls } = threads({
      [`POST /v1.0/${USER}/threads`]: [{ body: { id: '9001' } }],
      'GET /v1.0/9001': [{ body: { status: 'FINISHED' } }],
      [`POST /v1.0/${USER}/threads_publish`]: [{ body: { id: '18100000000000001' } }],
      'GET /v1.0/18100000000000001': [{ body: { permalink: 'https://www.threads.net/@quan.a/post/abc' } }],
    });
    expect(await new ThreadsPublisher(fetchImpl, fast).publish(input())).toEqual({ kind: 'accepted', externalId: '18100000000000001', url: 'https://www.threads.net/@quan.a/post/abc' });
    expect(calls[0]?.form).toEqual({ media_type: 'TEXT', text: 'Khai trương!' });
    expect(calls[2]?.form).toEqual({ creation_id: '9001' });
  });

  it('sends a poll on a text post and a topic tag on any post, and refuses bad ones before creating anything (#711)', async () => {
    const { fetchImpl, calls } = threads({
      [`POST /v1.0/${USER}/threads`]: [{ body: { id: '9001' } }, { body: { id: '9002' } }],
      'GET /v1.0/9001': [{ body: { status: 'FINISHED' } }],
      'GET /v1.0/9002': [{ body: { status: 'FINISHED' } }],
      [`POST /v1.0/${USER}/threads_publish`]: [{ body: { id: '18100000000000011' } }, { body: { id: '18100000000000012' } }],
      'GET /v1.0/18100000000000011': [{ body: {} }],
      'GET /v1.0/18100000000000012': [{ body: {} }],
    });
    const publisher = new ThreadsPublisher(fetchImpl, fast);
    const settings = { poll: { options: [' Cà phê ', 'Trà sữa', 'Nước ép'] }, topicTag: '#Ăn uống' };
    expect((await publisher.publish(input({ settings }))).kind).toBe('accepted');
    expect(calls[0]?.form).toEqual({ media_type: 'TEXT', text: 'Khai trương!', poll_attachment: JSON.stringify({ option_a: 'Cà phê', option_b: 'Trà sữa', option_c: 'Nước ép' }), topic_tag: 'Ăn uống' });
    const image = { body: 'Ảnh', title: null, linkUrl: null, media: [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 10, altText: null }] };
    expect((await publisher.publish(input({ content: image, settings: { topicTag: 'Khai trương' } }))).kind).toBe('accepted');
    expect(calls[4]?.form).toEqual({ media_type: 'IMAGE', image_url: 'https://bucket.example/f-1', text: 'Ảnh', topic_tag: 'Khai trương' });

    const none = threads({});
    const refused = new ThreadsPublisher(none.fetchImpl, fast);
    expect(await refused.publish(input({ settings: { poll: { options: ['Chỉ một'] } } }))).toMatchObject({ kind: 'rejected', code: 'POLL_INVALID' });
    expect(await refused.publish(input({ settings: { poll: { options: ['a', 'x'.repeat(26)] } } }))).toMatchObject({ kind: 'rejected', code: 'POLL_INVALID' });
    expect(await refused.publish(input({ content: image, settings: { poll: { options: ['a', 'b'] } } }))).toMatchObject({ kind: 'rejected', code: 'POLL_WITH_MEDIA' });
    expect(await refused.publish(input({ settings: { topicTag: 'a.b' } }))).toMatchObject({ kind: 'rejected', code: 'TOPIC_TAG_INVALID' });
    expect(await refused.publish(input({ settings: { topicTag: 7 } }))).toMatchObject({ kind: 'rejected', code: 'TOPIC_TAG_INVALID' });
    expect(none.calls).toHaveLength(0);
  });

  it('sends who may reply as reply_control on the published container, nothing for everyone, and refuses an unknown value before any call (#983)', async () => {
    const ids = ['9301', '9302', '9303', '9304', '9305', '9306', '9307', '9308'];
    const { fetchImpl, calls } = threads({
      [`POST /v1.0/${USER}/threads`]: ids.map((id) => ({ body: { id } })),
      ...Object.fromEntries(ids.map((id) => [`GET /v1.0/${id}`, [{ body: { status: 'FINISHED' } }]])),
      [`POST /v1.0/${USER}/threads_publish`]: ids.map((_, i) => ({ body: { id: `1810000000000030${i}` } })),
      ...Object.fromEntries(ids.map((_, i) => [`GET /v1.0/1810000000000030${i}`, [{ body: {} }]])),
    });
    const publisher = new ThreadsPublisher(fetchImpl, fast);
    const creates = () => calls.filter((c) => c.route === `POST /v1.0/${USER}/threads`).map((c) => c.form);
    // Everyone, said or not, sends exactly what was sent before the setting existed.
    await publisher.publish(input({ settings: { replySettings: 'everyone' } }));
    await publisher.publish(input({ settings: { replySettings: 'following' } }));
    await publisher.publish(input({ settings: { replySettings: 'mentionedUsers' } }));
    await publisher.publish(input({ settings: { replySettings: 'followers' } }));
    expect(creates()).toEqual([
      { media_type: 'TEXT', text: 'Khai trương!' },
      { media_type: 'TEXT', text: 'Khai trương!', reply_control: 'accounts_you_follow' },
      { media_type: 'TEXT', text: 'Khai trương!', reply_control: 'mentioned_only' },
      { media_type: 'TEXT', text: 'Khai trương!', reply_control: 'followers_only' },
    ]);
    // An image, and a carousel: on the carousel's container, not its items.
    const one = { body: 'Ảnh', title: null, linkUrl: null, media: [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 10, altText: null }] };
    await publisher.publish(input({ content: one, settings: { replySettings: 'followers' } }));
    const two = { ...one, media: [...one.media, { fileId: 'f-2', mime: 'video/mp4', sizeBytes: 10, altText: null }] };
    await publisher.publish(input({ content: two, settings: { replySettings: 'mentionedUsers' } }));
    expect(creates().slice(4)).toEqual([
      { media_type: 'IMAGE', image_url: 'https://bucket.example/f-1', text: 'Ảnh', reply_control: 'followers_only' },
      { media_type: 'IMAGE', image_url: 'https://bucket.example/f-1', is_carousel_item: 'true' },
      { media_type: 'VIDEO', video_url: 'https://bucket.example/f-2', is_carousel_item: 'true' },
      { media_type: 'CAROUSEL', children: '9306,9307', text: 'Ảnh', reply_control: 'mentioned_only' },
    ]);

    // Nothing at all goes out, the quota read included.
    let fetched = 0;
    const none = threads({});
    const refused = new ThreadsPublisher(async (url, init) => {
      fetched += 1;
      return none.fetchImpl(url, init);
    }, fast);
    for (const replySettings of ['accounts_you_follow', 'verified', 'toString', 3]) {
      expect(await refused.publish(input({ settings: { replySettings } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'REPLY_SETTINGS_INVALID' });
    }
    expect(fetched).toBe(0);
  });

  it('makes a carousel of images, and refuses without image URLs before creating anything', async () => {
    const { fetchImpl, calls } = threads({
      [`POST /v1.0/${USER}/threads`]: [{ body: { id: '9001' } }, { body: { id: '9002' } }, { body: { id: '9003' } }],
      'GET /v1.0/9003': [{ body: { status: 'FINISHED' } }],
      [`POST /v1.0/${USER}/threads_publish`]: [{ body: { id: '18100000000000002' } }],
      'GET /v1.0/18100000000000002': [{ body: {} }],
    });
    const media = [
      { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 10, altText: null },
      { fileId: 'f-2', mime: 'image/png', sizeBytes: 10, altText: null },
    ];
    const content = { body: 'Bộ ảnh', title: null, linkUrl: null, media };
    expect((await new ThreadsPublisher(fetchImpl, fast).publish(input({ content }))).kind).toBe('accepted');
    expect(calls.slice(0, 3).map((c) => c.form)).toEqual([
      { media_type: 'IMAGE', image_url: 'https://bucket.example/f-1', is_carousel_item: 'true' },
      { media_type: 'IMAGE', image_url: 'https://bucket.example/f-2', is_carousel_item: 'true' },
      { media_type: 'CAROUSEL', children: '9001,9002', text: 'Bộ ảnh' },
    ]);
    const empty = threads({});
    expect(await new ThreadsPublisher(empty.fetchImpl, fast).publish(input({ content, mediaUrl: async () => null }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(empty.calls).toHaveLength(0);
  });

  it('sends alt text on described images and videos (#790)', async () => {
    const { fetchImpl, calls } = threads({
      [`POST /v1.0/${USER}/threads`]: [{ body: { id: '9001' } }, { body: { id: '9002' } }, { body: { id: '9003' } }],
      'GET /v1.0/9003': [{ body: { status: 'FINISHED' } }],
      [`POST /v1.0/${USER}/threads_publish`]: [{ body: { id: '18100000000000002' } }],
      'GET /v1.0/18100000000000002': [{ body: {} }],
    });
    const media = [
      { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 10, altText: `Mặt tiền ${'c'.repeat(1200)}` },
      { fileId: 'f-2', mime: 'image/png', sizeBytes: 10, altText: null },
    ];
    await new ThreadsPublisher(fetchImpl, fast).publish(input({ content: { body: 'Bộ ảnh', title: null, linkUrl: null, media } }));
    expect(String(calls[0]?.form?.alt_text)).toHaveLength(1000);
    expect(calls[1]?.form).toEqual({ media_type: 'IMAGE', image_url: 'https://bucket.example/f-2', is_carousel_item: 'true' });
  });

  it('posts a video alone or in a carousel with images', async () => {
    const { fetchImpl, calls } = threads({
      [`POST /v1.0/${USER}/threads`]: [{ body: { id: '9101' } }, { body: { id: '9201' } }, { body: { id: '9202' } }, { body: { id: '9203' } }],
      'GET /v1.0/9101': [{ body: { status: 'FINISHED' } }],
      'GET /v1.0/9203': [{ body: { status: 'FINISHED' } }],
      [`POST /v1.0/${USER}/threads_publish`]: [{ body: { id: '18100000000000101' } }, { body: { id: '18100000000000102' } }],
      'GET /v1.0/18100000000000101': [{ body: {} }],
      'GET /v1.0/18100000000000102': [{ body: {} }],
    });
    const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 10, altText: null };
    const publisher = new ThreadsPublisher(fetchImpl, fast);
    expect((await publisher.publish(input({ content: { body: 'Video', title: null, linkUrl: null, media: [clip] } }))).kind).toBe('accepted');
    expect(calls[0]?.form).toEqual({ media_type: 'VIDEO', video_url: 'https://bucket.example/v-1', text: 'Video' });
    const mixed = { body: 'Ảnh và video', title: null, linkUrl: null, media: [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 10, altText: null }, clip] };
    expect((await publisher.publish(input({ content: mixed }))).kind).toBe('accepted');
    expect(calls.filter((c) => c.route === `POST /v1.0/${USER}/threads`).slice(1).map((c) => c.form)).toEqual([
      { media_type: 'IMAGE', image_url: 'https://bucket.example/f-1', is_carousel_item: 'true' },
      { media_type: 'VIDEO', video_url: 'https://bucket.example/v-1', is_carousel_item: 'true' },
      { media_type: 'CAROUSEL', children: '9201,9202', text: 'Ảnh và video' },
    ]);
  });

  it('reports pending, then recognises the post on the status check by its text', async () => {
    const { fetchImpl } = threads({
      [`POST /v1.0/${USER}/threads`]: [{ body: { id: '9001' } }],
      'GET /v1.0/9001': [{ body: { status: 'IN_PROGRESS' } }, { body: { status: 'PUBLISHED' } }],
      [`GET /v1.0/${USER}/threads`]: [{ body: { data: [{ id: '18100000000000099', text: 'Bài khác', timestamp: new Date().toISOString() }, { id: '18100000000000003', text: 'Khai trương!', timestamp: new Date().toISOString(), permalink: 'https://www.threads.net/@quan.a/post/def' }] } }],
    });
    const publisher = new ThreadsPublisher(fetchImpl, fast);
    expect(await publisher.publish(input())).toEqual({ kind: 'pending', externalRef: ref('9001', 'Khai trương!'), checkAfterSeconds: 30 });
    expect(await publisher.status({ externalAccountId: USER, secret: SECRET, externalRef: ref('9001', 'Khai trương!') })).toEqual({ kind: 'accepted', externalId: '18100000000000003', url: 'https://www.threads.net/@quan.a/post/def' });
  });

  it('maps a refused token while creating and an outage on publish', async () => {
    const expired = threads({ [`POST /v1.0/${USER}/threads`]: [{ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } }] });
    expect(await new ThreadsPublisher(expired.fetchImpl, fast).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const down = threads({
      [`POST /v1.0/${USER}/threads`]: [{ body: { id: '9001' } }],
      'GET /v1.0/9001': [{ body: { status: 'FINISHED' } }, { body: { status: 'FINISHED' } }],
      [`POST /v1.0/${USER}/threads_publish`]: [{ status: 500, body: { error: { message: 'Service temporarily unavailable', code: 2 } } }],
    });
    expect((await new ThreadsPublisher(down.fetchImpl, fast).publish(input())).kind).toBe('unknown');
  });
});

describe('Threads followers (#819)', () => {
  it('reads followers_count from threads_insights, and tells a missing permission apart', async () => {
    const { fetchImpl, calls } = threads({ [`GET /v1.0/${USER}/threads_insights`]: [{ body: { data: [{ name: 'followers_count', period: 'day', total_value: { value: 1234 } }] } }] });
    expect(await new ThreadsPublisher(fetchImpl, fast).accountMetrics({ externalAccountId: USER, secret: SECRET })).toEqual({ followers: 1234 });
    expect(calls[0]?.query.get('metric')).toBe('followers_count');
    const denied = threads({ [`GET /v1.0/${USER}/threads_insights`]: [{ status: 403, body: { error: { message: 'Application does not have permission for this action', type: 'OAuthException', code: 10 } } }] });
    expect(await new ThreadsPublisher(denied.fetchImpl, fast).accountMetrics({ externalAccountId: USER, secret: SECRET })).toEqual({ refused: 'permission' });
  });
});