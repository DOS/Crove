// Mastodon against recorded answers (shapes from docs.joinmastodon.org/methods); no live call.
import { describe, expect, it } from 'vitest';
import { connectMastodon, mastodonInstance, mastodonLogin, MastodonPublisher, mastodonSecretOf, type Fetch, type PublishInput } from '../src/index.ts';

const TOKEN = 'test-token-test-token-test-token';
const INSTANCE = 'https://mastodon.example';
const SECRET = JSON.stringify({ instance: INSTANCE, accessToken: TOKEN });
const ACCOUNT = '109302436954721982@mastodon.example';

type Answer = { status?: number; body: unknown };
type Call = { route: string; auth: string | null; json: unknown; form: FormData | null; idempotency: string | null };

function instance(routes: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    calls.push({ route, auth: headers.get('authorization'), json: typeof init?.body === 'string' ? JSON.parse(init.body) : null, form: init?.body instanceof FormData ? init.body : null, idempotency: headers.get('idempotency-key') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: `no answer for ${route}` } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const limits = (over: Record<string, unknown> = {}) => ({ body: { configuration: { statuses: { max_characters: 500, max_media_attachments: 4, ...over }, media_attachments: { image_size_limit: 16_777_216, video_size_limit: 103_809_024 } } } });

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: ACCOUNT,
  secret: SECRET,
  content: { body: 'Khai trương!', title: null, linkUrl: null, media: [] },
  readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'social.publish:v:1:1:publish',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});
const image = { fileId: 'f1', mime: 'image/jpeg', sizeBytes: 3, altText: 'Món mới' };

describe('Mastodon connect', () => {
  it('keeps an instance as https and its host only', () => {
    expect(mastodonInstance('mastodon.social')).toBe('https://mastodon.social');
    expect(mastodonInstance('https://Mastodon.Social/')).toBe('https://mastodon.social');
    for (const bad of ['http://mastodon.social', 'https://mastodon.social:8443', 'https://mastodon.social/@me', 'https://user:pw@mastodon.social', 'https://127.0.0.1', 'https://[::1]', 'localhost', 'not a host', 'file:///etc/passwd']) {
      expect(mastodonInstance(bad), bad).toBeNull();
    }
  });

  it('checks the token with the instance and connects the account by its id and host', async () => {
    const { fetchImpl, calls } = instance({ 'GET mastodon.example/api/v1/accounts/verify_credentials': [{ body: { id: '109302436954721982', username: 'quanpho', acct: 'quanpho', display_name: 'Quán Phở' } }] });
    const account = await connectMastodon(mastodonLogin({ instance: 'mastodon.example', accessToken: ` ${TOKEN} ` }), fetchImpl);
    expect(account).toEqual({ provider: 'mastodon', externalAccountId: ACCOUNT, displayName: 'Quán Phở (@quanpho@mastodon.example)', scopes: ['access_token'], expiresAt: null, secret: SECRET });
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses a bad address or token before any call, and says why the instance refused', async () => {
    expect(() => mastodonLogin({ instance: 'http://mastodon.example', accessToken: TOKEN })).toThrow(expect.objectContaining({ code: 'MASTODON_INSTANCE_INVALID' }));
    expect(() => mastodonLogin({ instance: 'mastodon.example', accessToken: 'short' })).toThrow(expect.objectContaining({ code: 'MASTODON_TOKEN_INVALID' }));
    const login = mastodonLogin({ instance: 'mastodon.example', accessToken: TOKEN });
    const route = 'GET mastodon.example/api/v1/accounts/verify_credentials';
    await expect(connectMastodon(login, instance({ [route]: [{ status: 401, body: { error: 'The access token is invalid' } }] }).fetchImpl)).rejects.toMatchObject({ code: 'MASTODON_TOKEN_REFUSED' });
    await expect(connectMastodon(login, instance({ [route]: [{ status: 404, body: {} }] }).fetchImpl)).rejects.toMatchObject({ code: 'MASTODON_NOT_AN_INSTANCE' });
    await expect(connectMastodon(login, instance({ [route]: [{ body: { hello: 'world' } }] }).fetchImpl)).rejects.toMatchObject({ code: 'MASTODON_NOT_AN_INSTANCE' });
    // The egress guard refusing the address, or no answer: an instance Crove cannot reach.
    const refused: Fetch = async () => Promise.reject(new Error('not a public address'));
    await expect(connectMastodon(login, refused)).rejects.toMatchObject({ kind: 'provider' });
  });

  it('reads back only a sealed secret for an https instance', () => {
    expect(mastodonSecretOf(SECRET)).toEqual({ instance: INSTANCE, accessToken: TOKEN });
    expect(mastodonSecretOf(JSON.stringify({ instance: 'http://mastodon.example', accessToken: TOKEN }))).toBeNull();
    expect(mastodonSecretOf(JSON.stringify({ instance: 'https://mastodon.example/path', accessToken: TOKEN }))).toBeNull();
    expect(mastodonSecretOf('{}')).toBeNull();
  });
});

describe('Mastodon publish', () => {
  it('uploads the image, then posts the status once with the call key, its visibility and content warning', async () => {
    const { fetchImpl, calls } = instance({
      'GET mastodon.example/api/v2/instance': [limits()],
      'POST mastodon.example/api/v2/media': [{ body: { id: '22345792', url: `${INSTANCE}/system/media/1.jpg` } }],
      'POST mastodon.example/api/v1/statuses': [{ body: { id: '103254962155278888', url: `${INSTANCE}/@quanpho/103254962155278888` } }],
    });
    const result = await new MastodonPublisher(fetchImpl).publish(
      input({ content: { body: 'Món mới', title: null, linkUrl: 'https://example.com/a', media: [image] }, settings: { visibility: 'unlisted', contentWarning: 'Đồ ăn' } }),
    );
    expect(result).toEqual({ kind: 'accepted', externalId: '103254962155278888', url: `${INSTANCE}/@quanpho/103254962155278888` });
    const upload = calls.find((c) => c.route.endsWith('/api/v2/media'));
    expect(upload?.form?.get('description')).toBe('Món mới');
    expect(upload?.form?.get('file')).toBeInstanceOf(Blob);
    const status = calls.find((c) => c.route.endsWith('/api/v1/statuses'));
    expect(status?.json).toEqual({ status: 'Món mới\n\nhttps://example.com/a', media_ids: ['22345792'], visibility: 'unlisted', spoiler_text: 'Đồ ăn' });
    expect(status?.idempotency).toBe('social.publish:v:1:1:publish');
    expect(new MastodonPublisher(fetchImpl).publishSafety).toBe('idempotent');
  });

  it('waits for a video the instance is still processing, and gives up without posting', async () => {
    const video = { fileId: 'v1', mime: 'video/mp4', sizeBytes: 3, altText: null };
    const ok = instance({
      'GET mastodon.example/api/v2/instance': [limits()],
      'POST mastodon.example/api/v2/media': [{ status: 202, body: { id: '22345793', url: null } }],
      'GET mastodon.example/api/v1/media/22345793': [{ status: 206, body: { id: '22345793', url: null } }, { body: { id: '22345793', url: `${INSTANCE}/system/media/v.mp4` } }],
      'POST mastodon.example/api/v1/statuses': [{ body: { id: '103254962155278889', url: null } }],
    });
    expect(await new MastodonPublisher(ok.fetchImpl, { mediaPollMs: 1 }).publish(input({ content: { body: '', title: null, linkUrl: null, media: [video] } }))).toMatchObject({ kind: 'accepted', externalId: '103254962155278889', url: null });
    const broken = instance({
      'GET mastodon.example/api/v2/instance': [limits()],
      'POST mastodon.example/api/v2/media': [{ status: 202, body: { id: '22345794', url: null } }],
      'GET mastodon.example/api/v1/media/22345794': [{ status: 422, body: { error: 'Error processing thumbnail' } }],
    });
    expect(await new MastodonPublisher(broken.fetchImpl, { mediaPollMs: 1 }).publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [video] } }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_PROCESSING' });
    expect(broken.calls.some((c) => c.route.endsWith('/api/v1/statuses'))).toBe(false);
  });

  it('keeps to the instance limits, and refuses an account of another instance, all before any post', async () => {
    const { fetchImpl, calls } = instance({ 'GET mastodon.example/api/v2/instance': [limits({ max_characters: 20 }), limits({ max_media_attachments: 1 })] });
    const publisher = new MastodonPublisher(fetchImpl);
    expect(await publisher.publish(input({ content: { body: 'x'.repeat(21), title: null, linkUrl: null, media: [] } }))).toMatchObject({ kind: 'rejected', code: 'TEXT_TOO_LONG' });
    expect(await publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image, image] } }))).toMatchObject({ kind: 'rejected', code: 'TOO_MANY_MEDIA' });
    expect(await publisher.publish(input({ externalAccountId: '1@other.example' }))).toMatchObject({ kind: 'rejected', code: 'BAD_ACCOUNT_ID' });
    expect(await publisher.publish(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(calls.every((c) => c.route.startsWith('GET'))).toBe(true);
  });

  it('maps answers: a refused token, a missing right, a rate limit, a validation error, and an unclear server error', async () => {
    const statuses = [
      { status: 401, body: { error: 'The access token was revoked' } },
      { status: 403, body: { error: 'This action is not allowed' } },
      { status: 429, body: { error: 'Too many requests' } },
      { status: 422, body: { error: 'Validation failed: Text character limit of 500 exceeded' } },
      { status: 503, body: { error: 'Service unavailable' } },
    ];
    const { fetchImpl } = instance({ 'GET mastodon.example/api/v2/instance': statuses.map(() => limits()), 'POST mastodon.example/api/v1/statuses': statuses });
    const publisher = new MastodonPublisher(fetchImpl);
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'permission' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'MASTODON_422' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'unknown', code: 'MASTODON_503' });
  });

  it('replies under its own status for a first comment, and reads favourites, replies and boosts', async () => {
    const { fetchImpl, calls } = instance({
      'POST mastodon.example/api/v1/statuses': [{ body: { id: '103254962155278890' } }],
      'GET mastodon.example/api/v1/statuses/103254962155278888': [{ body: { favourites_count: 12, replies_count: 3, reblogs_count: 4 } }, { status: 404, body: { error: 'Record not found' } }],
    });
    const publisher = new MastodonPublisher(fetchImpl);
    expect(await publisher.comment({ externalAccountId: ACCOUNT, secret: SECRET, externalId: '103254962155278888', text: '#khaitruong', callKey: 'social.publish:v:1:1:comment' })).toEqual({ kind: 'accepted', externalId: '103254962155278890' });
    expect(calls[0]?.json).toEqual({ status: '#khaitruong', in_reply_to_id: '103254962155278888', visibility: 'public' });
    const ask = { externalAccountId: ACCOUNT, secret: SECRET, externalId: '103254962155278888' };
    expect(await publisher.metrics(ask)).toEqual({ metrics: { reactions: 12, comments: 3, shares: 4 } });
    expect(await publisher.metrics(ask)).toEqual({ refused: 'gone' });
  });

  it('calls only the account instance, over https', async () => {
    const hosts: string[] = [];
    const fetchImpl: Fetch = async (url) => {
      const u = new URL(url);
      hosts.push(`${u.protocol}//${u.host}`);
      return new Response(JSON.stringify(u.pathname === '/api/v2/instance' ? limits().body : { id: '1', url: null }));
    };
    await new MastodonPublisher(fetchImpl).publish(input());
    expect([...new Set(hosts)]).toEqual([INSTANCE]);
  });
});

describe('Mastodon remove (#860)', () => {
  const DELETE = 'DELETE mastodon.example/api/v1/statuses/109302436954721999';
  const remove = (fetchImpl: Fetch, externalId = '109302436954721999') => new MastodonPublisher(fetchImpl).remove({ externalAccountId: ACCOUNT, secret: SECRET, externalId });

  it('deletes the status with the account token', async () => {
    const { fetchImpl, calls } = instance({ [DELETE]: [{ body: { id: '109302436954721999', text: 'Khai trương!' } }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
    expect(calls.map((c) => [c.route, c.auth])).toEqual([[DELETE, `Bearer ${TOKEN}`]]);
  });

  it('counts a status the instance no longer has as removed', async () => {
    const { fetchImpl } = instance({ [DELETE]: [{ status: 404, body: { error: 'Record not found' } }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
  });

  it('maps a revoked token, a rate limit and a server error, and calls nothing for a malformed id', async () => {
    const revoked = instance({ [DELETE]: [{ status: 401, body: { error: 'The access token was revoked' } }] });
    expect(await remove(revoked.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'MASTODON_401' });
    const limited = instance({ [DELETE]: [{ status: 429, body: { error: 'Too many requests' } }] });
    expect(await remove(limited.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    const down = instance({ [DELETE]: [{ status: 503, body: { error: 'Service Unavailable' } }] });
    expect(await remove(down.fetchImpl)).toEqual({ kind: 'unknown', code: 'MASTODON_503' });
    const none = instance({});
    expect(await remove(none.fetchImpl, '../accounts/1')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(none.calls).toHaveLength(0);
  });
});
