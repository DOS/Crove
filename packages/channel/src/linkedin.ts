// LinkedIn member posts (S9, issue #392), written from LinkedIn's "Share on LinkedIn", Posts API and Images API docs.
// A self-serve app (products "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn"):
// CHANNEL_LINKEDIN_CLIENT_ID and CHANNEL_LINKEDIN_CLIENT_SECRET.
//
// Connect: the OAuth dialog for openid, profile and w_member_social; the access token lives 60 days and self-serve apps
// get no refresh token, so the member reconnects before it expires (the channels screen says when).
// Publish: images are uploaded first (initializeUpload, then a PUT of the bytes; nothing is visible until the post
// names them), then one POST /rest/posts. A member app cannot list the member's posts, so an unclear answer cannot be
// checked: publishSafety 'never', and such a post waits for a person.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, RetrySafety } from './index.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

// Upload URLs LinkedIn hands out are on www.linkedin.com (dms-uploads) or api.linkedin.com (mediaUpload).
export const LINKEDIN_HOSTS = ['www.linkedin.com', 'api.linkedin.com'] as const;
export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'] as const;
const API = 'https://api.linkedin.com';
// The Posts and Images APIs are versioned by month (Linkedin-Version: YYYYMM); each version is served for a year.
export const LINKEDIN_VERSION = '202604';
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_LIFETIME_SECONDS = 60 * 86_400;
// LinkedIn shows at most 20 images in a post.
const MAX_IMAGES = 20;

export interface LinkedInAppConfig {
  clientId: string;
  clientSecret: string;
  version?: string;
}

export class LinkedInError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, body: Record<string, unknown> | null) {
    const message = typeof body?.message === 'string' ? body.message : typeof body?.error_description === 'string' ? body.error_description : `LinkedIn answered ${status}`;
    super(message);
    this.name = 'LinkedInError';
    this.status = status;
    const code = body?.code ?? body?.serviceErrorCode ?? body?.error;
    this.code = typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
  }
}

// Reserved characters of LinkedIn's "little text" commentary, which would otherwise start a mention, hashtag or
// template and drop the text after them.
export function littleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

class LinkedInClient {
  private readonly fetch: Fetch;
  private readonly version: string;

  constructor(version: string, fetchImpl?: Fetch) {
    this.fetch = allowlistedFetch(LINKEDIN_HOSTS, fetchImpl, 30_000);
    this.version = version;
  }

  async token(form: Record<string, string>): Promise<{ access_token?: unknown; expires_in?: unknown; scope?: unknown }> {
    const response = await this.fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new LinkedInError(response.status, json);
    return json;
  }

  // A JSON call to the versioned REST API (or /v2/userinfo). Returns the body and the x-restli-id header.
  async call<T>(method: 'GET' | 'POST', path: string, token: string, json?: unknown): Promise<{ body: T | null; id: string | null; status: number }> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', 'X-Restli-Protocol-Version': '2.0.0' };
    if (path.startsWith('/rest/')) headers['Linkedin-Version'] = this.version;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetch(`${API}${path}`, { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw new LinkedInError(response.status, body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null);
    return { body: body as T | null, id: response.headers.get('x-restli-id'), status: response.status };
  }

  async upload(url: string, token: string, bytes: Uint8Array, type: string): Promise<void> {
    const response = await this.fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: new Blob([new Uint8Array(bytes)], { type }) });
    if (!response.ok) throw new LinkedInError(response.status, null);
  }
}

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof LinkedInError) {
    if (codeStep && error.status >= 400 && error.status < 500) return new ConnectorError('invalid_grant', 'LinkedIn refused the authorization code', error.code ?? String(error.status));
    return new ConnectorError(error.status === 403 ? 'denied' : 'provider', error.message, error.code ?? String(error.status));
  }
  return new ConnectorError('provider', `LinkedIn could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

export class LinkedInConnector implements OAuthConnector {
  readonly provider = 'linkedin' as const;
  readonly pkce = false;
  private readonly app: LinkedInAppConfig;
  private readonly client: LinkedInClient;

  constructor(app: LinkedInAppConfig, fetchImpl?: Fetch) {
    if (!/^[A-Za-z0-9]{8,64}$/.test(app.clientId)) throw new Error('invalid LinkedIn client id');
    if (!app.clientSecret) throw new Error('missing LinkedIn client secret');
    this.app = app;
    this.client = new LinkedInClient(app.version ?? LINKEDIN_VERSION, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.app.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', LINKEDIN_SCOPES.join(' '));
    return url.toString();
  }

  async exchange(input: ExchangeInput, now = Date.now()): Promise<ConnectedAccount[]> {
    const answer = await this.client
      .token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, client_id: this.app.clientId, client_secret: this.app.clientSecret })
      .catch((error: unknown) => {
        throw connectorError(error, true);
      });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'LinkedIn answered without an access token');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(/[ ,]+/).filter(Boolean) : [...LINKEDIN_SCOPES];
    if (!granted.includes('w_member_social')) throw new ConnectorError('denied', 'LinkedIn did not grant w_member_social', 'MISSING_PERMISSION');
    const me = await this.client.call<{ sub?: unknown; name?: unknown }>('GET', '/v2/userinfo', answer.access_token).catch((error: unknown) => {
      throw connectorError(error);
    });
    const sub = typeof me.body?.sub === 'string' ? me.body.sub : '';
    if (!MEMBER_ID.test(sub)) throw new ConnectorError('provider', 'LinkedIn answered without a member id');
    const seconds = Number(answer.expires_in);
    const expiresAt = new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_LIFETIME_SECONDS) * 1000);
    const name = typeof me.body?.name === 'string' && me.body.name.trim() ? me.body.name.trim() : `LinkedIn ${sub}`;
    return [{ provider: 'linkedin', externalAccountId: sub, displayName: name.slice(0, 200), scopes: granted, expiresAt, secret: JSON.stringify({ accessToken: answer.access_token }) }];
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

function publishResult(error: unknown): PublishResult {
  if (!(error instanceof LinkedInError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code ?? `HTTP_${error.status}`;
  if (error.status >= 500 || error.status < 400) return { kind: 'unknown', code, message: error.message };
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  if (error.status === 403) return { kind: 'rejected', error: 'permission', code, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

// Nothing is visible before the post itself, so a failure while uploading images posted nothing.
const beforePost = (result: PublishResult): PublishResult =>
  result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !body.includes(content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};

export class LinkedInPublisher implements Publisher {
  readonly provider = 'linkedin' as const;
  readonly publishSafety: RetrySafety = 'never';
  private readonly client: LinkedInClient;

  constructor(app: Pick<LinkedInAppConfig, 'version'> = {}, fetchImpl?: Fetch) {
    this.client = new LinkedInClient(app.version ?? LINKEDIN_VERSION, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = tokenIn(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!MEMBER_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    const author = `urn:li:person:${input.externalAccountId}`;
    if (input.content.media.length > MAX_IMAGES) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_IMAGES' };
    const images: { id: string; altText?: string }[] = [];
    for (const m of input.content.media) {
      let bytes: Uint8Array;
      try {
        bytes = await input.readMedia(m.fileId);
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
      try {
        const init = await this.client.call<{ value?: { uploadUrl?: unknown; image?: unknown } }>('POST', '/rest/images?action=initializeUpload', token, { initializeUploadRequest: { owner: author } });
        const uploadUrl = init.body?.value?.uploadUrl;
        const image = init.body?.value?.image;
        if (typeof uploadUrl !== 'string' || typeof image !== 'string' || !image.startsWith('urn:li:image:')) return { kind: 'rejected', error: 'transient', code: 'NO_UPLOAD_URL' };
        await this.client.upload(uploadUrl, token, bytes, m.mime);
        images.push({ id: image, ...(m.altText ? { altText: m.altText.slice(0, 4086) } : {}) });
      } catch (error) {
        return beforePost(publishResult(error));
      }
    }
    const text = textOf(input.content);
    if (!text && images.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    const post: Record<string, unknown> = {
      author,
      commentary: littleText(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (images.length === 1) post.content = { media: images[0] };
    else if (images.length > 1) post.content = { multiImage: { images } };
    try {
      const answer = await this.client.call('POST', '/rest/posts', token, post);
      const urn = answer.id ?? '';
      // Created, but without the id LinkedIn names it by: it went out, and nothing here can say where.
      if (!/^urn:li:(share|ugcPost):\d{1,32}$/.test(urn)) return { kind: 'unknown', code: 'NO_POST_ID' };
      return { kind: 'accepted', externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
    } catch (error) {
      return publishResult(error);
    }
  }
}
