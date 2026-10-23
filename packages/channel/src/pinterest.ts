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
// leads. A video pin (#813) registers the upload (POST /v5/media), sends the bytes to the storage URL Pinterest hands
// back (its S3 upload host, the only one allowed), waits until the media is processed, then pins it with a cover frame.
// An unclear answer is checked by listing the board's
// latest pins, matched by title and description and their time.
// Sections (#1120): the composer picks one of the board's sections (GET /v5/boards/{board_id}/sections, boards:read),
// kept as settings.pinterest.sectionId. Publishing lists the board's sections again first and sends board_section_id
// only for one that is still there; a pin without a section is sent exactly as before.
// Metrics: impressions, saves and clicks of a pin from its pin_metrics.
import type { ConnectedAccount, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RetrySafety } from './index.ts';
import { videoCoverOf } from './cover.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';
import { CHANNEL_OPTIONS_MAX, optionName, type ChannelOption, type ChannelOptionsInput, type ChannelOptionsResult } from './options.ts';

export const PINTEREST_HOSTS = ['api.pinterest.com'] as const;
// Where Pinterest takes a video's bytes (the upload_url of POST /v5/media).
export const PINTEREST_UPLOAD_HOSTS = ['pinterest-media-upload.s3-accelerate.amazonaws.com'] as const;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
// How long a publish waits for Pinterest to process a video; with the upload it stays inside callTimeoutMs.
const VIDEO_WAIT_MS = 300_000;
// The last status read and the pin call (60 s each at most) plus slack fit between the budget and callTimeoutMs.
const VIDEO_CALL_MARGIN_MS = 150_000;
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
// Sections asked for per page; the pages read stop at CHANNEL_OPTIONS_MAX sections.
const SECTIONS_PAGE = 250;
// The longest paging bookmark followed; a longer one ends the list.
const BOOKMARK_MAX = 2048;

// The section a pin goes into (#1120): settings.pinterest.sectionId, one of the board's sections. null when there is
// none, 'invalid' when settings.pinterest is not an object holding only a section id.
export const PINTEREST_SECTION_ID = /^\d{1,32}$/;
export function pinterestSectionOf(settings: Readonly<Record<string, unknown>> | undefined): string | 'invalid' | null {
  const raw = settings?.pinterest;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'sectionId')) return 'invalid';
  if (r.sectionId === undefined) return null;
  return typeof r.sectionId === 'string' && PINTEREST_SECTION_ID.test(r.sectionId) ? r.sectionId : 'invalid';
}
// What publish answers for a section that is not (or no longer) one of the board's, and for settings it cannot read.
export const PINTEREST_SECTION_NOT_FOUND = 'PINTEREST_SECTION_NOT_FOUND';
export const PINTEREST_SECTION_INVALID = 'PINTEREST_SECTION_INVALID';
// The board's sections could not be listed before pinning: nothing was sent, and the attempt is tried again.
export const PINTEREST_SECTIONS_UNREADABLE = 'PINTEREST_SECTIONS_UNREADABLE';

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
  private readonly uploadFetch: Fetch;
  private readonly app: PinterestAppConfig;

  constructor(app: PinterestAppConfig, fetchImpl?: Fetch) {
    if (!/^\d{4,32}$/.test(app.appId)) throw new Error('invalid Pinterest app id');
    if (!app.appSecret) throw new Error('missing Pinterest app secret');
    this.app = app;
    this.fetch = allowlistedFetch(PINTEREST_HOSTS, fetchImpl, 60_000);
    this.uploadFetch = allowlistedFetch(PINTEREST_UPLOAD_HOSTS, fetchImpl, 300_000);
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

  // A video's bytes to the storage URL Pinterest handed out, as a form with the fields it named and then the file.
  async upload(url: string, fields: Record<string, string>, bytes: Uint8Array, type: string): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', new Blob([new Uint8Array(bytes)], { type }), 'video');
    const response = await this.uploadFetch(url, { method: 'POST', body: form });
    if (!response.ok) throw new PinterestError(response.status, null);
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

// A pin into a section that Pinterest no longer finds ("Board or section not found", 404): the section went between
// the check and the pin, and nothing was posted.
function pinResult(error: unknown, sectionId: string | null): PublishResult {
  if (sectionId && error instanceof PinterestError && error.status === 404) return { kind: 'rejected', error: 'bad_request', code: PINTEREST_SECTION_NOT_FOUND, message: sectionId, httpStatus: 404 };
  return publishResult(error);
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
  // A video's upload and processing take minutes (#813); within the job's stale limit (600 s).
  readonly callTimeoutMs = 420_000;
  private readonly client: PinterestClient;
  private readonly videoWaitMs: number;
  private readonly pollMs: number;
  private readonly budgetMs: number;

  constructor(app: PinterestAppConfig, fetchImpl?: Fetch, timing: { videoWaitMs?: number; pollMs?: number; budgetMs?: number } = {}) {
    this.client = new PinterestClient(app, fetchImpl);
    this.videoWaitMs = timing.videoWaitMs ?? VIDEO_WAIT_MS;
    this.pollMs = timing.pollMs ?? 3000;
    this.budgetMs = timing.budgetMs ?? this.callTimeoutMs - VIDEO_CALL_MARGIN_MS;
  }

  // The media id of an uploaded, processed video; nothing is visible before the pin names it, so any failure here
  // posted nothing, and a wait past the budget is a failure to retry.
  private async uploadVideo(token: string, bytes: Uint8Array, type: string, started: number): Promise<{ mediaId: string } | { rejected: PublishResult }> {
    const before = (error: unknown): { rejected: PublishResult } => {
      const result = publishResult(error);
      return { rejected: result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) } };
    };
    let mediaId: string;
    try {
      const registered = await this.client.call<{ media_id?: unknown; upload_url?: unknown; upload_parameters?: unknown }>('POST', '/media', token, { media_type: 'video' });
      const id = registered?.media_id;
      const url = registered?.upload_url;
      const params = registered?.upload_parameters;
      if (typeof id !== 'string' || !ID.test(id) || typeof url !== 'string' || params === null || typeof params !== 'object') return { rejected: { kind: 'rejected', error: 'transient', code: 'NO_UPLOAD' } };
      const fields = Object.fromEntries(Object.entries(params as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
      await this.client.upload(url, fields, bytes, type);
      mediaId = id;
    } catch (error) {
      // A storage URL on another host is refused by the upload fetch before anything is sent.
      if (error instanceof Error && !(error instanceof PinterestError) && /host not allowed/.test(error.message)) return { rejected: { kind: 'rejected', error: 'transient', code: 'UPLOAD_HOST' } };
      return before(error);
    }
    const until = Math.min(started + this.budgetMs, Date.now() + this.videoWaitMs);
    for (;;) {
      let status: unknown;
      try {
        status = (await this.client.call<{ status?: unknown }>('GET', `/media/${mediaId}`, token))?.status;
      } catch (error) {
        return before(error);
      }
      if (status === 'succeeded') return { mediaId };
      if (status === 'failed') return { rejected: { kind: 'rejected', error: 'bad_request', code: 'VIDEO_PROCESSING_FAILED' } };
      if (Date.now() + this.pollMs > until) return { rejected: { kind: 'rejected', error: 'transient', code: 'VIDEO_PROCESSING_SLOW' } };
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  // The board's sections, at most CHANNEL_OPTIONS_MAX, following Pinterest's bookmark from page to page. It only reads.
  private async listSections(boardId: string, token: string): Promise<ChannelOptionsResult> {
    const options: ChannelOption[] = [];
    const seen = new Set<string>();
    let bookmark: string | null = null;
    try {
      for (let page = 0; page < Math.ceil(CHANNEL_OPTIONS_MAX / SECTIONS_PAGE); page += 1) {
        const query: string = `page_size=${SECTIONS_PAGE}${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`;
        const answer = await this.client.call<{ items?: unknown; bookmark?: unknown }>('GET', `/boards/${boardId}/sections?${query}`, token);
        if (!answer || !Array.isArray(answer.items)) return null;
        for (const item of answer.items as ({ id?: unknown; name?: unknown } | null)[]) {
          if (!item || typeof item.id !== 'string' || !PINTEREST_SECTION_ID.test(item.id) || seen.has(item.id)) continue;
          seen.add(item.id);
          options.push({ id: item.id, name: (typeof item.name === 'string' ? optionName(item.name) : '') || item.id });
          if (options.length >= CHANNEL_OPTIONS_MAX) return { options };
        }
        bookmark = typeof answer.bookmark === 'string' && answer.bookmark && answer.bookmark.length <= BOOKMARK_MAX ? answer.bookmark : null;
        if (!bookmark) break;
      }
      return { options };
    } catch (error) {
      if (error instanceof PinterestError && error.status === 401) return { refused: 'token_expired' };
      if (error instanceof PinterestError && error.status === 403) return { refused: 'permission' };
      if (error instanceof PinterestError && error.status === 404) return { refused: 'not_found' };
      return null;
    }
  }

  // The composer's list of the board's sections (#1120), read by the worker with the board's token.
  async options(input: ChannelOptionsInput): Promise<ChannelOptionsResult> {
    const s = pinterestSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (input.kind !== 'pinterest_section' || !ID.test(input.externalAccountId)) return { refused: 'not_found' };
    return this.listSections(input.externalAccountId, s.accessToken);
  }

  // The section a pin goes into, checked against the board's sections as they are now; nothing is posted before.
  private async sectionFor(input: PublishInput, token: string): Promise<{ sectionId: string | null } | { rejected: PublishResult }> {
    const sectionId = pinterestSectionOf(input.settings);
    if (sectionId === null) return { sectionId: null };
    if (sectionId === 'invalid') return { rejected: { kind: 'rejected', error: 'bad_request', code: PINTEREST_SECTION_INVALID } };
    const listed = await this.listSections(input.externalAccountId, token);
    if (listed === null) return { rejected: { kind: 'rejected', error: 'transient', code: PINTEREST_SECTIONS_UNREADABLE } };
    if ('refused' in listed) {
      if (listed.refused === 'token_expired') return { rejected: { kind: 'rejected', error: 'token_expired', code: PINTEREST_SECTIONS_UNREADABLE } };
      if (listed.refused === 'permission') return { rejected: { kind: 'rejected', error: 'permission', code: PINTEREST_SECTIONS_UNREADABLE } };
      return { rejected: { kind: 'rejected', error: 'bad_request', code: 'BOARD_NOT_FOUND' } };
    }
    if (!listed.options.some((o) => o.id === sectionId)) return { rejected: { kind: 'rejected', error: 'bad_request', code: PINTEREST_SECTION_NOT_FOUND, message: sectionId } };
    return { sectionId };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = pinterestSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_BOARD_ID' };
    const section = await this.sectionFor(input, s.accessToken);
    if ('rejected' in section) return section.rejected;
    const { media } = input.content;
    const video = media.find((m) => m.mime.startsWith('video/'));
    if (video) return this.publishVideo(input, s.accessToken, video, section.sectionId);
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
      ...(section.sectionId ? { board_section_id: section.sectionId } : {}),
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
      return pinResult(error, section.sectionId);
    }
  }

  // A video pin (#813): one video alone, with its cover frame (the composer's cover time, else its first frame).
  private async publishVideo(input: PublishInput, token: string, video: PublishInput['content']['media'][number], sectionId: string | null): Promise<PublishResult> {
    const started = Date.now();
    if (input.content.media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_ALONE' };
    if (!VIDEO_TYPES.includes(video.mime)) return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TYPE' };
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    const uploaded = await this.uploadVideo(token, bytes, video.mime, started);
    if ('rejected' in uploaded) return uploaded.rejected;
    // Past the budget, a pin could land after the job gave up on it: retry instead, nothing is visible yet.
    if (Date.now() - started > this.budgetMs) return { kind: 'rejected', error: 'transient', code: 'VIDEO_BUDGET_SPENT' };
    const cover = videoCoverOf(input.settings);
    const link = linkOf(input.content);
    const title = titleOf(input.content);
    const description = descriptionOf(input.content);
    const pin = {
      board_id: input.externalAccountId,
      ...(sectionId ? { board_section_id: sectionId } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(link ? { link } : {}),
      ...(video.altText ? { alt_text: clip(video.altText, ALT_TEXT_MAX) } : {}),
      media_source: { source_type: 'video_id', media_id: uploaded.mediaId, cover_image_key_frame_time: cover && 'atMs' in cover ? Math.round(cover.atMs / 1000) : 0 },
    };
    try {
      const answer = await this.client.call<{ id?: unknown }>('POST', '/pins', token, pin);
      const id = answer?.id;
      if (typeof id !== 'string' || !ID.test(id)) return { kind: 'unknown', code: 'NO_PIN_ID' };
      return { kind: 'accepted', externalId: id, url: pinUrl(id) };
    } catch (error) {
      return pinResult(error, sectionId);
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

