// First comments (#587, #609) against recorded answers (X API v2 replies, LinkedIn Social Actions comments, Bluesky
// reply records, Graph API comments on Facebook Page and Instagram posts, Threads reply containers); no live call.
import { describe, expect, it } from 'vitest';
import {
  BlueskyPublisher,
  FACEBOOK_PAGE_COMMENT_SCOPES,
  FacebookPagePublisher,
  INSTAGRAM_COMMENT_SCOPES,
  InstagramPublisher,
  LinkedInPublisher,
  SandboxPublisher,
  THREADS_SCOPES,
  ThreadsPublisher,
  XPublisher,
  type CommentInput,
  type Fetch,
} from '../src/index.ts';

// network: the call never reaches the platform (fetch throws, as on a DNS failure or a reset connection).
type Answer = { status?: number; body?: unknown; headers?: Record<string, string>; network?: true };
// A JSON body, or a form body (Graph and Threads) as its fields.
const bodyOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
};
function fake(routes: Record<string, Answer[]>) {
  const calls: { route: string; body: unknown; url: URL; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const raw = init?.body;
    calls.push({ route, url, body: typeof raw === 'string' ? bodyOf(raw) : raw, auth: new Headers(init?.headers).get('authorization') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { message: `no answer for ${route}` } };
    if (answer.network) throw new TypeError('fetch failed');
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', ...answer.headers } });
  };
  return { calls, fetchImpl };
}

const input = (over: Partial<CommentInput>): CommentInput => ({ externalAccountId: 'acct', secret: '{}', externalId: 'post', text: '#khaitruong #quan3', callKey: 'social.publish:v:1:1:comment', ...over });

describe('first comments', () => {
  it('replies on X in the post thread', async () => {
    const { fetchImpl, calls } = fake({ 'POST api.x.com/2/tweets': [{ status: 201, body: { data: { id: '1850000000000000002', text: '#khaitruong' } } }] });
    const x = new XPublisher({ clientId: 'M1M5R3BMVy13QmpScXkzTUt5OE46MTpjaQ', clientSecret: 'test' }, fetchImpl);
    const result = await x.comment(input({ externalAccountId: '1580661436147937281', secret: JSON.stringify({ accessToken: 'x-1', refreshToken: 'r' }), externalId: '1850000000000000001' }));
    expect(result).toEqual({ kind: 'accepted', externalId: '1850000000000000002' });
    expect(calls[0]?.body).toEqual({ text: '#khaitruong #quan3', reply: { in_reply_to_tweet_id: '1850000000000000001' } });
    // A refusal posts nothing and says why.
    const refused = fake({ 'POST api.x.com/2/tweets': [{ status: 403, body: { title: 'Forbidden', detail: 'You are not permitted', type: 'about:blank', status: 403 } }] });
    expect((await new XPublisher({ clientId: 'M1M5R3BMVy13QmpScXkzTUt5OE46MTpjaQ', clientSecret: 'test' }, refused.fetchImpl).comment(input({ secret: JSON.stringify({ accessToken: 'x-1', refreshToken: 'r' }), externalId: '1850000000000000001' }))).kind).toBe('rejected');
  });

  it('comments on LinkedIn through Social Actions as the member', async () => {
    const urn = 'urn:li:share:7100000000000000001';
    const { fetchImpl, calls } = fake({ [`POST api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}/comments`]: [{ status: 201, body: {}, headers: { 'x-restli-id': 'urn:li:comment:(urn:li:activity:1,2)' } }] });
    const result = await new LinkedInPublisher({}, fetchImpl).comment(input({ externalAccountId: 'yrZCpj2Z12', secret: JSON.stringify({ accessToken: 'li-1' }), externalId: urn }));
    expect(result).toEqual({ kind: 'accepted', externalId: 'urn:li:comment:(urn:li:activity:1,2)' });
    expect(calls[0]?.body).toEqual({ actor: 'urn:li:person:yrZCpj2Z12', object: urn, message: { text: '#khaitruong #quan3' } });
    expect((await new LinkedInPublisher({}, fetchImpl).comment(input({ externalAccountId: 'yrZCpj2Z12', secret: JSON.stringify({ accessToken: 'li-1' }), externalId: 'not-a-urn' }))).kind).toBe('rejected');
  });

  it('replies on Bluesky under its own post, naming the post by uri and cid', async () => {
    const DID = 'did:plc:abc123def456ghi789jkl012';
    const PDS = 'https://morel.us-east.host.bsky.network';
    const uri = `at://${DID}/app.bsky.feed.post/3kabcde2fgh2z`;
    const { fetchImpl, calls } = fake({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [{ body: { did: DID, handle: 'quan-a.bsky.social', accessJwt: 'a', refreshJwt: 'r', didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] } } }],
      'GET morel.us-east.host.bsky.network/xrpc/com.atproto.repo.getRecord': [{ body: { uri, cid: 'bafyreicid1', value: {} } }],
      'POST morel.us-east.host.bsky.network/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3kreply2zz2z`, cid: 'bafyreicid2' } }],
    });
    const result = await new BlueskyPublisher(fetchImpl).comment(input({ externalAccountId: DID, secret: JSON.stringify({ identifier: DID, appPassword: 'abcd-efgh-ijkl-mnop' }), externalId: uri }));
    expect(result).toEqual({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/3kreply2zz2z` });
    const last = calls.at(-1);
    const record = (last ? (last.body as { record: { reply: unknown; text: string } }) : { record: { reply: null, text: '' } }).record;
    expect(record.reply).toEqual({ root: { uri, cid: 'bafyreicid1' }, parent: { uri, cid: 'bafyreicid1' } });
    expect(record.text).toBe('#khaitruong #quan3');
  });

  it('replies on Bluesky to a thread part, naming the first post of the thread as root (#742)', async () => {
    const DID = 'did:plc:abc123def456ghi789jkl012';
    const PDS = 'https://morel.us-east.host.bsky.network';
    const root = `at://${DID}/app.bsky.feed.post/3kroot22222z`;
    const part = `at://${DID}/app.bsky.feed.post/3kpart22222z`;
    const { fetchImpl, calls } = fake({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [{ body: { did: DID, handle: 'quan-a.bsky.social', accessJwt: 'a', refreshJwt: 'r', didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] } } }],
      'GET morel.us-east.host.bsky.network/xrpc/com.atproto.repo.getRecord': [{ body: { uri: part, cid: 'bafypart' } }, { body: { uri: root, cid: 'bafyroot' } }],
      'POST morel.us-east.host.bsky.network/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3kpart32222z`, cid: 'bafy3' } }],
    });
    const secret = JSON.stringify({ identifier: DID, appPassword: 'abcd-efgh-ijkl-mnop' });
    const result = await new BlueskyPublisher(fetchImpl).comment(input({ externalAccountId: DID, secret, externalId: part, rootExternalId: root, text: 'Phần ba' }));
    expect(result).toEqual({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/3kpart32222z` });
    expect(calls.filter((c) => c.route.endsWith('getRecord')).map((c) => c.url.searchParams.get('rkey'))).toEqual(['3kpart22222z', '3kroot22222z']);
    expect(calls.at(-1)?.body).toMatchObject({ record: { reply: { root: { uri: root, cid: 'bafyroot' }, parent: { uri: part, cid: 'bafypart' } } } });
    // A root of another account is refused before any post.
    const other = await new BlueskyPublisher(fake({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [{ body: { did: DID, handle: 'quan-a.bsky.social', accessJwt: 'a', refreshJwt: 'r', didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] } } }] }).fetchImpl).comment(
      input({ externalAccountId: DID, secret, externalId: part, rootExternalId: 'at://did:plc:someoneelse0000000000000/app.bsky.feed.post/3kroot22222z' }),
    );
    expect(other).toMatchObject({ kind: 'rejected', code: 'NOT_OWN_POST' });
  });

  // Graph API errors (developers.facebook.com/docs/graph-api/guides/error-handling): 190 an expired or revoked token,
  // 200 and 10 a permission the token lacks, 2 a Meta outage.
  const graphError = (status: number, code: number, message: string): Answer => ({ status, body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'AbCdEf' } } });
  const graphCases: [Answer, Record<string, unknown>][] = [
    [graphError(400, 190, 'Error validating access token: Session has expired'), { kind: 'rejected', error: 'token_expired', code: '190' }],
    [graphError(403, 200, '(#200) Permissions error'), { kind: 'rejected', error: 'permission', code: '200' }],
    [graphError(400, 4, 'Application request limit reached'), { kind: 'rejected', error: 'rate_limited', code: '4' }],
    [graphError(500, 2, 'Service temporarily unavailable'), { kind: 'unknown', code: '2' }],
    [{ network: true }, { kind: 'unknown', code: 'NETWORK' }],
  ];
  const META = { appSecret: 'meta-app-secret' };

  it('comments on a Facebook Page post as the Page, and asks for pages_manage_engagement when connecting', async () => {
    expect(FACEBOOK_PAGE_COMMENT_SCOPES).toContain('pages_manage_engagement');
    const route = 'POST graph.facebook.com/v24.0/111222333_444555666/comments';
    const { fetchImpl, calls } = fake({ [route]: [{ body: { id: '444555666_777888999' } }] });
    const post = input({ externalAccountId: '111222333', secret: JSON.stringify({ accessToken: 'page-token-111' }), externalId: '111222333_444555666' });
    expect(await new FacebookPagePublisher(META, fetchImpl).comment(post)).toEqual({ kind: 'accepted', externalId: '444555666_777888999' });
    expect(calls[0]?.body).toEqual({ message: '#khaitruong #quan3' });
    // The Page token travels in the header with its proof, never in the URL.
    expect(calls[0]?.auth).toBe('Bearer page-token-111');
    expect(calls[0]?.url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]?.url.toString()).not.toContain('page-token-111');
    for (const [answer, expected] of graphCases) expect(await new FacebookPagePublisher(META, fake({ [route]: [answer] }).fetchImpl).comment(post)).toMatchObject(expected);
    // A Page connected before Crove asked for pages_manage_engagement: the post shows the comment failed, for a retry
    // once the Page reconnects.
    const old = fake({ [route]: [graphError(400, 10, '(#10) This endpoint requires the pages_manage_engagement permission')] });
    expect(await new FacebookPagePublisher(META, old.fetchImpl).comment(post)).toMatchObject({ kind: 'rejected', error: 'permission', code: '10' });
    expect(await new FacebookPagePublisher(META, fetchImpl).comment({ ...post, externalId: '../me/feed' })).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await new FacebookPagePublisher(META, fetchImpl).comment({ ...post, secret: '{}' })).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    // A bare object id (a video) is commented on as it is.
    const video = fake({ ['POST graph.facebook.com/v24.0/444555777/comments']: [{ body: { id: '444555777_1' } }] });
    expect(await new FacebookPagePublisher(META, video.fetchImpl).comment({ ...post, externalId: '444555777' })).toEqual({ kind: 'accepted', externalId: '444555777_1' });
  });

  it('comments on an Instagram post as the account, and asks for instagram_manage_comments when connecting', async () => {
    expect(INSTAGRAM_COMMENT_SCOPES).toContain('instagram_manage_comments');
    const route = 'POST graph.facebook.com/v24.0/17900000000000001/comments';
    const { fetchImpl, calls } = fake({ [route]: [{ body: { id: '17850000000000001' } }] });
    const media = input({ externalAccountId: '17841400000000001', secret: JSON.stringify({ accessToken: 'page-token-111', pageId: '111' }), externalId: '17900000000000001' });
    expect(await new InstagramPublisher(META, fetchImpl).comment(media)).toEqual({ kind: 'accepted', externalId: '17850000000000001' });
    expect(calls[0]?.body).toEqual({ message: '#khaitruong #quan3' });
    expect(calls[0]?.auth).toBe('Bearer page-token-111');
    for (const [answer, expected] of graphCases) expect(await new InstagramPublisher(META, fake({ [route]: [answer] }).fetchImpl).comment(media)).toMatchObject(expected);
    // An account connected before Crove asked for instagram_manage_comments.
    const old = fake({ [route]: [graphError(403, 10, 'Application does not have permission for this action')] });
    expect(await new InstagramPublisher(META, old.fetchImpl).comment(media)).toMatchObject({ kind: 'rejected', error: 'permission', code: '10' });
    expect(await new InstagramPublisher(META, fetchImpl).comment({ ...media, externalId: 'abc' })).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await new InstagramPublisher(META, fetchImpl).comment({ ...media, secret: '{}' })).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    // A Reel still processing right after it went out takes no comment yet: nothing was posted, try again shortly.
    const notReady = fake({ [route]: [graphError(400, 9007, 'Media ID is not available')] });
    expect(await new InstagramPublisher(META, notReady.fetchImpl).comment(media)).toEqual({ kind: 'rejected', error: 'transient', code: 'MEDIA_NOT_READY' });
  });

  it('replies on Threads under its own post through a reply container, and asks for threads_manage_replies when connecting', async () => {
    expect(THREADS_SCOPES).toContain('threads_manage_replies');
    const USER = '17841400000000009';
    const CONTAINER = '18000000000000077';
    const create = `POST graph.threads.net/v1.0/${USER}/threads`;
    const status = `GET graph.threads.net/v1.0/${CONTAINER}`;
    const publish = `POST graph.threads.net/v1.0/${USER}/threads_publish`;
    const reply = input({ externalAccountId: USER, secret: JSON.stringify({ accessToken: 'th-1' }), externalId: '18100000000000001' });
    const fast = { pollMs: 0 };
    const { fetchImpl, calls } = fake({
      [create]: [{ body: { id: CONTAINER } }],
      [status]: [{ body: { status: 'IN_PROGRESS', id: CONTAINER } }, { body: { status: 'FINISHED', id: CONTAINER } }],
      [publish]: [{ body: { id: '18100000000000002' } }],
    });
    expect(await new ThreadsPublisher(fetchImpl, fast).comment(reply)).toEqual({ kind: 'accepted', externalId: '18100000000000002' });
    expect(calls[0]?.body).toEqual({ media_type: 'TEXT', text: '#khaitruong #quan3', reply_to_id: '18100000000000001' });
    expect(calls[0]?.auth).toBe('Bearer th-1');
    expect(calls.at(-1)?.body).toEqual({ creation_id: CONTAINER });
    const threadsError = (code: number, httpStatus: number, message: string): Answer => ({ status: httpStatus, body: { error: { message, type: 'OAuthException', code } } });
    // The reply container is invisible, so a failure while making it posted nothing: an outage there is transient.
    const createCases: [Answer, Record<string, unknown>][] = [
      [threadsError(190, 401, 'Error validating access token'), { kind: 'rejected', error: 'token_expired', code: '190' }],
      // A connection made before Crove asked for threads_manage_replies.
      [threadsError(10, 403, 'Application does not have permission for this action'), { kind: 'rejected', error: 'permission', code: '10' }],
      [threadsError(2, 500, 'Service temporarily unavailable'), { kind: 'rejected', error: 'transient', code: '2' }],
      [{ network: true }, { kind: 'rejected', error: 'transient', code: 'NETWORK' }],
    ];
    for (const [answer, expected] of createCases) expect(await new ThreadsPublisher(fake({ [create]: [answer] }).fetchImpl, fast).comment(reply)).toMatchObject(expected);
    // threads_publish is the visible step: an outage or a lost answer there may have posted the reply.
    const atPublish = (answer: Answer) => fake({ [create]: [{ body: { id: CONTAINER } }], [status]: [{ body: { status: 'FINISHED' } }], [publish]: [answer] }).fetchImpl;
    expect(await new ThreadsPublisher(atPublish(threadsError(2, 500, 'Service temporarily unavailable')), fast).comment(reply)).toMatchObject({ kind: 'unknown', code: '2' });
    expect(await new ThreadsPublisher(atPublish({ network: true }), fast).comment(reply)).toEqual({ kind: 'unknown', code: 'NETWORK' });
    expect(await new ThreadsPublisher(atPublish(threadsError(10, 403, 'Application does not have permission for this action')), fast).comment(reply)).toMatchObject({ kind: 'rejected', error: 'permission' });
    // A container still processing when the short wait ends posted nothing.
    const slow = fake({ [create]: [{ body: { id: CONTAINER } }], [status]: [{ body: { status: 'IN_PROGRESS' } }] });
    expect(await new ThreadsPublisher(slow.fetchImpl, { pollMs: 0, commentWaitMs: 0 }).comment(reply)).toEqual({ kind: 'rejected', error: 'transient', code: 'CONTAINER_NOT_READY' });
    expect(slow.calls.some((c) => c.route === publish)).toBe(false);
    // Past its time budget the reply is never published: the job has stopped waiting, so a late reply would be
    // recorded as unclear while it went out.
    const late = fake({ [create]: [{ body: { id: CONTAINER } }], [status]: [{ body: { status: 'FINISHED' } }], [publish]: [{ body: { id: '18100000000000003' } }] });
    expect(await new ThreadsPublisher(late.fetchImpl, { pollMs: 0, commentBudgetMs: -1 }).comment(reply)).toEqual({ kind: 'rejected', error: 'transient', code: 'LATE_PUBLISH' });
    expect(late.calls.some((c) => c.route === publish)).toBe(false);
    expect(await new ThreadsPublisher(fetchImpl, fast).comment({ ...reply, externalId: 'at://not-threads' })).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
  });

  it('comments on a sandbox post it holds', async () => {
    const sandbox = new SandboxPublisher();
    expect((await sandbox.comment(input({ secret: JSON.stringify({ accessToken: 'sbx_x' }), externalId: 'missing' }))).kind).toBe('rejected');
  });
});