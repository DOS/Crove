// YouTube uploads (S9, issue #411), written from the YouTube Data API v3 and Google OAuth 2.0 docs. One Google Cloud
// project serves every org of a deployment: CHANNEL_GOOGLE_CLIENT_ID and CHANNEL_GOOGLE_CLIENT_SECRET.
//
// Connect: Google's consent screen for youtube.upload and youtube.readonly with offline access, so a refresh token
// comes back; the access token lives an hour and the refresh schedule renews it. One grant is one YouTube channel.
// Publish: a resumable upload session (the video's title, description and privacy), then one PUT of the bytes; the
// answer names the video. The project's quota allows about 100 uploads a day; a quota refusal waits, never fails.
// An unclear answer is checked by listing the channel's latest uploads (one quota unit), matched by title and time.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RetrySafety } from './index.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const YOUTUBE_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com'] as const;
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] as const;
const API = 'https://www.googleapis.com/youtube/v3';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PRIVACY = ['public', 'unlisted', 'private'] as const;
// YouTube's own limits on a video's metadata.
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;

export interface GoogleAppConfig {
  clientId: string;
  clientSecret: string;
}

export class YouTubeError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, body: Record<string, unknown> | null) {
    const error = body?.error;
    const nested = error !== null && typeof error === 'object' ? (error as { message?: unknown; errors?: { reason?: unknown }[] }) : null;
    const message = typeof nested?.message === 'string' ? nested.message : typeof body?.error_description === 'string' ? body.error_description : `Google answered ${status}`;
    super(message);
    this.name = 'YouTubeError';
    this.status = status;
    const reason = nested?.errors?.[0]?.reason ?? (typeof error === 'string' ? error : undefined);
    this.reason = typeof reason === 'string' ? reason : undefined;
  }
}

export interface YouTubeSecret {
  accessToken: string;
  refreshToken: string;
}

export function youtubeSecretOf(secret: string): YouTubeSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<YouTubeSecret>;
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

class GoogleClient {
  private readonly fetch: Fetch;
  private readonly app: GoogleAppConfig;

  constructor(app: GoogleAppConfig, fetchImpl?: Fetch) {
    if (!/^[0-9]{6,32}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/.test(app.clientId)) throw new Error('invalid Google client id');
    if (!app.clientSecret) throw new Error('missing Google client secret');
    this.app = app;
    // A video of up to 100 MB goes in one PUT.
    this.fetch = allowlistedFetch(YOUTUBE_HOSTS, fetchImpl, 300_000);
  }

  get clientId(): string {
    return this.app.clientId;
  }

  async token(form: Record<string, string>): Promise<TokenAnswer> {
    const response = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...form }).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new YouTubeError(response.status, json);
    return json as TokenAnswer;
  }

  async call<T>(method: 'GET' | 'POST' | 'PUT', url: string, token: string, options: { json?: unknown; bytes?: { data: Uint8Array; type: string } } = {}): Promise<{ body: T | null; location: string | null }> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    let body: string | Blob | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(options.json);
    } else if (options.bytes) {
      headers['content-type'] = options.bytes.type;
      body = new Blob([new Uint8Array(options.bytes.data)], { type: options.bytes.type });
    }
    const response = await this.fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new YouTubeError(response.status, json);
    return { body: json as T | null, location: response.headers.get('location') };
  }
}

const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
};

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof YouTubeError) {
    if (codeStep && error.status >= 400 && error.status < 500) return new ConnectorError('invalid_grant', 'Google refused the authorization code', error.reason ?? String(error.status));
    return new ConnectorError(error.status === 403 ? 'denied' : 'provider', error.message, error.reason ?? String(error.status));
  }
  return new ConnectorError('provider', `Google could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

interface ChannelList {
  items?: { id?: unknown; snippet?: { title?: unknown; customUrl?: unknown }; contentDetails?: { relatedPlaylists?: { uploads?: unknown } } }[];
}

export class YouTubeConnector implements OAuthConnector {
  readonly provider = 'youtube' as const;
  readonly pkce = true;
  private readonly client: GoogleClient;

  constructor(app: GoogleAppConfig, fetchImpl?: Fetch) {
    this.client = new GoogleClient(app, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
    url.searchParams.set('state', input.state);
    // Offline access with consent each time, so Google returns a refresh token even for a channel connected before.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchange(input: ExchangeInput, now = Date.now()): Promise<ConnectedAccount[]> {
    const answer = await this.client
      .token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}) })
      .catch((error: unknown) => {
        throw connectorError(error, true);
      });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Google answered without an access token');
    if (typeof answer.refresh_token !== 'string' || !answer.refresh_token) throw new ConnectorError('provider', 'Google answered without a refresh token');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : [];
    if (!granted.includes(YOUTUBE_SCOPES[0])) throw new ConnectorError('denied', 'Google did not grant youtube.upload', 'MISSING_PERMISSION');
    const channels = await this.client.call<ChannelList>('GET', `${API}/channels?part=snippet&mine=true`, answer.access_token).catch((error: unknown) => {
      throw connectorError(error);
    });
    const channel = channels.body?.items?.[0];
    const id = typeof channel?.id === 'string' ? channel.id : '';
    if (!CHANNEL_ID.test(id)) throw new ConnectorError('denied', 'This Google account has no YouTube channel', 'NO_CHANNEL');
    const title = typeof channel?.snippet?.title === 'string' && channel.snippet.title.trim() ? channel.snippet.title.trim() : `YouTube ${id}`;
    const secret: YouTubeSecret = { accessToken: answer.access_token, refreshToken: answer.refresh_token };
    return [{ provider: 'youtube', externalAccountId: id, displayName: title.slice(0, 200), scopes: granted, expiresAt: expiryOf(answer, now), secret: JSON.stringify(secret) }];
  }
}

// Renews the hour-long access token a quarter of an hour before it expires; Google keeps the refresh token.
export class YouTubeRefresher implements Refresher {
  readonly provider = 'youtube' as const;
  readonly horizonSeconds = 15 * 60;
  private readonly client: GoogleClient;

  constructor(app: GoogleAppConfig, fetchImpl?: Fetch) {
    this.client = new GoogleClient(app, fetchImpl);
  }

  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }> {
    const s = youtubeSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const answer = await this.client.token({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
      if (typeof answer.access_token !== 'string' || !answer.access_token) return { failed: 'NO_ACCESS_TOKEN' };
      // Google may hand out a new refresh token; otherwise the old one stays.
      const next: YouTubeSecret = { accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : s.refreshToken };
      return { secret: JSON.stringify(next), expiresAt: expiryOf(answer) };
    } catch (error) {
      // invalid_grant: the grant was revoked, or expired (an app in testing mode gets 7-day refresh tokens).
      if (error instanceof YouTubeError && error.reason === 'invalid_grant') return { refused: 'invalid_grant' };
      return { failed: error instanceof YouTubeError ? (error.reason ?? String(error.status)) : 'NETWORK' };
    }
  }
}

function publishResult(error: unknown): PublishResult {
  if (!(error instanceof YouTubeError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.reason ?? `HTTP_${error.status}`;
  if (error.status >= 500 || error.status < 400) return { kind: 'unknown', code, message: error.message };
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  // The project's daily quota or a burst limit: try again later.
  if (error.status === 429 || error.reason === 'quotaExceeded' || error.reason === 'rateLimitExceeded' || error.reason === 'userRateLimitExceeded' || error.reason === 'uploadLimitExceeded') {
    return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status };
  }
  if (error.status === 403) return { kind: 'rejected', error: 'permission', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

// Nothing is visible before the bytes are sent, so a failure while opening the session posted nothing.
const beforeUpload = (result: PublishResult): PublishResult =>
  result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };

const titleOf = (content: { title: string | null }) => (content.title ?? '').trim().slice(0, TITLE_MAX);
const descriptionOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  const text = content.linkUrl && !body.includes(content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
  // YouTube refuses angle brackets in a description.
  return text.replace(/[<>]/g, '').slice(0, DESCRIPTION_MAX);
};

interface PlaylistItems {
  items?: { snippet?: { title?: unknown; publishedAt?: unknown; resourceId?: { videoId?: unknown } } }[];
}

export class YouTubePublisher implements Publisher {
  readonly provider = 'youtube' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly client: GoogleClient;

  constructor(app: GoogleAppConfig, fetchImpl?: Fetch) {
    this.client = new GoogleClient(app, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = youtubeSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    const video = input.content.media[0];
    if (!video || !video.mime.startsWith('video/') || input.content.media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_REQUIRED' };
    const title = titleOf(input.content);
    if (!title) return { kind: 'rejected', error: 'bad_request', code: 'TITLE_REQUIRED' };
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    const privacy = PRIVACY.find((p) => p === input.settings.privacy) ?? 'public';
    const metadata = {
      snippet: { title, description: descriptionOf(input.content), categoryId: typeof input.settings.categoryId === 'string' && /^\d{1,3}$/.test(input.settings.categoryId) ? input.settings.categoryId : '22' },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: input.settings.madeForKids === true, embeddable: true },
    };
    let session: string;
    try {
      const opened = await this.client.call('POST', 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', s.accessToken, { json: metadata });
      if (!opened.location) return { kind: 'rejected', error: 'transient', code: 'NO_UPLOAD_SESSION' };
      session = opened.location;
    } catch (error) {
      return beforeUpload(publishResult(error));
    }
    try {
      const uploaded = await this.client.call<{ id?: unknown }>('PUT', session, s.accessToken, { bytes: { data: bytes, type: video.mime } });
      const id = typeof uploaded.body?.id === 'string' ? uploaded.body.id : '';
      if (!VIDEO_ID.test(id)) return { kind: 'unknown', code: 'NO_VIDEO_ID' };
      return { kind: 'accepted', externalId: id, url: `https://www.youtube.com/watch?v=${id}` };
    } catch (error) {
      return publishResult(error);
    }
  }

  // The channel's latest uploads with the same title in the window.
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = youtubeSecretOf(input.secret);
    const title = titleOf(input.content);
    if (!s || !title || !CHANNEL_ID.test(input.externalAccountId)) return { found: 'unknown' };
    try {
      // A channel's uploads playlist is its id with UU in place of UC.
      const playlist = `UU${input.externalAccountId.slice(2)}`;
      const answer = await this.client.call<PlaylistItems>('GET', `${API}/playlistItems?part=snippet&maxResults=25&playlistId=${playlist}`, s.accessToken);
      const from = input.after.getTime() - 60_000;
      const to = input.before.getTime() + 10 * 60_000;
      for (const item of answer.body?.items ?? []) {
        const id = item.snippet?.resourceId?.videoId;
        const at = typeof item.snippet?.publishedAt === 'string' ? Date.parse(item.snippet.publishedAt) : Number.NaN;
        if (typeof id === 'string' && VIDEO_ID.test(id) && item.snippet?.title === title && at >= from && at <= to) {
          return { found: true, externalId: id, url: `https://www.youtube.com/watch?v=${id}` };
        }
      }
      return { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }
}
