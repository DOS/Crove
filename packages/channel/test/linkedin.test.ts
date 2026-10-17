// LinkedIn against recorded answers (shapes from LinkedIn's Share on LinkedIn, Posts and Images API docs); no live call.
import { describe, expect, it } from 'vitest';
import { LINKEDIN_VERSION, LinkedInConnector, LinkedInPublisher, littleText, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { clientId: '86abcdefgh1234', clientSecret: 'test-linkedin-secret-not-real' };
const MEMBER = 'yrZCpj2Z12';
const SECRET = JSON.stringify({ accessToken: 'li-token-1' });
const REDIRECT = 'https://crove.example/channels/oauth/linkedin/callback';
const UPLOAD = 'https://www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload?ca=vector_feedshare';

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
function linkedin(routes: Record<string, Answer[]>) {
  const calls: { route: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}${url.search.includes('action=') ? url.search : ''}`;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    calls.push({ route, headers, body: typeof raw === 'string' ? (headers.get('content-type')?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : raw });
    const answer = routes[route]?.shift() ?? { status: 500, body: { message: `no answer for ${route}`, status: 500 } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', ...answer.headers } });
  };
  return { calls, fetchImpl };
}

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: MEMBER,
  secret: SECRET,
  content: { body: 'Khai trương chi nhánh mới (Q1)', title: null, linkUrl: null, media: [] },
  readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});
const image = (fileId: string, altText: string | null = null) => ({ fileId, mime: 'image/jpeg', sizeBytes: 1000, altText });

describe('LinkedInConnector', () => {
  it('asks for member posting, and connects the member with a 60-day token', async () => {
    const { fetchImpl, calls } = linkedin({
      'POST www.linkedin.com/oauth/v2/accessToken': [{ body: { access_token: 'li-token-1', expires_in: 5_184_000, scope: 'email,openid,profile,w_member_social' } }],
      'GET api.linkedin.com/v2/userinfo': [{ body: { sub: MEMBER, name: 'Nguyễn Văn A', email_verified: true } }],
    });
    const connector = new LinkedInConnector(APP, fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: null }));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
    const [account] = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null }, 1_000_000);
    expect(account).toMatchObject({ provider: 'linkedin', externalAccountId: MEMBER, displayName: 'Nguyễn Văn A', secret: SECRET, expiresAt: new Date(1_000_000 + 5_184_000_000) });
    expect(calls[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT, client_id: APP.clientId });
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer li-token-1');
  });

  it('maps a refused code to invalid_grant and a missing posting grant to denied', async () => {
    const used = linkedin({ 'POST www.linkedin.com/oauth/v2/accessToken': [{ status: 400, body: { error: 'invalid_request', error_description: 'Unable to retrieve access token: authorization code not found' } }] });
    await expect(new LinkedInConnector(APP, used.fetchImpl).exchange({ code: 'used', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const narrow = linkedin({ 'POST www.linkedin.com/oauth/v2/accessToken': [{ body: { access_token: 't', expires_in: 5_184_000, scope: 'openid,profile' } }] });
    await expect(new LinkedInConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied' });
  });
});

describe('LinkedInPublisher', () => {
  it('never retries on its own: a member app cannot list its posts', () => {
    expect(new LinkedInPublisher().publishSafety).toBe('never');
  });

  it('posts the text once, with reserved characters escaped and the version header', async () => {
    const { fetchImpl, calls } = linkedin({ 'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7100000000000000001' } }] });
    expect(await new LinkedInPublisher({}, fetchImpl).publish(input({ content: { body: 'Khai trương chi nhánh mới (Q1)', title: null, linkUrl: 'https://example.com/a', media: [] } }))).toEqual({
      kind: 'accepted',
      externalId: 'urn:li:share:7100000000000000001',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:7100000000000000001/',
    });
    expect(calls[0]?.headers.get('linkedin-version')).toBe(LINKEDIN_VERSION);
    expect(calls[0]?.body).toMatchObject({
      author: `urn:li:person:${MEMBER}`,
      commentary: 'Khai trương chi nhánh mới \\(Q1\\)\n\nhttps://example.com/a',
      visibility: 'PUBLIC',
      lifecycleState: 'PUBLISHED',
    });
  });

  it('uploads images first, then one post with them', async () => {
    const { fetchImpl, calls } = linkedin({
      'POST api.linkedin.com/rest/images?action=initializeUpload': [
        { body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQ1' } } },
        { body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQ2' } } },
      ],
      'PUT www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload': [{ status: 201 }, { status: 201 }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7100000000000000002' } }],
    });
    const content = { body: 'Bộ ảnh', title: null, linkUrl: null, media: [image('f-1', 'Mặt tiền'), image('f-2')] };
    expect((await new LinkedInPublisher({}, fetchImpl).publish(input({ content }))).kind).toBe('accepted');
    expect(calls[0]?.body).toEqual({ initializeUploadRequest: { owner: `urn:li:person:${MEMBER}` } });
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer li-token-1');
    expect(calls.at(-1)?.body).toMatchObject({ content: { multiImage: { images: [{ id: 'urn:li:image:C4E10AQ1', altText: 'Mặt tiền' }, { id: 'urn:li:image:C4E10AQ2' }] } } });

    const one = linkedin({
      'POST api.linkedin.com/rest/images?action=initializeUpload': [{ body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQ3' } } }],
      'PUT www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload': [{ status: 201 }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7100000000000000003' } }],
    });
    await new LinkedInPublisher({}, one.fetchImpl).publish(input({ content: { ...content, media: [image('f-3')] } }));
    expect(one.calls.at(-1)?.body).toMatchObject({ content: { media: { id: 'urn:li:image:C4E10AQ3' } } });
  });

  it('posts nothing when an upload fails or names a host outside LinkedIn', async () => {
    const down = linkedin({
      'POST api.linkedin.com/rest/images?action=initializeUpload': [{ body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQ1' } } }],
      'PUT www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload': [{ status: 503 }],
    });
    expect(await new LinkedInPublisher({}, down.fetchImpl).publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image('f-1')] } }))).toMatchObject({ kind: 'rejected', error: 'transient' });
    expect(down.calls.some((c) => c.route.includes('/rest/posts'))).toBe(false);
    const elsewhere = linkedin({ 'POST api.linkedin.com/rest/images?action=initializeUpload': [{ body: { value: { uploadUrl: 'https://evil.example/upload', image: 'urn:li:image:C4E10AQ1' } } }] });
    expect((await new LinkedInPublisher({}, elsewhere.fetchImpl).publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image('f-1')] } }))).kind).toBe('rejected');
    expect(elsewhere.calls.some((c) => c.route.includes('evil.example'))).toBe(false);
  });

  it('maps a dead token, a refusal and an outage, and treats a created post without an id as unknown', async () => {
    const dead = linkedin({ 'POST api.linkedin.com/rest/posts': [{ status: 401, body: { status: 401, serviceErrorCode: 65601, code: 'REVOKED_ACCESS_TOKEN', message: 'The token used in the request has been revoked by the user' } }] });
    expect(await new LinkedInPublisher({}, dead.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'REVOKED_ACCESS_TOKEN' });
    const dup = linkedin({ 'POST api.linkedin.com/rest/posts': [{ status: 422, body: { status: 422, message: 'Content is a duplicate of urn:li:share:7100000000000000009' } }] });
    expect(await new LinkedInPublisher({}, dup.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request' });
    const down = linkedin({ 'POST api.linkedin.com/rest/posts': [{ status: 504, body: {} }] });
    expect((await new LinkedInPublisher({}, down.fetchImpl).publish(input())).kind).toBe('unknown');
    const noId = linkedin({ 'POST api.linkedin.com/rest/posts': [{ status: 201 }] });
    expect(await new LinkedInPublisher({}, noId.fetchImpl).publish(input())).toEqual({ kind: 'unknown', code: 'NO_POST_ID' });
    expect(await new LinkedInPublisher({}, noId.fetchImpl).publish(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
  });
});

describe('littleText', () => {
  it('escapes every reserved character and keeps the rest', () => {
    expect(littleText('Giảm 20% #sale @shop (hôm nay) [mới] <a> *x* _y_ ~z~ {t} a|b \\')).toBe('Giảm 20% \\#sale \\@shop \\(hôm nay\\) \\[mới\\] \\<a\\> \\*x\\* \\_y\\_ \\~z\\~ \\{t\\} a\\|b \\\\');
  });
});
