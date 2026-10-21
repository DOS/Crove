// Bluesky against recorded XRPC answers (shapes from the AT Protocol lexicons); no live call.
import { describe, expect, it } from 'vitest';
import { BlueskyPublisher, connectBluesky, isBlueskyHost, linkFacets, pdsOrigin, type Fetch, type PublishInput } from '../src/index.ts';

const DID = 'did:plc:abc123def456ghi789jkl012';
const PDS = 'https://morel.us-east.host.bsky.network';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const SECRET = JSON.stringify({ identifier: DID, appPassword: APP_PASSWORD, pds: PDS });

const jwt = (scope: string) => `eyJhbGciOiJFUzI1NksifQ.${Buffer.from(JSON.stringify({ scope, sub: DID })).toString('base64url')}.c2ln`;
const session = (pds = PDS, accessJwt = 'access-jwt-1') => ({ body: { did: DID, handle: 'quan-a.bsky.social', accessJwt, refreshJwt: 'refresh-jwt-1', didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: pds }] } } });

function xrpc(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; auth: string | null; json: unknown; type: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    calls.push({ route, auth: headers.get('authorization'), json: typeof init?.body === 'string' ? JSON.parse(init.body) : null, type: headers.get('content-type') });
    // A Bluesky-hosted DID document unless a test says otherwise: a publish reads it before signing in (#804).
    const hosted: { status?: number; body: unknown } | null = route === `GET plc.directory/${DID}` ? { body: { id: DID, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] } } : null;
    const answer = routes[route]?.shift() ?? hosted ?? { status: 500, body: { error: 'InternalServerError', message: `no answer for ${route}` } };
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
    // The PDS is not kept: each call's session names it (#399).
    expect(account).toEqual({ provider: 'bluesky', externalAccountId: DID, displayName: '@quan-a.bsky.social', scopes: ['app_password'], expiresAt: null, secret: JSON.stringify({ identifier: DID, appPassword: APP_PASSWORD }) });
    expect(calls[0]?.json).toEqual({ identifier: 'quan-a.bsky.social', password: APP_PASSWORD });
  });

  it('refuses the account password, a bad handle and an account on another PDS', async () => {
    const { fetchImpl, calls } = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session('https://pds.example.org')] });
    await expect(connectBluesky({ handle: 'quan-a.bsky.social', appPassword: 'my real password' }, fetchImpl)).rejects.toMatchObject({ code: 'NotAnAppPassword' });
    await expect(connectBluesky({ handle: 'not a handle', appPassword: APP_PASSWORD }, fetchImpl)).rejects.toMatchObject({ code: 'InvalidHandle' });
    expect(calls).toHaveLength(0);
    await expect(connectBluesky({ handle: 'quan-a.bsky.social', appPassword: APP_PASSWORD }, fetchImpl)).rejects.toMatchObject({ code: 'UnsupportedPds' });
  });

  it('refuses an account password shaped like an app password, and a privileged app password, by the session scope (#399)', async () => {
    const { fetchImpl } = xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [session(PDS, jwt('com.atproto.access')), session(PDS, jwt('com.atproto.appPassPrivileged')), session(PDS, jwt('com.atproto.appPass'))],
    });
    const connect = () => connectBluesky({ handle: 'quan-a.bsky.social', appPassword: APP_PASSWORD }, fetchImpl);
    await expect(connect()).rejects.toMatchObject({ code: 'NotAnAppPassword' });
    await expect(connect()).rejects.toMatchObject({ code: 'PrivilegedAppPassword' });
    await expect(connect()).resolves.toMatchObject({ externalAccountId: DID });
  });

  it('only talks to Bluesky-hosted servers', () => {
    expect(isBlueskyHost('bsky.social')).toBe(true);
    expect(isBlueskyHost('morel.us-east.host.bsky.network')).toBe(true);
    expect(isBlueskyHost('bsky.network.evil.example')).toBe(false);
    expect(isBlueskyHost('localhost')).toBe(false);
  });
});

describe('Bluesky on its own PDS (#792)', () => {
  const OWN = 'https://pds.example.org';
  const refused = { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } };
  const doc = (pds: string, alsoKnownAs = ['at://quan-a.bsky.social']) => ({ body: { id: DID, alsoKnownAs, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] } });
  const own = (pds = OWN) => ({
    bluesky: xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [refused, refused],
      'GET public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle': [{ body: { did: DID } }],
      [`GET plc.directory/${DID}`]: [doc(pds), doc(pds)],
    }),
    egress: xrpc({
      'POST pds.example.org/xrpc/com.atproto.server.createSession': [session(OWN), session(OWN)],
      'POST pds.example.org/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3kown`, cid: 'bafy' } }, { body: { uri: `at://${DID}/app.bsky.feed.post/3kown2`, cid: 'bafy' } }],
    }),
  });

  it('connects through the PDS the DID document names, called only through the egress fetch', async () => {
    const { bluesky, egress } = own();
    const account = await connectBluesky({ handle: 'quan-a.example.org', appPassword: APP_PASSWORD }, bluesky.fetchImpl, egress.fetchImpl);
    expect(account).toMatchObject({ externalAccountId: DID, displayName: '@quan-a.bsky.social' });
    expect(bluesky.calls.map((c) => c.route)).toEqual(['POST bsky.social/xrpc/com.atproto.server.createSession', 'GET public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle', `GET plc.directory/${DID}`]);
    expect(egress.calls.map((c) => c.route)).toEqual(['POST pds.example.org/xrpc/com.atproto.server.createSession']);
    expect(egress.calls[0]?.json).toEqual({ identifier: 'quan-a.example.org', password: APP_PASSWORD });
  });

  it('posts on that PDS, and goes straight there while the lookup is kept', async () => {
    const { bluesky, egress } = own();
    const publisher = new BlueskyPublisher(bluesky.fetchImpl, egress.fetchImpl);
    expect(await publisher.publish(input())).toMatchObject({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/3kown` });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/3kown2` });
    // The DID is looked up first, so bsky.social never sees the password (#804); the second publish reuses the lookup.
    expect(bluesky.calls.map((c) => c.route)).toEqual([`GET plc.directory/${DID}`]);
    expect(egress.calls.map((c) => c.route)).toEqual([
      'POST pds.example.org/xrpc/com.atproto.server.createSession',
      'POST pds.example.org/xrpc/com.atproto.repo.createRecord',
      'POST pds.example.org/xrpc/com.atproto.server.createSession',
      'POST pds.example.org/xrpc/com.atproto.repo.createRecord',
    ]);
  });

  it('refuses such an account without an egress fetch, and a PDS named by address or on another port', async () => {
    const plain = own();
    await expect(connectBluesky({ handle: 'quan-a.example.org', appPassword: APP_PASSWORD }, plain.bluesky.fetchImpl)).rejects.toMatchObject({ code: 'UnsupportedPds' });
    for (const pds of ['https://10.0.0.5', 'https://pds.example.org:8443', 'http://pds.example.org']) {
      const { bluesky, egress } = own(pds);
      // The identity names no PDS Crove calls, so the login stays refused as bsky.social said.
      await expect(connectBluesky({ handle: 'quan-a.example.org', appPassword: APP_PASSWORD }, bluesky.fetchImpl, egress.fetchImpl)).rejects.toMatchObject({ status: 401 });
      expect(egress.calls).toHaveLength(0);
    }
  });

  it('names the account by its DID when the DID document does not claim the handle its PDS reports', async () => {
    const bluesky = xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [refused],
      'GET public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle': [{ body: { did: DID } }],
      [`GET plc.directory/${DID}`]: [doc(OWN, ['at://someone-else.example.org'])],
    });
    const egress = xrpc({ 'POST pds.example.org/xrpc/com.atproto.server.createSession': [session(OWN)] });
    expect(await connectBluesky({ handle: 'quan-a.example.org', appPassword: APP_PASSWORD }, bluesky.fetchImpl, egress.fetchImpl)).toMatchObject({ displayName: `@${DID}` });
  });
  it('never trusts a session that signs in another account', async () => {
    const { bluesky } = own();
    const egress = xrpc({ 'POST pds.example.org/xrpc/com.atproto.server.createSession': [{ body: { ...session(OWN).body, did: 'did:plc:someoneelse0000000000000' } }] });
    await expect(connectBluesky({ handle: 'quan-a.example.org', appPassword: APP_PASSWORD }, bluesky.fetchImpl, egress.fetchImpl)).rejects.toMatchObject({ code: 'BadSession' });
  });

  it('reads a Bluesky-hosted DID once while it is fresh, so a revoked password costs no directory read', async () => {
    const revoked = xrpc({
      [`GET plc.directory/${DID}`]: [doc(PDS)],
      'POST bsky.social/xrpc/com.atproto.server.createSession': [refused, refused],
    });
    const publisher = new BlueskyPublisher(revoked.fetchImpl);
    for (let i = 0; i < 2; i += 1) expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(revoked.calls.map((c) => c.route)).toEqual([`GET plc.directory/${DID}`, 'POST bsky.social/xrpc/com.atproto.server.createSession', 'POST bsky.social/xrpc/com.atproto.server.createSession']);
  });

  it('sends the password nowhere when the DID document cannot be read or names no PDS Crove calls', async () => {
    for (const answer of [{ status: 503, body: {} }, doc('https://10.0.0.5'), { body: { id: DID, service: [] } }]) {
      const down = xrpc({ [`GET plc.directory/${DID}`]: [answer], 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()] });
      const egress = xrpc({});
      expect(await new BlueskyPublisher(down.fetchImpl, egress.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'transient' });
      expect(down.calls.map((c) => c.route)).toEqual([`GET plc.directory/${DID}`]);
      expect(egress.calls).toHaveLength(0);
    }
    // A did:web account without an egress fetch: its document host is not reachable, so nothing is sent either.
    const web = 'did:web:pds.example.org';
    const plain = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()] });
    expect(await new BlueskyPublisher(plain.fetchImpl).publish(input({ externalAccountId: web, secret: JSON.stringify({ identifier: web, appPassword: APP_PASSWORD }) }))).toMatchObject({ kind: 'rejected', error: 'transient' });
    expect(plain.calls).toHaveLength(0);
  });

  it('takes a PDS on an IDN top-level domain in its xn-- form (#804)', () => {
    expect(pdsOrigin('https://pds.example.xn--p1ai')).toBe('https://pds.example.xn--p1ai');
    expect(pdsOrigin('https://pds.example.xn--')).toBeNull();
  });

  it('looks the account up again when its PDS refuses the login, as after a move', async () => {
    const moved = 'https://pds2.example.org';
    const bluesky = xrpc({
      'POST bsky.social/xrpc/com.atproto.server.createSession': [refused, refused],
      [`GET plc.directory/${DID}`]: [doc(OWN), doc(moved)],
    });
    const egress = xrpc({
      'POST pds.example.org/xrpc/com.atproto.server.createSession': [session(OWN), refused],
      'POST pds.example.org/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3ka`, cid: 'bafy' } }],
      'POST pds2.example.org/xrpc/com.atproto.server.createSession': [session(moved)],
      'POST pds2.example.org/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3kb`, cid: 'bafy' } }],
    });
    const publisher = new BlueskyPublisher(bluesky.fetchImpl, egress.fetchImpl);
    expect(await publisher.publish(input())).toMatchObject({ kind: 'accepted' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/3kb` });
    expect(egress.calls.at(-1)?.route).toBe('POST pds2.example.org/xrpc/com.atproto.repo.createRecord');
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
    const post = calls.find((c) => c.route.endsWith('/com.atproto.repo.createRecord'));
    const record = (post?.json as { record: { text: string; facets: unknown[] } } | undefined)?.record;
    if (!record) throw new Error('no record');
    expect(record.text).toBe('Khai trương! Xem https://example.com/a');
    expect(record.facets).toEqual(linkFacets(record.text));
    expect(post?.auth).toBe('Bearer access-jwt-1');
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
    expect(calls.find((c) => c.route.endsWith('/com.atproto.repo.uploadBlob'))?.type).toBe('image/jpeg');
    expect((calls.find((c) => c.route.endsWith('/com.atproto.repo.createRecord'))?.json as { record: { embed: unknown } } | undefined)?.record.embed).toEqual({ $type: 'app.bsky.embed.images', images: [{ alt: 'Mặt tiền', image: { $type: 'blob', ref: { $link: 'bafyimg' }, mimeType: 'image/jpeg', size: 3 } }] });
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
      if (url.host === 'plc.directory') return new Response(JSON.stringify({ id: DID, service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] }), { status: 200 });
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

describe('Bluesky video (#455)', () => {
  const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5_000_000, altText: 'Lò bánh buổi sáng' };
  const videoInput = (over: Partial<PublishInput['content']> = {}) => input({ content: { body: 'Mẻ bánh đầu tiên', title: null, linkUrl: null, media: [clip], ...over } });
  const blob = { $type: 'blob', ref: { $link: 'bafkreivideo' }, mimeType: 'video/mp4', size: 4_000_000 };
  const fast = { pollMs: 1, videoWaitMs: 1000 };
  const routes = (job: { status?: number; body: unknown }, statuses: { body: unknown }[]) => ({
    'POST bsky.social/xrpc/com.atproto.server.createSession': [session()],
    'GET morel.us-east.host.bsky.network/xrpc/com.atproto.server.getServiceAuth': [{ body: { token: 'service-jwt-1' } }],
    'POST video.bsky.app/xrpc/app.bsky.video.uploadVideo': [job],
    'GET video.bsky.app/xrpc/app.bsky.video.getJobStatus': statuses,
    'POST morel.us-east.host.bsky.network/xrpc/com.atproto.repo.createRecord': [{ body: { uri: `at://${DID}/app.bsky.feed.post/3kvid`, cid: 'bafy' } }],
  });

  it('uploads the MP4 to the video service with a service token, waits for the job, and posts it embedded', async () => {
    const { fetchImpl, calls } = xrpc(
      routes({ body: { jobStatus: { jobId: 'job-1', state: 'JOB_STATE_CREATED' } } }, [{ body: { jobStatus: { jobId: 'job-1', state: 'JOB_STATE_ENCODING' } } }, { body: { jobStatus: { jobId: 'job-1', state: 'JOB_STATE_COMPLETED', blob } } }]),
    );
    expect(await new BlueskyPublisher(fetchImpl, undefined, fast).publish(videoInput())).toMatchObject({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/3kvid` });
    const upload = calls.find((c) => c.route === 'POST video.bsky.app/xrpc/app.bsky.video.uploadVideo');
    expect(upload?.auth).toBe('Bearer service-jwt-1');
    expect(upload?.type).toBe('video/mp4');
    const sent = calls.at(-1)?.json as { record: { embed: unknown } } | undefined;
    if (!sent) throw new Error('no post call');
    const record = sent.record;
    expect(record.embed).toEqual({ $type: 'app.bsky.embed.video', video: blob, alt: 'Lò bánh buổi sáng' });
  });

  it('takes the job of a video sent before, and posts nothing when processing fails, runs late, or the video comes with images', async () => {
    const again = xrpc(routes({ status: 409, body: { error: 'already_exists', message: 'Video already processed', jobId: 'job-0' } }, [{ body: { jobStatus: { jobId: 'job-0', state: 'JOB_STATE_COMPLETED', blob } } }]));
    expect((await new BlueskyPublisher(again.fetchImpl, undefined, fast).publish(videoInput())).kind).toBe('accepted');
    const failed = xrpc(routes({ body: { jobStatus: { jobId: 'job-2' } } }, [{ body: { jobStatus: { jobId: 'job-2', state: 'JOB_STATE_FAILED', message: 'Video too long' } } }]));
    expect(await new BlueskyPublisher(failed.fetchImpl, undefined, fast).publish(videoInput())).toMatchObject({ kind: 'rejected', code: 'VIDEO_PROCESSING_FAILED' });
    expect(failed.calls.some((c) => c.route.endsWith('createRecord'))).toBe(false);
    const slow = xrpc(routes({ body: { jobStatus: { jobId: 'job-3' } } }, Array.from({ length: 50 }, () => ({ body: { jobStatus: { jobId: 'job-3', state: 'JOB_STATE_ENCODING' } } }))));
    expect(await new BlueskyPublisher(slow.fetchImpl, undefined, { pollMs: 5, videoWaitMs: 20 }).publish(videoInput())).toMatchObject({ kind: 'rejected', error: 'transient', code: 'VIDEO_PROCESSING_SLOW' });
    const mixed = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()] });
    expect(await new BlueskyPublisher(mixed.fetchImpl, undefined, fast).publish(videoInput({ media: [clip, { fileId: 'i', mime: 'image/jpeg', sizeBytes: 3, altText: null }] }))).toMatchObject({ code: 'ONE_VIDEO_ALONE' });
  });
});

describe('Bluesky remove (#860)', () => {
  const POST = `at://${DID}/app.bsky.feed.post/3kq2abcdxyz22`;
  const DELETE = `POST ${new URL(PDS).host}/xrpc/com.atproto.repo.deleteRecord`;
  const remove = (fetchImpl: Fetch, externalId = POST) => new BlueskyPublisher(fetchImpl).remove({ externalAccountId: DID, secret: SECRET, externalId });

  it('deletes the post record on the account PDS by its record key', async () => {
    const { fetchImpl, calls } = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()], [DELETE]: [{ body: { commit: { cid: 'bafyreib', rev: '3kq2' } } }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
    const call = calls.find((c) => c.route === DELETE);
    expect(call?.json).toEqual({ repo: DID, collection: 'app.bsky.feed.post', rkey: '3kq2abcdxyz22' });
    expect(call?.auth).toBe('Bearer access-jwt-1');
  });

  it('counts a record already gone as removed', async () => {
    const { fetchImpl } = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()], [DELETE]: [{ status: 400, body: { error: 'RecordNotFound', message: 'Could not locate record' } }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
  });

  it('maps a refused app password, a rate limit and a server error, and never deletes another account post', async () => {
    const refused = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [{ status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } }] });
    expect(await remove(refused.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'AuthenticationRequired' });
    const limited = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()], [DELETE]: [{ status: 429, body: { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' } }] });
    expect(await remove(limited.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    const down = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()], [DELETE]: [{ status: 502, body: { error: 'UpstreamFailure', message: 'Upstream Failure' } }] });
    expect(await remove(down.fetchImpl)).toEqual({ kind: 'unknown', code: 'UpstreamFailure' });
    const other = xrpc({ 'POST bsky.social/xrpc/com.atproto.server.createSession': [session()] });
    expect(await remove(other.fetchImpl, 'at://did:plc:someoneelse0000000000000/app.bsky.feed.post/3kq2abcdxyz22')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'NOT_OWN_POST' });
    expect(await remove(other.fetchImpl, 'https://bsky.app/profile/x/post/1')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(other.calls.some((c) => c.route === DELETE)).toBe(false);
  });
});
