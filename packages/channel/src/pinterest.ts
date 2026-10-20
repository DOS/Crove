// Pinterest (#798), written from the Pinterest API v5 docs (OAuth, boards, pins, pin analytics). One Pinterest app
// serves every org of a deployment: CHANNEL_PINTEREST_APP_ID and CHANNEL_PINTEREST_APP_SECRET.
//
// Connect: Pinterest's consent screen for boards, pins and the user account; the app's id and secret go in Basic auth.
// A pin is always saved to a board, so each of the account's boards becomes a channel of its own ("Shop / Spring
// menu"), all sharing the account's tokens; the access token lives 30 days and the refresh schedule renews it. Each
// board's connection renews its own copy: this assumes a continuous refresh token stays valid after use (Pinterest's
// 2025 notes); if it turns out to rotate, sibling boards ask to reconnect (follow-up in the PR).
// Publish: one call, POST /v5/pins, with the image's bytes in the request (base64, no public URL needed), or 2 to 5
// images as a carousel pin. The post's title is the pin's title, its text the description, its link where the pin
// leads. Video pins are not posted yet (VIDEO_NOT_SUPPORTED_YET). An unclear answer is checked by listing the board's
// latest pins, matched by title and description and their time.
// Metrics: impressions, saves and clicks of a pin from its pin_metrics.
import type { ConnectedAccount, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RetrySafety } from './index.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const PINTEREST_HOSTS = ['api.pinterest.com'] as const;
export const PINTEREST_SCOPES = ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'] as const;
const API = 'https://api.pinterest.com/v5';
const ID = /^\d{1,32}$/;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 800;
const ALT_TEXT_MAX = 500;
// The types an image_base64 source takes.
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
// A carousel pin holds 2 to 5 images.
const CAROUSEL_MAX = 5;
// Boards one connect lists at most (a page of 250, as Pinterest pages them).
const BOARDS_MAX = 250;

export interface PinterestAppConfig {
  appId: string;
  appSecret: string;
}

export class PinterestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, body: Record<string, unknown> | null) {
    const message = [body?.message, body?.error_description, body?.error].find((m): m is string => typeof m === 'string' && m !== '') ?? `Pinterest answered ${status}`;
    super(message);
    this.name = 'PinterestError';
    this.status = status;
    const code = body?.code ?? body?.error;
    this.code = typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
  }
}

export interface PinterestSecret {
  accessToken: string;
  refreshToken: string;
}

export function pinterestSecretOf(secret: string): PinterestSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<PinterestSecret>;
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

class PinterestClient {
  private readonly fetch: Fetch;
  private readonly app: PinterestAppConfig;

  constructor(app: PinterestAppConfig, fetchImpl?: Fetch) {
    if (!/^\d{4,32}$/.test(app.appId)) throw new Error('invalid Pinterest app id');
    if (!app.appSecret) throw new Error('missing Pinterest app secret');
    this.app = app;
    this.fetch = allowlistedFetch(PINTEREST_HOSTS, fetchImpl, 60_000);
  }

  get appId(): string {
    return this.app.appId;
  }

  async token(form: Record<string, string>): Promise<TokenAnswer> {
    const basic = Buffer.from(`${this.app.appId}:${this.app.appSecret}`).toString('base64');
    const response = await this.fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new PinterestError(response.status, json);
    return json as TokenAnswer;
  }

  async call<T>(method: 'GET' | 'POST', path: string, token: string, json?: unknown): Promise<T | null> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (json !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetch(`${API}${path}`, { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new PinterestError(response.status, body);
    return body as T | null;
  }
}

const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 30 * 86_400) * 1000);
};

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof PinterestError) {
    if (codeStep && error.status >= 400 && error.status < 500 && error.status !== 401) return new ConnectorError('invalid_grant', 'Pinterest refused the authorization code', error.code ?? String(error.status));
    return new ConnectorError(error.status === 403 ? 'denied' : 'provider', error.message, error.code ?? String(error.status));
  }
  return new ConnectorError('provider', `Pinterest could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

interface Board {
  id?: unknown;
  name?: unknown;
  privacy?: unknown;
}

export class PinterestConnector implements OAuthConnector {
  readonly provider = 'pinterest' as const;
  readonly pkce = false;
  private readonly client: PinterestClient;

  constructor(app: PinterestAppConfig, fetchImpl?: Fetch) {
    this.client = new PinterestClient(app, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://www.pinterest.com/oauth/');
    url.searchParams.set('client_id', this.client.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', PINTEREST_SCOPES.join(','));
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  // One channel per board the account can pin to; secret boards are left out (a pin there is seen by nobody).
  async exchange(input: ExchangeInput, now = Date.now()): Promise<ConnectedAccount[]> {
    const answer = await this.client.token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, continuous_refresh: 'true' }).catch((error: unknown) => {
      throw connectorError(error, true);
    });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Pinterest answered without an access token');
    if (typeof answer.refresh_token !== 'string' || !answer.refresh_token) throw new ConnectorError('provider', 'Pinterest answered without a refresh token');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(/[ ,]+/).filter(Boolean) : [];
    if (!PINTEREST_SCOPES.every((s) => granted.includes(s))) throw new ConnectorError('denied', 'Pinterest did not grant the permissions Crove needs', 'MISSING_PERMISSION');
    const token = answer.access_token;
    const fail = (error: unknown) => {
      throw connectorError(error);
    };
    const me = await this.client.call<{ username?: unknown }>('GET', '/user_account', token).catch(fail);
    const username = typeof me?.username === 'string' && me.username.trim() ? me.username.trim() : 'Pinterest';
    const boards = await this.client.call<{ items?: Board[] }>('GET', `/boards?page_size=${BOARDS_MAX}`, token).catch(fail);
    const usable = (boards?.items ?? []).filter((b): b is { id: string; name: string; privacy?: unknown } => typeof b.id === 'string' && ID.test(b.id) && typeof b.name === 'string' && b.privacy !== 'SECRET');
    if (usable.length === 0) throw new ConnectorError('denied', 'This Pinterest account has no board to pin to; create one first', 'NO_BOARD');
    const secret: PinterestSecret = { accessToken: token, refreshToken: answer.refresh_token };
    return usable.map((b) => ({
      provider: 'pinterest' as const,
      externalAccountId: b.id,
      displayName: `${username} / ${b.name.trim() || b.id}`.slice(0, 200),
      scopes: granted,
      expiresAt: expiryOf(answer, now),
      secret: JSON.stringify(secret),
    }));
  }
}

// Renews the 30-day access token three days ahead. Pinterest may hand out a new refresh token; it is kept when it does.
export class PinterestRefresher implements Refresher {
  readonly provider = 'pinterest' as const;
  readonly horizonSeconds = 3 * 86_400;
  private readonly client: PinterestClient;

  constructor(app: PinterestAppConfig, fetchImpl?: Fetch) {
    this.client = new PinterestClient(app, fetchImpl);
  }

  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }> {
    const s = pinterestSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const answer = await this.client.token({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
      if (typeof answer.access_token !== 'string' || !answer.access_token) return { failed: 'NO_ACCESS_TOKEN' };
      const next: PinterestSecret = { accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : s.refreshToken };
      return { secret: JSON.stringify(next), expiresAt: expiryOf(answer) };
    } catch (error) {
      // A wrong app secret is the deployment's to fix: keep the connections and try again later.
      if (error instanceof PinterestError && error.status === 401) return { failed: 'invalid_client' };
      if (error instanceof PinterestError && error.status >= 400 && error.status < 500) return { refused: error.code ?? 'invalid_grant' };
      return { failed: error instanceof PinterestError ? (error.code ?? String(error.status)) : 'NETWORK' };
    }
  }
}

function publishResult(error: unknown): PublishResult {
  if (!(error instanceof PinterestError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code ?? `HTTP_${error.status}`;
  if (error.status >= 500 || error.status < 400) return { kind: 'unknown', code, message: error.message };
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status };
  if (error.status === 403) return { kind: 'rejected', error: 'permission', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

// Cut by code points, never inside a character.
const clip = (s: string, max: number) => Array.from(s).slice(0, max).join('');
const titleOf = (content: { title: string | null }) => clip((content.title ?? '').trim(), TITLE_MAX);
const descriptionOf = (content: { body: string }) => clip(content.body.trim(), DESCRIPTION_MAX);
// Pinterest leads to the link from the pin itself, so it is not repeated in the description.
const linkOf = (content: { linkUrl: string | null }) => (content.linkUrl && /^https?:\/\//.test(content.linkUrl) ? content.linkUrl : null);
const same = (got: unknown, sent: string) => (typeof got === 'string' ? got : '').trim() === sent;
const pinUrl = (id: string) => `https://www.pinterest.com/pin/${id}/`;

interface PinList {
  items?: { id?: unknown; title?: unknown; description?: unknown; created_at?: unknown }[];
}

export class PinterestPublisher implements Publisher {
  readonly provider = 'pinterest' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly client: PinterestClient;

  constructor(app: PinterestAppConfig, fetchImpl?: Fetch) {
    this.client = new PinterestClient(app, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = pinterestSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_BOARD_ID' };
    const { media } = input.content;
    if (media.some((m) => m.mime.startsWith('video/'))) return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_NOT_SUPPORTED_YET' };
    if (media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_REQUIRED' };
    if (media.length > CAROUSEL_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_IMAGES' };
    if (media.some((m) => !IMAGE_TYPES.includes(m.mime))) return { kind: 'rejected', error: 'bad_request', code: 'IMAGE_TYPE' };
    // Every image is read before the call, so a read failure posts nothing.
    const images: { content_type: string; data: string }[] = [];
    for (const m of media) {
      try {
        images.push({ content_type: m.mime, data: Buffer.from(await input.readMedia(m.fileId)).toString('base64') });
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
    }
    const first = images[0] as { content_type: string; data: string };
    const link = linkOf(input.content);
    const title = titleOf(input.content);
    const description = descriptionOf(input.content);
    const alt = media[0]?.altText ? clip(media[0].altText, ALT_TEXT_MAX) : null;
    const pin = {
      board_id: input.externalAccountId,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(link ? { link } : {}),
      ...(alt ? { alt_text: alt } : {}),
      media_source:
        images.length === 1
          ? { source_type: 'image_base64', content_type: first.content_type, data: first.data }
          : { source_type: 'multiple_image_base64', items: images.map((i) => ({ ...i, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(link ? { link } : {}) })) },
    };
    try {
      const answer = await this.client.call<{ id?: unknown }>('POST', '/pins', s.accessToken, pin);
      const id = answer?.id;
      if (typeof id !== 'string' || !ID.test(id)) return { kind: 'unknown', code: 'NO_PIN_ID' };
      return { kind: 'accepted', externalId: id, url: pinUrl(id) };
    } catch (error) {
      return publishResult(error);
    }
  }

  // The board's latest pins, matched by title and description within the call's window.
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = pinterestSecretOf(input.secret);
    if (!s || !ID.test(input.externalAccountId)) return { found: 'unknown' };
    const title = titleOf(input.content);
    const description = descriptionOf(input.content);
    // An image-only pin has nothing to tell it from any other pin of the window: never guessed.
    if (!title && !description) return { found: 'unknown' };
    try {
      const answer = await this.client.call<PinList>('GET', `/boards/${input.externalAccountId}/pins?page_size=25`, s.accessToken);
      const from = input.after.getTime() - 60_000;
      const to = input.before.getTime() + 10 * 60_000;
      const pin = (answer?.items ?? []).find((p) => {
        const at = typeof p.created_at === 'string' ? Date.parse(p.created_at.endsWith('Z') ? p.created_at : `${p.created_at}Z`) : Number.NaN;
        return typeof p.id === 'string' && ID.test(p.id) && at >= from && at <= to && same(p.title ?? '', title) && same(p.description ?? '', description);
      });
      if (pin && typeof pin.id === 'string') return { found: true, externalId: pin.id, url: pinUrl(pin.id) };
      // Not among the latest: missing only when the page held every pin of the board; else it may be further down.
      return (answer?.items?.length ?? 0) < 25 ? { found: false } : { found: 'unknown' };
    } catch {
      return { found: 'unknown' };
    }
  }

  // Impressions, saves and outbound clicks of a pin, lifetime counts only. A pin Pinterest no longer has is gone.
  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const s = pinterestSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!ID.test(input.externalId)) return { refused: 'gone' };
    try {
      const answer = await this.client.call<{ pin_metrics?: Record<string, Record<string, unknown> | undefined> }>('GET', `/pins/${input.externalId}?pin_metrics=true`, s.accessToken);
      const m = answer?.pin_metrics?.lifetime_metrics;
      if (!m) return null;
      const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
      const metrics = Object.fromEntries(
        Object.entries({ impressions: n(m.impression), saves: n(m.save), clicks: n(m.outbound_click), comments: n(m.comment), reactions: n(m.reaction) }).filter(([, v]) => v !== undefined),
      );
      return { metrics };
    } catch (error) {
      if (error instanceof PinterestError && error.status === 401) return { refused: 'token_expired' };
      if (error instanceof PinterestError && error.status === 404) return { refused: 'gone' };
      return null;
    }
  }
}

