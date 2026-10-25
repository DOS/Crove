// Meta (Facebook Pages; Instagram follows in S6.3), written from Meta's Graph API docs (Social plan §1: no code taken
// from other projects). One Meta app serves every org of a deployment: CHANNEL_META_APP_ID and
// CHANNEL_META_APP_SECRET. A self-hoster's own app works in development mode for people with a role on the app;
// others need App Review (docs/plan/social-research.md §4).
//
// Connect: Facebook Login with the Page permissions, then the short-lived user token becomes a long-lived one, and
// `/me/accounts` lists the Pages the user granted in Meta's dialog, each with its own Page token. A Page token from a
// long-lived user token has no expiry timer, so it is sealed as is; the user token is dropped.
import { createHmac } from 'node:crypto';
import type {
  CommentInput,
  CommentResult,
  ConnectedAccount,
  EditInput,
  EditResult,
  AccountMetricsInput,
  AccountMetricsResult,
  MetricsInput,
  MetricsResult,
  Publisher,
  PublishInput,
  PublishResult,
  RecentPost,
  RecentPostsInput,
  RecentPostsResult,
  ReconcileInput,
  ReconcileResult,
  RemoveInput,
  RemoveResult,
  RetrySafety,
} from './index.ts';
import { commentResult, EDIT_NOT_SUPPORTED, editResult, removeResult } from './comment.ts';
import { graphTime, pagingCursor, platformLink, RECENT_PAGES_MAX, RECENT_POSTS_MAX, recentSince } from './recent.ts';
import { coverImageType, videoCoverOf } from './cover.ts';
import { postTypeOf } from './post-type.ts';
import { holdsLink, POSSIBLE_DUPLICATE } from './text.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const META_GRAPH_HOST = 'graph.facebook.com';
// Video uploads go to Graph's video host.
export const META_VIDEO_HOST = 'graph-video.facebook.com';
// Where a Reel's or a video Story's bytes go (#644): Meta's resumable upload host, one request for the whole file.
export const META_RUPLOAD_HOST = 'rupload.facebook.com';
export const META_DEFAULT_GRAPH_VERSION = 'v24.0';
// What a Page connection needs: list the Pages, post to them, read posts back to reconcile and for metrics, and
// comment under its own posts (pages_manage_engagement, the first comment of #609).
export const FACEBOOK_PAGE_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'] as const;
// Asked for, not required: first comments (#609) need it, and a Page connects without it (its comments then fail with
// permission, shown on the post). Meta may hold it back until App Review approves it.
export const FACEBOOK_PAGE_COMMENT_SCOPES = ['pages_manage_engagement'] as const;

export interface MetaAppConfig {
  appId: string;
  appSecret: string;
  // Graph API version, for example v24.0.
  graphVersion?: string;
}

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
}

// A Graph API refusal or failure. `message` is Meta's text, which never holds the token we sent.
export class GraphError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly type: string | undefined;
  constructor(status: number, body: GraphErrorBody | undefined) {
    super(body?.message ?? `Graph API answered ${status}`);
    this.name = 'GraphError';
    this.status = status;
    this.code = body?.code;
    this.subcode = body?.error_subcode;
    this.type = body?.type;
  }
}

// A small Graph API client: the token travels in the Authorization header (never in a URL), with appsecret_proof so
// a leaked token alone cannot call the API when the app requires the proof.
export class Graph {
  readonly version: string;
  private readonly appSecret: string;
  private readonly fetch: Fetch;

  constructor(appSecret: string, version: string = META_DEFAULT_GRAPH_VERSION, fetchImpl?: Fetch) {
    if (!/^v\d{1,3}\.\d{1,2}$/.test(version)) throw new Error('invalid Graph API version');
    this.version = version;
    this.appSecret = appSecret;
    this.fetch = allowlistedFetch([META_GRAPH_HOST, META_VIDEO_HOST, META_RUPLOAD_HOST], fetchImpl);
  }

  url(path: string, params: Record<string, string> = {}, host: string = META_GRAPH_HOST): string {
    const url = new URL(`https://${host}/${this.version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  // video: the call goes to Graph's video host; timeoutMs: longer than the default for an upload.
  async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, options: { token?: string; params?: Record<string, string>; form?: Record<string, string>; multipart?: FormData; video?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const params = { ...options.params };
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
      params.appsecret_proof = createHmac('sha256', this.appSecret).update(options.token).digest('hex');
    }
    let body: string | FormData | undefined;
    if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    } else if (options.multipart) {
      // fetch sets the multipart content type with its boundary.
      body = options.multipart;
    }
    const response = await this.fetch(this.url(path, params, options.video ? META_VIDEO_HOST : META_GRAPH_HOST), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });
    const json = (await response.json().catch(() => null)) as ({ error?: GraphErrorBody } & Record<string, unknown>) | null;
    if (!response.ok || !json || json.error) throw new GraphError(response.status, json?.error);
    return json as T;
  }

  // The bytes of an Instagram video container made with upload_type=resumable (#772), to Meta's upload host, in one
  // request: how a deployment without public file URLs posts a Reel or a video Story. The address is built from the
  // container id Meta answered, never taken from the answer.
  async uploadInstagram(containerId: string, token: string, bytes: Uint8Array, timeoutMs: number): Promise<void> {
    if (!/^\d{1,32}$/.test(containerId)) throw new GraphError(400, { message: 'bad container id' });
    const response = await this.fetch(`https://${META_RUPLOAD_HOST}/ig-api-upload/${this.version}/${containerId}`, {
      method: 'POST',
      headers: { authorization: `OAuth ${token}`, offset: '0', file_size: String(bytes.byteLength), 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await response.json().catch(() => null)) as { success?: unknown; error?: GraphErrorBody } | null;
    if (!response.ok || !json || json.error || json.success !== true) throw new GraphError(response.status, json?.error);
  }

  // The bytes of a video started with upload_phase=start (#644), to Meta's upload host, in one request. The address is
  // built from the video id Meta answered, never taken from the answer.
  async upload(videoId: string, token: string, bytes: Uint8Array, timeoutMs: number): Promise<void> {
    if (!/^\d{1,32}$/.test(videoId)) throw new GraphError(400, { message: 'bad video id' });
    const response = await this.fetch(`https://${META_RUPLOAD_HOST}/video-upload/${this.version}/${videoId}`, {
      method: 'POST',
      headers: { authorization: `OAuth ${token}`, offset: '0', file_size: String(bytes.byteLength), 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await response.json().catch(() => null)) as { success?: unknown; error?: GraphErrorBody } | null;
    if (!response.ok || !json || json.error || json.success !== true) throw new GraphError(response.status, json?.error);
  }
}

interface TokenAnswer {
  access_token?: unknown;
}
interface PermissionsAnswer {
  data?: { permission?: unknown; status?: unknown }[];
}
export interface MetaPageRow {
  id?: unknown;
  name?: unknown;
  access_token?: unknown;
  tasks?: unknown;
  instagram_business_account?: { id?: unknown; username?: unknown; name?: unknown };
}
interface AccountsAnswer {
  data?: MetaPageRow[];
  paging?: { cursors?: { after?: unknown }; next?: unknown };
}

const MAX_PAGES_LISTED = 1000;

// Facebook Login for one set of permissions: the dialog URL, the code exchange to a long-lived user token, and the
// Pages that token manages. Shared by the Facebook Page and Instagram connectors; the user token never leaves here.
export class MetaLogin {
  readonly graph: Graph;
  private readonly app: MetaAppConfig;
  private readonly scopes: readonly string[];
  // Asked for in the dialog but not required: a connection goes on without them.
  private readonly optional: readonly string[];

  constructor(app: MetaAppConfig, scopes: readonly string[], fetchImpl?: Fetch, optional: readonly string[] = []) {
    if (!/^\d{1,32}$/.test(app.appId)) throw new Error('invalid Meta app id');
    if (!app.appSecret) throw new Error('missing Meta app secret');
    this.app = app;
    this.scopes = scopes;
    this.optional = optional;
    this.graph = new Graph(app.appSecret, app.graphVersion, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL(`https://www.facebook.com/${this.graph.version}/dialog/oauth`);
    url.searchParams.set('client_id', this.app.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', [...this.scopes, ...this.optional].join(','));
    // Asks again for a permission the user declined last time; without it Meta skips declined permissions for good.
    url.searchParams.set('auth_type', 'rerequest');
    return url.toString();
  }

  // The long-lived user token for a code, and the permissions it holds (all the required ones, or a denied error, and
  // whichever optional ones Meta granted).
  async userToken(input: ExchangeInput): Promise<{ token: string; scopes: string[] }> {
    const short = await this.graph
      .call<TokenAnswer>('POST', 'oauth/access_token', {
        form: { client_id: this.app.appId, client_secret: this.app.appSecret, redirect_uri: input.redirectUri, code: input.code },
      })
      .catch((error: unknown) => {
        // Code 100 is Meta's answer for a code that is used, expired or issued for another redirect; anything else (a wrong
        // app secret, a rate limit, an outage) is not the user's code.
        throw error instanceof GraphError && error.code === 100
          ? new ConnectorError('invalid_grant', 'Meta refused the authorization code', String(error.code))
          : asProviderError(error);
      });
    const long = await this.graph
      .call<TokenAnswer>('POST', 'oauth/access_token', {
        form: { grant_type: 'fb_exchange_token', client_id: this.app.appId, client_secret: this.app.appSecret, fb_exchange_token: tokenOf(short) },
      })
      .catch(asProviderErrorThrow);
    const token = tokenOf(long);
    const permissions = await this.graph.call<PermissionsAnswer>('GET', 'me/permissions', { token }).catch(asProviderErrorThrow);
    const granted = new Set((permissions.data ?? []).filter((p) => p.status === 'granted' && typeof p.permission === 'string').map((p) => p.permission as string));
    const missing = this.scopes.filter((s) => !granted.has(s));
    if (missing.length > 0) throw new ConnectorError('denied', `Meta did not grant ${missing.join(', ')}`, 'MISSING_PERMISSION');
    return { token, scopes: [...this.scopes, ...this.optional].filter((s) => granted.has(s)) };
  }

  // Every Page the user token manages, by cursor (never Meta's `next` URL, which carries the token).
  async pages(token: string, fields: string): Promise<MetaPageRow[]> {
    const out: MetaPageRow[] = [];
    let after: string | null = null;
    while (out.length < MAX_PAGES_LISTED) {
      const params: Record<string, string> = { fields, limit: '100' };
      if (after) params.after = after;
      const page = await this.graph.call<AccountsAnswer>('GET', 'me/accounts', { token, params }).catch(asProviderErrorThrow);
      const rows = page.data ?? [];
      out.push(...rows);
      const cursor = page.paging?.cursors?.after;
      if (rows.length === 0 || typeof page.paging?.next !== 'string' || typeof cursor !== 'string') break;
      after = cursor;
    }
    return out;
  }
}

const NUMERIC_ID = /^\d{1,32}$/;
// Alt text per image, as Instagram and Threads cap it.
// How much alt text this adapter sends; ALT_TEXT_LIMITS of the Social module follows it (alt-text-limits.test.ts, #1126).
export const FACEBOOK_ALT_TEXT_MAX = 1000;

export class FacebookPageConnector implements OAuthConnector {
  readonly provider = 'facebook_page' as const;
  readonly pkce = false;
  private readonly login: MetaLogin;

  constructor(app: MetaAppConfig, fetchImpl?: Fetch) {
    this.login = new MetaLogin(app, FACEBOOK_PAGE_SCOPES, fetchImpl, FACEBOOK_PAGE_COMMENT_SCOPES);
  }

  authorizeUrl(input: AuthorizeInput): string {
    return this.login.authorizeUrl(input);
  }

  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
    const { token, scopes } = await this.login.userToken(input);
    const accounts: ConnectedAccount[] = [];
    for (const row of await this.login.pages(token, 'id,name,access_token,tasks')) {
      // Posting needs the CREATE_CONTENT task on the Page; a Page the user only moderates cannot be connected.
      const tasks = Array.isArray(row.tasks) ? row.tasks : [];
      if (typeof row.id !== 'string' || !NUMERIC_ID.test(row.id) || typeof row.access_token !== 'string' || !row.access_token) continue;
      if (!tasks.includes('CREATE_CONTENT')) continue;
      const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : `Facebook Page ${row.id}`;
      accounts.push({ provider: 'facebook_page', externalAccountId: row.id, displayName: name, scopes: [...scopes], expiresAt: null, secret: JSON.stringify({ accessToken: row.access_token }) });
    }
    return accounts;
  }
}

function tokenOf(answer: TokenAnswer): string {
  if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Meta answered without an access token');
  return answer.access_token;
}

export function asProviderError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof GraphError) return new ConnectorError(error.status === 403 || error.code === 10 || error.code === 200 ? 'denied' : 'provider', error.message, String(error.code ?? error.status));
  // fetch's own message (DNS, TLS, timeout) for the log; our URLs carry no token.
  return new ConnectorError('provider', `Meta could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

function asProviderErrorThrow(error: unknown): never {
  throw asProviderError(error);
}

// ---------------------------------------------------------------------------------------------------------------------
// Publishing to a Facebook Page (S6.2, issue #371): `POST /{page-id}/feed` with the Page token. Meta has no idempotency
// key, so a call whose outcome is unclear (a 5xx, a timeout, Meta's own "unknown error") is `unknown`, and the pipeline
// reconciles by listing the Page's posts in the window and matching the message. A 4xx with a known code means nothing
// was posted.

// Graph error codes (developers.facebook.com/docs/graph-api/guides/error-handling).
const TOKEN_CODES = new Set([102, 190, 463, 467]);
const PERMISSION_CODES = new Set([3, 10]);
const RATE_CODES = new Set([4, 17, 32, 613, 80001]);
// 1 and 2: Meta's "unknown error" and "service unavailable". 506, a duplicate, is unclear too (graphPublishResult).
const UNCLEAR_CODES = new Set([1, 2]);

interface FeedAnswer {
  id?: unknown;
}
// photo_stories and video_stories (finish): success and the Story's post id.
interface StoryAnswer {
  success?: unknown;
  post_id?: unknown;
}
// The Story as a Page post id, <page>_<post>, the shape the metrics read and comments take; a bare id gets the Page's.
function storyResult(page: string, answer: StoryAnswer): PublishResult {
  if (answer.success !== true || typeof answer.post_id !== 'string' || !/^\d{1,32}(_\d{1,32})?$/.test(answer.post_id)) return { kind: 'unknown', code: 'STORY_NOT_CONFIRMED' };
  const id = answer.post_id.includes('_') ? answer.post_id : `${page}_${answer.post_id}`;
  return { kind: 'accepted', externalId: id, url: `https://www.facebook.com/${id}` };
}
interface PostsAnswer {
  data?: { id?: unknown; message?: unknown; created_time?: unknown; permalink_url?: unknown }[];
  paging?: { cursors?: { after?: unknown }; next?: unknown };
}
// Where a Page post's permalink may point.
const FACEBOOK_HOSTS = ['facebook.com'] as const;

function pageToken(secret: string): string | null {
  try {
    const token = (JSON.parse(secret) as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

// What Facebook shows as the post's text, built the same way for publishing and reconciling. Facebook Pages have no
// title; a link is sent apart and previewed, except on a post with photos, which has no link preview: there the link
// goes at the end of the text.
// A photo post has no link field, so its link goes in the text, once.
const feedMessage = (content: { body: string; linkUrl: string | null; media: readonly unknown[] }) => {
  const body = content.body.trim();
  return content.linkUrl && content.media.length > 0 && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};
const postUrl = (id: string) => `https://www.facebook.com/${encodeURIComponent(id)}`;
// A Page video's or Reel's title (#1499): the post's own, trimmed; none when it has none.
const videoTitle = (content: { title: string | null }) => content.title?.trim() ?? '';

export function graphPublishResult(error: unknown): PublishResult {
  if (!(error instanceof GraphError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code;
  const base = { code: code === undefined ? `HTTP_${error.status}` : String(code), message: error.message, httpStatus: error.status };
  // A duplicate (506) may be of Crove's own earlier attempt, so it stays unclear, with a code that says what Meta said (#1156).
  if (code === 506) return { kind: 'unknown', code: POSSIBLE_DUPLICATE, message: base.message };
  if (error.status >= 500 || (code !== undefined && UNCLEAR_CODES.has(code))) return { kind: 'unknown', code: base.code, message: base.message };
  if ((code !== undefined && TOKEN_CODES.has(code)) || error.status === 401) return { kind: 'rejected', error: 'token_expired', ...base };
  if ((code !== undefined && (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299))) || error.status === 403) return { kind: 'rejected', error: 'permission', ...base };
  if ((code !== undefined && RATE_CODES.has(code)) || error.status === 429) return { kind: 'rejected', error: 'rate_limited', ...base };
  if (error.status >= 400) return { kind: 'rejected', error: 'bad_request', ...base };
  return { kind: 'unknown', code: base.code, message: base.message };
}

// The upload of a video of up to 100 MB; the job waits a little longer (callTimeoutMs), so the adapter sees its own abort.
const VIDEO_UPLOAD_TIMEOUT_MS = 300_000;

export class FacebookPagePublisher implements Publisher {
  readonly provider = 'facebook_page' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  // A video upload takes minutes; within the job's stale limit (600 s).
  readonly callTimeoutMs = 420_000;
  private readonly graph: Graph;

  constructor(app: Pick<MetaAppConfig, 'appSecret' | 'graphVersion'>, fetchImpl?: Fetch) {
    if (!app.appSecret) throw new Error('missing Meta app secret');
    this.graph = new Graph(app.appSecret, app.graphVersion, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!/^\d{1,32}$/.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_PAGE_ID' };
    const media = input.content.media;
    // The post type (#644): a Story (one image or video, no text) or a Reel (one video), each through its own endpoint.
    const type = postTypeOf(input.settings);
    if (type === null) return { kind: 'rejected', error: 'bad_request', code: 'POST_TYPE_NOT_SUPPORTED' };
    // A cover (#642, #1499) is an image sent with a feed video as its thumbnail. Graph takes no frame, and Reels and
    // Stories take no cover through the API: refused before anything is posted.
    const cover = videoCoverOf(input.settings);
    if (cover && (!('fileId' in cover) || type !== 'feed' || !media.some((m) => m.mime.startsWith('video/')))) return { kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' };
    if (type === 'story') return this.publishStory(input, token);
    if (type === 'reel') return this.publishReel(input, token);
    if (media.some((m) => m.mime.startsWith('video/'))) return this.publishVideo(input, token);
    const form: Record<string, string> = { message: feedMessage(input.content) };
    if (input.content.linkUrl && media.length === 0) form.link = input.content.linkUrl;
    if (!form.message && !form.link && media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    if (media.length > 0) {
      const uploaded = await this.uploadPhotos(input, token);
      if ('rejected' in uploaded) return uploaded.rejected;
      form.attached_media = JSON.stringify(uploaded.ids.map((id) => ({ media_fbid: id })));
    }
    try {
      const answer = await this.graph.call<FeedAnswer>('POST', `${input.externalAccountId}/feed`, { token, form });
      // Meta answered 200 without an id: it may have posted.
      if (typeof answer.id !== 'string' || !answer.id) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: answer.id, url: postUrl(answer.id) };
    } catch (error) {
      return graphPublishResult(error);
    }
  }

  // A video post (#443): the bytes in one non-resumable upload to the Page's videos, with the post text as its
  // description. The post goes live once Meta takes the upload, so an unclear answer is unknown and reconciled from
  // the Page's posts by text, like a feed post. Meta names the video; its post on the Page is "{page id}_{video id}"
  // (an inference from how Page post ids are formed, which the metrics read relies on).
  // The post's title and a cover image (#1499) go in the same request as `title` and `thumb`, the cover read before
  // anything is sent, like the video; without them the request is what it always was. Meta documents no limit for
  // either: the Social module holds the title to 255 characters and the image to 10 MB, both Crove's caps [unverified].
  private async publishVideo(input: PublishInput, token: string): Promise<PublishResult> {
    const media = input.content.media;
    const video = media[0];
    if (!video || media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_REQUIRED' };
    const cover = videoCoverOf(input.settings);
    let bytes: Uint8Array;
    let thumb: Uint8Array | null = null;
    try {
      bytes = await input.readMedia(video.fileId);
      if (cover && 'fileId' in cover) thumb = await input.readMedia(cover.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    const title = videoTitle(input.content);
    const body = new FormData();
    if (title) body.set('title', title);
    body.set('description', feedMessage(input.content));
    body.set('published', 'true');
    if (thumb) {
      const type = coverImageType(thumb);
      body.set('thumb', new Blob([new Uint8Array(thumb)], { type }), type === 'image/png' ? 'cover.png' : 'cover.jpg');
    }
    body.set('source', new Blob([new Uint8Array(bytes)], { type: video.mime }), video.mime === 'video/quicktime' ? 'video.mov' : 'video.mp4');
    try {
      const answer = await this.graph.call<FeedAnswer>('POST', `${input.externalAccountId}/videos`, { token, multipart: body, video: true, timeoutMs: VIDEO_UPLOAD_TIMEOUT_MS });
      if (typeof answer.id !== 'string' || !/^\d{1,32}$/.test(answer.id)) return { kind: 'unknown', code: 'NO_VIDEO_ID' };
      return { kind: 'accepted', externalId: `${input.externalAccountId}_${answer.id}`, url: `https://www.facebook.com/${input.externalAccountId}/videos/${answer.id}` };
    } catch (error) {
      return graphPublishResult(error);
    }
  }

  // A Page Story (#644): an image is uploaded as an unpublished photo and then made a photo Story; a video is started
  // on video_stories, its bytes sent to the upload host, and finished, which publishes it. Nothing is visible before
  // the last call, so a failure earlier posted nothing; an unclear last answer is unknown. A Story is not a Page post
  // with a message, so reconcile has nothing to match it on.
  private async publishStory(input: PublishInput, token: string): Promise<PublishResult> {
    const media = input.content.media;
    const item = media[0];
    if (!item || media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'STORY_ONE_MEDIA' };
    const page = input.externalAccountId;
    if (!item.mime.startsWith('video/')) {
      const uploaded = await this.uploadPhotos(input, token);
      if ('rejected' in uploaded) return uploaded.rejected;
      try {
        const answer = await this.graph.call<StoryAnswer>('POST', `${page}/photo_stories`, { token, form: { photo_id: uploaded.ids[0] as string } });
        return storyResult(page, answer);
      } catch (error) {
        return graphPublishResult(error);
      }
    }
    const started = await this.startVideo(input, token, `${page}/video_stories`, item);
    if ('rejected' in started) return started.rejected;
    try {
      const answer = await this.graph.call<StoryAnswer>('POST', `${page}/video_stories`, { token, form: { upload_phase: 'finish', video_id: started.videoId } });
      return storyResult(page, answer);
    } catch (error) {
      return graphPublishResult(error);
    }
  }

  // A Page Reel (#644): started on video_reels, its bytes sent to the upload host, then finished with
  // video_state=PUBLISHED and the post text as its description, and the post's title when it has one (#1499). Meta
  // processes it after the answer; the Reel is named by its video id.
  private async publishReel(input: PublishInput, token: string): Promise<PublishResult> {
    const media = input.content.media;
    const video = media[0];
    if (!video || media.length !== 1 || !video.mime.startsWith('video/')) return { kind: 'rejected', error: 'bad_request', code: 'REEL_ONE_VIDEO' };
    const page = input.externalAccountId;
    const started = await this.startVideo(input, token, `${page}/video_reels`, video);
    if ('rejected' in started) return started.rejected;
    const title = videoTitle(input.content);
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', `${page}/video_reels`, {
        token,
        form: { upload_phase: 'finish', video_id: started.videoId, video_state: 'PUBLISHED', description: feedMessage(input.content), ...(title ? { title } : {}) },
      });
      if (answer.success !== true) return { kind: 'unknown', code: 'REEL_NOT_CONFIRMED' };
      // Named like a Page video post, <page>_<video>, which the metrics read takes (#443).
      return { kind: 'accepted', externalId: `${page}_${started.videoId}`, url: `https://www.facebook.com/reel/${started.videoId}` };
    } catch (error) {
      return graphPublishResult(error);
    }
  }

  // upload_phase=start on a Story or Reel edge, then the bytes: the video id, or why nothing was posted.
  private async startVideo(input: PublishInput, token: string, edge: string, video: { fileId: string }): Promise<{ videoId: string } | { rejected: PublishResult }> {
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { rejected: { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' } };
    }
    try {
      const started = await this.graph.call<{ video_id?: unknown }>('POST', edge, { token, form: { upload_phase: 'start' } });
      if (typeof started.video_id !== 'string' || !/^\d{1,32}$/.test(started.video_id)) return { rejected: { kind: 'rejected', error: 'transient', code: 'NO_VIDEO_ID' } };
      await this.graph.upload(started.video_id, token, bytes, VIDEO_UPLOAD_TIMEOUT_MS);
      return { videoId: started.video_id };
    } catch (error) {
      const result = graphPublishResult(error);
      // Nothing is published before the finish call, so an unclear answer here is a failure to retry.
      return { rejected: result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) } };
    }
  }

  // Uploads the post's images as unpublished photos of the Page: invisible until the feed post attaches them, so this
  // step is safe to repeat and any failure here posted nothing. One image at a time is held in memory.
  private async uploadPhotos(input: PublishInput, token: string): Promise<{ ids: string[] } | { rejected: PublishResult }> {
    const ids: string[] = [];
    for (const [i, m] of input.content.media.entries()) {
      let bytes: Uint8Array;
      try {
        bytes = await input.readMedia(m.fileId);
      } catch {
        return { rejected: { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' } };
      }
      const body = new FormData();
      body.set('published', 'false');
      body.set('source', new Blob([new Uint8Array(bytes)], { type: m.mime }), `image-${i + 1}`);
      // The image's description for screen readers (#790); Facebook writes its own when none is given.
      if (m.altText) body.set('alt_text_custom', m.altText.slice(0, FACEBOOK_ALT_TEXT_MAX));
      try {
        const answer = await this.graph.call<FeedAnswer>('POST', `${input.externalAccountId}/photos`, { token, multipart: body });
        if (typeof answer.id !== 'string' || !answer.id) return { rejected: { kind: 'rejected', error: 'transient', code: 'NO_PHOTO_ID' } };
        ids.push(answer.id);
      } catch (error) {
        const result = graphPublishResult(error);
        // Nothing is visible yet, so an unclear answer here is a failure to retry, not an unknown post.
        return { rejected: result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) } };
      }
    }
    return { ids };
  }

  // A comment by the Page under its own post (#609): `POST /{post-id}/comments` with the Page token. It needs
  // pages_manage_engagement; a Page connected before Crove asked for it is refused with a permission error (code 10 or
  // 200) and comments again once it reconnects.
  async comment(input: CommentInput): Promise<CommentResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    // A feed post is <page>_<post>; a bare object id (a video) is taken as it is.
    if (!/^\d{1,32}(_\d{1,32})?$/.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const answer = await this.graph.call<FeedAnswer>('POST', `${input.externalId}/comments`, { token, form: { message: input.text } });
      // Meta answered 200 without an id: the comment may be there.
      if (typeof answer.id !== 'string' || !answer.id) return { kind: 'unknown', code: 'NO_COMMENT_ID' };
      return { kind: 'accepted', externalId: answer.id.slice(0, 500) };
    } catch (error) {
      return commentResult(graphPublishResult(error));
    }
  }

  // Deletes the Page's own post (#1137): `DELETE /{page-post-id}` with the Page token (pages_manage_posts, which connect
  // requires), answered { success: true }. Every post Crove makes is named as a Page post, <page>_<post>: a feed post
  // with photos (the photos were uploaded unpublished and belong to the post), a Story, and a video or Reel as
  // <page>_<video> (#443). Only an id of this Page is sent, so a bare object id never deletes something else. Meta
  // answers code 100 with subcode 33 both for a post it no longer has and for one it will not delete or let the token
  // load, so that answer is checked with a read of the post: gone there too counts as removed; a post that is still
  // there is FACEBOOK_CANNOT_DELETE (a person removes it on Facebook); anything else stays unclear.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    const id = /^(\d{1,32})_\d{1,32}$/.exec(input.externalId);
    if (!id || id[1] !== input.externalAccountId) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const answer = await this.graph.call<{ success?: unknown }>('DELETE', input.externalId, { token });
      return answer.success === true ? { kind: 'removed' } : { kind: 'unknown', code: 'NOT_DELETED' };
    } catch (error) {
      if (error instanceof GraphError && error.code === 100 && error.subcode === 33) return this.removedAlready(input.externalId, token);
      return removeResult(graphPublishResult(error));
    }
  }

  // Corrects the text of the Page's own post (#1223): `POST /{page-post-id}` with `message` and the Page token
  // (pages_manage_posts, which connect requires), answered { success: true } (Graph API Page Post reference, Updating).
  // The text is built as publish builds it (feedMessage, the link at the end on a post with photos); the photos and the
  // link preview stay as they are. Only a feed post of text, a link or photos: a Story has no text, and a video's or a
  // Reel's text is its video's description, which this call does not reach, so those are refused before any call, as
  // the module refuses them first. Only an id of this Page is sent. Code 100 with subcode 33: the post is gone, or the
  // token cannot load it.
  async edit(input: EditInput): Promise<EditResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    const id = /^(\d{1,32})_\d{1,32}$/.exec(input.externalId);
    if (!id || id[1] !== input.externalAccountId) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    if (postTypeOf(input.settings) !== 'feed' || input.content.media.some((m) => m.mime.startsWith('video/'))) return { kind: 'rejected', error: 'bad_request', code: EDIT_NOT_SUPPORTED };
    const message = feedMessage(input.content);
    if (!message) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', input.externalId, { token, form: { message } });
      // 200 without success: Meta may or may not have changed it.
      return answer.success === true ? { kind: 'edited' } : { kind: 'unknown', code: 'NOT_CONFIRMED' };
    } catch (error) {
      if (error instanceof GraphError && error.code === 100 && error.subcode === 33) return { kind: 'rejected', error: 'bad_request', code: 'POST_NOT_FOUND', message: error.message };
      return editResult(graphPublishResult(error));
    }
  }

  // After a delete answered "does not exist or cannot be loaded": whether the post is really gone.
  private async removedAlready(postId: string, token: string): Promise<RemoveResult> {
    try {
      await this.graph.call<{ id?: unknown }>('GET', postId, { token, params: { fields: 'id' } });
      return { kind: 'rejected', error: 'bad_request', code: 'FACEBOOK_CANNOT_DELETE' };
    } catch (error) {
      if (error instanceof GraphError && error.code === 100 && error.subcode === 33) return { kind: 'removed' };
      return { kind: 'unknown', code: 'DELETE_UNCONFIRMED' };
    }
  }

  // Reactions, comments and shares of a Page post: plain fields of the post, which Meta's 2026 Page Insights changes do
  // not touch; impressions need Page Insights metrics that are being retired, so they are not read.
  // The Page's followers (#645): followers_count, or the older fan_count (likes) where Meta gives only that.
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const token = pageToken(input.secret);
    if (!token) return { refused: 'token_expired' };
    if (!/^\d{1,32}$/.test(input.externalAccountId)) return null;
    try {
      const answer = await this.graph.call<{ followers_count?: unknown; fan_count?: unknown }>('GET', input.externalAccountId, { token, params: { fields: 'followers_count,fan_count' } });
      const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
      return { followers: n(answer.followers_count) ?? n(answer.fan_count) };
    } catch (error) {
      const result = graphPublishResult(error);
      if (result.kind === 'rejected' && (result.error === 'token_expired' || result.error === 'permission')) return { refused: result.error };
      return null;
    }
  }

  // The Page's own posts since a date (#1054): `GET /{page-id}/published_posts`, paged by its after cursor, newest
  // first, at most RECENT_POSTS_MAX_DAYS back. It needs pages_read_engagement, which every Page connection has. A page
  // after the first that fails ends the listing with what came before it.
  async listRecentPosts(input: RecentPostsInput): Promise<RecentPostsResult> {
    const token = pageToken(input.secret);
    if (!token) return { refused: 'token_expired' };
    if (!/^\d{1,32}$/.test(input.externalAccountId)) return null;
    const since = recentSince(input.since);
    const posts: RecentPost[] = [];
    let after: string | null = null;
    for (let page = 0; page < RECENT_PAGES_MAX && posts.length < RECENT_POSTS_MAX; page++) {
      let answer: PostsAnswer;
      try {
        answer = await this.graph.call<PostsAnswer>('GET', `${input.externalAccountId}/published_posts`, {
          token,
          params: { fields: 'id,message,created_time,permalink_url', since: String(Math.floor(since.getTime() / 1000)), limit: '100', ...(after ? { after } : {}) },
        });
      } catch (error) {
        if (page > 0) break;
        const result = graphPublishResult(error);
        if (result.kind === 'rejected' && (result.error === 'token_expired' || result.error === 'permission')) return { refused: result.error };
        return null;
      }
      let older = false;
      for (const p of answer.data ?? []) {
        const at = graphTime(p.created_time);
        if (typeof p.id !== 'string' || !/^\d{1,32}_\d{1,32}$/.test(p.id) || !at) continue;
        if (at < since) {
          older = true;
          continue;
        }
        posts.push({ externalId: p.id, text: typeof p.message === 'string' ? p.message : '', permalink: platformLink(p.permalink_url, FACEBOOK_HOSTS), publishedAt: at });
      }
      after = typeof answer.paging?.next === 'string' ? pagingCursor(answer.paging.cursors?.after) : null;
      if (older || !after) break;
    }
    return { posts: posts.slice(0, RECENT_POSTS_MAX) };
  }

  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const token = pageToken(input.secret);
    if (!token) return { refused: 'token_expired' };
    if (!/^\d{1,32}_\d{1,32}$/.test(input.externalId)) return { refused: 'gone' };
    try {
      const answer = await this.graph.call<{ reactions?: { summary?: { total_count?: unknown } }; comments?: { summary?: { total_count?: unknown } }; shares?: { count?: unknown } }>('GET', input.externalId, {
        token,
        params: { fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares' },
      });
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
      const metrics: Partial<Record<'reactions' | 'comments' | 'shares', number>> = {};
      const reactions = n(answer.reactions?.summary?.total_count);
      const comments = n(answer.comments?.summary?.total_count);
      // A post nobody shared has no shares field at all.
      const shares = n(answer.shares?.count) ?? 0;
      if (reactions !== undefined) metrics.reactions = reactions;
      if (comments !== undefined) metrics.comments = comments;
      metrics.shares = shares;
      return { metrics };
    } catch (error) {
      const result = graphPublishResult(error);
      if (result.kind === 'rejected' && result.error === 'token_expired') return { refused: 'token_expired' };
      // Code 100 with subcode 33: the post does not exist any more. Code 100 alone also means a missing permission or a
      // bad field, which is not a deleted post.
      if (error instanceof GraphError && error.code === 100 && error.subcode === 33) return { refused: 'gone' };
      return null;
    }
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const token = pageToken(input.secret);
    if (!token || !/^\d{1,32}$/.test(input.externalAccountId)) return { found: 'unknown' };
    // A Story or a Reel is not matched by its text among the Page's posts (#644): never a guess.
    if (postTypeOf(input.settings) !== 'feed') return { found: 'unknown' };
    const message = feedMessage(input.content);
    // A post without text (link only, or photos only) has no message to match on, so it cannot be found again.
    if (!message) return { found: 'unknown' };
    // Graph's since/until are Unix seconds; a minute either side covers clock skew between Meta and the worker.
    const params = {
      fields: 'id,message,created_time,permalink_url',
      since: String(Math.floor(input.after.getTime() / 1000) - 60),
      until: String(Math.ceil(input.before.getTime() / 1000) + 60),
      limit: '100',
    };
    try {
      const answer = await this.graph.call<PostsAnswer>('GET', `${input.externalAccountId}/posts`, { token, params });
      const post = (answer.data ?? []).find((p) => typeof p.id === 'string' && typeof p.message === 'string' && p.message.trim() === message);
      if (!post) return { found: false };
      const id = post.id as string;
      return { found: true, externalId: id, url: typeof post.permalink_url === 'string' ? post.permalink_url : postUrl(id) };
    } catch {
      return { found: 'unknown' };
    }
  }
}