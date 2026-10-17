// Meta (Facebook Pages; Instagram follows in S6.3), written from Meta's Graph API docs (Social plan §1: no code taken
// from other projects). One Meta app serves every org of a deployment: CHANNEL_META_APP_ID and
// CHANNEL_META_APP_SECRET. A self-hoster's own app works in development mode for people with a role on the app;
// others need App Review (docs/plan/social-research.md §4).
//
// Connect: Facebook Login with the Page permissions, then the short-lived user token becomes a long-lived one, and
// `/me/accounts` lists the Pages the user granted in Meta's dialog, each with its own Page token. A Page token from a
// long-lived user token has no expiry timer, so it is sealed as is; the user token is dropped.
import { createHmac } from 'node:crypto';
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RetrySafety } from './index.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const META_GRAPH_HOST = 'graph.facebook.com';
export const META_DEFAULT_GRAPH_VERSION = 'v24.0';
// What a Page connection needs: list the Pages, post to them, read posts back to reconcile and for metrics.
export const FACEBOOK_PAGE_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'] as const;

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
    this.fetch = allowlistedFetch([META_GRAPH_HOST], fetchImpl);
  }

  url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`https://${META_GRAPH_HOST}/${this.version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  async call<T>(method: 'GET' | 'POST', path: string, options: { token?: string; params?: Record<string, string>; form?: Record<string, string> } = {}): Promise<T> {
    const params = { ...options.params };
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
      params.appsecret_proof = createHmac('sha256', this.appSecret).update(options.token).digest('hex');
    }
    let body: string | undefined;
    if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }
    const response = await this.fetch(this.url(path, params), { method, headers, ...(body === undefined ? {} : { body }) });
    const json = (await response.json().catch(() => null)) as ({ error?: GraphErrorBody } & Record<string, unknown>) | null;
    if (!response.ok || !json || json.error) throw new GraphError(response.status, json?.error);
    return json as T;
  }
}

interface TokenAnswer {
  access_token?: unknown;
}
interface PermissionsAnswer {
  data?: { permission?: unknown; status?: unknown }[];
}
interface AccountsAnswer {
  data?: { id?: unknown; name?: unknown; access_token?: unknown; tasks?: unknown }[];
  paging?: { cursors?: { after?: unknown }; next?: unknown };
}

const MAX_PAGES_LISTED = 1000;

export class FacebookPageConnector implements OAuthConnector {
  readonly provider = 'facebook_page' as const;
  readonly pkce = false;
  private readonly app: MetaAppConfig;
  private readonly graph: Graph;

  constructor(app: MetaAppConfig, fetchImpl?: Fetch) {
    if (!/^\d{1,32}$/.test(app.appId)) throw new Error('invalid Meta app id');
    if (!app.appSecret) throw new Error('missing Meta app secret');
    this.app = app;
    this.graph = new Graph(app.appSecret, app.graphVersion, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL(`https://www.facebook.com/${this.graph.version}/dialog/oauth`);
    url.searchParams.set('client_id', this.app.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', FACEBOOK_PAGE_SCOPES.join(','));
    // Asks again for a permission the user declined last time; without it Meta skips declined permissions for good.
    url.searchParams.set('auth_type', 'rerequest');
    return url.toString();
  }

  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
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
    const shortToken = tokenOf(short);
    const long = await this.graph
      .call<TokenAnswer>('POST', 'oauth/access_token', {
        form: { grant_type: 'fb_exchange_token', client_id: this.app.appId, client_secret: this.app.appSecret, fb_exchange_token: shortToken },
      })
      .catch(asProviderErrorThrow);
    const userToken = tokenOf(long);

    const permissions = await this.graph.call<PermissionsAnswer>('GET', 'me/permissions', { token: userToken }).catch(asProviderErrorThrow);
    const granted = new Set((permissions.data ?? []).filter((p) => p.status === 'granted' && typeof p.permission === 'string').map((p) => p.permission as string));
    const missing = FACEBOOK_PAGE_SCOPES.filter((s) => !granted.has(s));
    if (missing.length > 0) throw new ConnectorError('denied', `Meta did not grant ${missing.join(', ')}`, 'MISSING_PERMISSION');
    const scopes = FACEBOOK_PAGE_SCOPES.filter((s) => granted.has(s));

    const accounts: ConnectedAccount[] = [];
    let after: string | null = null;
    for (let listed = 0; listed < MAX_PAGES_LISTED; ) {
      const params: Record<string, string> = { fields: 'id,name,access_token,tasks', limit: '100' };
      if (after) params.after = after;
      const page = await this.graph.call<AccountsAnswer>('GET', 'me/accounts', { token: userToken, params }).catch(asProviderErrorThrow);
      const rows = page.data ?? [];
      listed += rows.length;
      for (const row of rows) {
        // Posting needs the CREATE_CONTENT task on the Page; a Page the user only moderates cannot be connected.
        const tasks = Array.isArray(row.tasks) ? row.tasks : [];
        if (typeof row.id !== 'string' || !/^\d{1,32}$/.test(row.id) || typeof row.access_token !== 'string' || !row.access_token) continue;
        if (!tasks.includes('CREATE_CONTENT')) continue;
        const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : `Facebook Page ${row.id}`;
        accounts.push({ provider: 'facebook_page', externalAccountId: row.id, displayName: name, scopes: [...scopes], expiresAt: null, secret: JSON.stringify({ accessToken: row.access_token }) });
      }
      const cursor = page.paging?.cursors?.after;
      if (rows.length === 0 || typeof page.paging?.next !== 'string' || typeof cursor !== 'string') break;
      after = cursor;
    }
    return accounts;
  }
}

function tokenOf(answer: TokenAnswer): string {
  if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Meta answered without an access token');
  return answer.access_token;
}

function asProviderError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof GraphError) return new ConnectorError(error.status === 403 || error.code === 10 || error.code === 200 ? 'denied' : 'provider', error.message, String(error.code ?? error.status));
  // fetch's own message (DNS, TLS, timeout) for the log; our URLs carry no token.
  return new ConnectorError('provider', `Meta could not be reached: ${error instanceof Error ? `: ${error.message}` : typeof error}`);
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
// 1 and 2: Meta's "unknown error" and "service unavailable"; 506: a duplicate of a post that went through.
const UNCLEAR_CODES = new Set([1, 2, 506]);

interface FeedAnswer {
  id?: unknown;
}
interface PostsAnswer {
  data?: { id?: unknown; message?: unknown; created_time?: unknown; permalink_url?: unknown }[];
}

function pageToken(secret: string): string | null {
  try {
    const token = (JSON.parse(secret) as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

// What Facebook shows as the post's text. Facebook Pages have no title; a link is sent apart and previewed.
const feedMessage = (content: { body: string }) => content.body.trim();
const postUrl = (id: string) => `https://www.facebook.com/${encodeURIComponent(id)}`;

export function graphPublishResult(error: unknown): PublishResult {
  if (!(error instanceof GraphError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code;
  const base = { code: code === undefined ? `HTTP_${error.status}` : String(code), message: error.message, httpStatus: error.status };
  if (error.status >= 500 || (code !== undefined && UNCLEAR_CODES.has(code))) return { kind: 'unknown', code: base.code, message: base.message };
  if ((code !== undefined && TOKEN_CODES.has(code)) || error.status === 401) return { kind: 'rejected', error: 'token_expired', ...base };
  if ((code !== undefined && (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299))) || error.status === 403) return { kind: 'rejected', error: 'permission', ...base };
  if ((code !== undefined && RATE_CODES.has(code)) || error.status === 429) return { kind: 'rejected', error: 'rate_limited', ...base };
  if (error.status >= 400) return { kind: 'rejected', error: 'bad_request', ...base };
  return { kind: 'unknown', code: base.code, message: base.message };
}

export class FacebookPagePublisher implements Publisher {
  readonly provider = 'facebook_page' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly graph: Graph;

  constructor(app: Pick<MetaAppConfig, 'appSecret' | 'graphVersion'>, fetchImpl?: Fetch) {
    if (!app.appSecret) throw new Error('missing Meta app secret');
    this.graph = new Graph(app.appSecret, app.graphVersion, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = pageToken(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!/^\d{1,32}$/.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_PAGE_ID' };
    const form: Record<string, string> = { message: feedMessage(input.content) };
    if (input.content.linkUrl) form.link = input.content.linkUrl;
    if (!form.message && !form.link) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    try {
      const answer = await this.graph.call<FeedAnswer>('POST', `${input.externalAccountId}/feed`, { token, form });
      // Meta answered 200 without an id: it may have posted.
      if (typeof answer.id !== 'string' || !answer.id) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: answer.id, url: postUrl(answer.id) };
    } catch (error) {
      return graphPublishResult(error);
    }
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const token = pageToken(input.secret);
    if (!token || !/^\d{1,32}$/.test(input.externalAccountId)) return { found: 'unknown' };
    const message = feedMessage(input.content);
    // A link-only post has no message to match on, so it cannot be found again.
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