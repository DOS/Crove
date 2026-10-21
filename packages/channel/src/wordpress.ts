// WordPress sites (#833), written from the WordPress REST API handbook (developer.wordpress.org/rest-api). A
// self-hosted site or a WordPress.com Business site, no app of the deployment's own: the site's user makes an
// application password in their profile (WordPress 5.6 and later) and gives Crove the site address, the user name and
// that password. It is sealed like any credential; the site's host and path are the account id.
//
// The site is the tenant's to name, so every call goes through the fetch the kernel hands in: the egress guard
// (public addresses only, the connection pinned to the checked address, no redirects). This module never calls fetch
// itself, and only over https; a redirect is a failure, since Basic auth must not follow it anywhere.
//
// Publish: each image is uploaded to the media library (POST /wp/v2/media, the raw bytes), its alt text set
// (POST /wp/v2/media/:id), then the post is published (POST /wp/v2/posts) with the text as HTML paragraphs, the images
// as figures after it and the first one as the featured image. Every character of the text is escaped. The post call
// takes no idempotency key, so an unclear answer is checked by listing the user's latest posts, matched by title and
// time.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RetrySafety } from './index.ts';
import { holdsLink } from './text.ts';
import { ConnectorError, type Fetch } from './oauth.ts';

const APP_PASSWORD = /^[A-Za-z0-9]{24}$/;
// A login name as Basic auth can carry it: no colon, no control character.
const USERNAME = /^[^:\p{Cc}]{1,60}$/u;
// The path WordPress may live under (/blog): plain segments only, so nothing like .. reaches a URL.
const SITE_PATH = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,99}){0,5}$/;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGES_MAX = 10;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const TITLE_MAX = 200;
// A title made from the text's first line.
const FIRST_LINE_MAX = 100;
const ALT_TEXT_MAX = 1000;
// Posts one reconcile reads (WordPress pages up to 100).
const RECONCILE_PAGE = 20;
// The post call and some slack fit between the upload budget and callTimeoutMs.
const POST_CALL_MARGIN_MS = 150_000;

export interface WordPressSecret {
  // https://host, with the path WordPress lives under when it has one; no trailing slash.
  site: string;
  username: string;
  appPassword: string;
}

// The site as Crove keeps it: https on the default port, a host name and an optional path, nothing else.
export function wordpressSite(raw: string): string | null {
  // Trailing slashes cut by hand: a regular expression for them is slow on a long run of slashes.
  let trimmed = raw.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  // The URL parser resolves dot segments, encoded or not; they are refused before it sees them.
  if (trimmed.includes('..') || trimmed.includes('%')) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || trimmed.includes('?') || trimmed.includes('#')) return null;
  const host = url.hostname.toLowerCase();
  // A name with a dot, not an address: a site is reached by its domain, as a Mastodon instance is.
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  const path = url.pathname === '/' ? '' : url.pathname;
  if (!SITE_PATH.test(path)) return null;
  return `https://${host}${path}`;
}

// The account id of a site: its host and path, lower-cased.
const siteId = (site: string) => site.slice('https://'.length).toLowerCase();

export function wordpressSecretOf(secret: string): WordPressSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<WordPressSecret>;
    const site = typeof s.site === 'string' ? wordpressSite(s.site) : null;
    if (!site || site !== s.site || typeof s.username !== 'string' || !USERNAME.test(s.username) || typeof s.appPassword !== 'string' || !APP_PASSWORD.test(s.appPassword)) return null;
    return { site, username: s.username, appPassword: s.appPassword };
  } catch {
    return null;
  }
}

export class WordPressError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  // A 2xx answer that is not JSON: no REST API answered at this address.
  readonly unreadable: boolean;
  constructor(status: number, message: string, options: { code?: string; unreadable?: boolean } = {}) {
    super(message.slice(0, 500));
    this.name = 'WordPressError';
    this.status = status;
    this.code = options.code;
    this.unreadable = options.unreadable ?? false;
  }
}

type Body = { json: unknown } | { bytes: Uint8Array; type: string; filename: string };

class WordPressClient {
  private readonly fetch: Fetch;
  constructor(fetchImpl: Fetch) {
    this.fetch = fetchImpl;
  }

  // A call to the site's REST API (path after /wp-json). The password goes in Basic auth and nowhere else.
  async call<T>(s: WordPressSecret, method: 'GET' | 'POST', path: string, body?: Body, auth = true): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth) headers.authorization = `Basic ${Buffer.from(`${s.username}:${s.appPassword}`, 'utf8').toString('base64')}`;
    let payload: string | Uint8Array<ArrayBuffer> | undefined;
    if (body && 'json' in body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body) {
      headers['content-type'] = body.type;
      headers['content-disposition'] = `attachment; filename="${body.filename}"`;
      payload = body.bytes as Uint8Array<ArrayBuffer>;
    }
    const response = await this.fetch(`${s.site}/wp-json${path}`, { method, headers, redirect: 'manual', ...(payload !== undefined ? { body: payload } : {}) });
    if (response.status >= 300 && response.status < 400) throw new WordPressError(response.status, 'the site redirects; use its final https address');
    const json = (await response.json().catch(() => null)) as (T & { code?: unknown; message?: unknown }) | null;
    if (response.status >= 400) {
      const code = typeof json?.code === 'string' ? json.code : undefined;
      throw new WordPressError(response.status, typeof json?.message === 'string' ? json.message : `WordPress answered ${response.status}`, code ? { code } : {});
    }
    if (json === null || typeof json !== 'object') throw new WordPressError(response.status, 'WordPress answered without a readable body', { unreadable: true });
    return json;
  }
}

// The connect form's fields, checked before any call. WordPress shows an application password as six groups of four
// letters and digits; it is taken with or without the spaces.
export function wordpressLogin(input: { site: string; username: string; appPassword: string }): WordPressSecret {
  const site = wordpressSite(input.site);
  if (!site) throw new ConnectorError('denied', 'not a WordPress site address', 'WORDPRESS_SITE_INVALID');
  const username = input.username.trim();
  const appPassword = input.appPassword.replace(/\s+/g, '');
  if (!USERNAME.test(username) || !APP_PASSWORD.test(appPassword)) throw new ConnectorError('denied', 'not a user name and application password', 'WORDPRESS_LOGIN_INVALID');
  return { site, username, appPassword };
}

// The few entities WordPress writes in a site's name or a title (&amp;, &#8217;), read back as characters.
function decodeEntities(s: string): string {
  const named: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,5});/gi, (whole, ref: string) => {
    if (ref[0] !== '#') return named[ref.toLowerCase()] ?? whole;
    const cp = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  });
}

export async function connectWordPress(login: WordPressSecret, fetchImpl: Fetch): Promise<ConnectedAccount> {
  const client = new WordPressClient(fetchImpl);
  let me: { id?: unknown; capabilities?: Record<string, unknown> };
  try {
    me = await client.call<typeof me>(login, 'GET', '/wp/v2/users/me?context=edit');
  } catch (error) {
    if (error instanceof WordPressError && (error.status === 401 || error.status === 403)) throw new ConnectorError('denied', 'the site refused the login', 'WORDPRESS_LOGIN_REFUSED');
    if (error instanceof WordPressError && (error.status === 404 || error.unreadable)) throw new ConnectorError('denied', 'no REST API at this address', 'WORDPRESS_NO_REST_API');
    if (error instanceof WordPressError && error.status >= 300 && error.status < 400) throw new ConnectorError('denied', 'the site redirects', 'WORDPRESS_SITE_REDIRECTS');
    throw new ConnectorError('provider', 'the site did not answer');
  }
  if (typeof me.id !== 'number' || !Number.isSafeInteger(me.id) || me.id <= 0) throw new ConnectorError('denied', 'no REST API at this address', 'WORDPRESS_NO_REST_API');
  if (me.capabilities?.publish_posts !== true) throw new ConnectorError('denied', 'this user may not publish posts', 'WORDPRESS_CANNOT_PUBLISH');
  const host = new URL(login.site).hostname;
  // The site's name, from its public index; the host when it has none.
  const index = await client.call<{ name?: unknown }>(login, 'GET', '', undefined, false).catch(() => null);
  const name = typeof index?.name === 'string' ? decodeEntities(index.name).trim() : '';
  return { provider: 'wordpress', externalAccountId: siteId(login.site), displayName: (name || host).slice(0, 200), scopes: ['application_password'], expiresAt: null, secret: JSON.stringify(login) };
}

function wordpressResult(error: unknown): PublishResult {
  if (!(error instanceof WordPressError)) return { kind: 'unknown', code: 'NETWORK' };
  const base = { code: `WORDPRESS_${error.status}`, message: error.message, httpStatus: error.status };
  // A redirect is answered before WordPress sees the call: nothing was made, and the address needs fixing.
  if (error.status >= 300 && error.status < 400) return { kind: 'rejected', error: 'bad_request', ...base, code: 'SITE_REDIRECTS' };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', ...base };
  // A revoked application password, or a user who lost the right to publish: reconnect.
  if (error.status === 401 || error.status === 403) return { kind: 'rejected', error: 'token_expired', ...base };
  if (error.status === 413) return { kind: 'rejected', error: 'bad_request', ...base, code: 'MEDIA_TOO_LARGE' };
  if (error.status >= 400 && error.status < 500) return { kind: 'rejected', error: 'bad_request', ...base };
  // A server error, or an answer that cannot be read: the post may have been made.
  return { kind: 'unknown', code: base.code, message: error.message };
}

// The post's title: its own, or the first line of its text cut to 100 characters.
function titleOf(content: { title: string | null; body: string }): string {
  const own = content.title?.trim();
  if (own) return [...own].slice(0, TITLE_MAX).join('');
  const line = content.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return [...line].slice(0, FIRST_LINE_MAX).join('');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// A title is HTML in WordPress; only what would make markup is escaped, as WordPress stores an & itself.
const escapeTitle = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const anchor = (url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
const LINK = /https?:\/\/[^\s<>"']+/gi;

// A line with its bare links made into anchors; everything else escaped. Sentence punctuation after a link stays text.
function linkify(line: string): string {
  let out = '';
  let at = 0;
  for (const m of line.matchAll(LINK)) {
    const url = m[0].replace(/[.,!?;:)\]]+$/, '');
    out += escapeHtml(line.slice(at, m.index)) + anchor(url);
    at = m.index + url.length;
  }
  return out + escapeHtml(line.slice(at));
}

// The post's HTML: a paragraph per block of text (blank lines between), single line breaks as <br>, the post's link as
// its own paragraph when the text does not hold it, then each image as a figure.
export function wordpressHtml(content: { body: string; linkUrl: string | null }, images: readonly { url: string; alt: string }[]): string {
  const body = content.body.replace(/\r\n?/g, '\n').trim();
  const paragraphs = body
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split('\n').map(linkify).join('<br>')}</p>`);
  const link = content.linkUrl?.trim();
  if (link && !holdsLink(body, link)) paragraphs.push(`<p>${/^https?:\/\//i.test(link) ? anchor(link) : escapeHtml(link)}</p>`);
  for (const image of images) paragraphs.push(`<figure><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}"></figure>`);
  return paragraphs.join('\n');
}

// A post's link, kept only when it is an https page of the site's own host.
function linkOn(site: string, link: unknown): string | null {
  if (typeof link !== 'string') return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname === new URL(site).hostname ? link : null;
  } catch {
    return null;
  }
}

const postId = (id: unknown) => (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null);

interface PostRow {
  id?: unknown;
  link?: unknown;
  date_gmt?: unknown;
  title?: { raw?: unknown };
}

export class WordPressPublisher implements Publisher {
  readonly provider = 'wordpress' as const;
  // The post call takes no idempotency key; the user's latest posts are listed to find an unclear one.
  readonly publishSafety: RetrySafety = 'reconcile_only';
  // Up to 10 images of 10 MB go up one by one, to hosts that may be slow; within the job's stale limit (600 s).
  readonly callTimeoutMs = 420_000;
  private readonly client: WordPressClient;

  // The fetch is the kernel's egress guard; there is no default, so this adapter never calls a site unguarded.
  constructor(fetchImpl: Fetch) {
    this.client = new WordPressClient(fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const started = Date.now();
    const s = wordpressSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' };
    if (input.externalAccountId !== siteId(s.site)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    const media = input.content.media;
    if (media.length > IMAGES_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_IMAGES' };
    if (media.some((m) => !IMAGE_TYPES.includes(m.mime))) return { kind: 'rejected', error: 'bad_request', code: 'IMAGE_TYPE' };
    if (media.some((m) => m.sizeBytes > IMAGE_MAX_BYTES)) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_TOO_LARGE' };
    const title = titleOf(input.content);
    if (!title) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    // Every image is read before the first upload, so a read failure sends nothing.
    const files: Uint8Array[] = [];
    for (const m of media) {
      try {
        files.push(await input.readMedia(m.fileId));
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
    }
    // Uploads make nothing visible: a failure here publishes nothing. Images already uploaded stay in the site's media
    // library (WordPress keeps unattached media), and a retry uploads them again.
    const images: { id: number; url: string; alt: string }[] = [];
    for (const [i, m] of media.entries()) {
      try {
        const uploaded = await this.client.call<{ id?: unknown; source_url?: unknown }>(s, 'POST', '/wp/v2/media', { bytes: files[i] as Uint8Array, type: m.mime, filename: `image-${i + 1}.${EXTENSIONS[m.mime] ?? 'jpg'}` });
        const id = postId(uploaded.id);
        const url = uploaded.source_url;
        if (id === null || typeof url !== 'string' || !url.startsWith('https://')) return { kind: 'rejected', error: 'transient', code: 'NO_MEDIA_ID' };
        const alt = m.altText ? [...m.altText.trim()].slice(0, ALT_TEXT_MAX).join('') : '';
        if (alt) await this.client.call(s, 'POST', `/wp/v2/media/${id}`, { json: { alt_text: alt } });
        images.push({ id, url, alt });
      } catch (error) {
        const result = wordpressResult(error);
        return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', code: (result.kind === 'unknown' && result.code) || 'MEDIA_UPLOAD' };
      }
    }
    // Past the budget, a post could land after the job gave up on the call: retry instead, nothing is visible yet.
    if (Date.now() - started > this.callTimeoutMs - POST_CALL_MARGIN_MS) return { kind: 'rejected', error: 'transient', code: 'UPLOAD_BUDGET_SPENT' };
    const first = images[0];
    const post = { status: 'publish', title: escapeTitle(title), content: wordpressHtml(input.content, images), ...(first ? { featured_media: first.id } : {}) };
    try {
      const answer = await this.client.call<{ id?: unknown; link?: unknown }>(s, 'POST', '/wp/v2/posts', { json: post });
      const id = postId(answer.id);
      if (id === null) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: String(id), url: linkOn(s.site, answer.link) };
    } catch (error) {
      return wordpressResult(error);
    }
  }

  // The user's latest published posts since a day before the window (WordPress compares `after` with the site's local
  // time), matched by title and by their UTC time within the window.
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = wordpressSecretOf(input.secret);
    if (!s || input.externalAccountId !== siteId(s.site)) return { found: 'unknown' };
    const title = titleOf(input.content);
    if (!title) return { found: 'unknown' };
    try {
      const me = await this.client.call<{ id?: unknown }>(s, 'GET', '/wp/v2/users/me');
      const author = postId(me.id);
      if (author === null) return { found: 'unknown' };
      const after = new Date(input.after.getTime() - 24 * 3_600_000).toISOString();
      const rows = await this.client.call<PostRow[]>(s, 'GET', `/wp/v2/posts?context=edit&status=publish&per_page=${RECONCILE_PAGE}&after=${encodeURIComponent(after)}&author=${author}`);
      if (!Array.isArray(rows)) return { found: 'unknown' };
      const from = input.after.getTime() - 60_000;
      const to = input.before.getTime() + 10 * 60_000;
      const match = rows.find((p) => {
        const at = typeof p.date_gmt === 'string' ? Date.parse(p.date_gmt.endsWith('Z') ? p.date_gmt : `${p.date_gmt}Z`) : Number.NaN;
        const raw = p.title?.raw;
        return postId(p.id) !== null && at >= from && at <= to && typeof raw === 'string' && decodeEntities(raw).trim() === title;
      });
      if (match) return { found: true, externalId: String(match.id), url: linkOn(s.site, match.link) };
      // Not among the latest: missing only when the page held every post since then; else it may be further down.
      return rows.length < RECONCILE_PAGE ? { found: false } : { found: 'unknown' };
    } catch {
      return { found: 'unknown' };
    }
  }
}
