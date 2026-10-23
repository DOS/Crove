// X posts (S9, issue #420), written from the X API v2 docs (OAuth 2.0 authorization code with PKCE, POST /2/tweets,
// POST /2/media/upload). The deployment's own X developer app: CHANNEL_X_CLIENT_ID and CHANNEL_X_CLIENT_SECRET. X
// bills each post to that app's account.
//
// Connect: X's dialog for tweet.read, tweet.write, users.read, media.write and offline.access, with PKCE; the access
// token lives two hours and the refresh schedule renews it, keeping whichever refresh token X hands back.
// Publish: each image is uploaded first (nothing is visible until a post names it), then one POST /2/tweets; a video
// goes through the chunked upload and X's processing first (#449). An unclear answer is checked against the account's recent posts by text and time.
// The post may carry a poll (never with media) and who may reply (#948), as poll and reply_settings.
import type { AccountMetricsInput, AccountMetricsResult, CommentInput, CommentResult, RepostInput, ConnectedAccount, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RemoveInput, RemoveResult, RetrySafety } from './index.ts';
import { commentResult, removeResult } from './comment.ts';
import { DUPLICATE_CONTENT, holdsLink } from './text.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const X_HOSTS = ['api.x.com'] as const;
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'] as const;
const API = 'https://api.x.com/2';
const USER_ID = /^\d{1,32}$/;
const POST_ID = /^\d{1,32}$/;
const MEDIA_ID = /^\d{1,32}$/;
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
// X shows at most 4 images in a post.
const MAX_IMAGES = 4;
// X takes at most 1000 characters of alt text per image.
// How much alt text this adapter sends; ALT_TEXT_LIMITS of the Social module follows it (alt-text-limits.test.ts, #1126).
export const X_ALT_TEXT_MAX = 1000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export interface XAppConfig {
  clientId: string;
  clientSecret: string;
}

export class XError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  // When X's rate limit window resets (x-rate-limit-reset), for a 429.
  readonly resetAt: Date | undefined;
  constructor(status: number, body: Record<string, unknown> | null, resetAt?: Date) {
    const errors = Array.isArray(body?.errors) ? (body.errors as { message?: unknown; code?: unknown }[]) : [];
    const message = [body?.detail, body?.title, errors[0]?.message, body?.error_description].find((m): m is string => typeof m === 'string' && m !== '') ?? `X answered ${status}`;
    super(message);
    this.name = 'XError';
    this.status = status;
    this.resetAt = resetAt;
    // A problem's type names it (https://api.x.com/2/problems/usage-capped); the OAuth endpoints answer error.
    const type = typeof body?.type === 'string' && body.type !== 'about:blank' ? body.type.split('/').pop() : undefined;
    const code = type ?? body?.error ?? errors[0]?.code;
    this.code = typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
  }
}

export interface XSecret {
  accessToken: string;
  refreshToken: string;
}

export function xSecretOf(secret: string): XSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<XSecret>;
    return typeof s.accessToken === 'string' && s.accessToken && typeof s.refreshToken === 'string' && s.refreshToken ? { accessToken: s.accessToken, refreshToken: s.refreshToken } : null;
  } catch {
    return null;
  }
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

class XClient {
  private readonly fetch: Fetch;
  private readonly app: XAppConfig;

  constructor(app: XAppConfig, fetchImpl?: Fetch) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(app.clientId)) throw new Error('invalid X client id');
    if (!app.clientSecret) throw new Error('missing X client secret');
    this.app = app;
    this.fetch = allowlistedFetch(X_HOSTS, fetchImpl, 30_000);
  }

  get clientId(): string {
    return this.app.clientId;
  }

  // A confidential client: the app's id and secret in Basic auth.
  async token(form: Record<string, string>): Promise<TokenAnswer> {
    const basic = Buffer.from(`${encodeURIComponent(this.app.clientId)}:${encodeURIComponent(this.app.clientSecret)}`).toString('base64');
    const response = await this.fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new XError(response.status, json);
    return json as TokenAnswer;
  }

  async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, body?: { json: unknown } | { form: FormData }): Promise<T | null> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    let payload: string | FormData | undefined;
    if (body && 'json' in body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body) {
      payload = body.form;
    }
    const response = await this.fetch(`${API}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const reset = Number(response.headers.get('x-rate-limit-reset'));
      throw new XError(response.status, json, Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined);
    }
    return json as T | null;
  }
}

const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 7200) * 1000);
};

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof XError) {
    // X answers a bad code with invalid_request; invalid_client is the deployment's configuration, not the code.
    if (codeStep && error.status >= 400 && error.status < 500 && error.code !== 'invalid_client') return new ConnectorError('invalid_grant', 'X refused the authorization code', error.code ?? String(error.status));
    return new ConnectorError(error.status === 403 ? 'denied' : 'provider', error.message, error.code ?? String(error.status));
  }
  return new ConnectorError('provider', `X could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

export class XConnector implements OAuthConnector {
  readonly provider = 'x' as const;
  readonly pkce = true;
  private readonly client: XClient;

  constructor(app: XAppConfig, fetchImpl?: Fetch) {
    this.client = new XClient(app, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://x.com/i/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', X_SCOPES.join(' '));
    url.searchParams.set('state', input.state);
    // X requires PKCE; the API always starts the attempt with a verifier for a pkce connector.
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchange(input: ExchangeInput, now = Date.now()): Promise<ConnectedAccount[]> {
    if (!input.codeVerifier) throw new ConnectorError('invalid_grant', 'X needs the PKCE verifier of the attempt');
    const answer = await this.client
      .token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier })
      .catch((error: unknown) => {
        throw connectorError(error, true);
      });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'X answered without an access token');
    if (typeof answer.refresh_token !== 'string' || !answer.refresh_token) throw new ConnectorError('provider', 'X answered without a refresh token');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : [];
    // All of them: posting, images, the account's own posts to reconcile, and renewal.
    if (!X_SCOPES.every((s) => granted.includes(s))) throw new ConnectorError('denied', 'X did not grant the permissions Crove needs', 'MISSING_PERMISSION');
    const me = await this.client.call<{ data?: { id?: unknown; name?: unknown; username?: unknown } }>('GET', '/users/me?user.fields=username,name', answer.access_token).catch((error: unknown) => {
      throw connectorError(error);
    });
    const id = typeof me?.data?.id === 'string' ? me.data.id : '';
    if (!USER_ID.test(id)) throw new ConnectorError('provider', 'X answered without a user id');
    const username = typeof me?.data?.username === 'string' && USERNAME.test(me.data.username) ? me.data.username : null;
    const name = typeof me?.data?.name === 'string' && me.data.name.trim() ? me.data.name.trim() : null;
    const displayName = name && username ? `${name} (@${username})` : (name ?? (username ? `@${username}` : `X ${id}`));
    const secret: XSecret = { accessToken: answer.access_token, refreshToken: answer.refresh_token };
    return [{ provider: 'x', externalAccountId: id, displayName: displayName.slice(0, 200), scopes: granted, expiresAt: expiryOf(answer, now), secret: JSON.stringify(secret) }];
  }
}

// Renews the two-hour access token half an hour ahead. X may rotate the refresh token, so the one it returns is kept.
export class XRefresher implements Refresher {
  readonly provider = 'x' as const;
  readonly horizonSeconds = 30 * 60;
  private readonly client: XClient;

  constructor(app: XAppConfig, fetchImpl?: Fetch) {
    this.client = new XClient(app, fetchImpl);
  }

  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }> {
    const s = xSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const answer = await this.client.token({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
      if (typeof answer.access_token !== 'string' || !answer.access_token) return { failed: 'NO_ACCESS_TOKEN' };
      const next: XSecret = { accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : s.refreshToken };
      return { secret: JSON.stringify(next), expiresAt: expiryOf(answer) };
    } catch (error) {
      // A wrong client secret is the deployment's to fix: keep the connections and try again later.
      if (error instanceof XError && error.code === 'invalid_client') return { failed: 'invalid_client' };
      // X answers a revoked, expired or already used refresh token with 400 invalid_request (or 401): reconnect.
      if (error instanceof XError && (error.status === 400 || error.status === 401)) return { refused: error.code ?? 'invalid_grant' };
      return { failed: error instanceof XError ? (error.code ?? String(error.status)) : 'NETWORK' };
    }
  }
}

function publishResult(error: unknown): PublishResult {
  if (!(error instanceof XError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code ?? `HTTP_${error.status}`;
  if (error.status >= 500 || error.status < 400) return { kind: 'unknown', code, message: error.message };
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  // 100 posts per 15 minutes per user, or the app's monthly cap: wait for the window X names.
  if (error.status === 429 || code === 'usage-capped') return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status, ...(error.resetAt ? { retryAt: error.resetAt } : {}) };
  // Text over the account's limit (the checks cannot see the link the adapter appends): fix the post, not the account.
  if (/too long|shorter/i.test(error.message)) return { kind: 'rejected', error: 'bad_request', code: 'TEXT_TOO_LONG', message: error.message, httpStatus: error.status };
  // The same text as a recent post of the account (#1156): fix the text, not the account. X answers 403 with the detail
  // "You are not allowed to create a Tweet with duplicate content." (public reports; confirm on a live account, #591).
  if (error.status === 403 && /\bduplicate content\b/i.test(error.message)) return { kind: 'rejected', error: 'bad_request', code: DUPLICATE_CONTENT, message: error.message, httpStatus: error.status };
  // 402: the app's account has no credit left for posts; 403: the app or the account may not post this.
  if (error.status === 402 || error.status === 403) return { kind: 'rejected', error: 'permission', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

// Nothing is visible before the post itself, so a failure while uploading images posted nothing.
const beforePost = (result: PublishResult): PublishResult =>
  result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};

// Links X finds without a scheme, on the common TLDs (the Social checks count the same ones).
const BARE_LINK = /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|vn|io|co|ai|app|dev|me|info|biz|xyz|shop|store|online|site|tech|asia|edu|gov|us|uk|jp|sg|tv|ly|gg|link)\b(?:\/\S*)?/giu;
const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&' };
// Something that may still be a link to X (a host on a rarer TLD).
const MAYBE_LINK = /[a-z0-9-]\.[a-z]{2,}/iu;

// A post's text as X returns it, comparable with what was sent: X replaces links with t.co links and escapes &, < and
// >, so links are dropped and entities decoded before comparing.
export function comparableText(text: string): string {
  // One pass over the three entities X writes, so "&amp;lt;" stays "&lt;" as it was sent. Only compared, never shown.
  return text
    .replace(/&(lt|gt|amp);/g, (_, name: string) => ENTITIES[name] ?? '')
    // A link becomes a space (the spaces collapse below), on both sides of the comparison alike.
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(BARE_LINK, ' ')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

const postUrl = (id: string) => `https://x.com/i/status/${id}`;

// A poll on X (#948), as the variant's settings carry it (`settings.poll`: { options, durationMinutes }, the shape
// Threads reads, with a length X needs): POST /2/tweets takes poll { options: 2 to 4 strings of 1 to 25 characters,
// duration_minutes: 5 to 10080 }, and a post carries media or a poll, never both. Without a length the poll runs a day,
// as on X. null for none, 'invalid' for any other shape.
export const X_POLL_DEFAULT_MINUTES = 1440;
export function xPollOf(settings: Readonly<Record<string, unknown>>): { options: string[]; duration_minutes: number } | null | 'invalid' {
  const poll = settings.poll;
  if (poll === undefined || poll === null) return null;
  if (typeof poll !== 'object' || Array.isArray(poll)) return 'invalid';
  const { options, durationMinutes } = poll as { options?: unknown; durationMinutes?: unknown };
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return 'invalid';
  const texts: string[] = [];
  for (const option of options) {
    const text = typeof option === 'string' ? option.trim() : '';
    if ([...text].length < 1 || [...text].length > 25) return 'invalid';
    texts.push(text);
  }
  const minutes = durationMinutes === undefined || durationMinutes === null ? X_POLL_DEFAULT_MINUTES : durationMinutes;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 5 || minutes > 10080) return 'invalid';
  return { options: texts, duration_minutes: minutes };
}

// Who may reply (#948, `settings.replySettings`): everyone (the default, sent as nothing), the accounts the poster
// follows, or the people the post mentions, sent as reply_settings. null for everyone, 'invalid' for any other value.
export const X_REPLY_SETTINGS = ['everyone', 'following', 'mentionedUsers'] as const;
export function xReplySettingsOf(settings: Readonly<Record<string, unknown>>): 'following' | 'mentionedUsers' | null | 'invalid' {
  const value = settings.replySettings;
  if (value === undefined || value === null || value === 'everyone') return null;
  return value === 'following' || value === 'mentionedUsers' ? value : 'invalid';
}

// What the first post carries besides its text and media (#948). Thread parts are replies (comment()) and carry neither.
interface PostExtras {
  poll?: { options: string[]; duration_minutes: number };
  reply_settings?: 'following' | 'mentionedUsers';
}

interface Timeline {
  data?: { id?: unknown; text?: unknown; created_at?: unknown }[];
}

interface ProcessingInfo {
  state?: unknown;
  check_after_secs?: unknown;
  error?: { message?: unknown };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
// Under X's 5 MB per append.
const VIDEO_CHUNK = 4 * 1024 * 1024;
// How long a publish waits for X to process a video; with the upload it stays inside callTimeoutMs.
const PROCESSING_WAIT_MS = 300_000;
const VIDEO_CALL_MARGIN_MS = 90_000;

export class XPublisher implements Publisher {
  readonly provider = 'x' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  // A video's upload and processing take minutes; within the job's stale limit (600 s).
  readonly callTimeoutMs = 420_000;
  private readonly client: XClient;
  private readonly processingWaitMs: number;
  private readonly pollMinMs: number;
  private readonly budgetMs: number;

  // Post counts (#797), when the deployment turns them on (CHANNEL_X_METRICS): X bills every post read, so they are
  // off by default and the metrics sweep then skips X.
  readonly metrics?: (input: MetricsInput) => Promise<MetricsResult>;
  // The account's followers (#819), on the same switch: one more billed read a day.
  readonly accountMetrics?: (input: AccountMetricsInput) => Promise<AccountMetricsResult>;

  constructor(app: XAppConfig, fetchImpl?: Fetch, timing: { processingWaitMs?: number; pollMinMs?: number; budgetMs?: number } = {}, options: { metrics?: boolean } = {}) {
    this.client = new XClient(app, fetchImpl);
    if (options.metrics) {
      this.metrics = (input) => this.readMetrics(input);
      this.accountMetrics = (input) => this.readFollowers(input);
    }
    this.processingWaitMs = timing.processingWaitMs ?? PROCESSING_WAIT_MS;
    this.pollMinMs = timing.pollMinMs ?? 1000;
    // The last status check and the post (30 s each at most) plus slack fit between the budget and callTimeoutMs.
    this.budgetMs = timing.budgetMs ?? this.callTimeoutMs - VIDEO_CALL_MARGIN_MS;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = xSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    const { media } = input.content;
    // The poll and who may reply are checked before anything is read or uploaded, so a refusal posts nothing.
    const poll = xPollOf(input.settings);
    const replySettings = xReplySettingsOf(input.settings);
    if (poll === 'invalid') return { kind: 'rejected', error: 'bad_request', code: 'POLL_INVALID' };
    if (poll && media.length > 0) return { kind: 'rejected', error: 'bad_request', code: 'POLL_WITH_MEDIA' };
    if (replySettings === 'invalid') return { kind: 'rejected', error: 'bad_request', code: 'REPLY_SETTINGS_INVALID' };
    const extras: PostExtras = { ...(poll ? { poll } : {}), ...(replySettings ? { reply_settings: replySettings } : {}) };
    if (media.some((m) => m.mime.startsWith('video/'))) return this.publishVideo(input, s.accessToken, extras);
    if (media.length > MAX_IMAGES) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_IMAGES' };
    if (media.some((m) => !IMAGE_TYPES.includes(m.mime))) return { kind: 'rejected', error: 'bad_request', code: 'IMAGE_TYPE' };
    const text = textOf(input.content);
    if (!text && media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    // Every image is read before the first upload, so a read failure posts nothing.
    const files: { bytes: Uint8Array; mime: string; altText?: string }[] = [];
    for (const m of media) {
      try {
        files.push({ bytes: await input.readMedia(m.fileId), mime: m.mime, ...(m.altText ? { altText: m.altText } : {}) });
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
    }
    const mediaIds: string[] = [];
    for (const f of files) {
      const form = new FormData();
      form.set('media', new Blob([new Uint8Array(f.bytes)], { type: f.mime }));
      form.set('media_category', f.mime === 'image/gif' ? 'tweet_gif' : 'tweet_image');
      try {
        const uploaded = await this.client.call<{ data?: { id?: unknown } }>('POST', '/media/upload', s.accessToken, { form });
        const id = uploaded?.data?.id;
        if (typeof id !== 'string' || !MEDIA_ID.test(id)) return { kind: 'rejected', error: 'transient', code: 'NO_MEDIA_ID' };
        // The image's description for screen readers (#790), set before the post names the image: still nothing visible.
        if (f.altText) await this.client.call('POST', '/media/metadata', s.accessToken, { json: { id, metadata: { alt_text: { text: f.altText.slice(0, X_ALT_TEXT_MAX) } } } });
        mediaIds.push(id);
      } catch (error) {
        return beforePost(publishResult(error));
      }
    }
    return this.post(s.accessToken, text, mediaIds, extras);
  }

  // A reply in the post's thread (#587), as the first comment X has none of its own.
  // A repost of the account's own post (#773): POST /2/users/:id/retweets. X answers with the post retweeted, not a new
  // id, so the repost is named by the account and the post.
  async repost(input: RepostInput): Promise<CommentResult> {
    const s = xSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!USER_ID.test(input.externalAccountId) || !POST_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const answer = await this.client.call<{ data?: { retweeted?: unknown } }>('POST', `/users/${input.externalAccountId}/retweets`, s.accessToken, { json: { tweet_id: input.externalId } });
      if (answer?.data?.retweeted !== true) return { kind: 'unknown', code: 'NOT_RETWEETED' };
      return { kind: 'accepted', externalId: `retweet:${input.externalAccountId}:${input.externalId}` };
    } catch (error) {
      return commentResult(publishResult(error));
    }
  }

  // Deletes the account's own post (#860): DELETE /2/tweets/:id, answered { data: { deleted: true } }. A post X no
  // longer has (404) is gone already; any other answer leaves it unclear.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const s = xSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!POST_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const answer = await this.client.call<{ data?: { deleted?: unknown } }>('DELETE', `/tweets/${input.externalId}`, s.accessToken);
      return answer?.data?.deleted === true ? { kind: 'removed' } : { kind: 'unknown', code: 'NOT_DELETED' };
    } catch (error) {
      if (error instanceof XError && (error.status === 404 || error.status === 410)) return { kind: 'removed' };
      return removeResult(publishResult(error));
    }
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const s = xSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!POST_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const answer = await this.client.call<{ data?: { id?: unknown } }>('POST', '/tweets', s.accessToken, { json: { text: input.text, reply: { in_reply_to_tweet_id: input.externalId } } });
      const id = answer?.data?.id;
      if (typeof id !== 'string' || !POST_ID.test(id)) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: id };
    } catch (error) {
      return commentResult(publishResult(error));
    }
  }

  private async readFollowers(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const s = xSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    try {
      const answer = await this.client.call<{ data?: { id?: unknown; public_metrics?: { followers_count?: unknown } } }>('GET', '/users/me?user.fields=public_metrics', s.accessToken);
      if (answer?.data?.id !== input.externalAccountId) return null;
      const n = answer.data.public_metrics?.followers_count;
      return { followers: typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null };
    } catch (error) {
      if (error instanceof XError && error.status === 401) return { refused: 'token_expired' };
      if (error instanceof XError && error.status === 403) return { refused: 'permission' };
      return null;
    }
  }

  // Likes, replies, reposts and quotes, bookmarks and impressions of the account's own post, from public_metrics (one
  // post read). A post X no longer has is gone.
  private async readMetrics(input: MetricsInput): Promise<MetricsResult> {
    const s = xSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!POST_ID.test(input.externalId)) return { refused: 'gone' };
    try {
      const answer = await this.client.call<{ data?: { id?: unknown; public_metrics?: Record<string, unknown> }; errors?: { type?: unknown }[] }>('GET', `/tweets/${input.externalId}?tweet.fields=public_metrics`, s.accessToken);
      if (!answer?.data && answer?.errors?.some((e) => typeof e.type === 'string' && e.type.endsWith('/resource-not-found'))) return { refused: 'gone' };
      const m = answer?.data?.public_metrics;
      if (!m) return null;
      const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
      const reposts = n(m.retweet_count);
      const quotes = n(m.quote_count);
      const metrics = Object.fromEntries(
        Object.entries({
          reactions: n(m.like_count),
          comments: n(m.reply_count),
          shares: reposts === undefined && quotes === undefined ? undefined : (reposts ?? 0) + (quotes ?? 0),
          saves: n(m.bookmark_count),
          impressions: n(m.impression_count),
        }).filter(([, v]) => v !== undefined),
      );
      return { metrics };
    } catch (error) {
      if (error instanceof XError && error.status === 401) return { refused: 'token_expired' };
      if (error instanceof XError && error.status === 404) return { refused: 'gone' };
      return null;
    }
  }

  // The one visible step.
  private async post(token: string, text: string, mediaIds: readonly string[], extras: PostExtras): Promise<PublishResult> {
    const post: Record<string, unknown> = {};
    if (text) post.text = text;
    if (mediaIds.length > 0) post.media = { media_ids: mediaIds };
    if (extras.poll) post.poll = extras.poll;
    if (extras.reply_settings) post.reply_settings = extras.reply_settings;
    try {
      const answer = await this.client.call<{ data?: { id?: unknown } }>('POST', '/tweets', token, { json: post });
      const id = answer?.data?.id;
      if (typeof id !== 'string' || !POST_ID.test(id)) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: id, url: postUrl(id) };
    } catch (error) {
      return publishResult(error);
    }
  }

  // One video (#449): the chunked upload (initialize, append per chunk, finalize), a wait while X processes it, then
  // the post. The video is invisible until the post names it, so every failure before the post posted nothing, and a
  // video X is still processing when the wait ends is a transient failure: the next attempt uploads it again. The text
  // is not kept anywhere on X meanwhile, which is why the post is not left to a later status check.
  private async publishVideo(input: PublishInput, token: string, extras: PostExtras): Promise<PublishResult> {
    const { media } = input.content;
    const video = media[0];
    if (!video || media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_REQUIRED' };
    if (!VIDEO_TYPES.includes(video.mime)) return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TYPE' };
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    // One budget for the whole call, upload included, ending well before the job gives up on it (callTimeoutMs): past
    // it nothing is visible yet, so the call stops as transient instead of posting after the job recorded unknown.
    const budgetEnd = Date.now() + this.budgetMs;
    const late = (): PublishResult => ({ kind: 'rejected', error: 'transient', code: 'VIDEO_TOO_SLOW' });
    let id: string;
    try {
      const init = await this.client.call<{ data?: { id?: unknown } }>('POST', '/media/upload/initialize', token, {
        json: { media_type: video.mime, total_bytes: bytes.byteLength, media_category: 'tweet_video' },
      });
      const got = init?.data?.id;
      if (typeof got !== 'string' || !MEDIA_ID.test(got)) return { kind: 'rejected', error: 'transient', code: 'NO_MEDIA_ID' };
      id = got;
      for (let i = 0, start = 0; start < bytes.byteLength; i++, start += VIDEO_CHUNK) {
        if (Date.now() >= budgetEnd) return late();
        const form = new FormData();
        form.set('segment_index', String(i));
        form.set('media', new Blob([bytes.slice(start, start + VIDEO_CHUNK)], { type: 'application/octet-stream' }));
        await this.client.call('POST', `/media/upload/${id}/append`, token, { form });
      }
      const finished = await this.client.call<{ data?: { processing_info?: ProcessingInfo } }>('POST', `/media/upload/${id}/finalize`, token);
      let info = finished?.data?.processing_info;
      // No processing info right after finalize: the media is ready. After a status check only "succeeded" is.
      let ready = info === undefined || info.state === 'succeeded';
      const deadline = Math.min(Date.now() + this.processingWaitMs, budgetEnd);
      while (!ready) {
        if (info?.state === 'failed') return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_PROCESSING_FAILED', ...(typeof info.error?.message === 'string' ? { message: info.error.message } : {}) };
        if (Date.now() >= deadline) return { kind: 'rejected', error: 'transient', code: 'VIDEO_STILL_PROCESSING' };
        const after = Number(info?.check_after_secs);
        await sleep(Math.min(Math.max(Number.isFinite(after) ? after * 1000 : 5000, this.pollMinMs), 30_000, Math.max(0, deadline - Date.now())));
        const status = await this.client.call<{ data?: { processing_info?: ProcessingInfo } }>('GET', `/media/upload?${new URLSearchParams({ command: 'STATUS', media_id: id }).toString()}`, token);
        info = status?.data?.processing_info;
        ready = info?.state === 'succeeded';
      }
    } catch (error) {
      return beforePost(publishResult(error));
    }
    if (Date.now() >= budgetEnd) return late();
    return this.post(token, textOf(input.content), [id], extras);
  }

  // The account's own posts since just before the call, matched by their text with links left out. A post with no
  // text but its images cannot be told from another one, so it stays unknown.
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = xSecretOf(input.secret);
    const wanted = comparableText(textOf(input.content));
    if (!s || !wanted || !USER_ID.test(input.externalAccountId)) return { found: 'unknown' };
    const from = new Date(input.after.getTime() - 60_000);
    const to = input.before.getTime() + 10 * 60_000;
    try {
      const query = new URLSearchParams({ max_results: '20', exclude: 'replies,retweets', 'tweet.fields': 'created_at', start_time: from.toISOString().replace(/\.\d{3}Z$/, 'Z') });
      const answer = await this.client.call<Timeline>('GET', `/users/${input.externalAccountId}/tweets?${query.toString()}`, s.accessToken);
      for (const p of answer?.data ?? []) {
        const at = typeof p.created_at === 'string' ? Date.parse(p.created_at) : Number.NaN;
        if (typeof p.id === 'string' && POST_ID.test(p.id) && typeof p.text === 'string' && comparableText(p.text) === wanted && at >= from.getTime() && at <= to) {
          return { found: true, externalId: p.id, url: postUrl(p.id) };
        }
      }
      // X may have made a link of a host this cannot tell from text, so a miss there proves nothing.
      return MAYBE_LINK.test(comparableText(textOf(input.content))) ? { found: 'unknown' } : { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }
}
