// Zalo Official Account (S6.4, issue #374). Endpoints and fields from Zalo's OA API v2 and OAuth v4, cross-checked with
// a community SDK; not yet tried against a live OA (docs/plan/social-research.md §4 marks the open points). One Zalo
// app serves every org of a deployment: CHANNEL_ZALO_APP_ID and CHANNEL_ZALO_APP_SECRET.
//
// Connect: OAuth v4 with PKCE. The OA admin grants the app; the code becomes an access token (about 25 hours) and a
// refresh token (3 months, single use: every refresh returns a new one, and the old one stops working). The refresh
// schedule in the worker renews tokens before they expire and seals the new pair at once.
//
// Publish: an article is created asynchronously (`article/create` answers a token), then `article/verify` turns the
// token into the article id once Zalo has processed it. The cover is fetched by Zalo from a public URL (1 MB at most).
import type { ConnectedAccount, MetricName, MetricsInput, MetricsResult, Publisher, Refresher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RetrySafety, StatusInput } from './index.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const ZALO_HOSTS = ['oauth.zaloapp.com', 'openapi.zalo.me'] as const;
const TOKEN_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
const API = 'https://openapi.zalo.me/v2.0';
// Zalo's error codes for a token it no longer accepts.
const TOKEN_ERRORS = new Set([-216, -124, -118]);
const CHECK_AFTER_SECONDS = 20;
const TITLE_MAX = 150;
const DESCRIPTION_MAX = 300;
const AUTHOR_MAX = 50;

export interface ZaloAppConfig {
  appId: string;
  appSecret: string;
}

// What the kernel seals for a Zalo OA connection. Both tokens rotate on every refresh.
export interface ZaloSecret {
  accessToken: string;
  refreshToken: string;
}

export function zaloSecretOf(secret: string): ZaloSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<ZaloSecret>;
    return typeof s.accessToken === 'string' && s.accessToken && typeof s.refreshToken === 'string' && s.refreshToken ? { accessToken: s.accessToken, refreshToken: s.refreshToken } : null;
  } catch {
    return null;
  }
}

// A Zalo answer that is not a success: `error` is Zalo's own code (0 is success), `status` the HTTP status.
export class ZaloError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(status: number, code: number | undefined, message: string) {
    super(message);
    this.name = 'ZaloError';
    this.status = status;
    this.code = code;
  }
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_name?: unknown;
  error_description?: unknown;
  message?: unknown;
}

// The account a token pair belongs to, with when the access token expires.
export interface ZaloTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

class ZaloClient {
  private readonly app: ZaloAppConfig;
  private readonly fetch: Fetch;

  constructor(app: ZaloAppConfig, fetchImpl?: Fetch) {
    if (!/^\d{1,32}$/.test(app.appId)) throw new Error('invalid Zalo app id');
    if (!app.appSecret) throw new Error('missing Zalo app secret');
    this.app = app;
    this.fetch = allowlistedFetch(ZALO_HOSTS, fetchImpl);
  }

  get appId(): string {
    return this.app.appId;
  }

  // The token endpoint, for a code or a refresh token; the app secret travels in the secret_key header.
  async token(form: Record<string, string>, now = Date.now()): Promise<ZaloTokens> {
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', secret_key: this.app.appSecret, accept: 'application/json' },
      body: new URLSearchParams({ app_id: this.app.appId, ...form }).toString(),
    });
    const json = (await response.json().catch(() => null)) as TokenAnswer | null;
    const code = typeof json?.error === 'number' ? json.error : undefined;
    if (!response.ok || !json || (code !== undefined && code !== 0) || typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string') {
      const message = typeof json?.error_description === 'string' ? json.error_description : typeof json?.message === 'string' ? json.message : `token endpoint answered ${response.status}`;
      throw new ZaloError(response.status, code, message);
    }
    // expires_in is a string of seconds in Zalo's answers; 25 hours when it is missing.
    const seconds = Number(json.expires_in ?? 90_000);
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 90_000) * 1000) };
  }

  async api<T>(method: 'GET' | 'POST', path: string, token: string, options: { params?: Record<string, string>; json?: unknown } = {}): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { access_token: token, accept: 'application/json' };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    const response = await this.fetch(url.toString(), { method, headers, ...(body === undefined ? {} : { body }) });
    const json = (await response.json().catch(() => null)) as ({ error?: unknown; message?: unknown; data?: unknown } & Record<string, unknown>) | null;
    const code = typeof json?.error === 'number' ? json.error : undefined;
    if (!response.ok || !json || (code !== undefined && code !== 0)) {
      throw new ZaloError(response.status, code, typeof json?.message === 'string' ? json.message : `Zalo answered ${response.status}`);
    }
    return json.data as T;
  }
}

function connectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof ZaloError) {
    // A refused code (used, expired, other redirect or verifier) comes back as a 4xx or a negative error code.
    if (error.status >= 500) return new ConnectorError('provider', error.message, String(error.code ?? error.status));
    return new ConnectorError('invalid_grant', 'Zalo refused the authorization code', String(error.code ?? error.status));
  }
  return new ConnectorError('provider', `Zalo could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

interface OaAnswer {
  oa_id?: unknown;
  name?: unknown;
}

export class ZaloOaConnector implements OAuthConnector {
  readonly provider = 'zalo_oa' as const;
  readonly pkce = true;
  private readonly client: ZaloClient;

  constructor(app: ZaloAppConfig, fetchImpl?: Fetch) {
    this.client = new ZaloClient(app, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    if (!input.codeChallenge) throw new Error('Zalo OA needs PKCE');
    const url = new URL('https://oauth.zaloapp.com/v4/oa/permission');
    url.searchParams.set('app_id', this.client.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  // One grant covers one OA: the one whose admin approved the app.
  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
    if (!input.codeVerifier) throw new ConnectorError('invalid_grant', 'missing PKCE verifier');
    const tokens = await this.client.token({ code: input.code, grant_type: 'authorization_code', code_verifier: input.codeVerifier }).catch((error: unknown) => {
      throw connectorError(error);
    });
    const oa = await this.client.api<OaAnswer>('GET', 'oa/getoa', tokens.accessToken).catch((error: unknown) => {
      throw error instanceof ZaloError && error.status < 500 ? new ConnectorError('denied', error.message, String(error.code ?? error.status)) : connectorError(error);
    });
    const id = typeof oa?.oa_id === 'string' || typeof oa?.oa_id === 'number' ? String(oa.oa_id) : '';
    if (!/^\d{1,32}$/.test(id)) throw new ConnectorError('provider', 'Zalo answered without an OA id');
    const name = typeof oa?.name === 'string' && oa.name.trim() ? oa.name.trim().slice(0, 200) : `Zalo OA ${id}`;
    const secret: ZaloSecret = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    return [{ provider: 'zalo_oa', externalAccountId: id, displayName: name, scopes: ['oa'], expiresAt: tokens.expiresAt, secret: JSON.stringify(secret) }];
  }
}

// Renews a connection's tokens. The refresh token is single use: the caller stores the new pair before anything else
// uses the connection, and never retries a refresh whose answer it lost (the old token is gone either way).
export class ZaloOaRefresher implements Refresher {
  readonly provider = 'zalo_oa' as const;
  private readonly client: ZaloClient;

  constructor(app: ZaloAppConfig, fetchImpl?: Fetch) {
    this.client = new ZaloClient(app, fetchImpl);
  }

  // refused: Zalo turned the refresh token down (invalid, expired or already used): the connection needs reconnecting.
  // Anything else (a rate limit, an outage, an answer we do not know) is a failure: the token may still be good, and the
  // next sweep tries again; if it really is dead, the access token expires and publishing marks the connection expired.
  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date } | { refused: string } | { failed: string }> {
    const s = zaloSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const tokens = await this.client.token({ refresh_token: s.refreshToken, grant_type: 'refresh_token' });
      return { secret: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } satisfies ZaloSecret), expiresAt: tokens.expiresAt };
    } catch (error) {
      if (error instanceof ZaloError && refusedRefresh(error)) return { refused: String(error.code ?? error.status) };
      return { failed: error instanceof ZaloError ? String(error.code ?? error.status) : 'NETWORK' };
    }
  }
}

// A refresh Zalo refused for the token itself: its code for an invalid refresh token, or a message naming one.
const REFRESH_REFUSED = new Set([-14020, -14014]);
function refusedRefresh(error: ZaloError): boolean {
  if (error.status === 429 || error.status === 408 || error.status >= 500 || error.status < 200) return false;
  if (error.code !== undefined && REFRESH_REFUSED.has(error.code)) return true;
  return /refresh[ _]?token/i.test(error.message) && /invalid|expired|used|revoked/i.test(error.message);
}

interface CreateAnswer {
  token?: unknown;
}
interface VerifyAnswer {
  id?: unknown;
}
interface SliceAnswer {
  // create_date: milliseconds since the epoch.
  medias?: { id?: unknown; title?: unknown; create_date?: unknown }[];
}

interface DetailAnswer {
  total_view?: unknown;
  total_share?: unknown;
}
// Zalo gives counts as numbers or numeric strings.
function count(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function zaloPublishResult(error: unknown): PublishResult {
  if (!(error instanceof ZaloError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code === undefined ? `HTTP_${error.status}` : String(error.code);
  if (error.status >= 500) return { kind: 'unknown', code, message: error.message };
  if ((error.code !== undefined && TOKEN_ERRORS.has(error.code)) || error.status === 401) return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

// The article Zalo shows: the post's title and text, the text's first lines as the description, the image as cover.
function articleOf(input: PublishInput, coverUrl: string) {
  const body = input.content.body.trim();
  const description = (body.split('\n').find((line) => line.trim()) ?? body).trim().slice(0, DESCRIPTION_MAX);
  const author = typeof input.settings.author === 'string' && input.settings.author.trim() ? input.settings.author.trim().slice(0, AUTHOR_MAX) : 'Crove';
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (input.content.linkUrl) paragraphs.push(input.content.linkUrl);
  return {
    type: 'normal',
    title: (input.content.title ?? '').trim().slice(0, TITLE_MAX),
    author,
    cover: { cover_type: 'photo', photo_url: coverUrl, status: 'show' },
    description,
    body: paragraphs.map((content) => ({ type: 'text', content })),
    status: 'show',
    comment: 'show',
  };
}

export class ZaloOaPublisher implements Publisher {
  readonly provider = 'zalo_oa' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly client: ZaloClient;

  constructor(app: ZaloAppConfig, fetchImpl?: Fetch) {
    this.client = new ZaloClient(app, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = zaloSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    const cover = input.content.media[0];
    if (!cover) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_REQUIRED' };
    if (!(input.content.title ?? '').trim()) return { kind: 'rejected', error: 'bad_request', code: 'TITLE_REQUIRED' };
    const coverUrl = await input.mediaUrl(cover.fileId).catch(() => null);
    if (!coverUrl) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
    let token: string;
    try {
      const answer = await this.client.api<CreateAnswer>('POST', 'article/create', s.accessToken, { json: articleOf(input, coverUrl) });
      if (typeof answer?.token !== 'string' || !answer.token) return { kind: 'unknown', code: 'NO_ARTICLE_TOKEN' };
      token = answer.token;
    } catch (error) {
      return zaloPublishResult(error);
    }
    // The article exists from here; the token tells where it stands. Nothing after this point is a rejection.
    const verified = await this.verify(s.accessToken, token);
    return verified.kind === 'rejected' ? { kind: 'pending', externalRef: token, checkAfterSeconds: CHECK_AFTER_SECONDS } : verified;
  }

  async status(input: StatusInput): Promise<PublishResult> {
    const s = zaloSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    return this.verify(s.accessToken, input.externalRef);
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = zaloSecretOf(input.secret);
    const title = (input.content.title ?? '').trim().slice(0, TITLE_MAX);
    if (!s || !title) return { found: 'unknown' };
    try {
      const answer = await this.client.api<SliceAnswer>('GET', 'article/getslice', s.accessToken, { params: { offset: '0', limit: '20', type: 'normal' } });
      // The same title is often reused (a weekly offer), so only an article created in the call's window counts; one
      // without a creation time cannot be told apart from an older one.
      const from = input.after.getTime() - 60_000;
      const to = input.before.getTime() + 60_000;
      let undated = false;
      for (const m of answer?.medias ?? []) {
        // Zalo gives ids as strings or numbers.
        const id = typeof m.id === 'string' || typeof m.id === 'number' ? String(m.id) : '';
        if (!id || m.title !== title) continue;
        const at = typeof m.create_date === 'number' ? m.create_date : typeof m.create_date === 'string' ? Number(m.create_date) : Number.NaN;
        if (!Number.isFinite(at)) undated = true;
        else if (at >= from && at <= to) return { found: true, externalId: id, url: null };
      }
      return undated ? { found: 'unknown' } : { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }

  // Views and shares of an article, when Zalo reports them on its detail.
  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const s = zaloSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.externalId)) return { refused: 'gone' };
    try {
      const answer = await this.client.api<DetailAnswer>('GET', 'article/getdetail', s.accessToken, { params: { id: input.externalId } });
      const metrics: Partial<Record<MetricName, number>> = {};
      const views = count(answer?.total_view);
      const shares = count(answer?.total_share);
      if (views !== undefined) metrics.views = views;
      if (shares !== undefined) metrics.shares = shares;
      return { metrics };
    } catch (error) {
      const result = zaloPublishResult(error);
      if (result.kind === 'rejected' && result.error === 'token_expired') return { refused: 'token_expired' };
      return null;
    }
  }

  private async verify(accessToken: string, token: string): Promise<PublishResult> {
    try {
      const answer = await this.client.api<VerifyAnswer>('POST', 'article/verify', accessToken, { json: { token } });
      const id = typeof answer?.id === 'string' || typeof answer?.id === 'number' ? String(answer.id) : '';
      return id ? { kind: 'accepted', externalId: id, url: null } : { kind: 'pending', externalRef: token, checkAfterSeconds: CHECK_AFTER_SECONDS };
    } catch (error) {
      const result = zaloPublishResult(error);
      // A refused token, or Zalo refusing the article itself (a 4xx), ends the check; a token still processing or an
      // answer that did not come is checked again later.
      return result.kind === 'rejected' && (result.error === 'token_expired' || result.error === 'bad_request') ? result : { kind: 'pending', externalRef: token, checkAfterSeconds: CHECK_AFTER_SECONDS };
    }
  }
}
