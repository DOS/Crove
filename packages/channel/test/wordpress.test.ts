// WordPress against recorded answers (shapes from developer.wordpress.org/rest-api/reference); no live call.
import { describe, expect, it } from 'vitest';
import { connectWordPress, wordpressHtml, wordpressLogin, wordpressOptionsOf, WordPressPublisher, wordpressSecretOf, wordpressSite, type Fetch, type PublishInput } from '../src/index.ts';

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
      [ME]: [{ body: { id: 3 } }, { body: { id: 3 } }, { body: { id: 3 } }],
      [LIST]: [
        {
          body: [
            { id: 118, link: `${SITE}/cu/`, date_gmt: '2026-10-20T03:01:00', title: { raw: 'Tiệm &amp; Bánh khai trương' } },
            { id: 119, link: `${SITE}/khac/`, date_gmt: '2026-10-21T03:01:00', title: { raw: 'Bài khác' } },
            { id: 120, link: `${SITE}/khai-truong/`, date_gmt: '2026-10-21T03:01:00', title: { raw: 'Tiệm &amp; Bánh khai trương' } },
          ],
        },
        { body: [{ id: 119, link: `${SITE}/khac/`, date_gmt: '2026-10-21T03:01:00', title: { raw: 'Bài khác' } }] },
        { body: [{ id: 118, link: `${SITE}/cu/`, date_gmt: '2026-10-20T03:01:00', title: { raw: 'Bài cũ' } }] },
      ],
    });
    const publisher = new WordPressPublisher(fetchImpl);
    expect(await publisher.reconcile(ask)).toEqual({ found: true, externalId: '120', url: `${SITE}/khai-truong/` });
    const list = new URL(calls[1]?.url ?? '');
    expect(Object.fromEntries(list.searchParams)).toEqual({ context: 'edit', status: 'publish,future,draft,pending', per_page: '20', after: '2026-10-20T03:00:00.000Z', author: '3', _fields: 'id,link,date_gmt,status,title' });
    // Another title in the window (a plugin may rewrite titles): unclear, for a person, never a second post.
    expect(await publisher.reconcile(ask)).toEqual({ found: 'unknown' });
    // Nothing of the user's in the window: not there.
    expect(await publisher.reconcile(ask)).toEqual({ found: false });
    expect(await publisher.reconcile({ ...ask, secret: '{}' })).toEqual({ found: 'unknown' });
  });

  it('takes an http media address on the site host as https, and refuses one elsewhere without retrying', async () => {
    const answers = (sourceUrl: string) => {
      const calls: string[] = [];
      const fetchImpl: Fetch = async (url, init) => {
        const u = new URL(url);
        calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
        const body = u.pathname.endsWith('/media') ? { id: 41, source_url: sourceUrl } : { id: 120, link: `${SITE}/p/` };
        return new Response(JSON.stringify(body), { status: 201 });
      };
      return { calls, publisher: new WordPressPublisher(fetchImpl) };
    };
    const same = answers('http://tiemcuaban.vn/wp-content/uploads/a.jpg');
    expect(await same.publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image('f1', '')] } }))).toMatchObject({ kind: 'accepted' });
    const elsewhere = answers('http://cdn.example/a.jpg');
    expect(await elsewhere.publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [image('f1', '')] } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_NOT_HTTPS' });
    expect(elsewhere.calls.some((c) => c === 'POST /wp-json/wp/v2/posts')).toBe(false);
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

  it('finds a draft or a post pending review as such, with no address', async () => {
    const after = new Date('2026-10-21T03:00:00Z');
    const before = new Date('2026-10-21T03:05:00Z');
    const ask = { externalAccountId: ACCOUNT, secret: SECRET, callKey: 'k', contentHash: 'h', content: { body: 'Thực đơn mùa thu', title: null, linkUrl: null, media: [] }, settings: { wordpress: { status: 'draft' } }, after, before };
    // A draft's date_gmt as WordPress shows it in the edit context, and its preview link, which is not public.
    const { fetchImpl } = site({
      [ME]: [{ body: { id: 3 } }, { body: { id: 3 } }],
      [LIST]: [
        { body: [{ id: 130, link: `${SITE}/?p=130`, date_gmt: '2026-10-21T03:01:00', status: 'draft', title: { raw: 'Thực đơn mùa thu' } }] },
        { body: [{ id: 131, link: `${SITE}/?p=131`, date_gmt: '2026-10-21T03:01:00', status: 'pending', title: { raw: 'Thực đơn mùa thu' } }] },
      ],
    });
    const publisher = new WordPressPublisher(fetchImpl);
    expect(await publisher.reconcile(ask)).toEqual({ found: true, externalId: '130', url: null, draft: 'draft' });
    expect(await publisher.reconcile(ask)).toEqual({ found: true, externalId: '131', url: null, draft: 'pending' });
  });

  it('escapes every character of the text and links, never passing markup through', () => {
    expect(wordpressHtml({ body: '<img src=x onerror=alert(1)> https://a.vn/"><script>', linkUrl: 'javascript:alert(1)' }, [])).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt; <a href="https://a.vn/">https://a.vn/</a>&quot;&gt;&lt;script&gt;</p>\n<p>javascript:alert(1)</p>',
    );
  });
});

describe('WordPress categories, tags, excerpt and status (#981)', () => {
  const CATEGORIES = 'GET tiemcuaban.vn/wp-json/wp/v2/categories';
  const TAGS = 'GET tiemcuaban.vn/wp-json/wp/v2/tags';
  const NEW_TAG = 'POST tiemcuaban.vn/wp-json/wp/v2/tags';
  const wp = (wordpress: Record<string, unknown>, media: PublishInput['content']['media'] = []) => input({ content: { body: 'Món mới', title: 'Thực đơn tháng 10', linkUrl: null, media }, settings: { wordpress } });
  const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it('resolves category and tag names to ids by exact name, creates a missing tag, and sends them with the excerpt', async () => {
    const { fetchImpl, calls } = site({
      // WordPress searches names and slugs for the text: only the exact name counts, case and entities aside.
      [CATEGORIES]: [
        { body: [{ id: 7, name: 'Tin tức nội bộ' }, { id: 5, name: 'Tin Tức' }] },
        { body: [{ id: 9, name: 'Khuyến mãi &amp; Quà' }] },
      ],
      [TAGS]: [{ body: [{ id: 21, name: 'bánh mì' }, { id: 22, name: 'bánh mì que' }] }, { body: [] }],
      [NEW_TAG]: [{ status: 201, body: { id: 23, name: 'Mới', slug: 'moi' } }],
      [POSTS]: [{ status: 201, body: { id: 140, link: `${SITE}/thuc-don-thang-10/`, status: 'publish' } }],
    });
    const result = await new WordPressPublisher(fetchImpl).publish(wp({ categories: ['tin tức', 'Khuyến mãi & Quà'], tags: ['Bánh mì', 'Mới', 'mới'], excerpt: '  Thực đơn <mới> & giá  ' }));
    expect(result).toEqual({ kind: 'accepted', externalId: '140', url: `${SITE}/thuc-don-thang-10/` });
    expect(calls.map((c) => c.route)).toEqual([CATEGORIES, CATEGORIES, TAGS, TAGS, NEW_TAG, POSTS]);
    expect(query(calls[0]?.url ?? '')).toEqual({ search: 'tin tức', per_page: '100', _fields: 'id,name' });
    // The search is the name as WordPress stores it, & as &amp;.
    expect(query(calls[1]?.url ?? '').search).toBe('Khuyến mãi &amp; Quà');
    expect(calls[4]?.json).toEqual({ name: 'Mới' });
    expect(calls.every((c) => c.auth === BASIC && c.redirect === 'manual')).toBe(true);
    expect(calls[5]?.json).toEqual({
      status: 'publish',
      title: 'Thực đơn tháng 10',
      content: '<p>Món mới</p>',
      categories: [5, 9],
      tags: [21, 23],
      excerpt: 'Thực đơn &lt;mới&gt; &amp; giá',
    });
  });

  it('saves a draft or sends a post for review, recorded with no address', async () => {
    const { fetchImpl, calls } = site({
      [POSTS]: [
        { status: 201, body: { id: 141, link: `${SITE}/?p=141`, status: 'draft' } },
        { status: 201, body: { id: 142, link: `${SITE}/?p=142`, status: 'pending' } },
        // A review plugin may hold back a post asked to go out: the site's answer decides.
        { status: 201, body: { id: 143, link: `${SITE}/?p=143`, status: 'pending' } },
      ],
    });
    const publisher = new WordPressPublisher(fetchImpl);
    expect(await publisher.publish(wp({ status: 'draft' }))).toEqual({ kind: 'accepted', externalId: '141', url: null, draft: 'draft' });
    expect(await publisher.publish(wp({ status: 'pending' }))).toEqual({ kind: 'accepted', externalId: '142', url: null, draft: 'pending' });
    expect(await publisher.publish(wp({}))).toEqual({ kind: 'accepted', externalId: '143', url: null, draft: 'pending' });
    expect(calls.map((c) => (c.json as { status: string }).status)).toEqual(['draft', 'pending', 'publish']);
    expect(calls[0]?.json).toEqual({ status: 'draft', title: 'Thực đơn tháng 10', content: '<p>Món mới</p>' });
  });

  it('posts nothing, and uploads nothing, when the site has no category by that name or two of them', async () => {
    const missing = site({ [CATEGORIES]: [{ body: [{ id: 7, name: 'Tin tức nội bộ' }] }] });
    const result = await new WordPressPublisher(missing.fetchImpl).publish(wp({ categories: ['Tin tức'], tags: ['bánh mì'] }, [image('f1', null)]));
    expect(result).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_CATEGORY_NOT_FOUND', message: 'Tin tức' });
    expect(missing.calls.map((c) => c.route)).toEqual([CATEGORIES]);
    // The same name under two parents: Crove cannot tell which one the person meant.
    const twice = site({ [CATEGORIES]: [{ body: [{ id: 5, name: 'Tin tức' }, { id: 6, name: 'Tin tức' }] }] });
    expect(await new WordPressPublisher(twice.fetchImpl).publish(wp({ categories: ['Tin tức'] }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_CATEGORY_AMBIGUOUS' });
    expect(twice.calls.some((c) => c.route === POSTS)).toBe(false);
  });

  // An Author may publish and assign the site's categories but not create them (manage_categories), which is why Crove
  // never creates a category. WordPress core lets anyone who can assign tags create one (assign_post_tags, since 4.9.8);
  // a site whose roles were narrowed answers the create with 403 rest_cannot_create, recorded here.
  it('posts nothing when the site will not let the user create a tag, and takes a tag made meanwhile', async () => {
    const author = { body: { id: 4, name: 'Tác giả', capabilities: { publish_posts: true, upload_files: true, manage_categories: false } } };
    const refused = site({
      [ME]: [author],
      [CATEGORIES]: [{ body: [{ id: 5, name: 'Tin tức' }] }],
      [TAGS]: [{ body: [] }],
      [NEW_TAG]: [{ status: 403, body: { code: 'rest_cannot_create', message: 'Sorry, you are not allowed to create terms in this taxonomy.', data: { status: 403 } } }],
    });
    // The Author connects: it may publish posts.
    expect(await connectWordPress(wordpressLogin({ site: SITE, username: 'chutiem', appPassword: PASSWORD }), refused.fetchImpl)).toMatchObject({ externalAccountId: ACCOUNT });
    const result = await new WordPressPublisher(refused.fetchImpl).publish(wp({ categories: ['Tin tức'], tags: ['Mới'] }, [image('f1', null)]));
    expect(result).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_TAG_NOT_ALLOWED', message: 'Mới', httpStatus: 403 });
    expect(refused.calls.some((c) => c.route === MEDIA || c.route === POSTS)).toBe(false);
    // Another post made the tag between the lookup and the create: WordPress names it.
    const raced = site({
      [TAGS]: [{ body: [] }],
      [NEW_TAG]: [{ status: 400, body: { code: 'term_exists', message: 'A term with the name provided already exists in this taxonomy.', data: { status: 400, term_id: 24 } } }],
      [POSTS]: [{ status: 201, body: { id: 144, link: `${SITE}/p/`, status: 'publish' } }],
    });
    expect(await new WordPressPublisher(raced.fetchImpl).publish(wp({ tags: ['Mới'] }))).toMatchObject({ kind: 'accepted', externalId: '144' });
    expect(raced.calls.at(-1)?.json).toMatchObject({ tags: [24] });
  });

  it('retries a lookup the site did not answer, and pauses on a refused password, with nothing posted', async () => {
    const down = site({ [CATEGORIES]: [{ status: 502, body: '<html>Bad gateway</html>' }] });
    expect(await new WordPressPublisher(down.fetchImpl).publish(wp({ categories: ['Tin tức'] }))).toMatchObject({ kind: 'rejected', error: 'transient', code: 'WORDPRESS_502' });
    const revoked = site({ [TAGS]: [{ status: 401, body: { code: 'incorrect_password', message: 'The provided password is an invalid application password.' } }] });
    expect(await new WordPressPublisher(revoked.fetchImpl).publish(wp({ tags: ['Mới'] }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect([...down.calls, ...revoked.calls].some((c) => c.route === POSTS)).toBe(false);
  });

  it('refuses settings it cannot read before any call, and reads the shape the composer saves', async () => {
    const none = site({});
    const publisher = new WordPressPublisher(none.fetchImpl);
    for (const bad of [{ status: 'private' }, { categories: 'Tin tức' }, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, { excerpt: 'x'.repeat(501) }, { categories: ['<b>'] }]) {
      expect(await publisher.publish(wp(bad)), JSON.stringify(bad)).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_SETTINGS_INVALID' });
    }
    expect(none.calls).toEqual([]);
    expect(wordpressOptionsOf({})).toEqual({ categories: [], tags: [], excerpt: '', status: 'publish' });
    expect(wordpressOptionsOf({ wordpress: { categories: [' Tin   tức ', 'tin tức'], status: 'pending' } })).toEqual({ categories: ['Tin tức'], tags: [], excerpt: '', status: 'pending' });
  });
});

describe('WordPress categories and tags for the composer (#1131)', () => {
  const CATEGORIES = 'GET tiemcuaban.vn/wp-json/wp/v2/categories';
  const TAGS = 'GET tiemcuaban.vn/wp-json/wp/v2/tags';
  const list = (fetchImpl: Fetch, over: { externalAccountId?: string; kind?: 'wordpress_term' | 'youtube_playlist'; secret?: string } = {}) =>
    new WordPressPublisher(fetchImpl).options({ externalAccountId: over.externalAccountId ?? ACCOUNT, secret: over.secret ?? SECRET, kind: over.kind ?? 'wordpress_term' });
  const terms = (from: number, n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `${prefix} ${from + i}` }));

  it('lists the categories, then the tags, by name with their taxonomy, names read back from entities and cleaned', async () => {
    const { fetchImpl, calls } = site({
      [CATEGORIES]: [{ body: [{ id: 1, name: 'Chưa phân loại' }, { id: 7, name: 'Tin tức &amp; Sự kiện' }, { id: 8, name: '  Giờ   mở cửa ' }, { id: 10, name: 'Ẩn\u200bdanh' }, { id: 0, name: 'bad id' }, { id: 9, name: '&lt;script&gt;' }] }],
      [TAGS]: [{ body: [{ id: 12, name: 'bánh mì' }, { id: 12, name: 'twice' }, { id: 13, name: '' }] }],
    });
    expect(await list(fetchImpl)).toEqual({
      options: [
        { id: '1', name: 'Chưa phân loại', taxonomy: 'category' },
        { id: '7', name: 'Tin tức & Sự kiện', taxonomy: 'category' },
        { id: '8', name: 'Giờ mở cửa', taxonomy: 'category' },
        { id: '12', name: 'bánh mì', taxonomy: 'tag' },
      ],
    });
    expect(calls.map((c) => c.auth)).toEqual([BASIC, BASIC]);
    expect(calls.map((c) => c.redirect)).toEqual(['manual', 'manual']);
    expect(Object.fromEntries(new URL(calls[0]?.url as string).searchParams)).toEqual({ per_page: '100', page: '1', orderby: 'name', order: 'asc', _fields: 'id,name' });
  });

  it('follows the pages of each taxonomy, stops past the last page, and keeps at most 500 terms, the categories first', async () => {
    const paged = site({
      [CATEGORIES]: [{ body: terms(1, 100, 'Chuyên mục') }, { status: 400, body: { code: 'rest_post_invalid_page_number', message: 'The page number requested is larger than the number of pages available.' } }],
      [TAGS]: [{ body: terms(1001, 100, 'Thẻ') }, { body: terms(1101, 3, 'Thẻ') }],
    });
    const answer = await list(paged.fetchImpl);
    expect(answer && 'options' in answer ? answer.options.length : 0).toBe(203);
    expect(paged.calls.map((c) => `${c.route} ${new URL(c.url).searchParams.get('page')}`)).toEqual([`${CATEGORIES} 1`, `${CATEGORIES} 2`, `${TAGS} 1`, `${TAGS} 2`]);
    const many = site({ [CATEGORIES]: [{ body: terms(1, 100, 'C') }, { body: terms(101, 50, 'C') }], [TAGS]: Array.from({ length: 5 }, (_, p) => ({ body: terms(1000 + p * 100, 100, 'T') })) });
    const full = await list(many.fetchImpl);
    const options = full && 'options' in full ? full.options : [];
    expect(options).toHaveLength(500);
    expect(options.filter((o) => o.taxonomy === 'category')).toHaveLength(150);
    expect(many.calls).toHaveLength(6);
  });

  it('tells a refused password, a refusal, a gone REST API and an outage apart', async () => {
    const cases: [Answer, unknown][] = [
      [{ status: 401, body: { code: 'incorrect_password', message: 'The provided password is an invalid application password.' } }, { refused: 'token_expired' }],
      [{ status: 403, body: { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.' } }, { refused: 'permission' }],
      [{ status: 404, body: { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' } }, { refused: 'not_found' }],
      [{ status: 500, body: { code: 'internal_server_error', message: 'There has been a critical error on this website.' } }, null],
      [{ status: 200, body: '<html>not the REST API</html>' }, null],
      [{ status: 200, body: { not: 'a list' } }, null],
      [{ status: 400, body: { code: 'rest_post_invalid_page_number', message: 'x' } }, null],
    ];
    for (const [answer, expected] of cases) expect(await list(site({ [CATEGORIES]: [answer] }).fetchImpl)).toEqual(expected);
    // A failure on the tags keeps none of the categories.
    expect(await list(site({ [CATEGORIES]: [{ body: terms(1, 2, 'C') }], [TAGS]: [{ status: 503, body: {} }] }).fetchImpl)).toBeNull();
  });

  it('asks nothing for a secret it cannot read, another kind of list or another site', async () => {
    const { fetchImpl, calls } = site({});
    expect(await list(fetchImpl, { secret: '{}' })).toEqual({ refused: 'token_expired' });
    expect(await list(fetchImpl, { kind: 'youtube_playlist' })).toEqual({ refused: 'not_found' });
    expect(await list(fetchImpl, { externalAccountId: 'other.example.com' })).toEqual({ refused: 'not_found' });
    expect(calls).toEqual([]);
  });
});

describe('WordPress names picked from the list publish as typed ones (#1131)', () => {
  it('matches a listed category and tag by name when publishing, with the post body as before', async () => {
    const { fetchImpl, calls } = site({
      'GET tiemcuaban.vn/wp-json/wp/v2/categories': [{ body: [{ id: 9, name: 'Khuyến mãi &amp; Quà' }] }, { body: [{ id: 9, name: 'Khuyến mãi &amp; Quà' }] }],
      'GET tiemcuaban.vn/wp-json/wp/v2/tags': [{ body: [{ id: 21, name: 'bánh mì' }] }, { body: [{ id: 21, name: 'bánh mì' }] }],
      [POSTS]: [{ status: 201, body: { id: 150, link: `${SITE}/khuyen-mai/`, status: 'publish' } }],
    });
    const publisher = new WordPressPublisher(fetchImpl);
    const listed = await publisher.options({ externalAccountId: ACCOUNT, secret: SECRET, kind: 'wordpress_term' });
    const names = (taxonomy: string) => (listed && 'options' in listed ? listed.options.filter((o) => o.taxonomy === taxonomy).map((o) => o.name) : []);
    expect([names('category'), names('tag')]).toEqual([['Khuyến mãi & Quà'], ['bánh mì']]);
    const result = await publisher.publish(input({ content: { body: 'Món mới', title: 'Khuyến mãi', linkUrl: null, media: [] }, settings: { wordpress: { categories: names('category'), tags: names('tag') } } }));
    expect(result).toEqual({ kind: 'accepted', externalId: '150', url: `${SITE}/khuyen-mai/` });
    expect(new URL(calls[2]?.url as string).searchParams.get('search')).toBe('Khuyến mãi &amp; Quà');
    expect(calls.at(-1)?.json).toEqual({ status: 'publish', title: 'Khuyến mãi', content: '<p>Món mới</p>', categories: [9], tags: [21] });
  });
});

describe('WordPress remove (#1138)', () => {
  const DELETE = 'DELETE tiemcuaban.vn/wp-json/wp/v2/posts/42';
  const remove = (fetchImpl: Fetch, externalId = '42', secret = SECRET) => new WordPressPublisher(fetchImpl).remove({ externalAccountId: ACCOUNT, secret, externalId });

  it('moves the post to the site trash, never past it, through the fetch it was given', async () => {
    const { fetchImpl, calls } = site({ [DELETE]: [{ body: { id: 42, status: 'trash', link: 'https://tiemcuaban.vn/?p=42' } }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
    expect(calls.map((c) => [c.route, c.auth, c.redirect])).toEqual([[DELETE, BASIC, 'manual']]);
    // No force: WordPress keeps the post in its trash, where the site owner can restore it.
    expect(new URL(calls[0]?.url ?? '').search).toBe('');
  });

  it('counts a post already in the trash or no longer on the site as removed', async () => {
    const trashed = site({ [DELETE]: [{ status: 410, body: { code: 'rest_already_trashed', message: 'The post has already been deleted.', data: { status: 410 } } }] });
    expect(await remove(trashed.fetchImpl)).toEqual({ kind: 'removed' });
    const gone = site({ [DELETE]: [{ status: 404, body: { code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } } }] });
    expect(await remove(gone.fetchImpl)).toEqual({ kind: 'removed' });
    // A 404 that is not WordPress saying the post is gone (no REST route at this address) deleted nothing.
    const noRoute = site({ [DELETE]: [{ status: 404, body: { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } } }] });
    expect(await remove(noRoute.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_404' });
    // A 410 from the host rather than WordPress (a site taken down) says nothing about the post.
    const hostGone = site({ [DELETE]: [{ status: 410, body: '<html>Gone</html>' }] });
    expect(await remove(hostGone.fetchImpl)).not.toEqual({ kind: 'removed' });
  });

  it('leaves an answer that did not trash the post unclear', async () => {
    const kept = site({ [DELETE]: [{ body: { id: 42, status: 'publish' } }] });
    expect(await remove(kept.fetchImpl)).toEqual({ kind: 'unknown', code: 'NOT_TRASHED' });
  });

  it('maps the refusals to codes, an outage to unclear, and calls nothing for a malformed id', async () => {
    const noTrash = site({ [DELETE]: [{ status: 501, body: { code: 'rest_trash_not_supported', message: "The post does not support trashing. Set 'force=true' to delete.", data: { status: 501 } } }] });
    expect(await remove(noTrash.fetchImpl)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_TRASH_DISABLED' });
    const notHers = site({ [DELETE]: [{ status: 403, body: { code: 'rest_cannot_delete', message: 'Sorry, you are not allowed to delete this post.', data: { status: 403 } } }] });
    expect(await remove(notHers.fetchImpl)).toEqual({ kind: 'rejected', error: 'permission', code: 'WORDPRESS_CANNOT_DELETE' });
    const revoked = site({ [DELETE]: [{ status: 401, body: { code: 'incorrect_password', message: 'The provided password is an invalid application password.', data: { status: 401 } } }] });
    const refused = await remove(revoked.fetchImpl);
    expect(refused).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'WORDPRESS_401' });
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
    const limited = site({ [DELETE]: [{ status: 429, body: { code: 'too_many_requests', message: 'Too many requests' } }] });
    expect(await remove(limited.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    const down = site({ [DELETE]: [{ status: 503, body: '<html>Service Unavailable</html>' }] });
    expect(await remove(down.fetchImpl)).toEqual({ kind: 'unknown', code: 'WORDPRESS_503' });
    const moved = site({ [DELETE]: [{ status: 301, body: '' }] });
    expect(await remove(moved.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'SITE_REDIRECTS' });
    const none = site({});
    expect(await remove(none.fetchImpl, '42?force=true')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await remove(none.fetchImpl, '0')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await new WordPressPublisher(none.fetchImpl).remove({ externalAccountId: 'other.vn', secret: SECRET, externalId: '42' })).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' });
    expect(await remove(none.fetchImpl, '42', '{}')).toEqual({ kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' });
    expect(none.calls).toHaveLength(0);
  });
});
