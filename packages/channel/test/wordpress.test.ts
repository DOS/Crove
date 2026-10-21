// WordPress against recorded answers (shapes from developer.wordpress.org/rest-api/reference); no live call.
import { describe, expect, it } from 'vitest';
import { connectWordPress, wordpressHtml, wordpressLogin, WordPressPublisher, wordpressSecretOf, wordpressSite, type Fetch, type PublishInput } from '../src/index.ts';

const PASSWORD = 'testtesttesttesttesttest';
const SITE = 'https://tiemcuaban.vn';
const SECRET = JSON.stringify({ site: SITE, username: 'chutiem', appPassword: PASSWORD });
const ACCOUNT = 'tiemcuaban.vn';
const BASIC = `Basic ${Buffer.from(`chutiem:${PASSWORD}`).toString('base64')}`;

type Answer = { status?: number; body: unknown };
type Call = { route: string; url: string; auth: string | null; type: string | null; disposition: string | null; redirect: RequestInit['redirect']; json: unknown; bytes: Uint8Array | null };

function site(routes: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    calls.push({
      route,
      url: input,
      auth: headers.get('authorization'),
      type: headers.get('content-type'),
      disposition: headers.get('content-disposition'),
      redirect: init?.redirect,
      json: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      bytes: init?.body instanceof Uint8Array ? init.body : null,
    });
    const answer = routes[route]?.shift() ?? { status: 500, body: { code: 'none', message: `no answer for ${route}` } };
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const ME = 'GET tiemcuaban.vn/wp-json/wp/v2/users/me';
const INDEX = 'GET tiemcuaban.vn/wp-json';
const MEDIA = 'POST tiemcuaban.vn/wp-json/wp/v2/media';
const POSTS = 'POST tiemcuaban.vn/wp-json/wp/v2/posts';
const LIST = 'GET tiemcuaban.vn/wp-json/wp/v2/posts';
const me = (publish = true) => ({ body: { id: 3, name: 'Chủ tiệm', slug: 'chutiem', capabilities: { publish_posts: publish, upload_files: true } } });

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
const image = (fileId: string, altText: string | null) => ({ fileId, mime: 'image/jpeg', sizeBytes: 3, altText });

describe('WordPress connect', () => {
  it('keeps a site as https, its host and the path WordPress lives under', () => {
    expect(wordpressSite('tiemcuaban.vn')).toBe(SITE);
    expect(wordpressSite('https://TiemCuaBan.vn/')).toBe(SITE);
    expect(wordpressSite('https://example.com/blog/')).toBe('https://example.com/blog');
    for (const bad of ['http://tiemcuaban.vn', 'https://tiemcuaban.vn:8443', 'https://user:pw@tiemcuaban.vn', 'https://tiemcuaban.vn/?p=1', 'https://tiemcuaban.vn/#x', 'https://tiemcuaban.vn/blog/../wp-admin', 'https://tiemcuaban.vn/%2e%2e/x', 'https://127.0.0.1', 'https://[::1]', 'localhost', 'not a host', 'file:///etc/passwd']) {
      expect(wordpressSite(bad), bad).toBeNull();
    }
  });

  it('takes an application password with or without its spaces, and refuses a bad one before any call', () => {
    expect(wordpressLogin({ site: 'tiemcuaban.vn', username: ' chutiem ', appPassword: 'test test test test test test' })).toEqual({ site: SITE, username: 'chutiem', appPassword: PASSWORD });
    expect(wordpressLogin({ site: SITE, username: 'chutiem', appPassword: PASSWORD }).appPassword).toBe(PASSWORD);
    expect(() => wordpressLogin({ site: 'http://tiemcuaban.vn', username: 'chutiem', appPassword: PASSWORD })).toThrow(expect.objectContaining({ code: 'WORDPRESS_SITE_INVALID' }));
    expect(() => wordpressLogin({ site: SITE, username: 'chutiem', appPassword: 'my-login-password' })).toThrow(expect.objectContaining({ code: 'WORDPRESS_LOGIN_INVALID' }));
    expect(() => wordpressLogin({ site: SITE, username: 'chu:tiem', appPassword: PASSWORD })).toThrow(expect.objectContaining({ code: 'WORDPRESS_LOGIN_INVALID' }));
    expect(() => wordpressLogin({ site: SITE, username: ' ', appPassword: PASSWORD })).toThrow(expect.objectContaining({ code: 'WORDPRESS_LOGIN_INVALID' }));
  });

  it('checks the user may publish, then connects the site by its host and path with its name', async () => {
    const { fetchImpl, calls } = site({ [ME]: [me()], [INDEX]: [{ body: { name: 'Tiệm Cửa Bạn &amp; Bánh', url: SITE } }] });
    const account = await connectWordPress(wordpressLogin({ site: 'tiemcuaban.vn', username: 'chutiem', appPassword: 'test test test test test test' }), fetchImpl);
    expect(account).toEqual({ provider: 'wordpress', externalAccountId: ACCOUNT, displayName: 'Tiệm Cửa Bạn & Bánh', scopes: ['application_password'], expiresAt: null, secret: SECRET });
    expect(calls.map((c) => c.url)).toEqual([`${SITE}/wp-json/wp/v2/users/me?context=edit`, `${SITE}/wp-json`]);
    expect(calls[0]?.auth).toBe(BASIC);
    // The site's public index is read without the password.
    expect(calls[1]?.auth).toBeNull();
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('keeps a path prefix and falls back to the host for a site without a name', async () => {
    const { fetchImpl, calls } = site({ 'GET example.com/blog/wp-json/wp/v2/users/me': [me()], 'GET example.com/blog/wp-json': [{ status: 500, body: {} }] });
    const account = await connectWordPress(wordpressLogin({ site: 'https://example.com/blog', username: 'chutiem', appPassword: PASSWORD }), fetchImpl);
    expect(account).toMatchObject({ externalAccountId: 'example.com/blog', displayName: 'example.com' });
    expect(calls[0]?.url).toBe('https://example.com/blog/wp-json/wp/v2/users/me?context=edit');
  });

  it('says why the site refused: a user who cannot publish, a refused login, no REST API, a redirect', async () => {
    const login = wordpressLogin({ site: SITE, username: 'chutiem', appPassword: PASSWORD });
    await expect(connectWordPress(login, site({ [ME]: [me(false)] }).fetchImpl)).rejects.toMatchObject({ code: 'WORDPRESS_CANNOT_PUBLISH' });
    await expect(connectWordPress(login, site({ [ME]: [{ status: 401, body: { code: 'incorrect_password', message: 'The provided password is an invalid application password.' } }] }).fetchImpl)).rejects.toMatchObject({ code: 'WORDPRESS_LOGIN_REFUSED' });
    await expect(connectWordPress(login, site({ [ME]: [{ status: 404, body: '<html>Not found</html>' }] }).fetchImpl)).rejects.toMatchObject({ code: 'WORDPRESS_NO_REST_API' });
    await expect(connectWordPress(login, site({ [ME]: [{ body: '<!doctype html><title>Shop</title>' }] }).fetchImpl)).rejects.toMatchObject({ code: 'WORDPRESS_NO_REST_API' });
    await expect(connectWordPress(login, site({ [ME]: [{ status: 301, body: '' }] }).fetchImpl)).rejects.toMatchObject({ code: 'WORDPRESS_SITE_REDIRECTS' });
    // The egress guard refusing the address, or no answer: a site Crove cannot reach.
    const refused: Fetch = async () => Promise.reject(new Error('not a public address'));
    await expect(connectWordPress(login, refused)).rejects.toMatchObject({ kind: 'provider' });
  });

  it('reads back only a sealed secret for an https site', () => {
    expect(wordpressSecretOf(SECRET)).toEqual({ site: SITE, username: 'chutiem', appPassword: PASSWORD });
    expect(wordpressSecretOf(JSON.stringify({ site: 'http://tiemcuaban.vn', username: 'chutiem', appPassword: PASSWORD }))).toBeNull();
    expect(wordpressSecretOf(JSON.stringify({ site: SITE, username: 'chutiem', appPassword: 'short' }))).toBeNull();
    expect(wordpressSecretOf('{}')).toBeNull();
  });
});

describe('WordPress publish', () => {
  it('publishes the text as escaped paragraphs with its links, and the post link as its own paragraph', async () => {
    const { fetchImpl, calls } = site({ [POSTS]: [{ status: 201, body: { id: 120, link: `${SITE}/khai-truong/` } }] });
    const body = 'Khai trương <script>alert(1)</script> & giảm 10%\nXem menu: https://tiemcuaban.vn/menu.\n\nHẹn gặp "bạn"!';
    const result = await new WordPressPublisher(fetchImpl).publish(input({ content: { body, title: null, linkUrl: 'https://tiemcuaban.vn/dat-ban?a=1&b=2', media: [] } }));
    expect(result).toEqual({ kind: 'accepted', externalId: '120', url: `${SITE}/khai-truong/` });
    expect(calls.map((c) => c.route)).toEqual([POSTS]);
    expect(calls[0]?.auth).toBe(BASIC);
    expect(calls[0]?.json).toEqual({
      status: 'publish',
      title: 'Khai trương &lt;script&gt;alert(1)&lt;/script&gt; &amp; giảm 10%',
      content: [
        '<p>Khai trương &lt;script&gt;alert(1)&lt;/script&gt; &amp; giảm 10%<br>Xem menu: <a href="https://tiemcuaban.vn/menu">https://tiemcuaban.vn/menu</a>.</p>',
        '<p>Hẹn gặp &quot;bạn&quot;!</p>',
        '<p><a href="https://tiemcuaban.vn/dat-ban?a=1&amp;b=2">https://tiemcuaban.vn/dat-ban?a=1&amp;b=2</a></p>',
      ].join('\n'),
    });
    expect(new WordPressPublisher(fetchImpl).publishSafety).toBe('reconcile_only');
  });

  it('uploads two images, sets their alt text, and posts them as figures with the first as the featured image', async () => {
    const { fetchImpl, calls } = site({
      [MEDIA]: [
        { status: 201, body: { id: 41, source_url: `${SITE}/wp-content/uploads/2026/10/image-1.jpg` } },
        { status: 201, body: { id: 42, source_url: `${SITE}/wp-content/uploads/2026/10/image-2.jpg` } },
      ],
      'POST tiemcuaban.vn/wp-json/wp/v2/media/41': [{ body: { id: 41 } }],
      [POSTS]: [{ status: 201, body: { id: 121, link: `${SITE}/mon-moi/` } }],
    });
    const result = await new WordPressPublisher(fetchImpl).publish(input({ content: { body: 'Món mới', title: 'Thực đơn tháng 10', linkUrl: null, media: [image('f1', 'Phở "đặc biệt" <b>'), image('f2', null)] } }));
    expect(result).toEqual({ kind: 'accepted', externalId: '121', url: `${SITE}/mon-moi/` });
    expect(calls.map((c) => c.route)).toEqual([MEDIA, 'POST tiemcuaban.vn/wp-json/wp/v2/media/41', MEDIA, POSTS]);
    expect(calls[0]).toMatchObject({ type: 'image/jpeg', disposition: 'attachment; filename="image-1.jpg"', bytes: new Uint8Array([0xff, 0xd8, 0xff]) });
    expect(calls[1]?.json).toEqual({ alt_text: 'Phở "đặc biệt" <b>' });
    expect(calls[2]?.disposition).toBe('attachment; filename="image-2.jpg"');
    expect(calls[3]?.json).toEqual({
      status: 'publish',
      title: 'Thực đơn tháng 10',
      content: [
        '<p>Món mới</p>',
        `<figure><img src="${SITE}/wp-content/uploads/2026/10/image-1.jpg" alt="Phở &quot;đặc biệt&quot; &lt;b&gt;"></figure>`,
        `<figure><img src="${SITE}/wp-content/uploads/2026/10/image-2.jpg" alt=""></figure>`,
      ].join('\n'),
      featured_media: 41,
    });
  });

  it('takes the title from the first line of the text, cut to 100 characters', async () => {
    const { fetchImpl, calls } = site({ [POSTS]: [{ status: 201, body: { id: 122, link: 'https://elsewhere.example/p/122' } }] });
    const line = 'Ư'.repeat(120);
    const result = await new WordPressPublisher(fetchImpl).publish(input({ content: { body: `\n  ${line}\nDòng hai`, title: '  ', linkUrl: null, media: [] } }));
    // A link off the site's host is not kept.
    expect(result).toEqual({ kind: 'accepted', externalId: '122', url: null });
    const sent = calls[0]?.json as { title: string } | undefined;
    expect(sent?.title).toBe('Ư'.repeat(100));
  });

  it('maps answers: a refused password, a validation error, a rate limit, and an unclear server error', async () => {
    const answers = [
      { status: 401, body: { code: 'rest_not_logged_in', message: 'You are not currently logged in.' } },
      { status: 400, body: { code: 'rest_invalid_param', message: 'Invalid parameter(s): status' } },
      { status: 429, body: { code: 'too_many', message: 'Slow down' } },
      { status: 500, body: { code: 'internal_server_error', message: 'There has been a critical error on this website.' } },
    ];
    const { fetchImpl } = site({ [POSTS]: answers });
    const publisher = new WordPressPublisher(fetchImpl);
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'WORDPRESS_401' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_400' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'unknown', code: 'WORDPRESS_500' });
  });

  it('posts nothing when an image upload fails, a file is too large, or a video comes', async () => {
    const failed = site({ [MEDIA]: [{ status: 201, body: { id: 41, source_url: `${SITE}/a.jpg` } }, { status: 500, body: { code: 'upload_failed', message: 'Disk full' } }] });
    expect(await new WordPressPublisher(failed.fetchImpl).publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image('f1', null), image('f2', null)] } }))).toMatchObject({ kind: 'rejected', error: 'transient', code: 'WORDPRESS_500' });
    expect(failed.calls.some((c) => c.route === POSTS)).toBe(false);
    const tooLarge = site({ [MEDIA]: [{ status: 413, body: '<html>Request Entity Too Large</html>' }] });
    expect(await new WordPressPublisher(tooLarge.fetchImpl).publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image('f1', null)] } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'MEDIA_TOO_LARGE' });
    const none = site({});
    const publisher = new WordPressPublisher(none.fetchImpl);
    expect(await publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [{ fileId: 'v1', mime: 'video/mp4', sizeBytes: 3, altText: null }] } }))).toMatchObject({ kind: 'rejected', code: 'IMAGE_TYPE' });
    expect(await publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [{ ...image('f1', null), sizeBytes: 11 * 1024 * 1024 }] } }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_TOO_LARGE' });
    expect(await publisher.publish(input({ externalAccountId: 'other.example' }))).toMatchObject({ kind: 'rejected', code: 'BAD_ACCOUNT_ID' });
    expect(await publisher.publish(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(await publisher.publish(input({ readMedia: async () => Promise.reject(new Error('gone')), content: { body: 'x', title: null, linkUrl: null, media: [image('f1', null)] } }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(none.calls).toEqual([]);
  });

  it('finds an unclear post among the user latest posts by title and time, and says when it is not there', async () => {
    const after = new Date('2026-10-21T03:00:00Z');
    const before = new Date('2026-10-21T03:05:00Z');
    const ask = { externalAccountId: ACCOUNT, secret: SECRET, callKey: 'social.publish:v:1:1:publish', contentHash: `sha256:${'0'.repeat(64)}`, content: { body: 'Tiệm & Bánh khai trương\nChi tiết', title: null, linkUrl: null, media: [] }, after, before };
    const { fetchImpl, calls } = site({
      [ME]: [{ body: { id: 3 } }, { body: { id: 3 } }],
      [LIST]: [
        {
          body: [
            { id: 118, link: `${SITE}/cu/`, date_gmt: '2026-10-20T03:01:00', title: { raw: 'Tiệm &amp; Bánh khai trương' } },
            { id: 119, link: `${SITE}/khac/`, date_gmt: '2026-10-21T03:01:00', title: { raw: 'Bài khác' } },
            { id: 120, link: `${SITE}/khai-truong/`, date_gmt: '2026-10-21T03:01:00', title: { raw: 'Tiệm &amp; Bánh khai trương' } },
          ],
        },
        { body: [{ id: 119, link: `${SITE}/khac/`, date_gmt: '2026-10-21T03:01:00', title: { raw: 'Bài khác' } }] },
      ],
    });
    const publisher = new WordPressPublisher(fetchImpl);
    expect(await publisher.reconcile(ask)).toEqual({ found: true, externalId: '120', url: `${SITE}/khai-truong/` });
    const list = new URL(calls[1]?.url ?? '');
    expect(Object.fromEntries(list.searchParams)).toEqual({ context: 'edit', status: 'publish', per_page: '20', after: '2026-10-20T03:00:00.000Z', author: '3' });
    expect(await publisher.reconcile(ask)).toEqual({ found: false });
    expect(await publisher.reconcile({ ...ask, secret: '{}' })).toEqual({ found: 'unknown' });
  });

  it('calls only the site host, over https, through the fetch it was given, never following a redirect', async () => {
    const seen: { origin: string; redirect: RequestInit['redirect'] }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      seen.push({ origin: `${u.protocol}//${u.host}`, redirect: init?.redirect });
      const body = u.pathname.endsWith('/media') ? { id: 41, source_url: 'https://cdn.example/a.jpg' } : u.pathname.endsWith('/users/me') ? { id: 3 } : u.pathname.endsWith('/posts') && init?.method !== 'POST' ? [] : { id: 120, link: `${SITE}/p/` };
      return new Response(JSON.stringify(body), { status: 201 });
    };
    const publisher = new WordPressPublisher(fetchImpl);
    await publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image('f1', 'alt')] } }));
    await publisher.reconcile({ externalAccountId: ACCOUNT, secret: SECRET, callKey: 'k', contentHash: 'h', content: { body: 'x', title: null, linkUrl: null, media: [] }, after: new Date(), before: new Date() });
    expect(seen.length).toBe(5);
    expect([...new Set(seen.map((s) => s.origin))]).toEqual([SITE]);
    expect(seen.every((s) => s.redirect === 'manual')).toBe(true);
    // A redirect from the site is a failure, with nothing posted.
    const redirecting: Fetch = async () => new Response(null, { status: 302 });
    expect(await new WordPressPublisher(redirecting).publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'SITE_REDIRECTS' });
  });

  it('escapes every character of the text and links, never passing markup through', () => {
    expect(wordpressHtml({ body: '<img src=x onerror=alert(1)> https://a.vn/"><script>', linkUrl: 'javascript:alert(1)' }, [])).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt; <a href="https://a.vn/">https://a.vn/</a>&quot;&gt;&lt;script&gt;</p>\n<p>javascript:alert(1)</p>',
    );
  });
});
