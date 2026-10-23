// Threads (S9, issue #391), written from Meta's Threads API docs. Threads has its own OAuth and its own app id (the
// Threads use case of a Meta app): CHANNEL_THREADS_APP_ID and CHANNEL_THREADS_APP_SECRET.
//
// Connect: threads.net's dialog, a short-lived token, then a long-lived one (60 days) that can be refreshed once it
// is a day old; the refresh schedule renews it a week before it expires.
// Publish: a container (text, an image, a video, or a carousel of 2 to 20 mixing them), a wait until Meta has processed it, then
// threads_publish, the one visible step. As for Instagram, a PUBLISHED container went out already, and a pending
// reference carries the text's hash so a status check recognises the post it became.
// Polls and topic tags (#711): a text post may carry a poll of 2 to 4 options (poll_attachment), and any post one topic
// tag (topic_tag); both come from the variant's settings and are checked before anything is created.
// Who may reply (#983): the post's container carries reply_control, read from the same settings field as X's reply setting.
// First comment (#609): a reply to the account's own post, made the same way (a TEXT container with reply_to_id, then
// threads_publish); replying needs threads_manage_replies.
import { createHash } from 'node:crypto';
import type { AccountMetricsInput, AccountMetricsResult, CommentInput, CommentResult, RepostInput, ConnectedAccount, MetricName, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RetrySafety, StatusInput } from './index.ts';
import { AUDIENCE_BREAKDOWNS, AUDIENCE_MIN_FOLLOWERS, audienceOf, audienceSlices, type Audience, type AudienceBreakdown, type AudienceSlice } from './audience.ts';
import { commentResult } from './comment.ts';
import { holdsLink } from './text.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';
import { QUOTA_RETRY_MS, quotaExhausted } from './instagram.ts';

export const THREADS_HOSTS = ['graph.threads.net'] as const;
// threads_manage_insights (#819): post counts and the account's followers; a channel connected before asks again.
export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_manage_insights'] as const;
const API = 'https://graph.threads.net';
const VERSION = 'v1.0';
const WAIT_MS = 15_000;
const POLL_MS = 2_000;
// How long a reply waits for its text container; a text container is usually ready at once, and the comment job's
// call timeout (60 s) leaves room for the two calls around the wait.
const COMMENT_WAIT_MS = 10_000;
// A first comment's calls each end within COMMENT_CALL_MS, and its publish is not made after COMMENT_BUDGET_MS, well
// inside the worker's call timeout.
const COMMENT_CALL_MS = 10_000;
const COMMENT_BUDGET_MS = 30_000;
const CHECK_AFTER_SECONDS = 30;
const NUMERIC_ID = /^\d{1,32}$/;
// Threads takes 2 to 20 items in a carousel.
const CAROUSEL_MAX = 20;

export interface ThreadsAppConfig {
  appId: string;
  appSecret: string;
}

export class ThreadsError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  constructor(status: number, body: { message?: unknown; code?: unknown; error_subcode?: unknown } | undefined) {
    super(typeof body?.message === 'string' ? body.message : `Threads answered ${status}`);
    this.name = 'ThreadsError';
    this.status = status;
    this.code = typeof body?.code === 'number' ? body.code : undefined;
    this.subcode = typeof body?.error_subcode === 'number' ? body.error_subcode : undefined;
  }
}

class ThreadsClient {
  private readonly fetch: Fetch;

  constructor(fetchImpl?: Fetch) {
    this.fetch = allowlistedFetch(THREADS_HOSTS, fetchImpl);
  }

  // path is relative to graph.threads.net; a token goes in the Authorization header unless an endpoint needs it as a
  // parameter (the token exchanges).
  async call<T>(method: 'GET' | 'POST', path: string, options: { token?: string; params?: Record<string, string>; form?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(`${API}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }
    const response = await this.fetch(url.toString(), { method, headers, ...(body === undefined ? {} : { body }), ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}) });
    const json = (await response.json().catch(() => null)) as ({ error?: { message?: unknown; code?: unknown; error_subcode?: unknown } } & Record<string, unknown>) | null;
    if (!response.ok || !json || json.error) throw new ThreadsError(response.ok && !json ? 200 : response.status, json?.error);
    return json as T;
  }
}

function asConnectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof ThreadsError) {
    if (codeStep && error.status < 500 && error.status >= 400) return new ConnectorError('invalid_grant', 'Threads refused the authorization code', String(error.code ?? error.status));
    return new ConnectorError(error.status === 403 || error.code === 10 ? 'denied' : 'provider', error.message, String(error.code ?? error.status));
  }
  return new ConnectorError('provider', `Threads could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

interface TokenAnswer {
  access_token?: unknown;
  expires_in?: unknown;
  user_id?: unknown;
}

const tokenOf = (a: TokenAnswer) => {
  if (typeof a.access_token !== 'string' || !a.access_token) throw new ConnectorError('provider', 'Threads answered without an access token');
  return a.access_token;
};
const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60 * 86_400) * 1000);
};

export class ThreadsConnector implements OAuthConnector {
  readonly provider = 'threads' as const;
  readonly pkce = false;
  private readonly app: ThreadsAppConfig;
  private readonly client: ThreadsClient;

  constructor(app: ThreadsAppConfig, fetchImpl?: Fetch) {
    if (!/^\d{1,32}$/.test(app.appId)) throw new Error('invalid Threads app id');
    if (!app.appSecret) throw new Error('missing Threads app secret');
    this.app = app;
    this.client = new ThreadsClient(fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://threads.net/oauth/authorize');
    url.searchParams.set('client_id', this.app.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', THREADS_SCOPES.join(','));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
    const short = await this.client
      .call<TokenAnswer>('POST', 'oauth/access_token', {
        form: { client_id: this.app.appId, client_secret: this.app.appSecret, grant_type: 'authorization_code', redirect_uri: input.redirectUri, code: input.code },
      })
      .catch((error: unknown) => {
        throw asConnectorError(error, true);
      });
    // The long-lived exchange takes its tokens as parameters (Meta's documented form); this URL is never logged.
    const long = await this.client
      .call<TokenAnswer>('GET', 'access_token', { params: { grant_type: 'th_exchange_token', client_secret: this.app.appSecret, access_token: tokenOf(short) } })
      .catch((error: unknown) => {
        throw asConnectorError(error);
      });
    const token = tokenOf(long);
    const me = await this.client.call<{ id?: unknown; username?: unknown }>('GET', `${VERSION}/me`, { token, params: { fields: 'id,username' } }).catch((error: unknown) => {
      throw asConnectorError(error);
    });
    const id = typeof me.id === 'string' || typeof me.id === 'number' ? String(me.id) : '';
    if (!NUMERIC_ID.test(id)) throw new ConnectorError('provider', 'Threads answered without a user id');
    const name = typeof me.username === 'string' && me.username ? `@${me.username}` : `Threads ${id}`;
    return [{ provider: 'threads', externalAccountId: id, displayName: name.slice(0, 200), scopes: [...THREADS_SCOPES], expiresAt: expiryOf(long), secret: JSON.stringify({ accessToken: token }) }];
  }
}

const tokenIn = (secret: string): string | null => {
  try {
    const t = (JSON.parse(secret) as { accessToken?: unknown }).accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
};

// Renews a long-lived token a week before it expires (Meta allows it once the token is a day old).
export class ThreadsRefresher implements Refresher {
  readonly provider = 'threads' as const;
  readonly horizonSeconds = 7 * 86_400;
  private readonly client: ThreadsClient;

  constructor(fetchImpl?: Fetch) {
    this.client = new ThreadsClient(fetchImpl);
  }

  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }> {
    const token = tokenIn(secret);
    if (!token) return { refused: 'NO_TOKEN' };
    try {
      const answer = await this.client.call<TokenAnswer>('GET', 'refresh_access_token', { params: { grant_type: 'th_refresh_token', access_token: token } });
      return { secret: JSON.stringify({ accessToken: tokenOf(answer) }), expiresAt: expiryOf(answer) };
    } catch (error) {
      // 190: the token is no longer valid; anything else may pass.
      if (error instanceof ThreadsError && (error.code === 190 || error.status === 401)) return { refused: String(error.code ?? error.status) };
      return { failed: error instanceof ThreadsError ? String(error.code ?? error.status) : 'NETWORK' };
    }
  }
}

const TOKEN_CODES = new Set([102, 190, 463, 467]);
const RATE_CODES = new Set([4, 17, 32, 613]);

function threadsResult(error: unknown): PublishResult {
  if (!(error instanceof ThreadsError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code === undefined ? `HTTP_${error.status}` : String(error.code);
  const base = { code, message: error.message, httpStatus: error.status };
  if (error.status < 400 || error.status >= 500 || error.code === 1 || error.code === 2) return { kind: 'unknown', code, message: error.message };
  if ((error.code !== undefined && TOKEN_CODES.has(error.code)) || error.status === 401) return { kind: 'rejected', error: 'token_expired', ...base };
  if (error.code === 10 || (error.code !== undefined && error.code >= 200 && error.code <= 299) || error.status === 403) return { kind: 'rejected', error: 'permission', ...base };
  if ((error.code !== undefined && RATE_CODES.has(error.code)) || error.status === 429) return { kind: 'rejected', error: 'rate_limited', ...base };
  return { kind: 'rejected', error: 'bad_request', ...base };
}

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};
const textKey = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const refOf = (container: string, text: string) => `${container}.${textKey(text)}`;
const parseRef = (ref: string) => {
  const m = /^(\d{1,32})\.([0-9a-f]{16})$/.exec(ref);
  return m ? { container: m[1] as string, key: m[2] as string } : null;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class NoUrl extends Error {}

// A Threads poll (#711), as the variant's settings carry it (`settings.poll`: { options: 2 to 4 strings of 1 to 25
// characters }); the form Threads takes (option_a to option_d), null for none, 'invalid' for any other shape.
const POLL_KEYS = ['option_a', 'option_b', 'option_c', 'option_d'] as const;
export function threadsPollOf(settings: Readonly<Record<string, unknown>>): Record<string, string> | null | 'invalid' {
  const poll = settings.poll;
  if (poll === undefined || poll === null) return null;
  const options = typeof poll === 'object' ? (poll as { options?: unknown }).options : undefined;
  if (!Array.isArray(options) || options.length < 2 || options.length > POLL_KEYS.length) return 'invalid';
  const out: Record<string, string> = {};
  for (const [i, option] of options.entries()) {
    const text = typeof option === 'string' ? option.trim() : '';
    if ([...text].length < 1 || [...text].length > 25) return 'invalid';
    out[POLL_KEYS[i] as string] = text;
  }
  return out;
}

// A post's topic tag (#711, `settings.topicTag`): 1 to 50 characters, without a period or an ampersand; a leading # is
// dropped. null for none, false for one Threads would refuse (a tag may be any word, so no string marks a bad one).
export function threadsTopicTagOf(settings: Readonly<Record<string, unknown>>): string | null | false {
  const tag = settings.topicTag;
  if (tag === undefined || tag === null) return null;
  if (typeof tag !== 'string') return false;
  const text = tag.trim().replace(/^#/, '');
  return [...text].length >= 1 && [...text].length <= 50 && !/[.&]/.test(text) ? text : false;
}

// Who may reply to a Threads post (#983), in `settings.replySettings`, the field X's reply setting uses (#948), with
// Crove's names mapped to Meta's reply_control values: everyone (the default, sent as nothing, as before), the accounts
// the poster follows, the people the post mentions, or the poster's followers (Threads only). Meta sets it per post, on
// the container that is published; thread parts are replies (comment()) and carry none. Meta's fifth value,
// parent_post_author_only, concerns replies to someone else's post, which Crove does not make. null for everyone,
// 'invalid' for any other value.
const REPLY_CONTROL: Readonly<Record<string, string>> = { following: 'accounts_you_follow', mentionedUsers: 'mentioned_only', followers: 'followers_only' };
export function threadsReplyControlOf(settings: Readonly<Record<string, unknown>>): string | null | 'invalid' {
  const value = settings.replySettings;
  if (value === undefined || value === null || value === 'everyone') return null;
  return typeof value === 'string' && Object.hasOwn(REPLY_CONTROL, value) ? (REPLY_CONTROL[value] as string) : 'invalid';
}

export class ThreadsPublisher implements Publisher {
  readonly provider = 'threads' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly client: ThreadsClient;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly commentWaitMs: number;
  private readonly commentBudgetMs: number;

  constructor(fetchImpl?: Fetch, timing: { waitMs?: number; pollMs?: number; commentWaitMs?: number; commentBudgetMs?: number } = {}) {
    this.client = new ThreadsClient(fetchImpl);
    this.waitMs = timing.waitMs ?? WAIT_MS;
    this.pollMs = timing.pollMs ?? POLL_MS;
    this.commentWaitMs = timing.commentWaitMs ?? COMMENT_WAIT_MS;
    this.commentBudgetMs = timing.commentBudgetMs ?? COMMENT_BUDGET_MS;
  }

  // A post's counts (plan §3.6, #744): views, likes, replies, and reposts, quotes and shares together, from the media
  // insights endpoint (threads_manage_insights). A post that is gone, or insights not granted, give no counts.
  // The account's followers (#819), from threads_insights (followers_count is a total, not a daily series), and who
  // follows it when asked (#1146).
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const token = tokenIn(input.secret);
    if (!token) return { refused: 'token_expired' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return null;
    let followers: number | null;
    try {
      const answer = await this.client.call<{ data?: { name?: unknown; total_value?: { value?: unknown } }[] }>('GET', `${VERSION}/${input.externalAccountId}/threads_insights`, { token, params: { metric: 'followers_count' } });
      const value = (answer.data ?? []).find((r) => r.name === 'followers_count')?.total_value?.value;
      followers = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch (error) {
      const result = threadsResult(error);
      if (result.kind === 'rejected' && result.error === 'token_expired') return { refused: 'token_expired' };
      if (result.kind === 'rejected' && result.error === 'permission') return { refused: 'permission' };
      return null;
    }
    if (!input.audience) return { followers };
    const audience = followers !== null && followers >= AUDIENCE_MIN_FOLLOWERS ? await this.audience(input.externalAccountId, token) : null;
    if (audience === 'token_expired') return { refused: 'token_expired' };
    return { followers, audience };
  }

  // Who follows the account (#1146): follower_demographics on threads_insights, which takes one breakdown per call
  // and no since or until, under threads_manage_insights. A breakdown that fails or comes back empty is left out.
  private async audience(user: string, token: string): Promise<Audience | null | 'token_expired'> {
    const parts: Partial<Record<AudienceBreakdown, AudienceSlice[]>> = {};
    for (const breakdown of AUDIENCE_BREAKDOWNS) {
      try {
        const answer = await this.client.call<unknown>('GET', `${VERSION}/${user}/threads_insights`, { token, params: { metric: 'follower_demographics', breakdown } });
        parts[breakdown] = audienceSlices(answer, breakdown);
      } catch (error) {
        const result = threadsResult(error);
        if (result.kind === 'rejected' && result.error === 'token_expired') return 'token_expired';
        if (result.kind === 'rejected' && result.error === 'permission') return null;
      }
    }
    return audienceOf(parts);
  }

  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const token = tokenIn(input.secret);
    if (!token) return { refused: 'token_expired' };
    if (!NUMERIC_ID.test(input.externalId)) return { refused: 'gone' };
    let answer: { data?: { name?: unknown; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[] };
    try {
      answer = await this.client.call('GET', `${VERSION}/${input.externalId}/insights`, { token, params: { metric: 'views,likes,replies,reposts,quotes,shares' } });
    } catch (error) {
      const result = threadsResult(error);
      if (result.kind === 'rejected' && result.error === 'token_expired') return { refused: 'token_expired' };
      return null;
    }
    const metrics: Partial<Record<MetricName, number>> = {};
    let shared: number | undefined;
    for (const row of answer.data ?? []) {
      const raw = row.values?.[0]?.value ?? row.total_value?.value;
      const value = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
      if (value === undefined || typeof row.name !== 'string') continue;
      if (row.name === 'views') metrics.views = value;
      else if (row.name === 'likes') metrics.reactions = value;
      else if (row.name === 'replies') metrics.comments = value;
      else if (row.name === 'reposts' || row.name === 'quotes' || row.name === 'shares') shared = (shared ?? 0) + value;
    }
    if (shared !== undefined) metrics.shares = shared;
    return { metrics };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = tokenIn(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    const user = input.externalAccountId;
    const text = textOf(input.content);
    const media = input.content.media.slice(0, CAROUSEL_MAX);
    if (!text && media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    const poll = threadsPollOf(input.settings);
    const topicTag = threadsTopicTagOf(input.settings);
    if (poll === 'invalid') return { kind: 'rejected', error: 'bad_request', code: 'POLL_INVALID' };
    if (poll && media.length > 0) return { kind: 'rejected', error: 'bad_request', code: 'POLL_WITH_MEDIA' };
    if (topicTag === false) return { kind: 'rejected', error: 'bad_request', code: 'TOPIC_TAG_INVALID' };
    const replyControl = threadsReplyControlOf(input.settings);
    if (replyControl === 'invalid') return { kind: 'rejected', error: 'bad_request', code: 'REPLY_SETTINGS_INVALID' };
    // On the container that is published (a carousel's, not its items').
    const extras = { ...(poll ? { poll_attachment: JSON.stringify(poll) } : {}), ...(topicTag ? { topic_tag: topicTag } : {}), ...(replyControl ? { reply_control: replyControl } : {}) };
    // The profile's publishing quota (plan §3.6; 250 posts in a rolling 24 hours today), read before any container; a
    // read that fails does not hold the post.
    const quota = await this.client.call<Parameters<typeof quotaExhausted>[0]>('GET', `${VERSION}/${user}/threads_publishing_limit`, { token, params: { fields: 'quota_usage,config' } }).catch(() => null);
    if (quotaExhausted(quota)) return { kind: 'rejected', error: 'rate_limited', code: 'QUOTA_EXHAUSTED', retryAt: new Date(Date.now() + QUOTA_RETRY_MS) };
    const urlOf = async (fileId: string) => {
      const url = await input.mediaUrl(fileId).catch(() => null);
      if (!url) throw new NoUrl();
      return url;
    };
    // An image or a video (#446), each fetched by Meta from its presigned URL, with its description for screen readers
    // (#790), which Threads takes on both, up to 1000 characters.
    const mediaForm = async (m: { fileId: string; mime: string; altText?: string | null }) => ({
      ...(m.mime.startsWith('video/') ? { media_type: 'VIDEO', video_url: await urlOf(m.fileId) } : { media_type: 'IMAGE', image_url: await urlOf(m.fileId) }),
      ...(m.altText ? { alt_text: m.altText.slice(0, 1000) } : {}),
    });
    let container: string;
    try {
      if (media.length === 0) {
        container = await this.create(user, token, { media_type: 'TEXT', text, ...extras });
      } else if (media.length === 1) {
        const only = media[0] as { fileId: string; mime: string; altText?: string | null };
        container = await this.create(user, token, { ...(await mediaForm(only)), ...(text ? { text } : {}), ...extras });
      } else {
        // A carousel may mix images and videos.
        const children: string[] = [];
        for (const m of media) children.push(await this.create(user, token, { ...(await mediaForm(m)), is_carousel_item: 'true' }));
        container = await this.create(user, token, { media_type: 'CAROUSEL', children: children.join(','), ...(text ? { text } : {}), ...extras });
      }
    } catch (error) {
      if (error instanceof NoUrl) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
      // Containers are invisible until published: an unclear answer here posted nothing.
      const result = threadsResult(error);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const state = await this.status_(container, token);
      if (state === 'FINISHED') return this.publishContainer(user, token, container, textKey(text));
      if (state === 'ERROR' || state === 'EXPIRED') return { kind: 'rejected', error: 'bad_request', code: `CONTAINER_${state}` };
      if (state === 'PUBLISHED') return this.findPublished(user, token, textKey(text), container);
      if (state === 'TOKEN_EXPIRED') return { kind: 'rejected', error: 'token_expired', code: '190' };
      if (Date.now() >= deadline) return { kind: 'pending', externalRef: refOf(container, text), checkAfterSeconds: CHECK_AFTER_SECONDS };
      await sleep(this.pollMs);
    }
  }

  async status(input: StatusInput): Promise<PublishResult> {
    const token = tokenIn(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' };
    const ref = parseRef(input.externalRef);
    if (!ref) return { kind: 'unknown', code: 'BAD_CONTAINER_REF' };
    switch (await this.status_(ref.container, token)) {
      case 'FINISHED': {
        const already = await this.findPublished(input.externalAccountId, token, ref.key, ref.container);
        if (already.kind === 'accepted') return already;
        return this.publishContainer(input.externalAccountId, token, ref.container, ref.key);
      }
      case 'PUBLISHED':
        return this.findPublished(input.externalAccountId, token, ref.key, ref.container);
      case 'IN_PROGRESS':
        return { kind: 'pending', externalRef: input.externalRef, checkAfterSeconds: CHECK_AFTER_SECONDS };
      case 'ERROR':
      case 'EXPIRED':
        return { kind: 'rejected', error: 'bad_request', code: 'CONTAINER_FAILED' };
      case 'TOKEN_EXPIRED':
        return { kind: 'rejected', error: 'token_expired', code: '190' };
      default:
        return { kind: 'unknown', code: 'CONTAINER_STATUS_UNKNOWN' };
    }
  }

  // A reply to the account's own post (#609), as the first comment. The reply container is invisible until published,
  // so any failure before threads_publish posted nothing; a container still processing when the short wait ends is
  // transient, and the person retries. A connection made before Crove asked for threads_manage_replies is refused with
  // a permission error and replies again once it reconnects.
  // A repost of the account's own post (#773): POST /{media_id}/repost, which answers with the repost's id.
  async repost(input: RepostInput): Promise<CommentResult> {
    const token = tokenIn(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' };
    if (!NUMERIC_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const answer = await this.client.call<{ id?: unknown }>('POST', `${VERSION}/${input.externalId}/repost`, { token, timeoutMs: COMMENT_CALL_MS });
      if (typeof answer.id !== 'string' || !NUMERIC_ID.test(answer.id)) return { kind: 'unknown', code: 'NO_REPOST_ID' };
      return { kind: 'accepted', externalId: answer.id };
    } catch (error) {
      return commentResult(threadsResult(error));
    }
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const token = tokenIn(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    if (!NUMERIC_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    const user = input.externalAccountId;
    // Each call is bounded, and the publish is never made past the budget: the job stops waiting at its own timeout,
    // and a reply published after that would be recorded as unclear while it went out.
    const started = Date.now();
    let container: string;
    try {
      container = await this.create(user, token, { media_type: 'TEXT', text: input.text, reply_to_id: input.externalId }, COMMENT_CALL_MS);
    } catch (error) {
      const result = threadsResult(error);
      return commentResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    const deadline = Date.now() + this.commentWaitMs;
    for (;;) {
      const state = await this.status_(container, token, COMMENT_CALL_MS);
      if (state === 'FINISHED') break;
      if (state === 'ERROR' || state === 'EXPIRED') return { kind: 'rejected', error: 'bad_request', code: `CONTAINER_${state}` };
      // This call has not published the container yet; if Meta says it is published, whether a reply went out is unclear.
      if (state === 'PUBLISHED') return { kind: 'unknown', code: 'CONTAINER_PUBLISHED' };
      if (state === 'TOKEN_EXPIRED') return { kind: 'rejected', error: 'token_expired', code: '190' };
      if (Date.now() >= deadline) return { kind: 'rejected', error: 'transient', code: 'CONTAINER_NOT_READY' };
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    }
    // Nothing is published yet: too late to publish within the job's time, so nothing goes out and the person retries.
    if (Date.now() - started > this.commentBudgetMs) return { kind: 'rejected', error: 'transient', code: 'LATE_PUBLISH' };
    try {
      const answer = await this.client.call<{ id?: unknown }>('POST', `${VERSION}/${user}/threads_publish`, { token, form: { creation_id: container }, timeoutMs: COMMENT_CALL_MS });
      const id = typeof answer.id === 'string' || typeof answer.id === 'number' ? String(answer.id) : '';
      if (!NUMERIC_ID.test(id)) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: id };
    } catch (error) {
      return commentResult(threadsResult(error));
    }
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const token = tokenIn(input.secret);
    const text = textOf(input.content);
    if (!token || !text || !NUMERIC_ID.test(input.externalAccountId)) return { found: 'unknown' };
    try {
      const post = await this.recent(input.externalAccountId, token, (p) => p.text === text && p.at >= input.after.getTime() - 60_000 && p.at <= input.before.getTime() + 60_000);
      return post ? { found: true, externalId: post.id, url: post.permalink } : { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }

  private async create(user: string, token: string, form: Record<string, string>, timeoutMs?: number): Promise<string> {
    const answer = await this.client.call<{ id?: unknown }>('POST', `${VERSION}/${user}/threads`, { token, form, ...(timeoutMs ? { timeoutMs } : {}) });
    const id = typeof answer.id === 'string' || typeof answer.id === 'number' ? String(answer.id) : '';
    if (!NUMERIC_ID.test(id)) throw new ThreadsError(502, { message: 'no container id', code: 1 });
    return id;
  }

  private async status_(container: string, token: string, timeoutMs?: number): Promise<string> {
    try {
      const answer = await this.client.call<{ status?: unknown }>('GET', `${VERSION}/${container}`, { token, params: { fields: 'status' }, ...(timeoutMs ? { timeoutMs } : {}) });
      return typeof answer.status === 'string' ? answer.status : 'UNKNOWN';
    } catch (error) {
      const result = threadsResult(error);
      return result.kind === 'rejected' && result.error === 'token_expired' ? 'TOKEN_EXPIRED' : 'UNKNOWN';
    }
  }

  private async publishContainer(user: string, token: string, container: string, key: string): Promise<PublishResult> {
    try {
      const answer = await this.client.call<{ id?: unknown }>('POST', `${VERSION}/${user}/threads_publish`, { token, form: { creation_id: container } });
      const id = typeof answer.id === 'string' || typeof answer.id === 'number' ? String(answer.id) : '';
      if (!id) return { kind: 'unknown', code: 'NO_POST_ID' };
      const link = await this.client.call<{ permalink?: unknown }>('GET', `${VERSION}/${id}`, { token, params: { fields: 'permalink' } }).catch(() => ({ permalink: null }));
      return { kind: 'accepted', externalId: id, url: typeof link.permalink === 'string' ? link.permalink : null };
    } catch (error) {
      if ((await this.status_(container, token)) === 'PUBLISHED') return this.findPublished(user, token, key, container);
      return threadsResult(error);
    }
  }

  // The post a published container became: a post of the last day with the same text; no match is unknown.
  private async findPublished(user: string, token: string, key: string, container: string): Promise<PublishResult> {
    const since = Date.now() - 86_400_000;
    try {
      const post = await this.recent(user, token, (p) => textKey(p.text) === key && !(p.at < since));
      return post ? { kind: 'accepted', externalId: post.id, url: post.permalink } : { kind: 'unknown', code: 'PUBLISHED_NOT_FOUND', message: `container ${container}` };
    } catch {
      return { kind: 'unknown', code: 'PUBLISHED_NOT_FOUND' };
    }
  }

  private async recent(user: string, token: string, match: (p: { text: string; at: number }) => boolean): Promise<{ id: string; permalink: string | null } | null> {
    const answer = await this.client.call<{ data?: { id?: unknown; text?: unknown; timestamp?: unknown; permalink?: unknown }[] }>('GET', `${VERSION}/${user}/threads`, {
      token,
      params: { fields: 'id,text,timestamp,permalink', limit: '25' },
    });
    for (const p of answer.data ?? []) {
      const id = typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id) : '';
      if (!id) continue;
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      const at = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : Number.NaN;
      if (match({ text, at })) return { id, permalink: typeof p.permalink === 'string' ? p.permalink : null };
    }
    return null;
  }
}
