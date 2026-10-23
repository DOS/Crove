// LinkedIn against recorded answers (shapes from LinkedIn's Share on LinkedIn, Posts, Images, Videos and Documents API
// docs); no live call.
import { describe, expect, it } from 'vitest';
import { LINKEDIN_DOCUMENT_MAX_BYTES, LINKEDIN_DOCUMENT_TITLE_MAX, LINKEDIN_VERSION, LinkedInConnector, LinkedInPageConnector, LinkedInPagePublisher, LinkedInPublisher, linkedinDocumentTitle, linkedinDocumentTitleOf, littleText, type Fetch, type PublishInput } from '../src/index.ts';

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

  it('sends who sees the post as its visibility, PUBLIC when unsaid, and refuses an unknown value before any call (#983)', async () => {
    const answers = () => [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7100000000000000004' } }];
    const sent = async (settings: Record<string, unknown>) => {
      const { fetchImpl, calls } = linkedin({ 'POST api.linkedin.com/rest/posts': answers() });
      expect((await new LinkedInPublisher({}, fetchImpl).publish(input({ settings }))).kind).toBe('accepted');
      return calls[0]?.body;
    };
    // The default sends exactly the body it sent before the setting existed.
    expect(await sent({})).toEqual({
      author: `urn:li:person:${MEMBER}`,
      commentary: 'Khai trương chi nhánh mới \\(Q1\\)',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    expect(await sent({ visibility: 'public' })).toMatchObject({ visibility: 'PUBLIC' });
    expect(await sent({ visibility: 'connections' })).toMatchObject({ visibility: 'CONNECTIONS' });
    expect(await sent({ visibility: 'loggedIn' })).toMatchObject({ visibility: 'LOGGED_IN' });

    // Images and a video carry it too.
    const img = linkedin({
      'POST api.linkedin.com/rest/images?action=initializeUpload': [{ body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQ9' } } }],
      'PUT www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload': [{ status: 201 }],
      'POST api.linkedin.com/rest/posts': answers(),
    });
    await new LinkedInPublisher({}, img.fetchImpl).publish(input({ content: { body: 'Ảnh', title: null, linkUrl: null, media: [image('f-9')] }, settings: { visibility: 'connections' } }));
    expect(img.calls.at(-1)?.body).toMatchObject({ visibility: 'CONNECTIONS', content: { media: { id: 'urn:li:image:C4E10AQ9' } } });

    const none = linkedin({});
    const publisher = new LinkedInPublisher({}, none.fetchImpl);
    for (const visibility of ['CONNECTIONS', 'unlisted', 'toString', 7]) {
      expect(await publisher.publish(input({ settings: { visibility } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'VISIBILITY_INVALID' });
    }
    expect(await publisher.publish(input({ content: { body: 'Ảnh', title: null, linkUrl: null, media: [image('f-9')] }, settings: { visibility: 'friends' } }))).toMatchObject({ code: 'VISIBILITY_INVALID' });
    expect(none.calls).toHaveLength(0);
  });

  it('posts a poll as the content, with its own question and LinkedIn duration, a week when unsaid (#1118)', async () => {
    const created = (n: number) => ({ status: 201, headers: { 'x-restli-id': `urn:li:ugcPost:690000000000000000${n}` } });
    const { fetchImpl, calls } = linkedin({ 'POST api.linkedin.com/rest/posts': [created(1), created(2), created(3), created(4)] });
    const publisher = new LinkedInPublisher({}, fetchImpl);
    const asked = (poll: Record<string, unknown>) => input({ settings: { poll } });
    expect(await publisher.publish(asked({ question: ' Món nào ngon nhất? ', options: [' Phở ', 'Bún chả'] }))).toEqual({
      kind: 'accepted',
      externalId: 'urn:li:ugcPost:6900000000000000001',
      url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:6900000000000000001/',
    });
    for (const minutes of [1440, 4320, 20_160]) await publisher.publish(asked({ question: 'Q', options: ['a', 'b', 'c', 'd'], durationMinutes: minutes }));
    expect(calls[0]?.body).toEqual({
      author: `urn:li:person:${MEMBER}`,
      commentary: 'Khai trương chi nhánh mới \\(Q1\\)',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: { poll: { question: 'Món nào ngon nhất?', options: [{ text: 'Phở' }, { text: 'Bún chả' }], settings: { duration: 'SEVEN_DAYS' } } },
    });
    expect(calls.slice(1).map((c) => (c.body as { content: { poll: { settings: unknown } } }).content.poll.settings)).toEqual([{ duration: 'ONE_DAY' }, { duration: 'THREE_DAYS' }, { duration: 'FOURTEEN_DAYS' }]);
  });

  it('refuses a poll with media, without a question, or LinkedIn would refuse, before any call (#1118)', async () => {
    const none = linkedin({});
    const publisher = new LinkedInPublisher({}, none.fetchImpl);
    const poll = { question: 'Món nào?', options: ['Phở', 'Bún chả'] };
    expect(await publisher.publish(input({ content: { body: 'Ảnh', title: null, linkUrl: null, media: [image('f-9')] }, settings: { poll } }))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'POLL_WITH_MEDIA' });
    expect(await publisher.publish(input({ content: { body: 'Clip', title: null, linkUrl: null, media: [{ fileId: 'v', mime: 'video/mp4', sizeBytes: 10, altText: null }] }, settings: { poll } }))).toMatchObject({ code: 'POLL_WITH_MEDIA' });
    for (const bad of [
      { options: poll.options },
      { ...poll, question: 'x'.repeat(141) },
      { ...poll, options: ['Phở'] },
      { ...poll, options: ['a', 'b', 'c', 'd', 'e'] },
      { ...poll, options: ['Phở', 'x'.repeat(31)] },
      { ...poll, durationMinutes: 2880 },
      { ...poll, multiple: true },
      { ...poll, hideTotals: true },
      'có',
    ]) {
      expect(await publisher.publish(input({ settings: { poll: bad } }))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'POLL_INVALID' });
    }
    expect(none.calls).toHaveLength(0);
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

describe('LinkedInPublisher video', () => {
  const VIDEO = 'urn:li:video:C5505AQH-oV1qvnFtKA';
  const PART = 'https://www.linkedin.com/dms-uploads/C5505AQH-oV1qvnFtKA/uploadedVideo';
  const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 10, altText: null };
  const withClip = (over: Partial<PublishInput> = {}) => input({ content: { ...input().content, media: [clip] }, readMedia: async () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), ...over });
  const quick = { processingWaitMs: 1000, pollMs: 0 };
  const init = () => ({
    'POST api.linkedin.com/rest/videos?action=initializeUpload': [
      { body: { value: { video: VIDEO, uploadToken: '', uploadInstructions: [{ uploadUrl: `${PART}?part=0`, firstByte: 0, lastByte: 5 }, { uploadUrl: `${PART}?part=1`, firstByte: 6, lastByte: 9 }] } } },
    ],
  });
  const status = `GET api.linkedin.com/rest/videos/${encodeURIComponent(VIDEO)}`;

  it('uploads each part, finalizes with the ETags, waits until the video is available, then posts it once', async () => {
    const { fetchImpl, calls } = linkedin({
      ...init(),
      [`PUT www.linkedin.com/dms-uploads/C5505AQH-oV1qvnFtKA/uploadedVideo`]: [{ headers: { etag: 'etag-0' } }, { headers: { etag: 'etag-1' } }],
      'POST api.linkedin.com/rest/videos?action=finalizeUpload': [{ body: {} }],
      [status]: [{ body: { id: VIDEO, status: 'PROCESSING' } }, { body: { id: VIDEO, status: 'AVAILABLE' } }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7300000000000000001' } }],
    });
    const publisher = new LinkedInPublisher({}, fetchImpl, quick);
    expect(publisher.callTimeoutMs).toBeGreaterThan(300_000);
    expect(publisher.callTimeoutMs).toBeLessThan(600_000);
    expect(await publisher.publish(withClip())).toEqual({ kind: 'accepted', externalId: 'urn:li:share:7300000000000000001', url: 'https://www.linkedin.com/feed/update/urn:li:share:7300000000000000001/' });
    expect(calls[0]?.body).toEqual({ initializeUploadRequest: { owner: `urn:li:person:${MEMBER}`, fileSizeBytes: 10, uploadCaptions: false, uploadThumbnail: false } });
    expect(calls.filter((c) => c.route.startsWith('PUT')).map((c) => (c.body as Blob).size)).toEqual([6, 4]);
    expect(calls.find((c) => c.route.endsWith('finalizeUpload'))?.body).toEqual({ finalizeUploadRequest: { video: VIDEO, uploadToken: '', uploadedPartIds: ['etag-0', 'etag-1'] } });
    expect(calls.at(-1)?.body).toMatchObject({ author: `urn:li:person:${MEMBER}`, visibility: 'PUBLIC', content: { media: { id: VIDEO } } });
  });

  it('sends the chosen visibility on a video post, and refuses an unknown one before reading the file (#983)', async () => {
    const { fetchImpl, calls } = linkedin({
      ...init(),
      [`PUT www.linkedin.com/dms-uploads/C5505AQH-oV1qvnFtKA/uploadedVideo`]: [{ headers: { etag: 'etag-0' } }, { headers: { etag: 'etag-1' } }],
      'POST api.linkedin.com/rest/videos?action=finalizeUpload': [{ body: {} }],
      [status]: [{ body: { id: VIDEO, status: 'AVAILABLE' } }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7300000000000000002' } }],
    });
    expect((await new LinkedInPublisher({}, fetchImpl, quick).publish(withClip({ settings: { visibility: 'loggedIn' } }))).kind).toBe('accepted');
    expect(calls.at(-1)?.body).toMatchObject({ visibility: 'LOGGED_IN', content: { media: { id: VIDEO } } });
    let read = false;
    const none = linkedin({});
    const refused = await new LinkedInPublisher({}, none.fetchImpl, quick).publish(
      withClip({
        settings: { visibility: 'LOGGED_IN' },
        readMedia: async () => {
          read = true;
          return new Uint8Array(10);
        },
      }),
    );
    expect(refused).toMatchObject({ kind: 'rejected', code: 'VISIBILITY_INVALID' });
    expect(read).toBe(false);
    expect(none.calls).toHaveLength(0);
  });

  it('posts nothing when processing fails, a part is refused, or the file is not MP4', async () => {
    const failed = linkedin({
      ...init(),
      [`PUT www.linkedin.com/dms-uploads/C5505AQH-oV1qvnFtKA/uploadedVideo`]: [{ headers: { etag: 'etag-0' } }, { headers: { etag: 'etag-1' } }],
      'POST api.linkedin.com/rest/videos?action=finalizeUpload': [{ body: {} }],
      [status]: [{ body: { id: VIDEO, status: 'PROCESSING_FAILED', processingFailureReason: 'Unsupported codec' } }],
    });
    expect(await new LinkedInPublisher({}, failed.fetchImpl, quick).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'VIDEO_PROCESSING_FAILED', message: 'Unsupported codec' });
    const refused = linkedin({ ...init(), [`PUT www.linkedin.com/dms-uploads/C5505AQH-oV1qvnFtKA/uploadedVideo`]: [{ status: 503 }] });
    expect(await new LinkedInPublisher({}, refused.fetchImpl, quick).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'transient' });
    // Parts that leave a gap or run past the file, and a spent budget, stop before any byte is sent.
    const gap = linkedin({
      'POST api.linkedin.com/rest/videos?action=initializeUpload': [{ body: { value: { video: VIDEO, uploadToken: '', uploadInstructions: [{ uploadUrl: PART, firstByte: 0, lastByte: 4 }, { uploadUrl: PART, firstByte: 6, lastByte: 9 }] } } }],
    });
    expect(await new LinkedInPublisher({}, gap.fetchImpl, quick).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'transient', code: 'BAD_UPLOAD_PART' });
    const past = linkedin({ 'POST api.linkedin.com/rest/videos?action=initializeUpload': [{ body: { value: { video: VIDEO, uploadToken: '', uploadInstructions: [{ uploadUrl: PART, firstByte: 0, lastByte: 20 }] } } }] });
    expect(await new LinkedInPublisher({}, past.fetchImpl, quick).publish(withClip())).toMatchObject({ code: 'BAD_UPLOAD_PART' });
    const spent = linkedin(init());
    expect(await new LinkedInPublisher({}, spent.fetchImpl, { ...quick, budgetMs: 0 }).publish(withClip())).toMatchObject({ kind: 'rejected', error: 'transient', code: 'VIDEO_TOO_SLOW' });
    for (const run of [gap, past, spent]) expect(run.calls.some((c) => c.route.startsWith('PUT'))).toBe(false);
    const mov = linkedin({});
    expect(await new LinkedInPublisher({}, mov.fetchImpl, quick).publish(withClip({ content: { ...input().content, media: [{ ...clip, mime: 'video/quicktime' }] } }))).toMatchObject({ kind: 'rejected', code: 'VIDEO_TYPE' });
    expect(mov.calls).toHaveLength(0);
    for (const run of [failed, refused]) expect(run.calls.some((c) => c.route === 'POST api.linkedin.com/rest/posts')).toBe(false);
  });
});

describe('LinkedIn post counts (#797)', () => {
  const URN = 'urn:li:share:7123456789012345678';
  const counts = [120, 80, 9, 3, 2];
  const analytics = (answers: { status?: number; body?: unknown }[]) => {
    const urls: URL[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      urls.push(new URL(url));
      expect(new Headers(init?.headers).get('linkedin-version')).toBe(LINKEDIN_VERSION);
      const a = answers.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    return { urls, fetchImpl };
  };

  it('reads nothing unless the app has member post analytics, and then asks for its scope too', () => {
    expect(new LinkedInPublisher().metrics).toBeUndefined();
    const url = new URL(new LinkedInConnector({ ...APP, analytics: true }).authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null }));
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social r_member_postAnalytics');
    expect(new URL(new LinkedInConnector(APP).authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null })).searchParams.get('scope')).toBe('openid profile w_member_social');
  });

  it('reads impressions, reach, reactions, comments and reshares, one call each', async () => {
    const { urls, fetchImpl } = analytics(counts.map((count) => ({ body: { elements: [{ count, metricType: {} }] } })));
    const read = await new LinkedInPublisher({ analytics: true }, fetchImpl).metrics?.({ externalAccountId: MEMBER, secret: SECRET, externalId: URN });
    expect(read).toEqual({ metrics: { impressions: 120, reach: 80, reactions: 9, comments: 3, shares: 2 } });
    expect(urls.map((u) => u.searchParams.get('queryType'))).toEqual(['IMPRESSION', 'MEMBERS_REACHED', 'REACTION', 'COMMENT', 'RESHARE']);
    expect(urls[0]?.pathname).toBe('/rest/memberCreatorPostAnalytics');
    expect(urls[0]?.search).toContain(`entity=(share:${encodeURIComponent(URN)})`);
  });

  it('keeps nothing without the permission, and tells a deleted post and a dead token apart', async () => {
    const publisher = (answers: { status?: number; body?: unknown }[]) => new LinkedInPublisher({ analytics: true }, analytics(answers).fetchImpl);
    const ask = (p: LinkedInPublisher, externalId = URN) => p.metrics?.({ externalAccountId: MEMBER, secret: SECRET, externalId });
    expect(await ask(publisher([{ status: 403, body: { message: 'Not enough permissions' } }]))).toBeNull();
    expect(await ask(publisher([{ status: 404, body: {} }]))).toEqual({ refused: 'gone' });
    expect(await ask(publisher([{ status: 401, body: {} }]))).toEqual({ refused: 'token_expired' });
    expect(await ask(publisher([]), 'not-a-urn')).toEqual({ refused: 'gone' });
  });
});

// Company Pages (#1077), against answers shaped like the Organization Access Control, Organization Lookup, Posts,
// Images, Videos and Comments API docs (Community Management API, Linkedin-Version 202604); no live call.
describe('LinkedIn Company Pages (#1077)', () => {
  const PAGE_REDIRECT = 'https://crove.example/channels/oauth/linkedin_page/callback';
  const ORG_A = '2414183';
  const ORG_B = '79988552';
  const ACL = '/rest/organizationAcls';
  const pageInput = (over: Partial<PublishInput> = {}) => input({ externalAccountId: ORG_A, ...over });
  // Routes by method, host, path and query, so each finder and batch call is named exactly.
  function pages(routes: Record<string, Answer[]>) {
    const calls: { route: string; url: URL; headers: Headers; body: unknown }[] = [];
    const fetchImpl: Fetch = async (raw, init) => {
      const url = new URL(raw);
      const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
      const headers = new Headers(init?.headers);
      const sent = init?.body;
      calls.push({ route, url, headers, body: typeof sent === 'string' ? (headers.get('content-type')?.includes('json') ? JSON.parse(sent) : Object.fromEntries(new URLSearchParams(sent))) : sent });
      const answer = routes[`${route}${url.search.includes('action=') ? url.search : ''}`]?.shift() ?? { status: 500, body: { message: `no answer for ${route}`, status: 500 } };
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', ...answer.headers } });
    };
    return { calls, fetchImpl };
  }
  const token = (scope: string) => ({ 'POST www.linkedin.com/oauth/v2/accessToken': [{ body: { access_token: 'li-page-token', expires_in: 5_184_000, scope } }] });
  const GRANTED = 'r_organization_admin,w_organization_social';

  it('asks for the page scopes only, and connects one channel per administered page', async () => {
    const { fetchImpl, calls } = pages({
      ...token(GRANTED),
      [`GET api.linkedin.com${ACL}`]: [
        {
          body: {
            elements: [
              // The docs' two shapes of the same answer: `organization` and `organizationTarget`.
              { role: 'ADMINISTRATOR', state: 'APPROVED', roleAssignee: `urn:li:person:${MEMBER}`, organization: `urn:li:organization:${ORG_A}` },
              { role: 'ADMINISTRATOR', state: 'APPROVED', roleAssignee: `urn:li:person:${MEMBER}`, organizationTarget: `urn:li:organization:${ORG_B}` },
              // Another role, a pending request and a duplicate connect nothing more.
              { role: 'ANALYST', state: 'APPROVED', organization: 'urn:li:organization:111' },
              { role: 'ADMINISTRATOR', state: 'REQUESTED', organization: 'urn:li:organization:222' },
              { role: 'ADMINISTRATOR', state: 'APPROVED', organization: `urn:li:organization:${ORG_A}` },
            ],
            paging: { count: 100, start: 0, links: [] },
          },
        },
      ],
      'GET api.linkedin.com/rest/organizations': [
        { body: { results: { [ORG_A]: { id: Number(ORG_A), localizedName: 'Tiệm Bánh B', vanityName: 'tiem-banh-b' }, [ORG_B]: { id: Number(ORG_B), vanityName: 'firstdemocompany' } }, statuses: { [ORG_A]: 200, [ORG_B]: 200 }, errors: {} } },
      ],
    });
    const connector = new LinkedInPageConnector(APP, fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 'st', redirectUri: PAGE_REDIRECT, codeChallenge: null }));
    expect(url.searchParams.get('scope')).toBe('w_organization_social r_organization_admin');
    expect(url.searchParams.get('redirect_uri')).toBe(PAGE_REDIRECT);
    const accounts = await connector.exchange({ code: 'c', redirectUri: PAGE_REDIRECT, codeVerifier: null }, 1_000_000);
    const secret = JSON.stringify({ accessToken: 'li-page-token' });
    expect(accounts).toEqual([
      { provider: 'linkedin_page', externalAccountId: ORG_A, displayName: 'Tiệm Bánh B', scopes: ['r_organization_admin', 'w_organization_social'], expiresAt: new Date(1_000_000 + 5_184_000_000), secret },
      { provider: 'linkedin_page', externalAccountId: ORG_B, displayName: 'firstdemocompany', scopes: ['r_organization_admin', 'w_organization_social'], expiresAt: new Date(1_000_000 + 5_184_000_000), secret },
    ]);
    const acl = calls.find((c) => c.url.pathname === ACL);
    expect(Object.fromEntries(acl?.url.searchParams ?? [])).toEqual({ q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED', start: '0', count: '100' });
    expect(acl?.headers.get('linkedin-version')).toBe(LINKEDIN_VERSION);
    expect(acl?.headers.get('x-restli-protocol-version')).toBe('2.0.0');
    expect(acl?.headers.get('authorization')).toBe('Bearer li-page-token');
    expect(calls.find((c) => c.url.pathname === '/rest/organizations')?.url.searchParams.get('ids')).toBe(`List(${ORG_A},${ORG_B})`);
  });

  it('reads every page of roles and names them in batches, keeping a page under a fallback name when the lookup fails', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(1000 + i));
    const rows = (slice: string[]) => slice.map((id) => ({ role: 'ADMINISTRATOR', state: 'APPROVED', organization: `urn:li:organization:${id}` }));
    const named = (slice: string[]) => ({ body: { results: Object.fromEntries(slice.map((id) => [id, { localizedName: `Trang ${id}` }])) } });
    const { fetchImpl, calls } = pages({
      ...token(GRANTED),
      [`GET api.linkedin.com${ACL}`]: [{ body: { elements: rows(ids.slice(0, 100)), paging: { links: [{ rel: 'next', href: `${ACL}?start=100` }] } } }, { body: { elements: rows(ids.slice(100)), paging: { links: [] } } }],
      'GET api.linkedin.com/rest/organizations': [named(ids.slice(0, 50)), { status: 500, body: { message: 'Internal Server Error' } }, named(ids.slice(100))],
    });
    const accounts = await new LinkedInPageConnector(APP, fetchImpl).exchange({ code: 'c', redirectUri: PAGE_REDIRECT, codeVerifier: null });
    expect(accounts.map((a) => a.externalAccountId)).toEqual(ids);
    expect(accounts[0]?.displayName).toBe('Trang 1000');
    expect(accounts[50]?.displayName).toBe('LinkedIn Page 1050');
    expect(accounts[100]?.displayName).toBe('Trang 1100');
    expect(calls.filter((c) => c.url.pathname === ACL).map((c) => c.url.searchParams.get('start'))).toEqual(['0', '100']);
    expect(calls.filter((c) => c.url.pathname === '/rest/organizations')).toHaveLength(3);
  });

  it('asks the next page after the rows LinkedIn returned when it answers fewer than asked for', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => String(2000 + i));
    const rows = (slice: string[]) => slice.map((id) => ({ role: 'ADMINISTRATOR', state: 'APPROVED', organization: `urn:li:organization:${id}` }));
    const { fetchImpl, calls } = pages({
      ...token(GRANTED),
      [`GET api.linkedin.com${ACL}`]: [{ body: { elements: rows(ids.slice(0, 10)), paging: { links: [{ rel: 'next', href: `${ACL}?start=10` }] } } }, { body: { elements: rows(ids.slice(10)), paging: { links: [] } } }],
      'GET api.linkedin.com/rest/organizations': [{ body: { results: {} } }],
    });
    const accounts = await new LinkedInPageConnector(APP, fetchImpl).exchange({ code: 'c', redirectUri: PAGE_REDIRECT, codeVerifier: null });
    expect(accounts.map((a) => a.externalAccountId)).toEqual(ids);
    expect(calls.filter((c) => c.url.pathname === ACL).map((c) => c.url.searchParams.get('start'))).toEqual(['0', '10']);
  });

  it('refuses a grant without a page scope as MISSING_PERMISSION before reading any page, and connects nothing for a member with no page', async () => {
    for (const scope of ['r_organization_admin', 'w_organization_social', 'openid,profile,w_member_social']) {
      const narrow = pages(token(scope));
      await expect(new LinkedInPageConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: PAGE_REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
      expect(narrow.calls.some((c) => c.url.host === 'api.linkedin.com')).toBe(false);
    }
    const used = pages({ 'POST www.linkedin.com/oauth/v2/accessToken': [{ status: 400, body: { error: 'invalid_request', error_description: 'authorization code not found' } }] });
    await expect(new LinkedInPageConnector(APP, used.fetchImpl).exchange({ code: 'used', redirectUri: PAGE_REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const refused = pages({ ...token(GRANTED), [`GET api.linkedin.com${ACL}`]: [{ status: 403, body: { status: 403, message: 'Not enough permissions to access: organizationAcls' } }] });
    await expect(new LinkedInPageConnector(APP, refused.fetchImpl).exchange({ code: 'c', redirectUri: PAGE_REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied' });
    const none = pages({ ...token(GRANTED), [`GET api.linkedin.com${ACL}`]: [{ body: { elements: [], paging: { links: [] } } }] });
    expect(await new LinkedInPageConnector(APP, none.fetchImpl).exchange({ code: 'c', redirectUri: PAGE_REDIRECT, codeVerifier: null })).toEqual([]);
    expect(none.calls.some((c) => c.url.pathname === '/rest/organizations')).toBe(false);
  });

  it('posts text as the page, never retried by itself and with no member counts', async () => {
    const { fetchImpl, calls } = pages({ 'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7400000000000000001' } }] });
    const publisher = new LinkedInPagePublisher({}, fetchImpl);
    expect(publisher.provider).toBe('linkedin_page');
    expect(publisher.publishSafety).toBe('never');
    expect(publisher).not.toHaveProperty('metrics');
    expect(await publisher.publish(pageInput())).toEqual({ kind: 'accepted', externalId: 'urn:li:share:7400000000000000001', url: 'https://www.linkedin.com/feed/update/urn:li:share:7400000000000000001/' });
    expect(calls[0]?.headers.get('linkedin-version')).toBe(LINKEDIN_VERSION);
    expect(calls[0]?.body).toEqual({
      author: `urn:li:organization:${ORG_A}`,
      commentary: 'Khai trương chi nhánh mới \\(Q1\\)',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('posts a poll as the page (#1118)', async () => {
    const { fetchImpl, calls } = pages({ 'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:ugcPost:7400000000000000009' } }] });
    const result = await new LinkedInPagePublisher({}, fetchImpl).publish(pageInput({ settings: { visibility: 'loggedIn', poll: { question: 'Chi nhánh tiếp theo ở đâu?', options: ['Quận 1', 'Thủ Đức', 'Bình Thạnh'], durationMinutes: 4320 } } }));
    expect(result).toMatchObject({ kind: 'accepted', externalId: 'urn:li:ugcPost:7400000000000000009' });
    expect(calls[0]?.body).toEqual({
      author: `urn:li:organization:${ORG_A}`,
      commentary: 'Khai trương chi nhánh mới \\(Q1\\)',
      visibility: 'LOGGED_IN',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: { poll: { question: 'Chi nhánh tiếp theo ở đâu?', options: [{ text: 'Quận 1' }, { text: 'Thủ Đức' }, { text: 'Bình Thạnh' }], settings: { duration: 'THREE_DAYS' } } },
    });
  });

  it('sends signed-in members only when chosen, and refuses connections and a member id before any call', async () => {
    const shown = pages({ 'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7400000000000000002' } }] });
    expect((await new LinkedInPagePublisher({}, shown.fetchImpl).publish(pageInput({ settings: { visibility: 'loggedIn' } }))).kind).toBe('accepted');
    expect(shown.calls[0]?.body).toMatchObject({ author: `urn:li:organization:${ORG_A}`, visibility: 'LOGGED_IN' });
    const none = pages({});
    const publisher = new LinkedInPagePublisher({}, none.fetchImpl);
    expect(await publisher.publish(pageInput({ settings: { visibility: 'connections' } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'VISIBILITY_INVALID' });
    expect(await publisher.publish(pageInput({ externalAccountId: MEMBER }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' });
    expect(await publisher.comment({ externalAccountId: MEMBER, secret: SECRET, externalId: 'urn:li:share:7400000000000000002', text: 'x', callKey: 'k' })).toMatchObject({ kind: 'rejected', code: 'BAD_ACCOUNT_ID' });
    expect(none.calls).toHaveLength(0);
  });

  it('uploads an image and several images owned by the page, then posts them as the page', async () => {
    const one = pages({
      'POST api.linkedin.com/rest/images?action=initializeUpload': [{ body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQP1' } } }],
      'PUT www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload': [{ status: 201 }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7400000000000000003' } }],
    });
    expect((await new LinkedInPagePublisher({}, one.fetchImpl).publish(pageInput({ content: { body: 'Ảnh', title: null, linkUrl: null, media: [image('f-1', 'Mặt tiền')] } }))).kind).toBe('accepted');
    expect(one.calls[0]?.body).toEqual({ initializeUploadRequest: { owner: `urn:li:organization:${ORG_A}` } });
    expect(one.calls.at(-1)?.body).toMatchObject({ author: `urn:li:organization:${ORG_A}`, content: { media: { id: 'urn:li:image:C4E10AQP1', altText: 'Mặt tiền' } } });

    const many = pages({
      'POST api.linkedin.com/rest/images?action=initializeUpload': [{ body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQP2' } } }, { body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQP3' } } }],
      'PUT www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload': [{ status: 201 }, { status: 201 }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7400000000000000004' } }],
    });
    expect((await new LinkedInPagePublisher({}, many.fetchImpl).publish(pageInput({ content: { body: 'Bộ ảnh', title: null, linkUrl: null, media: [image('f-2'), image('f-3')] } }))).kind).toBe('accepted');
    expect(many.calls.filter((c) => c.route.endsWith('/rest/images')).map((c) => c.body)).toEqual([
      { initializeUploadRequest: { owner: `urn:li:organization:${ORG_A}` } },
      { initializeUploadRequest: { owner: `urn:li:organization:${ORG_A}` } },
    ]);
    expect(many.calls.at(-1)?.body).toMatchObject({ author: `urn:li:organization:${ORG_A}`, content: { multiImage: { images: [{ id: 'urn:li:image:C4E10AQP2' }, { id: 'urn:li:image:C4E10AQP3' }] } } });
  });

  it('uploads a video owned by the page and posts it as the page', async () => {
    const VIDEO = 'urn:li:video:C5505AQPage1';
    const PART = 'https://www.linkedin.com/dms-uploads/C5505AQPage1/uploadedVideo';
    const { fetchImpl, calls } = pages({
      'POST api.linkedin.com/rest/videos?action=initializeUpload': [{ body: { value: { video: VIDEO, uploadToken: '', uploadInstructions: [{ uploadUrl: PART, firstByte: 0, lastByte: 9 }] } } }],
      'PUT www.linkedin.com/dms-uploads/C5505AQPage1/uploadedVideo': [{ headers: { etag: 'etag-p' } }],
      'POST api.linkedin.com/rest/videos?action=finalizeUpload': [{ body: {} }],
      [`GET api.linkedin.com/rest/videos/${encodeURIComponent(VIDEO)}`]: [{ body: { id: VIDEO, status: 'AVAILABLE' } }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7400000000000000005' } }],
    });
    const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 10, altText: null };
    const result = await new LinkedInPagePublisher({}, fetchImpl, { processingWaitMs: 1000, pollMs: 0 }).publish(
      pageInput({ content: { body: 'Video', title: null, linkUrl: null, media: [clip] }, readMedia: async () => new Uint8Array(10) }),
    );
    expect(result.kind).toBe('accepted');
    expect(calls[0]?.body).toEqual({ initializeUploadRequest: { owner: `urn:li:organization:${ORG_A}`, fileSizeBytes: 10, uploadCaptions: false, uploadThumbnail: false } });
    expect(calls.at(-1)?.body).toMatchObject({ author: `urn:li:organization:${ORG_A}`, content: { media: { id: VIDEO } } });
  });

  it('posts the first comment as the page', async () => {
    const urn = 'urn:li:share:7400000000000000006';
    const { fetchImpl, calls } = pages({ [`POST api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}/comments`]: [{ status: 201, body: {}, headers: { 'x-restli-id': '6643206422739898368' } }] });
    const result = await new LinkedInPagePublisher({}, fetchImpl).comment({ externalAccountId: ORG_A, secret: SECRET, externalId: urn, text: 'Đặt bánh tại tiembanhb.vn', callKey: 'k' });
    expect(result).toEqual({ kind: 'accepted', externalId: '6643206422739898368' });
    expect(calls[0]?.body).toEqual({ actor: `urn:li:organization:${ORG_A}`, object: urn, message: { text: 'Đặt bánh tại tiembanhb.vn' } });
  });
});
describe('LinkedIn documents (#1119)', () => {
  const DOC = 'urn:li:document:D5510AQHXjcP8QBYD9A';
  const DOC_PUT = 'PUT www.linkedin.com/dms-uploads/D5510AQHXjcP8QBYD9A/ads-uploadedDocument/0';
  const DOC_UPLOAD = 'https://www.linkedin.com/dms-uploads/D5510AQHXjcP8QBYD9A/ads-uploadedDocument/0?ca=vector_ads&cn=uploads&sync=0&v=beta&ut=36ezHi';
  const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const pdf = { fileId: 'd-1', mime: 'application/pdf', sizeBytes: PDF.byteLength, altText: null };
  const quick = { processingWaitMs: 1000, pollMs: 0 };
  const status = `GET api.linkedin.com/rest/documents/${encodeURIComponent(DOC)}`;
  const withPdf = (over: Partial<PublishInput> = {}) =>
    input({ content: { body: 'Báo giá quý 4', title: null, linkUrl: null, media: [pdf] }, readMedia: async () => PDF, mediaName: async () => 'bao-gia-q4.pdf', ...over });
  // The Documents API's recorded answers: initializeUpload, the PUT, the status, then the post.
  const answers = (post = 'urn:li:share:7500000000000000001'): Record<string, Answer[]> => ({
    'POST api.linkedin.com/rest/documents?action=initializeUpload': [{ body: { value: { uploadUrlExpiresAt: 1650567510704, uploadUrl: DOC_UPLOAD, document: DOC } } }],
    [DOC_PUT]: [{ status: 201 }],
    [status]: [{ body: { id: DOC, owner: `urn:li:person:${MEMBER}`, status: 'PROCESSING' } }, { body: { id: DOC, owner: `urn:li:person:${MEMBER}`, status: 'AVAILABLE' } }],
    'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': post } }],
  });

  it('uploads the PDF owned by the member, waits until it is available, then posts it with its title', async () => {
    const { fetchImpl, calls } = linkedin(answers());
    const result = await new LinkedInPublisher({}, fetchImpl, quick).publish(withPdf({ settings: { linkedin: { documentTitle: '  Báo giá dịch vụ quý 4  ' } } }));
    expect(result).toEqual({ kind: 'accepted', externalId: 'urn:li:share:7500000000000000001', url: 'https://www.linkedin.com/feed/update/urn:li:share:7500000000000000001/' });
    expect(calls.map((c) => c.route)).toEqual(['POST api.linkedin.com/rest/documents?action=initializeUpload', DOC_PUT, status, status, 'POST api.linkedin.com/rest/posts']);
    expect(calls[0]?.body).toEqual({ initializeUploadRequest: { owner: `urn:li:person:${MEMBER}` } });
    expect(calls[0]?.headers.get('linkedin-version')).toBe(LINKEDIN_VERSION);
    expect(calls[0]?.headers.get('x-restli-protocol-version')).toBe('2.0.0');
    // The exact bytes, with the member's token, to the URL LinkedIn handed out.
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer li-token-1');
    const sent = calls[1]?.body;
    expect(sent).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (sent as Blob).arrayBuffer())).toEqual(PDF);
    expect(calls[2]?.headers.get('linkedin-version')).toBe(LINKEDIN_VERSION);
    expect(calls.at(-1)?.body).toEqual({
      author: `urn:li:person:${MEMBER}`,
      commentary: 'Báo giá quý 4',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: DOC, title: 'Báo giá dịch vụ quý 4' } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('titles the document with the post title, else the file name, cut to the limit, else Document', async () => {
    const titled = async (over: Partial<PublishInput>) => {
      const { fetchImpl, calls } = linkedin(answers());
      expect((await new LinkedInPublisher({}, fetchImpl, quick).publish(withPdf(over))).kind).toBe('accepted');
      return (calls.at(-1)?.body as { content: { media: { title: string } } } | undefined)?.content.media.title ?? '';
    };
    expect(await titled({})).toBe('bao-gia-q4.pdf');
    expect(await titled({ content: { body: 'x', title: 'Hồ sơ năng lực', linkUrl: null, media: [pdf] } })).toBe('Hồ sơ năng lực');
    expect(await titled({ mediaName: async () => null })).toBe('Document');
    expect(
      await titled({
        mediaName: async () => {
          throw new Error('gone');
        },
      }),
    ).toBe('Document');
    const long = `${'Tài liệu giới thiệu '.repeat(5)}.pdf`;
    const cut = await titled({ mediaName: async () => long });
    expect(cut.length).toBe(LINKEDIN_DOCUMENT_TITLE_MAX);
    expect(long.startsWith(cut)).toBe(true);
    // An emoji is never split in half.
    expect(linkedinDocumentTitle(`${'a'.repeat(57)}😀`, null)).toBe('a'.repeat(57));
  });

  it('uploads the PDF owned by the page and posts it as the page', async () => {
    const ORG = '2414183';
    const { fetchImpl, calls } = linkedin(answers('urn:li:share:7500000000000000002'));
    const result = await new LinkedInPagePublisher({}, fetchImpl, quick).publish(withPdf({ externalAccountId: ORG, settings: { linkedin: { documentTitle: 'Catalogue 2026' }, visibility: 'loggedIn' } }));
    expect(result).toMatchObject({ kind: 'accepted', externalId: 'urn:li:share:7500000000000000002' });
    expect(calls[0]?.body).toEqual({ initializeUploadRequest: { owner: `urn:li:organization:${ORG}` } });
    expect(calls.at(-1)?.body).toMatchObject({ author: `urn:li:organization:${ORG}`, visibility: 'LOGGED_IN', content: { media: { id: DOC, title: 'Catalogue 2026' } } });
  });

  it('refuses a document beside other files, too large, or with a title LinkedIn would refuse, before any call', async () => {
    const none = linkedin({});
    const publisher = new LinkedInPublisher({}, none.fetchImpl, quick);
    const media = (list: PublishInput['content']['media']) => withPdf({ content: { body: 'x', title: null, linkUrl: null, media: list } });
    expect(await publisher.publish(media([pdf, image('f-1')]))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'ONE_DOCUMENT_ONLY' });
    expect(await publisher.publish(media([image('f-1'), pdf]))).toMatchObject({ code: 'ONE_DOCUMENT_ONLY' });
    expect(await publisher.publish(media([pdf, { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 10, altText: null }]))).toMatchObject({ code: 'ONE_DOCUMENT_ONLY' });
    expect(await publisher.publish(media([pdf, { ...pdf, fileId: 'd-2' }]))).toMatchObject({ code: 'ONE_DOCUMENT_ONLY' });
    expect(await publisher.publish(media([{ ...pdf, sizeBytes: LINKEDIN_DOCUMENT_MAX_BYTES + 1 }]))).toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    const refused = { kind: 'rejected', error: 'bad_request', code: 'DOCUMENT_TITLE_INVALID' };
    for (const shape of [{ documentTitle: '' }, { documentTitle: '   ' }, { documentTitle: 'a'.repeat(LINKEDIN_DOCUMENT_TITLE_MAX + 1) }, { documentTitle: 7 }, 'title', ['x']]) {
      const settings = { linkedin: shape };
      expect(await publisher.publish(withPdf({ settings }))).toEqual(refused);
    }
    expect(await publisher.publish(withPdf({ settings: { poll: { question: 'Chọn gói nào?', options: ['A', 'B'] } } }))).toMatchObject({ code: 'POLL_WITH_MEDIA' });
    expect(
      await publisher.publish(
        withPdf({
          readMedia: async () => {
            throw new Error('missing');
          },
        }),
      ),
    ).toMatchObject({ code: 'MEDIA_UNREADABLE' });
    expect(none.calls).toHaveLength(0);
    expect(linkedinDocumentTitleOf({ linkedin: { documentTitle: 'a'.repeat(LINKEDIN_DOCUMENT_TITLE_MAX) } })).toBe('a'.repeat(LINKEDIN_DOCUMENT_TITLE_MAX));
    expect(linkedinDocumentTitleOf({})).toBeNull();
    expect(linkedinDocumentTitleOf({ linkedin: {} })).toBeNull();
  });

  it('posts nothing when processing fails, the upload fails, the answer names no document, or it is still processing', async () => {
    const run = async (routes: Record<string, Answer[]>, timing = quick) => {
      const recorded = linkedin(routes);
      const result = await new LinkedInPublisher({}, recorded.fetchImpl, timing).publish(withPdf());
      expect(recorded.calls.some((c) => c.route === 'POST api.linkedin.com/rest/posts')).toBe(false);
      return { result, calls: recorded.calls };
    };
    expect((await run({ ...answers(), [status]: [{ body: { id: DOC, status: 'PROCESSING_FAILED' } }] })).result).toEqual({ kind: 'rejected', error: 'bad_request', code: 'DOCUMENT_PROCESSING_FAILED' });
    expect((await run({ ...answers(), [DOC_PUT]: [{ status: 503 }] })).result).toMatchObject({ kind: 'rejected', error: 'transient' });
    expect((await run({ 'POST api.linkedin.com/rest/documents?action=initializeUpload': [{ body: { value: { uploadUrl: DOC_UPLOAD, document: 'urn:li:image:C4E10AQ1' } } }] })).result).toEqual({
      kind: 'rejected',
      error: 'transient',
      code: 'NO_UPLOAD_URL',
    });
    const forbidden = { status: 403, body: { status: 403, code: 'DOCUMENT_FORBIDDEN', message: 'Accessing this document resource is forbidden' } };
    expect((await run({ 'POST api.linkedin.com/rest/documents?action=initializeUpload': [forbidden] })).result).toMatchObject({ kind: 'rejected', error: 'permission', code: 'DOCUMENT_FORBIDDEN' });
    const elsewhere = await run({ 'POST api.linkedin.com/rest/documents?action=initializeUpload': [{ body: { value: { uploadUrl: 'https://evil.example/upload', document: DOC } } }] });
    expect(elsewhere.result.kind).toBe('rejected');
    expect(elsewhere.calls.some((c) => c.route.includes('evil.example'))).toBe(false);
    const waiting = { ...answers(), [status]: Array.from({ length: 5 }, () => ({ body: { id: DOC, status: 'WAITING_UPLOAD' } })) };
    expect((await run(waiting, { processingWaitMs: 0, pollMs: 0 })).result).toEqual({ kind: 'rejected', error: 'transient', code: 'DOCUMENT_STILL_PROCESSING' });
  });

  it('leaves image posts as they were: only a PDF goes to the Documents API', async () => {
    const { fetchImpl, calls } = linkedin({
      'POST api.linkedin.com/rest/images?action=initializeUpload': [{ body: { value: { uploadUrl: UPLOAD, image: 'urn:li:image:C4E10AQ7' } } }],
      'PUT www.linkedin.com/dms-uploads/sp/v2/D4D10AQ/upload': [{ status: 201 }],
      'POST api.linkedin.com/rest/posts': [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:7500000000000000003' } }],
    });
    await new LinkedInPublisher({}, fetchImpl).publish(input({ content: { body: 'Ảnh', title: null, linkUrl: null, media: [image('f-7', 'Mặt tiền')] }, mediaName: async () => 'anh.jpg' }));
    expect(calls.some((c) => c.route.includes('/rest/documents'))).toBe(false);
    expect(calls.at(-1)?.body).toEqual({
      author: `urn:li:person:${MEMBER}`,
      commentary: 'Ảnh',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: 'urn:li:image:C4E10AQ7', altText: 'Mặt tiền' } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });
});

describe('LinkedIn remove (#1138)', () => {
  const URN = 'urn:li:share:6844785523593134080';
  const DELETE = `DELETE api.linkedin.com/rest/posts/${encodeURIComponent(URN)}`;
  const remove = (fetchImpl: Fetch, externalId = URN) => new LinkedInPublisher({}, fetchImpl).remove({ externalAccountId: MEMBER, secret: SECRET, externalId });

  it('deletes the member post by its encoded urn with the versioned Rest.li headers', async () => {
    const { fetchImpl, calls } = linkedin({ [DELETE]: [{ status: 204 }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
    expect(calls.map((c) => c.route)).toEqual([DELETE]);
    const headers = calls[0]?.headers;
    expect(headers?.get('authorization')).toBe('Bearer li-token-1');
    expect(headers?.get('linkedin-version')).toBe(LINKEDIN_VERSION);
    expect(headers?.get('x-restli-protocol-version')).toBe('2.0.0');
    expect(headers?.get('x-restli-method')).toBe('DELETE');
  });

  it('deletes a page post with the same call', async () => {
    const ugc = 'urn:li:ugcPost:6856810298419044352';
    const route = `DELETE api.linkedin.com/rest/posts/${encodeURIComponent(ugc)}`;
    const { fetchImpl, calls } = linkedin({ [route]: [{ status: 204 }] });
    expect(await new LinkedInPagePublisher({}, fetchImpl).remove({ externalAccountId: '2414183', secret: SECRET, externalId: ugc })).toEqual({ kind: 'removed' });
    expect(calls.map((c) => c.route)).toEqual([route]);
    // A page is a number; a member id is not one.
    expect(await new LinkedInPagePublisher({}, fetchImpl).remove({ externalAccountId: MEMBER, secret: SECRET, externalId: ugc })).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' });
  });

  it('counts a post LinkedIn no longer has as removed', async () => {
    // Deletes are idempotent (204 again), and a post it cannot find is gone too.
    const again = linkedin({ [DELETE]: [{ status: 204 }] });
    expect(await remove(again.fetchImpl)).toEqual({ kind: 'removed' });
    const gone = linkedin({ [DELETE]: [{ status: 404, body: { status: 404, serviceErrorCode: 100, code: 'NOT_FOUND', message: 'Not Found' } }] });
    expect(await remove(gone.fetchImpl)).toEqual({ kind: 'removed' });
  });

  it('maps a refusal to a code, an outage to unclear, and calls nothing for a malformed id', async () => {
    const expired = linkedin({ [DELETE]: [{ status: 401, body: { status: 401, serviceErrorCode: 65601, code: 'REVOKED_ACCESS_TOKEN', message: 'The token used in the request has been revoked by the user' } }] });
    expect(await remove(expired.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'REVOKED_ACCESS_TOKEN' });
    const denied = linkedin({ [DELETE]: [{ status: 403, body: { status: 403, serviceErrorCode: 100, code: 'ACCESS_DENIED', message: 'Not enough permissions to access: partnerApiPosts.DELETE.20260401' } }] });
    expect(await remove(denied.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'permission', code: 'ACCESS_DENIED' });
    const limited = linkedin({ [DELETE]: [{ status: 429, body: { status: 429, code: 'TOO_MANY_REQUESTS', message: 'Resource level throttle limit reached' } }] });
    expect(await remove(limited.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    const conflict = linkedin({ [DELETE]: [{ status: 409, body: { status: 409, code: 'CONFLICT', message: 'A write conflict occurred' } }] });
    expect(await remove(conflict.fetchImpl)).toEqual({ kind: 'rejected', error: 'transient', code: 'CONFLICT' });
    const down = linkedin({ [DELETE]: [{ status: 503, body: { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable' } }] });
    expect(await remove(down.fetchImpl)).toEqual({ kind: 'unknown', code: 'SERVICE_UNAVAILABLE' });
    const none = linkedin({});
    expect(await remove(none.fetchImpl, 'urn:li:person:yrZCpj2Z12')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await new LinkedInPublisher({}, none.fetchImpl).remove({ externalAccountId: MEMBER, secret: '{}', externalId: URN })).toEqual({ kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' });
    expect(none.calls).toHaveLength(0);
  });

  it('sends nothing to a host outside LinkedIn and puts no token in its answer', async () => {
    const hosts: string[] = [];
    const fetchImpl: Fetch = async (input) => {
      hosts.push(new URL(input).host);
      return new Response(JSON.stringify({ status: 401, message: 'Invalid access token' }), { status: 401, headers: { 'content-type': 'application/json' } });
    };
    const result = await remove(fetchImpl);
    expect([...new Set(hosts)]).toEqual(['api.linkedin.com']);
    expect(JSON.stringify(result)).not.toContain('li-token-1');
  });
});
