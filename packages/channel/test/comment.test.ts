// First comments (#587) against recorded answers (X API v2 replies, LinkedIn Social Actions comments, Bluesky reply
// records); no live call.
import { describe, expect, it } from 'vitest';
import { BlueskyPublisher, LinkedInPublisher, SandboxPublisher, XPublisher, type CommentInput, type Fetch } from '../src/index.ts';

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
function fake(routes: Record<string, Answer[]>) {
  const calls: { route: string; body: unknown; url: URL }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const raw = init?.body;
    calls.push({ route, url, body: typeof raw === 'string' ? JSON.parse(raw) : raw });
    const answer = routes[route]?.shift() ?? { status: 500, body: { message: `no answer for ${route}` } };
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

  it('comments on a sandbox post it holds', async () => {
    const sandbox = new SandboxPublisher();
    expect((await sandbox.comment(input({ secret: JSON.stringify({ accessToken: 'sbx_x' }), externalId: 'missing' }))).kind).toBe('rejected');
  });
});