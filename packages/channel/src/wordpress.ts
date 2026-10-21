// WordPress sites (#833), written from the WordPress REST API handbook (developer.wordpress.org/rest-api). A
// self-hosted site or a WordPress.com Business site, no app of the deployment's own: the site's user makes an
// application password in their profile (WordPress 5.6 and later) and gives Crove the site address, the user name and
// that password. It is sealed like any credential; the site's host and path are the account id.
//
// The site is the tenant's to name, so every call goes through the fetch the kernel hands in: the egress guard
// (public addresses only, the connection pinned to the checked address, no redirects). This module never calls fetch
// itself, and only over https; a redirect is a failure, since Basic auth must not follow it anywhere.
//
// Publish: the variant's category and tag names (#981, settings.wordpress) are first turned into term ids
// (GET /wp/v2/categories and /wp/v2/tags with search, an exact match on the name), a missing tag created
// (POST /wp/v2/tags); then each image is uploaded to the media library (POST /wp/v2/media, the raw bytes), its alt text
// set (POST /wp/v2/media/:id), then the post is made (POST /wp/v2/posts) with the text as HTML paragraphs, the images as
// figures after it, the first one as the featured image, the terms, the excerpt and the status (published, a draft or
// pending review). Every character of the text is escaped. Nothing before the post call is visible on the site. The post
// call takes no idempotency key, so an unclear answer is checked by listing the user's latest posts, drafts included,
// matched by title and time.
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

// A post's categories, tags, excerpt and status (#981), in `settings.wordpress`; the composer checks the same shapes
// (modules/social validate.ts). Categories and tags are names as the site shows them; a category must exist on the
// site, a missing tag is created when the user may create one. Absent, the post goes out as it always did: published,
// in the site's default category, with no tags and WordPress's own excerpt.
export const WORDPRESS_STATUSES = ['publish', 'draft', 'pending'] as const;
export type WordPressStatus = (typeof WORDPRESS_STATUSES)[number];
export const WORDPRESS_CATEGORIES_MAX = 10;
export const WORDPRESS_TAGS_MAX = 20;
export const WORDPRESS_EXCERPT_MAX = 500;
// WordPress keeps a term's name in a 200-character column.
export const WORDPRESS_TERM_MAX = 200;
// Terms one lookup reads (the REST API caps per_page at 100).
const TERM_PAGE = 100;

export interface WordPressOptions {
  categories: string[];
  tags: string[];
  excerpt: string;
  status: WordPressStatus;
}

// A term's name as compared: entities read back (WordPress stores & as &amp;), spaces collapsed, case ignored.
const termKey = (name: string) => decodeEntities(name).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

// The names of a list, trimmed, each once (case ignored); null when the list is not one of names WordPress would keep.
function termNames(value: unknown, max: number): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!name || [...name].length > WORDPRESS_TERM_MAX || /[<>]/.test(name)) return null;
    if (!out.some((n) => termKey(n) === termKey(name))) out.push(name);
  }
  return out;
}

// The variant's WordPress options; null when settings.wordpress is set but not in the shape the composer saves.
export function wordpressOptionsOf(settings: Readonly<Record<string, unknown>> | undefined): WordPressOptions | null {
  const raw = settings?.wordpress;
  if (raw === undefined || raw === null) return { categories: [], tags: [], excerpt: '', status: 'publish' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  const categories = termNames(w.categories, WORDPRESS_CATEGORIES_MAX);
  const tags = termNames(w.tags, WORDPRESS_TAGS_MAX);
  const excerpt = w.excerpt === undefined || w.excerpt === null ? '' : w.excerpt;
  const status = w.status === undefined || w.status === null ? 'publish' : w.status;
  if (!categories || !tags || typeof excerpt !== 'string' || [...excerpt.trim()].length > WORDPRESS_EXCERPT_MAX) return null;
  if (!(WORDPRESS_STATUSES as readonly unknown[]).includes(status)) return null;
  return { categories, tags, excerpt: excerpt.trim(), status: status as WordPressStatus };
}

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
  // The error's term_id, where WordPress names the term that already exists (term_exists).
  readonly termId: number | null;
  constructor(status: number, message: string, options: { code?: string; unreadable?: boolean; termId?: number | null } = {}) {
    super(message.slice(0, 500));
    this.name = 'WordPressError';
    this.status = status;
    this.code = options.code;
    this.unreadable = options.unreadable ?? false;
    this.termId = options.termId ?? null;
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
    const json = (await response.json().catch(() => null)) as (T & { code?: unknown; message?: unknown; data?: { term_id?: unknown } }) | null;
    if (response.status >= 400) {
      const code = typeof json?.code === 'string' ? json.code : undefined;
      const termId = postId(json?.data?.term_id);
      throw new WordPressError(response.status, typeof json?.message === 'string' ? json.message : `WordPress answered ${response.status}`, { ...(code ? { code } : {}), termId });
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

// An uploaded image's address for the post: https anywhere (a CDN may serve it), or plain http on the site's own host
// served over https (a site behind a proxy that ends TLS often names its media http); null for anything else.
function mediaUrl(site: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.toString();
    if (url.protocol === 'http:' && url.hostname === new URL(site).hostname && !url.port) {
      url.protocol = 'https:';
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

const postId = (id: unknown) =>(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null);

interface PostRow {
  id?: unknown;
  link?: unknown;
  date_gmt?: unknown;
  status?: unknown;
  title?: { raw?: unknown };
}

// A post the site keeps unpublished: a draft, or one pending an editor's review.
const unpublished = (status: unknown): 'draft' | 'pending' | null => (status === 'draft' || status === 'pending' ? status : null);

// A refusal before the post call: nothing is visible on the site yet, so an unclear answer is a retry, not an unknown.
function beforePost(error: unknown, fallback: string): PublishResult {
  const result = wordpressResult(error);
  return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', code: (result.kind === 'unknown' && result.code) || fallback };
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
    const options = wordpressOptionsOf(input.settings);
    if (!options) return { kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_SETTINGS_INVALID' };
    // Every image is read before the first upload, so a read failure sends nothing.
    const files: Uint8Array[] = [];
    for (const m of media) {
      let bytes: Uint8Array;
      try {
        bytes = await input.readMedia(m.fileId);
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
      // The size read, not the size stored.
      if (bytes.byteLength > IMAGE_MAX_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_TOO_LARGE' };
      files.push(bytes);
    }
    // The terms before the uploads, so an unknown category uploads nothing either. The lookups only read, and a tag
    // created for a post that then fails is just an unused tag, found by the retry's lookup: safe to repeat.
    const terms = await this.terms(s, options);
    if ('refused' in terms) return terms.refused;
    // Uploads make nothing visible: a failure here publishes nothing. Images already uploaded stay in the site's media
    // library (WordPress keeps unattached media), and a retry uploads them again.
    const images: { id: number; url: string; alt: string }[] = [];
    for (const [i, m] of media.entries()) {
      try {
        const uploaded = await this.client.call<{ id?: unknown; source_url?: unknown }>(s, 'POST', '/wp/v2/media', { bytes: files[i] as Uint8Array, type: m.mime, filename: `image-${i + 1}.${EXTENSIONS[m.mime] ?? 'jpg'}` });
        const id = postId(uploaded.id);
        if (id === null) return { kind: 'rejected', error: 'transient', code: 'NO_MEDIA_ID' };
        const url = mediaUrl(s.site, uploaded.source_url);
        // A site that names its media over plain http on another host: a retry would only upload them again.
        if (!url) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_NOT_HTTPS' };
        const alt = m.altText ? [...m.altText.trim()].slice(0, ALT_TEXT_MAX).join('') : '';
        if (alt) await this.client.call(s, 'POST', `/wp/v2/media/${id}`, { json: { alt_text: alt } });
        images.push({ id, url, alt });
      } catch (error) {
        return beforePost(error, 'MEDIA_UPLOAD');
      }
    }
    // Past the budget, a post could land after the job gave up on the call: retry instead, nothing is visible yet.
    if (Date.now() - started > this.callTimeoutMs - POST_CALL_MARGIN_MS) return { kind: 'rejected', error: 'transient', code: 'UPLOAD_BUDGET_SPENT' };
    const first = images[0];
    // Only what the variant sets: without options the post is the one Crove always sent.
    const post = {
      status: options.status,
      title: escapeTitle(title),
      content: wordpressHtml(input.content, images),
      ...(first ? { featured_media: first.id } : {}),
      ...(terms.categories.length > 0 ? { categories: terms.categories } : {}),
      ...(terms.tags.length > 0 ? { tags: terms.tags } : {}),
      ...(options.excerpt ? { excerpt: escapeTitle(options.excerpt) } : {}),
    };
    try {
      const answer = await this.client.call<{ id?: unknown; link?: unknown; status?: unknown }>(s, 'POST', '/wp/v2/posts', { json: post });
      const id = postId(answer.id);
      if (id === null) return { kind: 'unknown', code: 'NO_POST_ID' };
      // A draft or a post pending review is on the site but not public: published for Crove, with no address and a
      // note (as TikTok's inbox draft, #903). The site's own answer decides, since a review plugin may hold a post back.
      const held = unpublished(typeof answer.status === 'string' ? answer.status : options.status);
      if (held) return { kind: 'accepted', externalId: String(id), url: null, draft: held };
      return { kind: 'accepted', externalId: String(id), url: linkOn(s.site, answer.link) };
    } catch (error) {
      return wordpressResult(error);
    }
  }

  // The ids of the variant's categories and tags. A category must exist: an unknown one (or a name two categories share,
  // under different parents) fails the post with nothing sent, since a post filed in the wrong category is visible and
  // Crove never makes categories (WordPress lets only editors and administrators do that). A missing tag is created;
  // when the site refuses (rest_cannot_create: the user lacks assign_post_tags), the post fails with nothing sent rather
  // than going out without a tag the person chose.
  private async terms(s: WordPressSecret, options: WordPressOptions): Promise<{ categories: number[]; tags: number[] } | { refused: PublishResult }> {
    const categories: number[] = [];
    const tags: number[] = [];
    const missingTags: string[] = [];
    try {
      for (const name of options.categories) {
        const ids = await this.findTerms(s, 'categories', name);
        if (ids.length === 0) return { refused: { kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_CATEGORY_NOT_FOUND', message: name } };
        if (ids.length > 1) return { refused: { kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_CATEGORY_AMBIGUOUS', message: name } };
        categories.push(ids[0] as number);
      }
      for (const name of options.tags) {
        const ids = await this.findTerms(s, 'tags', name);
        if (ids[0] !== undefined) tags.push(ids[0]);
        else missingTags.push(name);
      }
    } catch (error) {
      return { refused: beforePost(error, 'TERM_LOOKUP') };
    }
    for (const name of missingTags) {
      try {
        const made = await this.client.call<{ id?: unknown }>(s, 'POST', '/wp/v2/tags', { json: { name: escapeTitle(name) } });
        const id = postId(made.id);
        if (id === null) return { refused: { kind: 'rejected', error: 'transient', code: 'NO_TAG_ID' } };
        tags.push(id);
      } catch (error) {
        // Made meanwhile (another post, a person): WordPress names the tag that exists.
        if (error instanceof WordPressError && error.code === 'term_exists' && error.termId !== null) {
          tags.push(error.termId);
          continue;
        }
        if (error instanceof WordPressError && (error.status === 401 || error.status === 403) && error.code === 'rest_cannot_create') {
          return { refused: { kind: 'rejected', error: 'bad_request', code: 'WORDPRESS_TAG_NOT_ALLOWED', message: name, httpStatus: error.status } };
        }
        return { refused: beforePost(error, 'TAG_CREATE') };
      }
    }
    return { categories, tags: [...new Set(tags)] };
  }

  // The ids of a taxonomy's terms named exactly `name`. WordPress searches names and slugs for the text, so the matches
  // are kept only when the whole name is the same, case and entities aside. The search is the name as WordPress stores
  // it (& as &amp;). A site with more than 100 terms holding the text may leave the exact one off the page: it then
  // counts as missing, which fails a category with nothing posted, and for a tag ends in term_exists, which names it.
  private async findTerms(s: WordPressSecret, taxonomy: 'categories' | 'tags', name: string): Promise<number[]> {
    const rows = await this.client.call<{ id?: unknown; name?: unknown }[]>(s, 'GET', `/wp/v2/${taxonomy}?search=${encodeURIComponent(escapeTitle(name))}&per_page=${TERM_PAGE}&_fields=id,name`);
    if (!Array.isArray(rows)) throw new WordPressError(200, 'WordPress answered without a term list', { unreadable: true });
    const key = termKey(name);
    const ids = rows.filter((r) => typeof r.name === 'string' && termKey(r.name) === key).map((r) => postId(r.id));
    return [...new Set(ids.filter((id): id is number => id !== null))];
  }

  // The user's latest posts since a day before the window (WordPress compares `after` with the site's local time),
  // matched by title and by their UTC time within the window, with 10 minutes either way for the site's clock. Missing
  // only when the user has no post at all in that time: a post there with another title (a plugin may rewrite titles)
  // leaves it unclear, for a person, rather than posting twice.
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
      // Drafts too (#981): a variant saved as a draft or sent for review is found as such. WordPress shows the user's own
      // drafts in the edit context, with a date_gmt worked out from the draft's local date.
      const rows = await this.client.call<PostRow[]>(s, 'GET', `/wp/v2/posts?context=edit&status=publish,future,draft,pending&per_page=${RECONCILE_PAGE}&after=${encodeURIComponent(after)}&author=${author}&_fields=id,link,date_gmt,status,title`);
      if (!Array.isArray(rows)) return { found: 'unknown' };
      const from = input.after.getTime() - 10 * 60_000;
      const to = input.before.getTime() + 10 * 60_000;
      const inWindow = rows.filter((p) => {
        const at = typeof p.date_gmt === 'string' ? Date.parse(p.date_gmt.endsWith('Z') ? p.date_gmt : `${p.date_gmt}Z`) : Number.NaN;
        return postId(p.id) !== null && at >= from && at <= to;
      });
      const match = inWindow.find((p) => typeof p.title?.raw === 'string' && decodeEntities(p.title.raw).trim() === title);
      if (match) {
        const held = unpublished(match.status);
        return held ? { found: true, externalId: String(match.id), url: null, draft: held } : { found: true, externalId: String(match.id), url: linkOn(s.site, match.link) };
      }
      // Not among the latest: missing only when the page held every post since then and none falls in the window.
      return rows.length < RECONCILE_PAGE && inWindow.length === 0 ? { found: false } : { found: 'unknown' };
    } catch {
      return { found: 'unknown' };
    }
  }
}
