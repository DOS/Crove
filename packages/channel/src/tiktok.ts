// TikTok video posts (S9, issue #412), written from TikTok's Login Kit and Content Posting API docs. One TikTok app
// serves every org of a deployment: CHANNEL_TIKTOK_CLIENT_KEY and CHANNEL_TIKTOK_CLIENT_SECRET.
//
// Connect: TikTok's consent screen for user.info.basic and video.publish; the access token lives a day and the refresh
// token a year, and the refresh schedule renews the access token. One grant is one TikTok account.
// Publish (Direct Post): the creator's current options first (privacy levels, interactions it allows, longest video),
// then an init call that opens the upload, the bytes in chunks, and a status check until TikTok has published it. The
// person posting chooses the privacy level and the interaction settings (TikTok's rules for the posting UI); an app TikTok
// has not audited can only post SELF_ONLY. A post is visible only after the bytes are in, so a failure before then
// posted nothing; after init, the publish_id says where it stands.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, Refresher, RetrySafety, StatusInput } from './index.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const TIKTOK_HOSTS = ['open.tiktokapis.com', 'open-upload.tiktokapis.com'] as const;
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'] as const;
export const TIKTOK_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY_LEVELS)[number];
const API = 'https://open.tiktokapis.com/v2';
const OPEN_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const PUBLISH_ID = /^[A-Za-z0-9_.~-]{1,128}$/;
const CHECK_AFTER_SECONDS = 30;
const TITLE_MAX = 2200;
// TikTok takes chunks of 5 to 64 MB, the last one up to 128 MB; a video under 5 MB goes whole.
const CHUNK = 64 * 1024 * 1024;

export interface TikTokAppConfig {
  clientKey: string;
  clientSecret: string;
}

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
    this.fetch = allowlistedFetch(TIKTOK_HOSTS, fetchImpl, 300_000);
  }

  get clientKey(): string {
    return this.app.clientKey;
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
    if (!response.ok || !body || (body.error?.code !== undefined && body.error.code !== 'ok')) throw new TikTokError(response.ok && body ? 400 : response.status, body);
    return { data: (body.data ?? {}) as T, raw };
  }

  async chunk(url: string, bytes: Uint8Array, start: number, end: number, total: number, type: string): Promise<void> {
    const response = await this.fetch(url, {
      method: 'PUT',
      headers: { 'content-type': type, 'content-range': `bytes ${start}-${end - 1}/${total}` },
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
    if (codeStep && error.status >= 400 && error.status < 500) return new ConnectorError('invalid_grant', 'TikTok refused the authorization code', error.code ?? String(error.status));
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
    url.searchParams.set('scope', TIKTOK_SCOPES.join(','));
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

function publishResult(error: unknown): PublishResult {
  if (!(error instanceof TikTokError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code ?? `HTTP_${error.status}`;
  if (error.status >= 500) return { kind: 'unknown', code, message: error.message };
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

const captionOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return (content.linkUrl && !body.includes(content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body).slice(0, TITLE_MAX);
};

export class TikTokPublisher implements Publisher {
  readonly provider = 'tiktok' as const;
  // Each init opens a new upload; an unclear answer after it is followed through the publish_id.
  readonly publishSafety: RetrySafety = 'never';
  private readonly client: TikTokClient;

  constructor(app: TikTokAppConfig, fetchImpl?: Fetch) {
    this.client = new TikTokClient(app, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = tiktokSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    const video = input.content.media[0];
    if (!video || !video.mime.startsWith('video/') || input.content.media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_REQUIRED' };
    const privacy = TIKTOK_PRIVACY_LEVELS.find((p) => p === input.settings.privacyLevel);
    if (!privacy) return { kind: 'rejected', error: 'bad_request', code: 'PRIVACY_REQUIRED' };
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    // The creator's options now: the chosen privacy level must be one of them, and an interaction the creator turned
    // off stays off whatever the post asked.
    let creator: CreatorInfo;
    try {
      creator = await this.client.call<CreatorInfo>('POST', '/post/publish/creator_info/query/', s.accessToken, {});
    } catch (error) {
      const result = publishResult(error);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
    const options = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
    if (!options.includes(privacy)) return { kind: 'rejected', error: 'permission', code: 'PRIVACY_NOT_ALLOWED', message: `${privacy} is not available for this account` };
    const size = bytes.byteLength;
    const chunk = Math.min(size, CHUNK);
    const count = Math.max(1, Math.floor(size / chunk));
    let init: { publish_id?: unknown; upload_url?: unknown };
    try {
      init = await this.client.call('POST', '/post/publish/video/init/', s.accessToken, {
        post_info: {
          title: captionOf(input.content),
          privacy_level: privacy,
          disable_comment: creator.comment_disabled === true || input.settings.allowComments !== true,
          disable_duet: creator.duet_disabled === true || input.settings.allowDuet !== true,
          disable_stitch: creator.stitch_disabled === true || input.settings.allowStitch !== true,
        },
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count },
      });
    } catch (error) {
      // Nothing is posted before the bytes arrive.
      const result = publishResult(error);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
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
      // The post may still go out: only a refused token ends the check.
      return result.kind === 'rejected' && result.error === 'token_expired' ? result : { kind: 'pending', externalRef: input.externalRef, checkAfterSeconds: CHECK_AFTER_SECONDS };
    }
    switch (answer.status) {
      case 'PUBLISH_COMPLETE': {
        // The first id as written in the answer (a 64-bit integer, or a string of digits), never through a JS number.
        const id = /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d{1,32})/.exec(raw)?.[1];
        // A private (SELF_ONLY) post has no public id: it is known by its publish_id.
        return { kind: 'accepted', externalId: id ?? input.externalRef, url: null };
      }
      case 'FAILED':
        return { kind: 'rejected', error: 'bad_request', code: typeof answer.fail_reason === 'string' ? answer.fail_reason.slice(0, 100) : 'FAILED' };
      default:
        return { kind: 'pending', externalRef: input.externalRef, checkAfterSeconds: CHECK_AFTER_SECONDS };
    }
  }
}
