// TikTok video posts (S9, issue #412), written from TikTok's Login Kit and Content Posting API docs. One TikTok app
// serves every org of a deployment: CHANNEL_TIKTOK_CLIENT_KEY and CHANNEL_TIKTOK_CLIENT_SECRET.
//
// Connect: TikTok's consent screen for user.info.basic and video.publish (and video.upload where the deployment turns
// inbox mode on); the access token lives a day and the refresh token a year, and the refresh schedule renews the
// access token. One grant is one TikTok account.
// Publish (Direct Post): the creator's current options first (privacy levels, interactions it allows, longest video),
// then an init call that opens the upload, the bytes in chunks, and a status check until TikTok has published it. The
// person posting chooses the privacy level and the interaction settings (TikTok's rules for the posting UI); an app TikTok
// has not audited can only post SELF_ONLY. A post is visible only after the bytes are in, so a failure before then
// posted nothing; after init, the publish_id says where it stands.
// Photo posts (#710): 1 to 35 JPEG or WebP images through content/init with media_type PHOTO, which TikTok pulls from
// Crove's presigned URLs (PULL_FROM_URL; the URL's domain must be verified for the TikTok app, or TikTok answers
// url_ownership_unverified). The text goes as the description; the status check is the same as for a video.
// Inbox mode (#903, settings.tiktokMode 'inbox'; 'direct', the default, is the above): TikTok's Upload API sends the
// video to the creator's TikTok inbox as a draft, where they add sound, write the caption and post it inside TikTok.
// No privacy level, interaction settings or cover is sent (the creator picks them in TikTok), and none is needed, so
// it also works for an app TikTok has not audited, whose direct posts stay SELF_ONLY. The init call is
// inbox/video/init with source_info alone, the chunks are the same, and the status check ends at SEND_TO_USER_INBOX:
// the draft is in the app, not public, with no post id yet. Photos go through content/init with post_mode
// MEDIA_UPLOAD and their description. It needs the video.upload scope, which Crove asks for only when the deployment
// sets CHANNEL_TIKTOK_INBOX (its TikTok app must be approved for it), and which connections made before then lack.
// Late ids (#1475): TikTok gives a public post's id (publicaly_available_post_id) only once its moderation passes, which
// may come after PUBLISH_COMPLETE, and an inbox draft moves on to PUBLISH_COMPLETE once the creator posts it in TikTok.
// lateId asks status/fetch again for such a post (a read, never a post), and reads its address from video/query where
// the connection has video.list.
// Outside posts (#1476): listRecentPosts reads the account's own public videos from video/list where the connection
// has video.list, so the ones posted straight from the TikTok app count in the Metrics tab and the client report.
import type { ConnectedAccount, LateIdInput, LateIdResult, MetricName, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, RecentPost, RecentPostsInput, RecentPostsResult, Refresher, RetrySafety, StatusInput } from './index.ts';
import { videoCoverOf } from './cover.ts';
import { platformLink, RECENT_PAGES_MAX, RECENT_POSTS_MAX, recentSince } from './recent.ts';
import { holdsLink } from './text.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const TIKTOK_HOSTS = ['open.tiktokapis.com', 'open-upload.tiktokapis.com'] as const;
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'] as const;
// What inbox mode needs (#903): TikTok's Upload API refuses a token without it (scope_not_authorized). Asked for only
// when the deployment turns inbox mode on (CHANNEL_TIKTOK_INBOX): TikTok refuses a whole sign-in that asks for a scope
// the app has not been approved for, so it is never asked for by default.
export const TIKTOK_UPLOAD_SCOPE = 'video.upload';
// How a variant goes to TikTok (#903): posted at once (direct, the default), or sent to the creator's TikTok inbox as
// a draft they finish in the app (inbox).
export const TIKTOK_MODES = ['direct', 'inbox'] as const;
export type TikTokMode = (typeof TIKTOK_MODES)[number];
// The mode in a variant's settings; null when settings.tiktokMode is set to something else.
export function tiktokModeOf(settings: Readonly<Record<string, unknown>> | undefined): TikTokMode | null {
  const value = settings?.tiktokMode;
  if (value === undefined || value === null) return 'direct';
  return TIKTOK_MODES.find((m) => m === value) ?? null;
}
// Commercial content and AI labels (#1078), in settings.tiktok: { commercial?, yourBrand?, brandedContent?,
// aiGenerated? }, each true when on and absent otherwise. yourBrand (promoting yourself or your own business) goes as
// brand_organic_toggle and TikTok labels the post "Promotional content"; brandedContent (promoting another brand or a
// third party) goes as brand_content_toggle and TikTok labels it "Paid partnership"; aiGenerated goes as is_aigc and
// TikTok labels it as AI-generated. commercial is the disclosure turned on: it needs yourBrand or brandedContent, or
// the post is refused, as TikTok's sharing guidelines require. Branded content cannot be SELF_ONLY. A variant without
// settings.tiktok sends none of these fields, exactly as before. Inbox mode takes none: the creator sets them in TikTok.
// The domain's tiktokDisclosureOf in @crove/mod-social reads the same value.
export interface TikTokDisclosure {
  commercial: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
}
const DISCLOSURE_KEYS: readonly string[] = ['commercial', 'yourBrand', 'brandedContent', 'aiGenerated'];
// The disclosure in a variant's settings: null when there is none, 'invalid' when settings.tiktok is not an object of
// those true-or-false keys.
export function tiktokDisclosureOf(settings: Readonly<Record<string, unknown>> | undefined): TikTokDisclosure | 'invalid' | null {
  const raw = settings?.tiktok;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.entries(r).some(([k, v]) => !DISCLOSURE_KEYS.includes(k) || typeof v !== 'boolean')) return 'invalid';
  const yourBrand = r.yourBrand === true;
  const brandedContent = r.brandedContent === true;
  return { commercial: r.commercial === true || yourBrand || brandedContent, yourBrand, brandedContent, aiGenerated: r.aiGenerated === true };
}
// What the adapter refuses in a disclosure, with nothing sent (#1078).
export const TIKTOK_DISCLOSURE_INVALID = 'TIKTOK_DISCLOSURE_INVALID';
export const TIKTOK_COMMERCIAL_CHOOSE = 'TIKTOK_COMMERCIAL_CHOOSE';
export const TIKTOK_BRANDED_PRIVATE = 'TIKTOK_BRANDED_PRIVATE';
export const TIKTOK_DISCLOSURE_INBOX = 'TIKTOK_DISCLOSURE_INBOX';
// The disclosure's fields of post_info (is_aigc goes in post_info for a video, beside it for photos).
const brandFields = (d: TikTokDisclosure) => ({ brand_content_toggle: d.brandedContent, brand_organic_toggle: d.yourBrand });
// Asked for only when the deployment's app has the Display API (CHANNEL_TIKTOK_VIDEO_LIST): it reads a video's counts
// (#744). An app without it would refuse the whole sign-in, so it is never asked for by default.
export const TIKTOK_METRICS_SCOPE = 'video.list';
export const TIKTOK_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY_LEVELS)[number];
const API = 'https://open.tiktokapis.com/v2';
const OPEN_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const PUBLISH_ID = /^[A-Za-z0-9_.~-]{1,128}$/;
const CHECK_AFTER_SECONDS = 30;
const TITLE_MAX = 2200;
// A photo post's description, and how many images it takes.
const PHOTO_DESCRIPTION_MAX = 4000;
const PHOTO_MAX = 35;
const PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/webp'];
// TikTok takes chunks of 5 to 64 MB, the last one up to 128 MB; a video under 5 MB goes whole.
const CHUNK = 64 * 1024 * 1024;

export interface TikTokAppConfig {
  clientKey: string;
  clientSecret: string;
  // The app has the Display API: connections ask for video.list and posts' counts are read (#744).
  videoList?: boolean;
  // The app is approved for video.upload (CHANNEL_TIKTOK_INBOX, #903): connections ask for it and inbox mode is sent.
  // Without it, an inbox variant is refused with TIKTOK_INBOX_NOT_ENABLED and nothing is sent.
  inbox?: boolean;
}

// The code for a variant this deployment's TikTok app cannot send (#903): inbox mode on an app without video.upload.
export const TIKTOK_INBOX_NOT_ENABLED = 'TIKTOK_INBOX_NOT_ENABLED';

export class TikTokError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, body: Record<string, unknown> | null) {
    const error = body?.error;
    const nested = error !== null && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : null;
    const message = typeof nested?.message === 'string' && nested.message ? nested.message : typeof body?.error_description === 'string' ? body.error_description : `TikTok answered ${status}`;
    super(message);
    this.name = 'TikTokError';
    this.status = status;
    const code = nested?.code ?? error;
    this.code = typeof code === 'string' ? code : undefined;
  }
}

export interface TikTokSecret {
  accessToken: string;
  refreshToken: string;
}

export function tiktokSecretOf(secret: string): TikTokSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<TikTokSecret>;
    return typeof s.accessToken === 'string' && s.accessToken && typeof s.refreshToken === 'string' && s.refreshToken ? { accessToken: s.accessToken, refreshToken: s.refreshToken } : null;
  } catch {
    return null;
  }
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  open_id?: unknown;
  scope?: unknown;
}

class TikTokClient {
  private readonly fetch: Fetch;
  private readonly app: TikTokAppConfig;

  constructor(app: TikTokAppConfig, fetchImpl?: Fetch) {
    if (!/^[A-Za-z0-9]{8,64}$/.test(app.clientKey)) throw new Error('invalid TikTok client key');
    if (!app.clientSecret) throw new Error('missing TikTok client secret');
    this.app = app;
    this.fetch = allowlistedFetch(TIKTOK_HOSTS, fetchImpl, 30_000);
  }

  get clientKey(): string {
    return this.app.clientKey;
  }

  get videoList(): boolean {
    return this.app.videoList === true;
  }

  get inbox(): boolean {
    return this.app.inbox === true;
  }

  async token(form: Record<string, string>): Promise<TokenAnswer> {
    const response = await this.fetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_key: this.app.clientKey, client_secret: this.app.clientSecret, ...form }).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json || typeof json.error === 'string') throw new TikTokError(response.ok ? 400 : response.status, json);
    return json as TokenAnswer;
  }

  // A JSON call; TikTok answers { data, error: { code: 'ok' } } on success.
  async call<T>(method: 'GET' | 'POST', path: string, token: string, json?: unknown): Promise<T> {
    return (await this.callRaw<T>(method, path, token, json)).data;
  }

  // The same, with the answer's text: TikTok's post ids are 64-bit integers, which JSON.parse rounds.
  async callRaw<T>(method: 'GET' | 'POST', path: string, token: string, json?: unknown): Promise<{ data: T; raw: string }> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (json !== undefined) headers['content-type'] = 'application/json; charset=UTF-8';
    const response = await this.fetch(`${API}${path}`, { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const raw = await response.text().catch(() => '');
    type Answer = { data?: unknown; error?: { code?: unknown } } & Record<string, unknown>;
    let body: Answer | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Answer) : null;
    } catch {
      body = null;
    }
    // Success carries error.code 'ok'; any other error object, with or without a code, is a refusal.
    if (!response.ok || !body || (body.error !== undefined && body.error !== null && body.error.code !== 'ok')) throw new TikTokError(response.ok && body ? 400 : response.status, body);
    return { data: (body.data ?? {}) as T, raw };
  }

  async chunk(url: string, bytes: Uint8Array, start: number, end: number, total: number, type: string): Promise<void> {
    const response = await this.fetch(url, {
      method: 'PUT',
      headers: { 'content-type': type, 'content-range': `bytes ${start}-${end - 1}/${total}` },
      // One chunk of up to 100 MB; the job waits a little longer (callTimeoutMs), so this abort is the adapter's.
      signal: AbortSignal.timeout(300_000),
      body: new Blob([new Uint8Array(bytes.subarray(start, end))], { type }),
    });
    if (!response.ok) throw new TikTokError(response.status, null);
  }
}

const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 86_400) * 1000);
};

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof TikTokError) {
    // invalid_client is the deployment's configuration, not the code.
    if (codeStep && error.status >= 400 && error.status < 500 && error.code !== 'invalid_client') return new ConnectorError('invalid_grant', 'TikTok refused the authorization code', error.code ?? String(error.status));
    return new ConnectorError(error.status === 403 ? 'denied' : 'provider', error.message, error.code ?? String(error.status));
  }
  return new ConnectorError('provider', `TikTok could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

export class TikTokConnector implements OAuthConnector {
  readonly provider = 'tiktok' as const;
  readonly pkce = false;
  private readonly client: TikTokClient;

  constructor(app: TikTokAppConfig, fetchImpl?: Fetch) {
    this.client = new TikTokClient(app, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.searchParams.set('client_key', this.client.clientKey);
    url.searchParams.set('scope', [...TIKTOK_SCOPES, ...(this.client.inbox ? [TIKTOK_UPLOAD_SCOPE] : []), ...(this.client.videoList ? [TIKTOK_METRICS_SCOPE] : [])].join(','));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  async exchange(input: ExchangeInput, now = Date.now()): Promise<ConnectedAccount[]> {
    const answer = await this.client.token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri }).catch((error: unknown) => {
      throw connectorError(error, true);
    });
    if (typeof answer.access_token !== 'string' || !answer.access_token || typeof answer.refresh_token !== 'string' || !answer.refresh_token) {
      throw new ConnectorError('provider', 'TikTok answered without tokens');
    }
    const openId = typeof answer.open_id === 'string' ? answer.open_id : '';
    if (!OPEN_ID.test(openId)) throw new ConnectorError('provider', 'TikTok answered without an account id');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(/[ ,]+/).filter(Boolean) : [];
    if (!granted.includes('video.publish')) throw new ConnectorError('denied', 'TikTok did not grant video.publish', 'MISSING_PERMISSION');
    const user = await this.client
      .call<{ user?: { display_name?: unknown } }>('GET', '/user/info/?fields=open_id,display_name', answer.access_token)
      .catch((error: unknown) => {
        throw connectorError(error);
      });
    const name = typeof user.user?.display_name === 'string' && user.user.display_name.trim() ? user.user.display_name.trim() : `TikTok ${openId.slice(0, 8)}`;
    const secret: TikTokSecret = { accessToken: answer.access_token, refreshToken: answer.refresh_token };
    return [{ provider: 'tiktok', externalAccountId: openId, displayName: name.slice(0, 200), scopes: granted, expiresAt: expiryOf(answer, now), secret: JSON.stringify(secret) }];
  }
}

// Renews the day-long access token two hours ahead; TikTok may rotate the refresh token.
export class TikTokRefresher implements Refresher {
  readonly provider = 'tiktok' as const;
  readonly horizonSeconds = 2 * 3600;
  private readonly client: TikTokClient;

  constructor(app: TikTokAppConfig, fetchImpl?: Fetch) {
    this.client = new TikTokClient(app, fetchImpl);
  }

  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }> {
    const s = tiktokSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const answer = await this.client.token({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
      if (typeof answer.access_token !== 'string' || !answer.access_token) return { failed: 'NO_ACCESS_TOKEN' };
      const next: TikTokSecret = { accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : s.refreshToken };
      return { secret: JSON.stringify(next), expiresAt: expiryOf(answer) };
    } catch (error) {
      if (error instanceof TikTokError && error.status < 500 && (error.code === 'invalid_grant' || error.code === 'access_token_invalid')) return { refused: error.code };
      return { failed: error instanceof TikTokError ? (error.code ?? String(error.status)) : 'NETWORK' };
    }
  }
}

// What TikTok's Upload API answers mean in inbox mode (#903), in plain words for the post screen.
const INBOX_HINTS: Readonly<Record<string, string>> = {
  spam_risk_too_many_pending_share:
    "The TikTok inbox already holds as many drafts as TikTok allows from apps in a day; post or delete some in the TikTok app, then publish again",
};

// inbox: the call was one of inbox mode's, where scope_not_authorized means the connection lacks video.upload (it was
// made before Crove asked for it): a refusal that asks for a reconnect, never an expired token, so the connection's
// direct posts go on.
function publishResult(error: unknown, inbox = false): PublishResult {
  if (!(error instanceof TikTokError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code ?? `HTTP_${error.status}`;
  if (error.status >= 500) return { kind: 'unknown', code, message: error.message };
  if (inbox && error.code === 'scope_not_authorized') {
    return { kind: 'rejected', error: 'permission', code: 'CHANNEL_SCOPE_MISSING', message: `TikTok refused the upload: the connection lacks ${TIKTOK_UPLOAD_SCOPE}; reconnect the channel`, httpStatus: error.status };
  }
  const hint = inbox && error.code ? INBOX_HINTS[error.code] : undefined;
  if (hint) return { kind: 'rejected', error: 'permission', code, message: hint, httpStatus: error.status };
  if (error.status === 401 || error.code === 'access_token_invalid' || error.code === 'token_not_authorized_for_specified_scope') {
    return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  }
  if (error.status === 429 || error.code === 'rate_limit_exceeded' || error.code === 'spam_risk_too_many_posts' || error.code === 'spam_risk_user_banned_from_posting') {
    return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status };
  }
  if (error.status === 403 || error.code === 'unaudited_client_can_only_post_to_private_accounts' || error.code === 'privacy_level_option_mismatch') {
    return { kind: 'rejected', error: 'permission', code, message: error.message, httpStatus: error.status };
  }
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

interface CreatorInfo {
  privacy_level_options?: unknown;
  comment_disabled?: unknown;
  duet_disabled?: unknown;
  stitch_disabled?: unknown;
  max_video_post_duration_sec?: unknown;
}

interface StatusAnswer {
  status?: unknown;
  fail_reason?: unknown;
  publicaly_available_post_id?: unknown;
}

// The first public post id of a status answer, as written in its text (a 64-bit integer, or a string of digits), never
// through a JS number. A draft the creator turned into several posts gives several; the first is the post's.
const postIdOf = (raw: string) => /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d{1,32})/.exec(raw)?.[1];
// A video's address as video/query gives it: https on tiktok.com only.
const SHARE_URL = /^https:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\/\S{1,1900}$/i;
// Where a listed video's share_url may point (#1476): tiktok.com or a subdomain of it.
const TIKTOK_POST_HOSTS = ['tiktok.com'] as const;
// TikTok's public video ids: a 64-bit integer as digits.
const VIDEO_ID = /^\d{1,32}$/;
// video/list (#1476): the fields asked for, all on the Video Object's documented list, and the page size (TikTok's
// max_count is 20 at most).
const VIDEO_LIST_FIELDS = 'id,create_time,title,video_description,share_url';
const VIDEO_LIST_PAGE = 20;

interface ListedVideo {
  id?: unknown;
  create_time?: unknown;
  title?: unknown;
  video_description?: unknown;
  share_url?: unknown;
}
interface VideoListAnswer {
  videos?: unknown;
  cursor?: unknown;
  has_more?: unknown;
}

// A video/list answer's data with every "id" as written: TikTok documents ids as strings, but a 64-bit integer sent as
// a number would be rounded by a JS number. A runtime without JSON.parse's source text gives the number, which the
// caller takes only when it is a safe integer.
function videoListOf(raw: string): VideoListAnswer {
  const body = JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) => (key === 'id' && typeof value === 'number' && typeof context?.source === 'string' ? context.source : value)) as { data?: unknown } | null;
  return body?.data && typeof body.data === 'object' ? (body.data as VideoListAnswer) : {};
}

// A video's create_time (UTC seconds), or null.
function createTimeOf(value: unknown): Date | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

const captionOf = (content: { body: string; linkUrl: string | null }, max = TITLE_MAX) => {
  const body = content.body.trim();
  return (content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body).slice(0, max);
};

// What TikTok's answers about photo URLs mean for the deployment, in plain words for the post screen.
const PHOTO_HINTS: Readonly<Record<string, string>> = {
  url_ownership_unverified: "TikTok did not take the image links: this deployment's media domain must be verified in the TikTok app's settings",
  unaudited_client_can_only_post_to_private_accounts: 'This TikTok app is not audited yet, so it can post only to private accounts (privacy SELF_ONLY)',
};

export class TikTokPublisher implements Publisher {
  readonly provider = 'tiktok' as const;
  // Each init opens a new upload; an unclear answer after it is followed through the publish_id.
  readonly publishSafety: RetrySafety = 'never';
  // Three JSON calls of 30 seconds and one chunk of 300 seconds at most (a video of up to 100 MB is one chunk), within
  // the job's stale limit; a chunk that runs too long is aborted here and followed by its publish_id.
  readonly callTimeoutMs = 420_000;
  private readonly client: TikTokClient;

  constructor(app: TikTokAppConfig, fetchImpl?: Fetch) {
    this.client = new TikTokClient(app, fetchImpl);
  }

  // Inbox mode on a deployment that has not turned it on (#903): refused before anything else, nothing sent.
  refusal(settings: Readonly<Record<string, unknown>>): string | null {
    return tiktokModeOf(settings) === 'inbox' && !this.client.inbox ? TIKTOK_INBOX_NOT_ENABLED : null;
  }

  // A video's counts (#744): views, likes, comments and shares from the video query endpoint (video.list). Without
  // the scope, or for a post id TikTok has not given (a private post), no counts.
  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const s = tiktokSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!/^\d{1,32}$/.test(input.externalId)) return null;
    let answer: { videos?: { id?: unknown; view_count?: unknown; like_count?: unknown; comment_count?: unknown; share_count?: unknown }[] };
    try {
      answer = await this.client.call('POST', '/video/query/?fields=id,view_count,like_count,comment_count,share_count', s.accessToken, { filters: { video_ids: [input.externalId] } });
    } catch (error) {
      if (error instanceof TikTokError && (error.status === 401 || error.code === 'access_token_invalid')) return { refused: 'token_expired' };
      return null;
    }
    const video = answer.videos?.[0];
    if (!video) return null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const metrics: Partial<Record<MetricName, number>> = {};
    const views = n(video.view_count);
    const likes = n(video.like_count);
    const comments = n(video.comment_count);
    const shares = n(video.share_count);
    if (views !== undefined) metrics.views = views;
    if (likes !== undefined) metrics.reactions = likes;
    if (comments !== undefined) metrics.comments = comments;
    if (shares !== undefined) metrics.shares = shares;
    return { metrics };
  }

  // The account's own public videos since a date (#1476): `POST /v2/video/list/` under video.list (the Display API),
  // which lists the user's public videos newest first by create_time, at most 20 a page (max_count), paged by a cursor
  // (a create time in milliseconds) sent back while has_more is true. Only fields of the documented Video Object are
  // asked for. A connection without video.list (Crove asks for it only where CHANNEL_TIKTOK_VIDEO_LIST is set) is not
  // asked at all: the answer is the missing permission. Ids are the numeric video ids publish stores once TikTok gives
  // them (#1475), so external_post_is_crove drops Crove's own posts; the excerpt is the longer of the title and the
  // description, the time create_time, and the permalink share_url on tiktok.com only. A refused token is said on the
  // first page (a missing scope, which TikTok also answers with 401, is the permission, never an expired token); any
  // failure after it ends the listing with what came before it.
  async listRecentPosts(input: RecentPostsInput): Promise<RecentPostsResult> {
    const s = tiktokSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!input.scopes?.includes(TIKTOK_METRICS_SCOPE)) return { refused: 'permission' };
    const since = recentSince(input.since);
    const posts: RecentPost[] = [];
    let cursor: number | null = null;
    for (let page = 0; page < RECENT_PAGES_MAX && posts.length < RECENT_POSTS_MAX; page++) {
      let answer: VideoListAnswer;
      try {
        const { raw } = await this.client.callRaw('POST', `/video/list/?fields=${VIDEO_LIST_FIELDS}`, s.accessToken, { max_count: VIDEO_LIST_PAGE, ...(cursor === null ? {} : { cursor }) });
        answer = videoListOf(raw);
      } catch (error) {
        if (page > 0) break;
        if (!(error instanceof TikTokError)) return null;
        if (error.code === 'scope_not_authorized' || error.code === 'scope_permission_missed' || error.status === 403) return { refused: 'permission' };
        if (error.status === 401 || error.code === 'access_token_invalid') return { refused: 'token_expired' };
        return null;
      }
      const videos: unknown[] = Array.isArray(answer.videos) ? answer.videos : [];
      let older = false;
      for (const item of videos) {
        if (!item || typeof item !== 'object') continue;
        const v = item as ListedVideo;
        const id = typeof v.id === 'string' ? v.id : typeof v.id === 'number' && Number.isSafeInteger(v.id) ? String(v.id) : '';
        const at = createTimeOf(v.create_time);
        if (!VIDEO_ID.test(id) || !at) continue;
        if (at < since) {
          older = true;
          continue;
        }
        const title = typeof v.title === 'string' ? v.title.trim() : '';
        const description = typeof v.video_description === 'string' ? v.video_description.trim() : '';
        posts.push({ externalId: id, text: description.length > title.length ? description : title, permalink: platformLink(v.share_url, TIKTOK_POST_HOSTS), publishedAt: at });
      }
      // The next page only while TikTok says there is one, with a cursor that moves back in time.
      const next = typeof answer.cursor === 'number' && Number.isSafeInteger(answer.cursor) && answer.cursor > 0 ? answer.cursor : null;
      if (older || answer.has_more !== true || next === null || (cursor !== null && next >= cursor)) break;
      cursor = next;
    }
    // Newest first, a video listed twice kept once.
    const seen = new Set<string>();
    const unique = posts.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()).filter((p) => !seen.has(p.externalId) && seen.add(p.externalId));
    return { posts: unique.slice(0, RECENT_POSTS_MAX) };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = tiktokSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    const mode = tiktokModeOf(input.settings);
    if (!mode) return { kind: 'rejected', error: 'bad_request', code: 'TIKTOK_MODE_INVALID' };
    const notEnabled = this.refusal(input.settings);
    if (notEnabled) return { kind: 'rejected', error: 'bad_request', code: notEnabled, message: 'Inbox mode is not turned on for this deployment (CHANNEL_TIKTOK_INBOX)' };
    const inbox = mode === 'inbox';
    // Inbox mode takes no privacy level: the creator picks who sees the post in TikTok.
    const privacy = TIKTOK_PRIVACY_LEVELS.find((p) => p === input.settings.privacyLevel);
    // The commercial content and AI labels (#1078), checked before anything is sent.
    const disclosure = tiktokDisclosureOf(input.settings);
    if (disclosure === 'invalid') return { kind: 'rejected', error: 'bad_request', code: TIKTOK_DISCLOSURE_INVALID };
    if (disclosure && inbox) return { kind: 'rejected', error: 'bad_request', code: TIKTOK_DISCLOSURE_INBOX, message: 'A draft sent to the TikTok app takes no disclosure; set it in TikTok' };
    if (disclosure?.commercial && !disclosure.yourBrand && !disclosure.brandedContent) {
      return { kind: 'rejected', error: 'bad_request', code: TIKTOK_COMMERCIAL_CHOOSE, message: 'Choose whether the post promotes your own brand, another brand, or both' };
    }
    if (disclosure?.brandedContent && privacy === 'SELF_ONLY') return { kind: 'rejected', error: 'bad_request', code: TIKTOK_BRANDED_PRIVATE, message: 'Branded content visibility cannot be set to private' };
    const media = input.content.media;
    if (media.length > 0 && media.every((m) => m.mime.startsWith('image/'))) {
      if (inbox) return this.publishPhotos(input, s.accessToken, null, null);
      if (!privacy) return { kind: 'rejected', error: 'bad_request', code: 'PRIVACY_REQUIRED' };
      return this.publishPhotos(input, s.accessToken, privacy, disclosure);
    }
    const video = media[0];
    if (!video || !video.mime.startsWith('video/') || media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_REQUIRED' };
    if (!inbox && !privacy) return { kind: 'rejected', error: 'bad_request', code: 'PRIVACY_REQUIRED' };
    // A cover (#642): direct post takes a frame of the video (video_cover_timestamp_ms), never an uploaded image; the
    // inbox upload takes none (the creator picks it in TikTok).
    const cover = videoCoverOf(input.settings);
    if (cover && (inbox || !('atMs' in cover))) return { kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' };
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    const size = bytes.byteLength;
    const chunk = Math.min(size, CHUNK);
    const count = Math.max(1, Math.floor(size / chunk));
    const source = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count };
    // An init TikTok refused, or did not answer clearly, opened nothing: nothing is posted before the bytes arrive.
    const refused = (error: unknown): PublishResult => {
      const result = publishResult(error, inbox);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    };
    let init: { publish_id?: unknown; upload_url?: unknown };
    if (inbox) {
      // The Upload API's init takes the file's size and chunks only; the creator's options are TikTok's to show.
      try {
        init = await this.client.call('POST', '/post/publish/inbox/video/init/', s.accessToken, { source_info: source });
      } catch (error) {
        return refused(error);
      }
    } else {
      const chosen = privacy as TikTokPrivacy;
      // The creator's options now: the chosen privacy level must be one of them, and an interaction the creator turned
      // off stays off whatever the post asked.
      let creator: CreatorInfo;
      try {
        creator = await this.client.call<CreatorInfo>('POST', '/post/publish/creator_info/query/', s.accessToken, {});
      } catch (error) {
        return refused(error);
      }
      const options = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
      if (!options.includes(chosen)) return { kind: 'rejected', error: 'permission', code: 'PRIVACY_NOT_ALLOWED', message: `${chosen} is not available for this account` };
      // The creator's own limit on a video's length (it differs per account); TikTok would refuse the init otherwise.
      const maxSeconds = Number(creator.max_video_post_duration_sec);
      if (Number.isFinite(maxSeconds) && maxSeconds > 0 && typeof video.durationSeconds === 'number' && video.durationSeconds > maxSeconds) {
        return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TOO_LONG', message: `This account posts videos of up to ${Math.floor(maxSeconds)} seconds` };
      }
      try {
        init = await this.client.call('POST', '/post/publish/video/init/', s.accessToken, {
          post_info: {
            title: captionOf(input.content),
            privacy_level: chosen,
            disable_comment: creator.comment_disabled === true || input.settings.allowComments !== true,
            disable_duet: creator.duet_disabled === true || input.settings.allowDuet !== true,
            disable_stitch: creator.stitch_disabled === true || input.settings.allowStitch !== true,
            ...(cover && 'atMs' in cover ? { video_cover_timestamp_ms: cover.atMs } : {}),
            ...(disclosure ? brandFields(disclosure) : {}),
            ...(disclosure?.aiGenerated ? { is_aigc: true } : {}),
          },
          source_info: source,
        });
      } catch (error) {
        return refused(error);
      }
    }
    const publishId = typeof init.publish_id === 'string' ? init.publish_id : '';
    const uploadUrl = typeof init.upload_url === 'string' ? init.upload_url : '';
    if (!PUBLISH_ID.test(publishId) || !uploadUrl) return { kind: 'rejected', error: 'transient', code: 'NO_UPLOAD_URL' };
    try {
      for (let i = 0; i < count; i++) {
        const start = i * chunk;
        const end = i === count - 1 ? size : start + chunk;
        await this.client.chunk(uploadUrl, bytes, start, end, size, video.mime);
      }
    } catch (error) {
      // An upload TikTok did not take whole is never published; the status check says so for certain.
      const result = publishResult(error);
      return result.kind === 'rejected' ? { kind: 'rejected', error: 'transient', ...(result.code ? { code: result.code } : {}) } : { kind: 'pending', externalRef: publishId, checkAfterSeconds: CHECK_AFTER_SECONDS };
    }
    return { kind: 'pending', externalRef: publishId, checkAfterSeconds: CHECK_AFTER_SECONDS };
  }

  // A photo post: every image's URL first (nothing is sent without all of them), the creator's options, then one init.
  // privacy null: inbox mode (#903), an upload to the creator's TikTok inbox (MEDIA_UPLOAD) with its description only.
  // disclosure: the commercial content and AI labels of a direct post (#1078), already checked.
  private async publishPhotos(input: PublishInput, token: string, privacy: TikTokPrivacy | null, disclosure: TikTokDisclosure | null): Promise<PublishResult> {
    const images = input.content.media;
    if (images.length > PHOTO_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_MEDIA' };
    if (images.some((m) => !PHOTO_TYPES.includes(m.mime.toLowerCase()))) return { kind: 'rejected', error: 'bad_request', code: 'IMAGE_TYPE_NOT_ALLOWED', message: 'TikTok takes JPEG or WebP photos' };
    // The URLs together: presigning is local, and none is sent unless all of them are there.
    const found = await Promise.all(images.map((m) => input.mediaUrl(m.fileId).catch(() => null)));
    if (found.some((url) => !url)) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
    const urls = found as string[];
    const inbox = privacy === null;
    let postInfo: Record<string, unknown> = { description: captionOf(input.content, PHOTO_DESCRIPTION_MAX) };
    if (privacy !== null) {
      let creator: CreatorInfo;
      try {
        creator = await this.client.call<CreatorInfo>('POST', '/post/publish/creator_info/query/', token, {});
      } catch (error) {
        const result = publishResult(error);
        return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
      }
      const options = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
      if (!options.includes(privacy)) return { kind: 'rejected', error: 'permission', code: 'PRIVACY_NOT_ALLOWED', message: `${privacy} is not available for this account` };
      postInfo = {
        ...postInfo,
        privacy_level: privacy,
        disable_comment: creator.comment_disabled === true || input.settings.allowComments !== true,
        auto_add_music: input.settings.autoAddMusic === true,
        ...(disclosure ? brandFields(disclosure) : {}),
      };
    }
    let init: { publish_id?: unknown };
    try {
      init = await this.client.call('POST', '/post/publish/content/init/', token, {
        post_info: postInfo,
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: urls },
        post_mode: inbox ? 'MEDIA_UPLOAD' : 'DIRECT_POST',
        media_type: 'PHOTO',
        // The photo endpoint takes is_aigc beside post_info, not in it.
        ...(disclosure?.aiGenerated ? { is_aigc: true } : {}),
      });
    } catch (error) {
      // An init TikTok refused posted nothing; an unclear answer did not either, since no publish_id came back.
      const result = publishResult(error, inbox);
      const hint = result.kind === 'rejected' && result.code ? PHOTO_HINTS[result.code] : undefined;
      if (result.kind === 'rejected') return hint ? { ...result, message: hint } : result;
      return { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
    const publishId = typeof init.publish_id === 'string' ? init.publish_id : '';
    if (!PUBLISH_ID.test(publishId)) return { kind: 'rejected', error: 'transient', code: 'NO_PUBLISH_ID' };
    return { kind: 'pending', externalRef: publishId, checkAfterSeconds: CHECK_AFTER_SECONDS };
  }

  async status(input: StatusInput): Promise<PublishResult> {
    const s = tiktokSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!PUBLISH_ID.test(input.externalRef)) return { kind: 'unknown', code: 'BAD_PUBLISH_ID' };
    let answer: StatusAnswer;
    let raw = '';
    try {
      ({ data: answer, raw } = await this.client.callRaw<StatusAnswer>('POST', '/post/publish/status/fetch/', s.accessToken, { publish_id: input.externalRef }));
    } catch (error) {
      const result = publishResult(error);
      // A refused token ends the check. A status call TikTok refuses for good (a 4xx other than a rate limit) will not
      // start answering: the post may still be out, so a person looks, now rather than at the 24-hour cap. A rate
      // limit, an outage or the network: check again.
      if (result.kind === 'rejected' && result.error === 'token_expired') return result;
      const refused = result.kind === 'rejected' && (result.error === 'bad_request' || result.error === 'permission') && (result.httpStatus ?? 0) >= 400 && (result.httpStatus ?? 0) < 500;
      if (result.kind === 'rejected' && refused) return { kind: 'unknown', code: result.code ?? 'STATUS_REFUSED', ...(result.message ? { message: result.message } : {}) };
      return { kind: 'pending', externalRef: input.externalRef, checkAfterSeconds: CHECK_AFTER_SECONDS };
    }
    switch (answer.status) {
      case 'PUBLISH_COMPLETE': {
        const id = postIdOf(raw);
        // A private (SELF_ONLY) post has no public id: it is known by its publish_id. A public one still in moderation
        // has none yet either; the late-id sweep asks again for it (#1475).
        return { kind: 'accepted', externalId: id ?? input.externalRef, url: null };
      }
      case 'SEND_TO_USER_INBOX':
        // Inbox mode (#903): the draft is in the creator's TikTok inbox. The check ends here; the post is not public and
        // has no id until the creator posts it in TikTok, so it is known by its publish_id. The late-id sweep asks again
        // until they do (#1475).
        return { kind: 'accepted', externalId: input.externalRef, url: null, sentToApp: true };
      case 'FAILED':
        return { kind: 'rejected', error: 'bad_request', code: typeof answer.fail_reason === 'string' ? answer.fail_reason.slice(0, 100) : 'FAILED' };
      default:
        return { kind: 'pending', externalRef: input.externalRef, checkAfterSeconds: CHECK_AFTER_SECONDS };
    }
  }

  // Where a published post without its public id stands now (#1475): status/fetch again, a read only. PUBLISH_COMPLETE
  // with an id is the post out with its id (and its address from video/query, with video.list); without one, out with no
  // public id yet (moderation, or a post not public); FAILED, never posted; any other status is still on its way (an
  // inbox draft waits at SEND_TO_USER_INBOX until the creator posts it). A refused token is the connection's; a publish_id
  // TikTok refuses for good (invalid_publish_id) will not answer again; a rate limit or an outage is asked again later.
  async lateId(input: LateIdInput): Promise<LateIdResult> {
    const s = tiktokSecretOf(input.secret);
    if (!s) return { kind: 'refused' };
    if (!PUBLISH_ID.test(input.externalRef)) return { kind: 'failed', code: 'BAD_PUBLISH_ID' };
    let answer: StatusAnswer;
    let raw = '';
    try {
      ({ data: answer, raw } = await this.client.callRaw<StatusAnswer>('POST', '/post/publish/status/fetch/', s.accessToken, { publish_id: input.externalRef }));
    } catch (error) {
      const result = publishResult(error);
      if (result.kind === 'rejected' && result.error === 'token_expired') return { kind: 'refused' };
      const status = result.kind === 'rejected' ? (result.httpStatus ?? 0) : 0;
      if (result.kind === 'rejected' && (result.error === 'bad_request' || result.error === 'permission') && status >= 400 && status < 500) return { kind: 'failed', code: (result.code ?? 'STATUS_REFUSED').slice(0, 100) };
      return null;
    }
    switch (answer.status) {
      case 'PUBLISH_COMPLETE': {
        const id = postIdOf(raw);
        if (!id) return { kind: 'posted_without_id' };
        return { kind: 'posted', externalId: id, url: input.scopes.includes(TIKTOK_METRICS_SCOPE) ? await this.shareUrl(s.accessToken, id) : null };
      }
      case 'FAILED':
        return { kind: 'failed', code: typeof answer.fail_reason === 'string' && answer.fail_reason ? answer.fail_reason.slice(0, 100) : 'FAILED' };
      default:
        return { kind: 'waiting' };
    }
  }

  // A video's address from video/query (video.list); null when TikTok does not give one, whatever the reason: the id is
  // recorded all the same.
  private async shareUrl(token: string, id: string): Promise<string | null> {
    try {
      const answer = await this.client.call<{ videos?: { share_url?: unknown }[] }>('POST', '/video/query/?fields=id,share_url', token, { filters: { video_ids: [id] } });
      const url = answer.videos?.[0]?.share_url;
      return typeof url === 'string' && SHARE_URL.test(url) ? url : null;
    } catch {
      return null;
    }
  }
}
