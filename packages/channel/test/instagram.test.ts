// Instagram through Facebook Login against recorded Graph answers (shapes from Meta's docs); no live call.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InstagramConnector, InstagramPublisher, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { appId: '1234567890', appSecret: 'test-app-secret-not-real' };
const IG = '17841400000000001';
const SECRET = JSON.stringify({ accessToken: 'page-token-1', pageId: '111' });
const REDIRECT = 'https://crove.example/channels/oauth/instagram/callback';

// Answers per "METHOD /path" in order; records every call with its form.
function graph(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; form: Record<string, string>; query: URLSearchParams }[] = [];
  const quota: string[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/v24.0', '')}`;
    // The quota read (#743) is kept apart, so the other calls keep their order.
    if (route.endsWith('/content_publishing_limit')) quota.push(route);
    else calls.push({ route, form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')), query: url.searchParams });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, code: 1 } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, quota, fetchImpl };
}

const image = (fileId: string) => ({ fileId, mime: 'image/jpeg', sizeBytes: 1000, altText: null });
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: IG,
  secret: SECRET,
  content: { body: '  Khai trương!  ', title: null, linkUrl: null, media: [image('f-1')] },
  readMedia: async () => {
    throw new Error('Instagram fetches images itself');
  },
  mediaUrl: async (fileId) => `https://bucket.example/${fileId}?sig=1`,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});
const fast = { waitMs: 0, pollMs: 0 };
const ref = (container: string, caption = 'Khai trương!') => `${container}.${createHash('sha256').update(caption).digest('hex').slice(0, 16)}`;

describe('InstagramConnector', () => {
  it('asks for the Instagram publishing permissions and connects the business account of each Page', async () => {
    const { fetchImpl, calls } = graph({
      'POST /oauth/access_token': [{ body: { access_token: 'short' } }, { body: { access_token: 'long-user-token' } }],
      'GET /me/permissions': [
        { body: { data: ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'instagram_manage_comments'].map((permission) => ({ permission, status: 'granted' })) } },
      ],
      'GET /me/accounts': [
        {
          body: {
            data: [
              { id: '111', name: 'Quán A', access_token: 'page-token-111', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: IG, username: 'quan.a' } },
              { id: '222', name: 'Trang không có Instagram', access_token: 'page-token-222', tasks: ['CREATE_CONTENT'] },
            ],
          },
        },
      ],
    });
    const connector = new InstagramConnector(APP, fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: null }));
    expect(url.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish,instagram_manage_insights,instagram_manage_comments');
    const accounts = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null });
    expect(accounts).toEqual([
      {
        provider: 'instagram',
        externalAccountId: IG,
        displayName: '@quan.a',
        scopes: ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'instagram_manage_comments'],
        expiresAt: null,
        secret: JSON.stringify({ accessToken: 'page-token-111', pageId: '111' }),
      },
    ]);
    expect(calls.find((c) => c.route === 'GET /me/accounts')?.query.get('fields')).toContain('instagram_business_account');
  });
});

describe('InstagramPublisher', () => {
  it('waits hours with nothing created when the publishing quota is used up, and posts while some is left (#743)', async () => {
    const full = graph({ [`GET /${IG}/content_publishing_limit`]: [{ body: { data: [{ quota_usage: 100, config: { quota_total: 100, quota_duration: 86400 } }] } }] });
    const before = Date.now();
    const result = await new InstagramPublisher(APP, full.fetchImpl, fast).publish(input());
    expect(result).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'QUOTA_EXHAUSTED' });
    const at = (result as { retryAt?: Date }).retryAt?.getTime() ?? 0;
    expect(at - before).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1000);
    expect(full.quota).toEqual([`GET /${IG}/content_publishing_limit`]);
    expect(full.calls).toEqual([]);
    const left = graph({
      [`GET /${IG}/content_publishing_limit`]: [{ body: { data: [{ quota_usage: 99, config: { quota_total: 100 } }] } }],
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }],
      'GET /9001': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000001' } }],
      'GET /18000000000000001': [{ body: { permalink: 'https://www.instagram.com/p/abc/' } }],
    });
    expect(await new InstagramPublisher(APP, left.fetchImpl, fast).publish(input())).toMatchObject({ kind: 'accepted' });
  });

  it('creates a container, waits for it and publishes it once', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }],
      'GET /9001': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000001' } }],
      'GET /18000000000000001': [{ body: { permalink: 'https://www.instagram.com/p/abc/' } }],
    });
    const result = await new InstagramPublisher(APP, fetchImpl, fast).publish(input());
    expect(result).toEqual({ kind: 'accepted', externalId: '18000000000000001', url: 'https://www.instagram.com/p/abc/' });
    expect(calls[0]?.form).toEqual({ image_url: 'https://bucket.example/f-1?sig=1', caption: 'Khai trương!' });
    expect(calls[2]?.form).toEqual({ creation_id: '9001' });
    expect(calls.filter((c) => c.route.endsWith('/media_publish'))).toHaveLength(1);
  });

  it('makes a carousel of several images', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }, { body: { id: '9002' } }, { body: { id: '9003' } }],
      'GET /9003': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000002' } }],
      'GET /18000000000000002': [{ body: {} }],
    });
    const content = { body: 'Bộ ảnh', title: null, linkUrl: null, media: [image('f-1'), image('f-2')] };
    expect(await new InstagramPublisher(APP, fetchImpl, fast).publish(input({ content }))).toMatchObject({ kind: 'accepted', externalId: '18000000000000002' });
    expect(calls.slice(0, 3).map((c) => c.form)).toEqual([
      { image_url: 'https://bucket.example/f-1?sig=1', is_carousel_item: 'true' },
      { image_url: 'https://bucket.example/f-2?sig=1', is_carousel_item: 'true' },
      { media_type: 'CAROUSEL', children: '9001,9002', caption: 'Bộ ảnh' },
    ]);
  });

  it('sends collaborators on the post and people tags on the first image, never on a Story (#796)', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }, { body: { id: '9002' } }, { body: { id: '9003' } }],
      'GET /9003': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000002' } }],
      'GET /18000000000000002': [{ body: {} }],
    });
    const settings = { collaborators: ['doi.tac', 'Bad Name'], userTags: ['lan_anh', 'minh'] };
    await new InstagramPublisher(APP, fetchImpl, fast).publish(input({ settings, content: { body: 'Bộ ảnh', title: null, linkUrl: null, media: [image('f-1'), image('f-2')] } }));
    expect(calls[0]?.form).toEqual({ image_url: 'https://bucket.example/f-1?sig=1', user_tags: JSON.stringify([{ username: 'lan_anh', x: 0.333, y: 0.9 }, { username: 'minh', x: 0.667, y: 0.9 }]), is_carousel_item: 'true' });
    expect(calls[1]?.form).toEqual({ image_url: 'https://bucket.example/f-2?sig=1', is_carousel_item: 'true' });
    expect(calls[2]?.form).toEqual({ media_type: 'CAROUSEL', children: '9001,9002', caption: 'Bộ ảnh', collaborators: JSON.stringify(['doi.tac']) });
    const story = graph({ [`POST /${IG}/media`]: [{ body: { id: '9101' } }], 'GET /9101': [{ body: { status_code: 'FINISHED' } }], [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000101' } }] });
    await new InstagramPublisher(APP, story.fetchImpl, fast).publish(input({ settings: { ...settings, postType: 'story' } }));
    expect(story.calls[0]?.form).toEqual({ media_type: 'STORIES', image_url: 'https://bucket.example/f-1?sig=1' });
  });

  it('sends alt text on described images, alone or in a carousel, and never on a video (#790)', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }, { body: { id: '9002' } }, { body: { id: '9003' } }],
      'GET /9003': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000002' } }],
      'GET /18000000000000002': [{ body: {} }],
    });
    const media = [{ ...image('f-1'), altText: 'Mặt tiền' }, { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 10, altText: 'Video' }];
    await new InstagramPublisher(APP, fetchImpl, fast).publish(input({ content: { body: 'Bộ ảnh', title: null, linkUrl: null, media } }));
    expect(calls[0]?.form).toEqual({ image_url: 'https://bucket.example/f-1?sig=1', alt_text: 'Mặt tiền', is_carousel_item: 'true' });
    expect(calls[1]?.form).toEqual({ media_type: 'VIDEO', video_url: 'https://bucket.example/v-1?sig=1', is_carousel_item: 'true' });
    const single = graph({ [`POST /${IG}/media`]: [{ body: { id: '9004' } }], 'GET /9004': [{ body: { status_code: 'FINISHED' } }], [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000003' } }], 'GET /18000000000000003': [{ body: {} }] });
    await new InstagramPublisher(APP, single.fetchImpl, fast).publish(input({ content: { body: 'Ảnh', title: null, linkUrl: null, media: [{ ...image('f-1'), altText: 'Mặt tiền' }] } }));
    expect(single.calls[0]?.form).toEqual({ image_url: 'https://bucket.example/f-1?sig=1', alt_text: 'Mặt tiền', caption: 'Ảnh' });
  });

  it('posts one video as a Reel shown in the feed, and finishes it on the status check while Meta processes it', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9101' } }],
      'GET /9101': [{ body: { status_code: 'IN_PROGRESS' } }, { body: { status_code: 'FINISHED' } }],
      [`GET /${IG}/media`]: [{ body: { data: [] } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000101' } }],
      'GET /18000000000000101': [{ body: { permalink: 'https://www.instagram.com/reel/xyz/' } }],
    });
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    const content = { body: 'Khai trương!', title: null, linkUrl: null, media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: null }] };
    expect(await publisher.publish(input({ content }))).toEqual({ kind: 'pending', externalRef: ref('9101'), checkAfterSeconds: 30 });
    expect(calls[0]?.form).toEqual({ media_type: 'REELS', video_url: 'https://bucket.example/v-1?sig=1', share_to_feed: 'true', caption: 'Khai trương!' });
    expect(await publisher.status({ externalAccountId: IG, secret: SECRET, externalRef: ref('9101') })).toEqual({ kind: 'accepted', externalId: '18000000000000101', url: 'https://www.instagram.com/reel/xyz/' });
  });

  it('uploads a Reel to its container when the deployment has no public file URLs, and still refuses images then (#772)', async () => {
    const { fetchImpl: base, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9201' } }],
      'POST /ig-api-upload/9201': [{ body: { success: true, message: 'Upload successful.' } }],
      'GET /9201': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000301' } }],
      'GET /18000000000000301': [{ body: { permalink: 'https://www.instagram.com/reel/up/' } }],
    });
    const uploads: { host: string; headers: Headers; size: number }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      if (new URL(url).host === 'rupload.facebook.com') uploads.push({ host: new URL(url).host, headers: new Headers(init?.headers), size: init?.body instanceof Uint8Array ? init.body.byteLength : -1 });
      return base(url, init);
    };
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    const noUrls = { mediaUrl: async () => null, readMedia: async () => new Uint8Array(2048) };
    const content = { body: 'Khai trương!', title: null, linkUrl: null, media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 2048, altText: null }] };
    expect(await publisher.publish(input({ content, ...noUrls }))).toEqual({ kind: 'accepted', externalId: '18000000000000301', url: 'https://www.instagram.com/reel/up/' });
    expect(calls[0]?.form).toEqual({ media_type: 'REELS', upload_type: 'resumable', share_to_feed: 'true', caption: 'Khai trương!' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.headers.get('authorization')).toBe('OAuth page-token-1');
    expect(uploads[0]?.headers.get('file_size')).toBe('2048');
    expect(uploads[0]?.size).toBe(2048);
    expect(publisher.callTimeoutMs).toBeGreaterThanOrEqual(300_000);
    // An image, or a Reel with a cover image, is still fetched by URL: refused before anything is created.
    const none = graph({});
    const strict = new InstagramPublisher(APP, none.fetchImpl, fast);
    expect(await strict.publish(input({ ...noUrls }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(await strict.publish(input({ content, ...noUrls, settings: { cover: { fileId: 'c-1' } } }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_URL_UNAVAILABLE' });
    // A file that cannot be read posts nothing either.
    expect(await strict.publish(input({ content, mediaUrl: async () => null, readMedia: async () => Promise.reject(new Error('gone')) }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(none.calls).toEqual([]);
  });
  it('posts a Story of one image or video with no caption, and never guesses which Story a container became (#644)', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9201' } }, { body: { id: '9202' } }],
      'GET /9201': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000201' } }],
      'GET /18000000000000201': [{ body: { permalink: 'https://www.instagram.com/stories/quan.a/1/' } }],
      'GET /9202': [{ body: { status_code: 'IN_PROGRESS' } }, { body: { status_code: 'PUBLISHED' } }],
    });
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    expect(await publisher.publish(input({ settings: { postType: 'story' } }))).toEqual({ kind: 'accepted', externalId: '18000000000000201', url: 'https://www.instagram.com/stories/quan.a/1/' });
    expect(calls[0]?.form).toEqual({ media_type: 'STORIES', image_url: 'https://bucket.example/f-1?sig=1' });
    // A video Story still processing: pending, and once Meta says it went out without the id, unknown rather than a guess.
    const video = { body: 'Không gửi chữ', title: null, linkUrl: 'https://shop.example/', media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: null }] };
    const pending = await publisher.publish(input({ content: video, settings: { postType: 'story' } }));
    expect(pending).toEqual({ kind: 'pending', externalRef: `9202.${'0'.repeat(16)}`, checkAfterSeconds: 30 });
    expect(calls.find((c) => c.form.media_type === 'STORIES' && c.form.video_url)?.form).toEqual({ media_type: 'STORIES', video_url: 'https://bucket.example/v-1?sig=1' });
    expect(await publisher.status({ externalAccountId: IG, secret: SECRET, externalRef: `9202.${'0'.repeat(16)}` })).toMatchObject({ kind: 'unknown', code: 'STORY_NOT_FOUND' });
    expect(calls.some((c) => c.route === `GET /${IG}/media`)).toBe(false);
    // Reconcile never matches a Story by text.
    expect(await publisher.reconcile({ externalAccountId: IG, secret: SECRET, callKey: 'k', contentHash: 'h', content: video, settings: { postType: 'story' }, after: new Date(), before: new Date() })).toEqual({ found: 'unknown' });
  });

  it('refuses a Story of several images, a Reel without a video, a cover on a Story and an unknown post type, before calling Meta (#644)', async () => {
    const { fetchImpl, calls } = graph({});
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    const two = { body: 'x', title: null, linkUrl: null, media: [image('f-1'), image('f-2')] };
    expect(await publisher.publish(input({ content: two, settings: { postType: 'story' } }))).toMatchObject({ kind: 'rejected', code: 'STORY_ONE_MEDIA' });
    expect(await publisher.publish(input({ settings: { postType: 'reel' } }))).toMatchObject({ kind: 'rejected', code: 'REEL_ONE_VIDEO' });
    const clip = { body: 'x', title: null, linkUrl: null, media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: null }] };
    expect(await publisher.publish(input({ content: clip, settings: { postType: 'story', cover: { atMs: 1000 } } }))).toMatchObject({ kind: 'rejected', code: 'COVER_NOT_SUPPORTED' });
    expect(await publisher.publish(input({ settings: { postType: 'carousel' } }))).toMatchObject({ kind: 'rejected', code: 'POST_TYPE_NOT_SUPPORTED' });
    expect(calls).toEqual([]);
  });

  it('gives a Reel its cover: a frame as thumb_offset in milliseconds, or an image Meta fetches as cover_url (#642)', async () => {
    const reel = { body: 'Khai trương!', title: null, linkUrl: null, media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: null }] };
    const answers = () => ({
      [`POST /${IG}/media`]: [{ body: { id: '9102' } }],
      'GET /9102': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000102' } }],
      'GET /18000000000000102': [{ body: {} }],
    });
    const frame = graph(answers());
    expect(await new InstagramPublisher(APP, frame.fetchImpl, fast).publish(input({ content: reel, settings: { cover: { atMs: 2500 } } }))).toMatchObject({ kind: 'accepted' });
    expect(frame.calls[0]?.form).toEqual({ media_type: 'REELS', video_url: 'https://bucket.example/v-1?sig=1', share_to_feed: 'true', thumb_offset: '2500', caption: 'Khai trương!' });
    const image = graph(answers());
    expect(await new InstagramPublisher(APP, image.fetchImpl, fast).publish(input({ content: reel, settings: { cover: { fileId: 'c-1' } } }))).toMatchObject({ kind: 'accepted' });
    expect(image.calls[0]?.form).toEqual({ media_type: 'REELS', video_url: 'https://bucket.example/v-1?sig=1', share_to_feed: 'true', cover_url: 'https://bucket.example/c-1?sig=1', caption: 'Khai trương!' });
  });

  it('keeps a Reel to the Reels tab with share_to_feed false, or makes it a trial Reel with its graduation (#1019)', async () => {
    const reel = { body: 'Khai trương!', title: null, linkUrl: null, media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: null }] };
    const sent = async (settings: Record<string, unknown>, over: Partial<PublishInput> = {}) => {
      const { fetchImpl, calls } = graph({
        [`POST /${IG}/media`]: [{ body: { id: '9103' } }],
        'POST /ig-api-upload/9103': [{ body: { success: true } }],
        'GET /9103': [{ body: { status_code: 'FINISHED' } }],
        [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000103' } }],
        'GET /18000000000000103': [{ body: { permalink: 'https://www.instagram.com/reel/r/' } }],
      });
      expect(await new InstagramPublisher(APP, fetchImpl, fast).publish(input({ content: reel, settings, ...over }))).toMatchObject({ kind: 'accepted', externalId: '18000000000000103' });
      return calls[0]?.form;
    };
    const url = 'https://bucket.example/v-1?sig=1';
    // The default, and feed said outright: in the feed and on the grid, as before.
    expect(await sent({})).toEqual({ media_type: 'REELS', video_url: url, share_to_feed: 'true', caption: 'Khai trương!' });
    expect(await sent({ instagram: { reelFeed: 'feed' } })).toEqual({ media_type: 'REELS', video_url: url, share_to_feed: 'true', caption: 'Khai trương!' });
    expect(await sent({ instagram: { reelFeed: 'reels_only' }, cover: { atMs: 1200 } })).toEqual({ media_type: 'REELS', video_url: url, share_to_feed: 'false', thumb_offset: '1200', caption: 'Khai trương!' });
    // A trial Reel carries trial_params and no share_to_feed, as in Meta's example; graduated by hand unless chosen.
    expect(await sent({ instagram: { reelFeed: 'trial' } })).toEqual({ media_type: 'REELS', video_url: url, trial_params: '{"graduation_strategy":"MANUAL"}', caption: 'Khai trương!' });
    expect(await sent({ instagram: { reelFeed: 'trial', trialGraduation: 'manual' } })).toEqual({ media_type: 'REELS', video_url: url, trial_params: '{"graduation_strategy":"MANUAL"}', caption: 'Khai trương!' });
    expect(await sent({ instagram: { reelFeed: 'trial', trialGraduation: 'performance' } })).toEqual({ media_type: 'REELS', video_url: url, trial_params: '{"graduation_strategy":"SS_PERFORMANCE"}', caption: 'Khai trương!' });
    // The same on a Reel whose bytes Crove uploads (#772), with collaborators.
    const noUrls = { mediaUrl: async () => null, readMedia: async () => new Uint8Array(16) };
    expect(await sent({ instagram: { reelFeed: 'reels_only' }, collaborators: ['partner'] }, noUrls)).toEqual({ media_type: 'REELS', upload_type: 'resumable', share_to_feed: 'false', caption: 'Khai trương!', collaborators: '["partner"]' });
    expect(await sent({ instagram: { reelFeed: 'trial', trialGraduation: 'performance' } }, noUrls)).toEqual({ media_type: 'REELS', upload_type: 'resumable', trial_params: '{"graduation_strategy":"SS_PERFORMANCE"}', caption: 'Khai trương!' });
  });

  it('refuses where a Reel shows on a post that is not a Reel, and any other shape, before calling Meta (#1019)', async () => {
    const { fetchImpl, calls } = graph({});
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    const clip = { body: 'x', title: null, linkUrl: null, media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: null }] };
    const two = { body: 'x', title: null, linkUrl: null, media: [image('f-1'), image('f-2')] };
    const notReel = { kind: 'rejected', error: 'bad_request', code: 'IG_REEL_FEED_NOT_REEL' };
    expect(await publisher.publish(input({ settings: { instagram: { reelFeed: 'reels_only' } } }))).toEqual(notReel);
    expect(await publisher.publish(input({ content: two, settings: { instagram: { reelFeed: 'trial' } } }))).toEqual(notReel);
    expect(await publisher.publish(input({ content: clip, settings: { postType: 'story', instagram: { reelFeed: 'feed' } } }))).toEqual(notReel);
    const invalid = { kind: 'rejected', error: 'bad_request', code: 'IG_REEL_FEED_INVALID' };
    for (const instagram of [{ reelFeed: 'grid' }, { reelFeed: 'reels_only', trialGraduation: 'manual' }, { reelFeed: 'trial', trialGraduation: 'SS_PERFORMANCE' }, { reelFeed: 'trial', extra: true }, 'trial', null, ['trial']]) {
      expect(await publisher.publish(input({ content: clip, settings: { instagram } }))).toEqual(invalid);
    }
    expect(calls).toEqual([]);
  });

  it('posts nothing with a cover on a post that is not a Reel, or a cover image without a public URL', async () => {
    const { fetchImpl, calls } = graph({});
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    expect(await publisher.publish(input({ settings: { cover: { atMs: 0 } } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' });
    const reel = { body: 'x', title: null, linkUrl: null, media: [{ fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: null }] };
    const noCoverUrl = input({ content: reel, settings: { cover: { fileId: 'c-1' } }, mediaUrl: async (fileId) => (fileId === 'c-1' ? null : `https://bucket.example/${fileId}?sig=1`) });
    expect(await publisher.publish(noCoverUrl)).toMatchObject({ kind: 'rejected', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  it('mixes images and videos in a carousel', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9201' } }, { body: { id: '9202' } }, { body: { id: '9203' } }],
      'GET /9203': [{ body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000201' } }],
      'GET /18000000000000201': [{ body: {} }],
    });
    const content = { body: 'Ảnh và video', title: null, linkUrl: null, media: [image('f-1'), { fileId: 'v-1', mime: 'video/quicktime', sizeBytes: 4_000_000, altText: null }] };
    expect(await new InstagramPublisher(APP, fetchImpl, fast).publish(input({ content }))).toMatchObject({ kind: 'accepted', externalId: '18000000000000201' });
    expect(calls.slice(0, 3).map((c) => c.form)).toEqual([
      { image_url: 'https://bucket.example/f-1?sig=1', is_carousel_item: 'true' },
      { media_type: 'VIDEO', video_url: 'https://bucket.example/v-1?sig=1', is_carousel_item: 'true' },
      { media_type: 'CAROUSEL', children: '9201,9202', caption: 'Ảnh và video' },
    ]);
  });

  it('posts nothing without a public image URL or without an image', async () => {
    const { fetchImpl, calls } = graph({});
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    expect(await publisher.publish(input({ mediaUrl: async () => null }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' });
    expect(await publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [] } }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('reports a container still processing as pending, then publishes it on the status check', async () => {
    const { fetchImpl, calls } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }],
      'GET /9001': [{ body: { status_code: 'IN_PROGRESS' } }, { body: { status_code: 'FINISHED' } }],
      // Before publishing on the status check, it looks for a post that already went out.
      [`GET /${IG}/media`]: [{ body: { data: [] } }],
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000003' } }],
      'GET /18000000000000003': [{ body: { permalink: 'https://www.instagram.com/p/def/' } }],
    });
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    expect(await publisher.publish(input())).toEqual({ kind: 'pending', externalRef: ref('9001'), checkAfterSeconds: 30 });
    expect(calls.some((c) => c.route.endsWith('/media_publish'))).toBe(false);
    expect(await publisher.status({ externalAccountId: IG, secret: SECRET, externalRef: ref('9001') })).toMatchObject({ kind: 'accepted', externalId: '18000000000000003' });
  });

  it('finds the post of a container that was published already instead of publishing again', async () => {
    const { fetchImpl, calls } = graph({
      'GET /9001': [{ body: { status_code: 'PUBLISHED' } }],
      [`GET /${IG}/media`]: [{ body: { data: [{ id: '18000000000000004', caption: 'Khai trương!', timestamp: new Date().toISOString(), permalink: 'https://www.instagram.com/p/ghi/' }] } }],
    });
    const result = await new InstagramPublisher(APP, fetchImpl, fast).status({ externalAccountId: IG, secret: SECRET, externalRef: ref('9001') });
    expect(result).toEqual({ kind: 'accepted', externalId: '18000000000000004', url: 'https://www.instagram.com/p/ghi/' });
    expect(calls.some((c) => c.route.endsWith('/media_publish'))).toBe(false);
  });

  it('never takes an unrelated newer post for the one a container became', async () => {
    const { fetchImpl } = graph({
      'GET /9001': [{ body: { status_code: 'PUBLISHED' } }],
      [`GET /${IG}/media`]: [{ body: { data: [{ id: '18000000000000099', caption: 'Bài đăng tay của chủ tài khoản', timestamp: new Date().toISOString() }] } }],
    });
    const result = await new InstagramPublisher(APP, fetchImpl, fast).status({ externalAccountId: IG, secret: SECRET, externalRef: ref('9001') });
    expect(result).toMatchObject({ kind: 'unknown', code: 'PUBLISHED_NOT_FOUND' });
  });

  it('reports a refused token while checking a pending container', async () => {
    const { fetchImpl } = graph({ 'GET /9001': [{ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } }] });
    expect(await new InstagramPublisher(APP, fetchImpl, fast).status({ externalAccountId: IG, secret: SECRET, externalRef: ref('9001') })).toMatchObject({ kind: 'rejected', error: 'token_expired' });
  });

  it('checks the container when media_publish fails, so a publish that went through is not repeated', async () => {
    const { fetchImpl } = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }],
      'GET /9001': [{ body: { status_code: 'FINISHED' } }, { body: { status_code: 'PUBLISHED' } }],
      [`POST /${IG}/media_publish`]: [{ status: 500, body: { error: { message: 'Service temporarily unavailable', code: 2 } } }],
      [`GET /${IG}/media`]: [{ body: { data: [{ id: '18000000000000005', caption: 'Khai trương!', timestamp: new Date().toISOString() }] } }],
    });
    expect(await new InstagramPublisher(APP, fetchImpl, fast).publish(input())).toMatchObject({ kind: 'accepted', externalId: '18000000000000005' });
  });

  it('answers unknown when media_publish fails and the container is not published, and reconciles by caption', async () => {
    const failing = graph({
      [`POST /${IG}/media`]: [{ body: { id: '9001' } }],
      'GET /9001': [{ body: { status_code: 'FINISHED' } }, { body: { status_code: 'FINISHED' } }],
      [`POST /${IG}/media_publish`]: [{ status: 500, body: { error: { message: 'Service temporarily unavailable', code: 2 } } }],
    });
    expect((await new InstagramPublisher(APP, failing.fetchImpl, fast).publish(input())).kind).toBe('unknown');
    const listing = graph({ [`GET /${IG}/media`]: [{ body: { data: [{ id: '18000000000000006', caption: 'Khai trương!', timestamp: new Date().toISOString(), permalink: 'https://www.instagram.com/p/jkl/' }] } }] });
    const found = await new InstagramPublisher(APP, listing.fetchImpl, fast).reconcile({
      externalAccountId: IG,
      secret: SECRET,
      callKey: 'call-1',
      contentHash: `sha256:${'0'.repeat(64)}`,
      content: input().content,
      after: new Date(Date.now() - 600_000),
      before: new Date(),
    });
    expect(found).toEqual({ found: true, externalId: '18000000000000006', url: 'https://www.instagram.com/p/jkl/' });
  });

  it('maps a refused token and a refused container to rejections, with nothing published', async () => {
    const expired = graph({ [`POST /${IG}/media`]: [{ status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } }] });
    expect(await new InstagramPublisher(APP, expired.fetchImpl, fast).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const broken = graph({ [`POST /${IG}/media`]: [{ body: { id: '9001' } }], 'GET /9001': [{ body: { status_code: 'ERROR' } }] });
    expect(await new InstagramPublisher(APP, broken.fetchImpl, fast).publish(input())).toMatchObject({ kind: 'rejected', code: 'CONTAINER_ERROR' });
  });
});

describe('InstagramPublisher metrics', () => {
  const metricsInput = { externalAccountId: IG, secret: SECRET, externalId: '18000000000000042' };

  it('reads likes and comments, and reach, saves, shares and views from the insights', async () => {
    const { fetchImpl, calls } = graph({
      'GET /18000000000000042': [{ body: { like_count: 12, comments_count: 3, id: '18000000000000042' } }],
      'GET /18000000000000042/insights': [
        {
          body: {
            data: [
              { name: 'reach', period: 'lifetime', values: [{ value: 140 }] },
              { name: 'saved', period: 'lifetime', values: [{ value: 4 }] },
              { name: 'shares', period: 'lifetime', values: [{ value: 2 }] },
              { name: 'views', period: 'lifetime', total_value: { value: 310 } },
            ],
          },
        },
      ],
    });
    expect(await new InstagramPublisher(APP, fetchImpl).metrics(metricsInput)).toEqual({ metrics: { reactions: 12, comments: 3, reach: 140, saves: 4, shares: 2, views: 310 } });
    expect(calls[0]?.query.get('fields')).toBe('like_count,comments_count');
    expect(calls[1]?.query.get('metric')).toBe('reach,saved,shares,views');
  });

  it('keeps the plain counts when the insights are refused (no insights permission)', async () => {
    const { fetchImpl } = graph({
      'GET /18000000000000042': [{ body: { like_count: 5, comments_count: 0 } }],
      'GET /18000000000000042/insights': [{ status: 403, body: { error: { message: '(#10) Application does not have permission for this action', code: 10 } } }],
    });
    expect(await new InstagramPublisher(APP, fetchImpl).metrics(metricsInput)).toEqual({ metrics: { reactions: 5, comments: 0 } });
  });

  it('tells a deleted post and a dead token from an outage', async () => {
    const gone = graph({ 'GET /18000000000000042': [{ status: 400, body: { error: { message: 'Unsupported get request.', code: 100, error_subcode: 33 } } }] });
    expect(await new InstagramPublisher(APP, gone.fetchImpl).metrics(metricsInput)).toEqual({ refused: 'gone' });
    const dead = graph({ 'GET /18000000000000042': [{ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } }] });
    expect(await new InstagramPublisher(APP, dead.fetchImpl).metrics(metricsInput)).toEqual({ refused: 'token_expired' });
    const down = graph({ 'GET /18000000000000042': [{ status: 503, body: {} }] });
    expect(await new InstagramPublisher(APP, down.fetchImpl).metrics(metricsInput)).toBeNull();
    expect(await new InstagramPublisher(APP, down.fetchImpl).metrics({ ...metricsInput, externalId: 'not-a-media-id' })).toEqual({ refused: 'gone' });
  });
});