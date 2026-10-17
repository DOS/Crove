// Instagram through Facebook Login against recorded Graph answers (shapes from Meta's docs); no live call.
import { describe, expect, it } from 'vitest';
import { InstagramConnector, InstagramPublisher, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { appId: '1234567890', appSecret: 'test-app-secret-not-real' };
const IG = '17841400000000001';
const SECRET = JSON.stringify({ accessToken: 'page-token-1', pageId: '111' });
const REDIRECT = 'https://crove.example/channels/oauth/instagram/callback';

// Answers per "METHOD /path" in order; records every call with its form.
function graph(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; form: Record<string, string>; query: URLSearchParams }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/v24.0', '')}`;
    calls.push({ route, form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')), query: url.searchParams });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, code: 1 } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
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

describe('InstagramConnector', () => {
  it('asks for the Instagram publishing permissions and connects the business account of each Page', async () => {
    const { fetchImpl, calls } = graph({
      'POST /oauth/access_token': [{ body: { access_token: 'short' } }, { body: { access_token: 'long-user-token' } }],
      'GET /me/permissions': [
        { body: { data: ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'].map((permission) => ({ permission, status: 'granted' })) } },
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
    expect(url.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish');
    const accounts = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null });
    expect(accounts).toEqual([
      {
        provider: 'instagram',
        externalAccountId: IG,
        displayName: '@quan.a',
        scopes: ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'],
        expiresAt: null,
        secret: JSON.stringify({ accessToken: 'page-token-111', pageId: '111' }),
      },
    ]);
    expect(calls.find((c) => c.route === 'GET /me/accounts')?.query.get('fields')).toContain('instagram_business_account');
  });
});

describe('InstagramPublisher', () => {
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
      [`POST /${IG}/media_publish`]: [{ body: { id: '18000000000000003' } }],
      'GET /18000000000000003': [{ body: { permalink: 'https://www.instagram.com/p/def/' } }],
    });
    const publisher = new InstagramPublisher(APP, fetchImpl, fast);
    expect(await publisher.publish(input())).toEqual({ kind: 'pending', externalRef: '9001', checkAfterSeconds: 30 });
    expect(calls.some((c) => c.route.endsWith('/media_publish'))).toBe(false);
    expect(await publisher.status({ externalAccountId: IG, secret: SECRET, externalRef: '9001' })).toMatchObject({ kind: 'accepted', externalId: '18000000000000003' });
  });

  it('finds the post of a container that was published already instead of publishing again', async () => {
    const { fetchImpl, calls } = graph({
      'GET /9001': [{ body: { status_code: 'PUBLISHED' } }],
      [`GET /${IG}/media`]: [{ body: { data: [{ id: '18000000000000004', caption: 'Khai trương!', timestamp: new Date().toISOString(), permalink: 'https://www.instagram.com/p/ghi/' }] } }],
    });
    const result = await new InstagramPublisher(APP, fetchImpl, fast).status({ externalAccountId: IG, secret: SECRET, externalRef: '9001' });
    expect(result).toEqual({ kind: 'accepted', externalId: '18000000000000004', url: 'https://www.instagram.com/p/ghi/' });
    expect(calls.some((c) => c.route.endsWith('/media_publish'))).toBe(false);
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
