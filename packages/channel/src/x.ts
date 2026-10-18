// X posts (S9, issue #420), written from the X API v2 docs (OAuth 2.0 authorization code with PKCE, POST /2/tweets,
// POST /2/media/upload). The deployment's own X developer app: CHANNEL_X_CLIENT_ID and CHANNEL_X_CLIENT_SECRET. X
// bills each post to that app's account.
//
// Connect: X's dialog for tweet.read, tweet.write, users.read, media.write and offline.access, with PKCE; the access
// token lives two hours and the refresh schedule renews it, keeping whichever refresh token X hands back.
// Publish: each image is uploaded first (nothing is visible until a post names it), then one POST /2/tweets. Video
// waits for the chunked upload. An unclear answer is checked against the account's recent posts by text and time.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RetrySafety } from './index.ts';
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

  async call<T>(method: 'GET' | 'POST', path: string, token: string, body?: { json: unknown } | { form: FormData }): Promise<T | null> {
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
    if (codeStep && error.status >= 400 && error.status < 500) return new ConnectorError('invalid_grant', 'X refused the authorization code', error.code ?? String(error.status));
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
  // 402: the app's account has no credit left for posts; 403: the app or the account may not post this.
  if (error.status === 402 || error.status === 403) return { kind: 'rejected', error: 'permission', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

// Nothing is visible before the post itself, so a failure while uploading images posted nothing.
const beforePost = (result: PublishResult): PublishResult =>
  result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !body.includes(content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};

// A post's text as X returns it, comparable with what was sent: X replaces links with t.co links and escapes &, < and
// >, so links are dropped and entities decoded before comparing.
export function comparableText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

const postUrl = (id: string) => `https://x.com/i/status/${id}`;

interface Timeline {
  data?: { id?: unknown; text?: unknown; created_at?: unknown }[];
}

export class XPublisher implements Publisher {
  readonly provider = 'x' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly client: XClient;

  constructor(app: XAppConfig, fetchImpl?: Fetch) {
    this.client = new XClient(app, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = xSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    const { media } = input.content;
    if (media.some((m) => m.mime.startsWith('video/'))) return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_NOT_SUPPORTED' };
    if (media.length > MAX_IMAGES) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_IMAGES' };
    if (media.some((m) => !IMAGE_TYPES.includes(m.mime))) return { kind: 'rejected', error: 'bad_request', code: 'IMAGE_TYPE' };
    const text = textOf(input.content);
    if (!text && media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    // Every image is read before the first upload, so a read failure posts nothing.
    const files: { bytes: Uint8Array; mime: string }[] = [];
    for (const m of media) {
      try {
        files.push({ bytes: await input.readMedia(m.fileId), mime: m.mime });
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
    }
    const mediaIds: string[] = [];
    for (const f of files) {
      const form = new FormData();
      form.set('media', new Blob([new Uint8Array(f.bytes)], { type: f.mime }));
      form.set('media_category', 'tweet_image');
      try {
        const uploaded = await this.client.call<{ data?: { id?: unknown } }>('POST', '/media/upload', s.accessToken, { form });
        const id = uploaded?.data?.id;
        if (typeof id !== 'string' || !MEDIA_ID.test(id)) return { kind: 'rejected', error: 'transient', code: 'NO_MEDIA_ID' };
        mediaIds.push(id);
      } catch (error) {
        return beforePost(publishResult(error));
      }
    }
    const post: Record<string, unknown> = {};
    if (text) post.text = text;
    if (mediaIds.length > 0) post.media = { media_ids: mediaIds };
    try {
      const answer = await this.client.call<{ data?: { id?: unknown } }>('POST', '/tweets', s.accessToken, { json: post });
      const id = answer?.data?.id;
      if (typeof id !== 'string' || !POST_ID.test(id)) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: id, url: postUrl(id) };
    } catch (error) {
      return publishResult(error);
    }
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
      return { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }
}
