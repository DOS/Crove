// Bluesky against recorded XRPC answers (shapes from the AT Protocol lexicons); no live call.
import { describe, expect, it } from 'vitest';
import { BlueskyPublisher, connectBluesky, isBlueskyHost, linkFacets, type Fetch, type PublishInput } from '../src/index.ts';

const DID = 'did:plc:abc123def456ghi789jkl012';
const PDS = 'https://morel.us-east.host.bsky.network';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const SECRET = JSON.stringify({ identifier: DID, appPassword: APP_PASSWORD, pds: PDS });

const session = (pds = PDS) => ({ body: { did: DID, handle: 'quan-a.bsky.social', accessJwt: 'access-jwt-1', refreshJwt: 'refresh-jwt-1', didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: pds }] } } });

function xrpc(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; auth: string | null; json: unknown; type: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    calls.push({ route, auth: headers.get('authorization'), json: typeof init?.body === 'string' ? JSON.parse(init.body) : null, type: headers.get('content-type') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: 'InternalServerError', message: `no answer for ${route}` } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: DID,
  secret: SECRET,
  content: { body: 'Khai trương! Xem https://example.com/a', title: null, linkUrl: null, media: [] },
  readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});

describe('Bluesky connect', () => {
  it('opens a session with the app password and connects the account by its DID', async () => {
    const { fetchImpl, calls } = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()] });
    const account = await connectBluesky({ handle: '@Quan-A.bsky.social', appPassword: APP_PASSWORD }, fetchImpl);
    expect(account).toEqual({ provider: 'bluesky', externalAccountId: DID, displayName: '@quan-a.bsky.social', scopes: ['app_password'], expiresAt: null, secret: SECRET });
    expect(calls[0]?.json).toEqual({ identifier: 'quan-a.bsky.social', password: APP_PASSWORD });
  });

  it('refuses the account password, a bad handle and an account on another PDS', async () => {
    const { fetchImpl, calls } = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session('https://pds.example.org')] });
    await expect(connectBluesky({ handle: 'quan-a.bsky.social', appPassword: 'my real password' }, fetchImpl)).rejects.toMatchObject({ code: 'NotAnAppPassword' });
    await expect(connectBluesky({ handle: 'not a handle', appPassword: APP_PASSWORD }, fetchImpl)).rejects.toMatchObject({ code: 'InvalidHandle' });
    expect(calls).toHaveLength(0);
    await expect(connectBluesky({ handle: 'quan-a.bsky.social', appPassword: APP_PASSWORD }, fetchImpl)).rejects.toMatchObject({ code: 'UnsupportedPds' });
  });

  it('only talks to Bluesky-hosted servers', () => {
    expect(isBlueskyHost('bsky.social')).toBe(true);
    expect(isBlueskyHost('morel.us-east.host.bsky.network')).toBe(true);
    expect(isBlueskyHost('bsky.network.evil.example')).toBe(false);
    expect(isBlueskyHost('localhost')).toBe(false);
  });
});

describe('BlueskyPublisher', () => {
  it('posts the text with link facets on the account PDS', async () => {
    const { fetchImpl, calls } = xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [session()],
      'POST morel.us-east.host.bsky.network/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3kabc`, cid: 'bafy' } }],
    });
    const result = await new BlueskyPublisher(fetchImpl).publish(input());
    expect(result).toEqual({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/3kabc`, url: 'https://bsky.app/profile/quan-a.bsky.social/post/3kabc' });
    const record = (calls[1]?.json as { record: { text: string; facets: unknown[] } } | undefined)?.record;
    if (!record) throw new Error('no record');
    expect(record.text).toBe('Khai trương! Xem https://example.com/a');
    expect(record.facets).toEqual(linkFacets(record.text));
    expect(calls[1]?.auth).toBe('Bearer access-jwt-1');
  });

  it('counts facet offsets in UTF-8 bytes', () => {
    const [facet] = linkFacets('Ưu đãi: https://example.com/x.');
    const bytes = new TextEncoder().encode('Ưu đãi: ').byteLength;
    expect(facet?.index).toEqual({ byteStart: bytes, byteEnd: bytes + 'https://example.com/x'.length });
  });

  it('uploads images as blobs first and embeds them with their alt text', async () => {
    const { fetchImpl, calls } = xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [session()],
      'POST morel.us-east.host.bsky.network/xrpc/com.atproto.repo.uploadBlob': [{ body: { blob: { $type: 'blob', ref: { $link: 'bafyimg' }, mimeType: 'image/jpeg', size: 3 } } }],
      'POST morel.us-east.host.bsky.network/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3kimg` } }],
    });
    const content = { body: 'Ảnh mới', title: null, linkUrl: null, media: [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 3, altText: 'Mặt tiền' }] };
    expect((await new BlueskyPublisher(fetchImpl).publish(input({ content }))).kind).toBe('accepted');
    expect(calls[1]?.type).toBe('image/jpeg');
    expect((calls[2]?.json as { record: { embed: unknown } } | undefined)?.record.embed).toEqual({ $type: 'app.bsky.embed.images', images: [{ alt: 'Mặt tiền', image: { $type: 'blob', ref: { $link: 'bafyimg' }, mimeType: 'image/jpeg', size: 3 } }] });
  });

  it('maps a revoked app password to token_expired and an outage after the post to unknown', async () => {
    const revoked = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [{ status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } }] });
    expect(await new BlueskyPublisher(revoked.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const down = xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [session()],
      'POST morel.us-east.host.bsky.network/xrpc/com.atproto.repo.createRecord': [{ status: 502, body: {} }],
    });
    expect((await new BlueskyPublisher(down.fetchImpl).publish(input())).kind).toBe('unknown');
  });

  it('reconciles by text inside the window only', async () => {
    const now = Date.now();
    const { fetchImpl } = xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [session(), session()],
      'GET morel.us-east.host.bsky.network/xrpc/com.atproto.repo.listRecords': [
        { body: { records: [{ uri: `at://${DID}/app.bsky.feed.post/old`, value: { text: 'Khai trương! Xem https://example.com/a', createdAt: new Date(now - 7 * 86_400_000).toISOString() } }, { uri: `at://${DID}/app.bsky.feed.post/new`, value: { text: 'Khai trương! Xem https://example.com/a', createdAt: new Date(now - 60_000).toISOString() } }] } },
        { body: { records: [{ uri: `at://${DID}/app.bsky.feed.post/old`, value: { text: 'Khai trương! Xem https://example.com/a', createdAt: new Date(now - 7 * 86_400_000).toISOString() } }] } },
      ],
    });
    const publisher = new BlueskyPublisher(fetchImpl);
    const window = { externalAccountId: DID, secret: SECRET, callKey: 'call-1', contentHash: `sha256:${'0'.repeat(64)}`, content: input().content, after: new Date(now - 600_000), before: new Date(now) };
    expect(await publisher.reconcile(window)).toMatchObject({ found: true, externalId: `at://${DID}/app.bsky.feed.post/new` });
    expect(await publisher.reconcile(window)).toEqual({ found: false });
  });
});

describe('Bluesky edge answers', () => {
  it('takes a success without a readable body after the post call as unknown, never a refusal', async () => {
    const calls: string[] = [];
    const fetchImpl: Fetch = async (input) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname.endsWith('createSession')) return new Response(JSON.stringify(session().body), { status: 200 });
      return new Response('', { status: 200 });
    };
    expect((await new BlueskyPublisher(fetchImpl).publish(input())).kind).toBe('unknown');
  });

  it('refuses a PDS on another port and a malformed one', async () => {
    for (const pds of ['https://morel.us-east.host.bsky.network:8443', 'not a url']) {
      const { fetchImpl } = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session(pds)] });
      await expect(connectBluesky({ handle: 'quan-a.bsky.social', appPassword: APP_PASSWORD }, fetchImpl)).rejects.toMatchObject({ code: 'UnsupportedPds' });
    }
  });

  it('pauses on a deactivated account instead of failing the post', async () => {
    const { fetchImpl } = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [{ status: 400, body: { error: 'AccountDeactivated', message: 'Account is deactivated' } }] });
    expect(await new BlueskyPublisher(fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
  });
});

describe('BlueskyPublisher metrics', () => {
  const URI = `at://${DID}/app.bsky.feed.post/3kabcdefghi22`;
  const metricsInput = { externalAccountId: DID, secret: SECRET, externalId: URI };

  it('reads likes, replies, reposts and quotes from the public AppView, without a session', async () => {
    const { fetchImpl, calls } = xrpc({ 'GET public.api.bsky.app/xrpc/app.bsky.feed.getPosts': [{ body: { posts: [{ uri: URI, likeCount: 9, replyCount: 2, repostCount: 3, quoteCount: 1 }] } }] });
    expect(await new BlueskyPublisher(fetchImpl).metrics(metricsInput)).toEqual({ metrics: { reactions: 9, comments: 2, shares: 4 }, extra: { quotes: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBeNull();
  });

  it("reports a deleted post as gone, never reads another account's post, and retries an outage later", async () => {
    const deleted = xrpc({ 'GET public.api.bsky.app/xrpc/app.bsky.feed.getPosts': [{ body: { posts: [] } }] });
    expect(await new BlueskyPublisher(deleted.fetchImpl).metrics(metricsInput)).toEqual({ refused: 'gone' });
    const other = xrpc({});
    expect(await new BlueskyPublisher(other.fetchImpl).metrics({ ...metricsInput, externalId: 'at://did:plc:someoneelse0000000000000/app.bsky.feed.post/3kabcdefghi22' })).toEqual({ refused: 'gone' });
    expect(other.calls).toHaveLength(0);
    const down = xrpc({ 'GET public.api.bsky.app/xrpc/app.bsky.feed.getPosts': [{ status: 502, body: {} }] });
    expect(await new BlueskyPublisher(down.fetchImpl).metrics(metricsInput)).toBeNull();
  });
});
