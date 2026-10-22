// YouTube uploads (S9, issue #411), written from the YouTube Data API v3 and Google OAuth 2.0 docs. One Google Cloud
// project serves every org of a deployment: CHANNEL_GOOGLE_CLIENT_ID and CHANNEL_GOOGLE_CLIENT_SECRET.
//
// Connect: Google's consent screen for youtube.upload and youtube.readonly with offline access, so a refresh token
// comes back; the access token lives an hour and the refresh schedule renews it. One grant is one YouTube channel.
// Publish: a resumable upload session (the video's title, description, privacy, and since #905 its category, tags and
// audience), then one PUT of the bytes; the answer names the video. The project's quota allows about 100 uploads a day; a quota refusal waits, never fails.
// An unclear answer is checked by listing the channel's latest uploads (one quota unit), matched by title and time.
// Metrics: views, likes and comments from videos.list (one quota unit each).
// First comment (#791): commentThreads.insert on the video, with the force-ssl scope (50 quota units).
// Playlists (#1018): once the video is out, playlistItems.insert puts it into each of the channel's playlists the
// variant names (settings.youtube.playlistIds, at most 5), one call each (50 quota units), with the force-ssl scope too.
// A refused insert (a playlist deleted since) never touches the video. playlists() lists the channel's own playlists
// (playlists.list mine=true, one quota unit) for the composer.
import type { CommentInput, CommentResult, ConnectedAccount, MetricName, AccountMetricsInput, AccountMetricsResult, MetricsInput, MetricsResult, PlaylistInput, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RetrySafety } from './index.ts';
import { coverImageType, videoCoverOf } from './cover.ts';
import { commentResult } from './comment.ts';
import { holdsLink } from './text.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';

export const YOUTUBE_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com'] as const;
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] as const;
// Asked for too but not required (#791): the first comment needs it. A channel connected without it posts videos and
// is told to reconnect when a comment is refused.
export const YOUTUBE_COMMENT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const API = 'https://www.googleapis.com/youtube/v3';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// A playlist a channel made itself: PL and 16 or 32 more characters. modules/social checks the same shape
// (YOUTUBE_PLAYLIST_ID) when a variant is saved.
export const YOUTUBE_PLAYLIST_ID = /^PL[A-Za-z0-9_-]{16,32}$/;
// Playlists one lookup reads: one page, as playlists.list pages them.
const PLAYLISTS_PAGE = 50;
const PRIVACY = ['public', 'unlisted', 'private'] as const;
// YouTube's own limits on a video's metadata.
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
// The PUT of a video of up to 100 MB; the job waits a little longer (callTimeoutMs), so this abort is the adapter's.
const UPLOAD_TIMEOUT_MS = 300_000;

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
    if (!/^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/.test(app.clientId)) throw new Error('invalid Google client id');
    if (!app.clientSecret) throw new Error('missing Google client secret');
    this.app = app;
    this.fetch = allowlistedFetch(YOUTUBE_HOSTS, fetchImpl);
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

  // timeoutMs: 30 seconds for a JSON call, more for the video bytes (the PUT of up to 100 MB).
  async call<T>(method: 'GET' | 'POST' | 'PUT', url: string, token: string, options: { json?: unknown; bytes?: { data: Uint8Array; type: string }; timeoutMs?: number } = {}): Promise<{ body: T | null; location: string | null }> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    let body: string | Blob | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(options.json);
    } else if (options.bytes) {
      headers['content-type'] = options.bytes.type;
      body = new Blob([new Uint8Array(options.bytes.data)], { type: options.bytes.type });
    }
    const response = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(body === undefined ? {} : { body }) });
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
    // Only invalid_grant is the code itself; invalid_client or redirect_uri_mismatch is the deployment's configuration.
    if (codeStep && error.reason === 'invalid_grant') return new ConnectorError('invalid_grant', 'Google refused the authorization code', error.reason);
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
    url.searchParams.set('scope', [...YOUTUBE_SCOPES, YOUTUBE_COMMENT_SCOPE].join(' '));
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
    // Both: upload posts, readonly finds the channel and reconciles an unclear upload.
    if (!YOUTUBE_SCOPES.every((s) => granted.includes(s))) throw new ConnectorError('denied', 'Google did not grant the YouTube permissions Crove needs', 'MISSING_PERMISSION');
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

// Cuts never split a character: a title is limited in characters, a description in UTF-8 bytes (Vietnamese letters
// with a tone mark take three).
export function clipCodepoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}
export function clipBytes(s: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= max) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = encoder.encode(ch).length;
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

// YouTube refuses angle brackets in a title, as in a description.
const titleOf = (content: { title: string | null }) => clipCodepoints((content.title ?? '').replace(/[<>]/g, '').trim(), TITLE_MAX);
const descriptionOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  const text = content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
  // YouTube refuses angle brackets in a description.
  return clipBytes(text.replace(/[<>]/g, ''), DESCRIPTION_MAX);
};

// The video's tags (#905): settings.tags, a list of strings. The composer checks YouTube's 500-character total and
// refuses angle brackets; here each tag is trimmed, an empty one dropped, and angle brackets removed as in the title.
const tagsOf = (settings: Readonly<Record<string, unknown>>): string[] =>
  Array.isArray(settings.tags) ? settings.tags.filter((t): t is string => typeof t === 'string').map((t) => t.replace(/[<>]/g, '').trim()).filter(Boolean) : [];

interface PlaylistItems {
  items?: { snippet?: { title?: unknown; description?: unknown; publishedAt?: unknown; resourceId?: { videoId?: unknown } } }[];
}

// YouTube keeps a description as sent, but its line endings and outer spaces may differ.
// A video without one may come back with no description field at all.
const sameText = (got: unknown, sent: string) => (typeof got === 'string' ? got : '').replace(/\r\n/g, '\n').trim() === sent.replace(/\r\n/g, '\n').trim();

export class YouTubePublisher implements Publisher {
  readonly provider = 'youtube' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  // The PUT of up to 100 MB has 300 seconds of its own; the job waits a little longer, so the adapter sees its own abort.
  readonly callTimeoutMs = 420_000;
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
    // A cover (#642) is an image YouTube takes as the video's thumbnail once it is uploaded; the Data API cannot pick
    // a frame. The image is read before anything is sent, like the video.
    const cover = videoCoverOf(input.settings);
    if (cover && !('fileId' in cover)) return { kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' };
    let bytes: Uint8Array;
    let thumbnail: Uint8Array | null = null;
    try {
      bytes = await input.readMedia(video.fileId);
      if (cover) thumbnail = await input.readMedia(cover.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    const privacy = PRIVACY.find((p) => p === input.settings.privacy) ?? 'public';
    const tags = tagsOf(input.settings);
    const metadata = {
      snippet: {
        title,
        description: descriptionOf(input.content),
        categoryId: typeof input.settings.categoryId === 'string' && /^\d{1,3}$/.test(input.settings.categoryId) ? input.settings.categoryId : '22',
        ...(tags.length > 0 ? { tags } : {}),
      },
      // A variant saved before the audience could be chosen (#905) goes out as not made for kids, as it always did.
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
      const uploaded = await this.client.call<{ id?: unknown }>('PUT', session, s.accessToken, { bytes: { data: bytes, type: video.mime }, timeoutMs: UPLOAD_TIMEOUT_MS });
      const id = typeof uploaded.body?.id === 'string' ? uploaded.body.id : '';
      if (!VIDEO_ID.test(id)) return { kind: 'unknown', code: 'NO_VIDEO_ID' };
      if (thumbnail) await this.setThumbnail(id, s.accessToken, thumbnail);
      return { kind: 'accepted', externalId: id, url: `https://www.youtube.com/watch?v=${id}` };
    } catch (error) {
      return publishResult(error);
    }
  }

  // thumbnails.set with the cover's bytes. The video is out already, so a refused thumbnail (a channel not allowed
  // custom thumbnails, an image over 2 MB) never fails the post: it is logged, and the video keeps YouTube's own.
  // A top-level comment on the channel's own video. A grant without the comment scope is told apart, so the post page
  // can say to reconnect; a video with comments turned off (made for kids, or by its settings) is refused as such.
  async comment(input: CommentInput): Promise<CommentResult> {
    const s = youtubeSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!CHANNEL_ID.test(input.externalAccountId) || !VIDEO_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    const thread = { snippet: { channelId: input.externalAccountId, videoId: input.externalId, topLevelComment: { snippet: { textOriginal: input.text } } } };
    try {
      const answer = await this.client.call<{ id?: unknown }>('POST', `${API}/commentThreads?part=snippet`, s.accessToken, { json: thread });
      const id = answer.body?.id;
      if (typeof id !== 'string' || !id || id.length > 200) return { kind: 'unknown', code: 'NO_COMMENT_ID' };
      return { kind: 'accepted', externalId: id };
    } catch (error) {
      if (error instanceof YouTubeError && error.status === 403 && (error.reason === 'insufficientPermissions' || error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
        return { kind: 'rejected', error: 'permission', code: 'RECONNECT_FOR_COMMENTS', message: error.message };
      }
      if (error instanceof YouTubeError && error.reason === 'commentsDisabled') return { kind: 'rejected', error: 'bad_request', code: 'COMMENTS_DISABLED', message: error.message };
      return commentResult(publishResult(error));
    }
  }

  // Puts the channel's own published video into one of its playlists. Like a comment, a grant without the force-ssl
  // scope is told apart (RECONNECT_FOR_PLAYLISTS), and a playlist that is gone (deleted since the post was written)
  // answers 404 playlistNotFound: PLAYLIST_NOT_FOUND, for the post page to say so. Nothing here touches the video.
  async playlist(input: PlaylistInput): Promise<CommentResult> {
    const s = youtubeSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!VIDEO_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    if (!YOUTUBE_PLAYLIST_ID.test(input.playlistId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_PLAYLIST_ID' };
    const item = { snippet: { playlistId: input.playlistId, resourceId: { kind: 'youtube#video', videoId: input.externalId } } };
    try {
      const answer = await this.client.call<{ id?: unknown }>('POST', `${API}/playlistItems?part=snippet`, s.accessToken, { json: item });
      const id = answer.body?.id;
      if (typeof id !== 'string' || !id || id.length > 200) return { kind: 'unknown', code: 'NO_PLAYLIST_ITEM_ID' };
      return { kind: 'accepted', externalId: id };
    } catch (error) {
      if (error instanceof YouTubeError && error.status === 403 && (error.reason === 'insufficientPermissions' || error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
        return { kind: 'rejected', error: 'permission', code: 'RECONNECT_FOR_PLAYLISTS', message: error.message };
      }
      if (error instanceof YouTubeError && error.status === 404 && error.reason === 'playlistNotFound') return { kind: 'rejected', error: 'bad_request', code: 'PLAYLIST_NOT_FOUND', message: error.message };
      // Another channel's playlist, or one the channel may not add to.
      if (error instanceof YouTubeError && error.status === 403 && (error.reason === 'playlistItemsNotAccessible' || error.reason === 'forbidden')) {
        return { kind: 'rejected', error: 'permission', code: 'PLAYLIST_NOT_ALLOWED', message: error.message };
      }
      return commentResult(publishResult(error));
    }
  }

  // The channel's own playlists, the first page of 50 (playlists.list mine=true, one quota unit), for the composer's
  // picker; it only reads. null: Google did not answer (try again later).
  async playlists(input: { secret: string }): Promise<{ playlists: { id: string; title: string }[] } | { refused: 'token_expired' | 'permission' } | null> {
    const s = youtubeSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    try {
      const answer = await this.client.call<{ items?: { id?: unknown; snippet?: { title?: unknown } }[] }>('GET', `${API}/playlists?part=snippet&mine=true&maxResults=${PLAYLISTS_PAGE}`, s.accessToken);
      const playlists: { id: string; title: string }[] = [];
      for (const item of answer.body?.items ?? []) {
        if (typeof item.id !== 'string' || !YOUTUBE_PLAYLIST_ID.test(item.id)) continue;
        const title = typeof item.snippet?.title === 'string' && item.snippet.title.trim() ? item.snippet.title.trim() : item.id;
        playlists.push({ id: item.id, title: clipCodepoints(title, 150) });
      }
      return { playlists };
    } catch (error) {
      if (error instanceof YouTubeError && error.status === 401) return { refused: 'token_expired' };
      if (error instanceof YouTubeError && error.status === 403) return { refused: 'permission' };
      return null;
    }
  }

  private async setThumbnail(videoId: string, token: string, image: Uint8Array): Promise<void> {
    try {
      await this.client.call('POST', `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=${videoId}`, token, { bytes: { data: image, type: coverImageType(image) } });
    } catch (error) {
      const reason = error instanceof YouTubeError ? (error.reason ?? `HTTP_${error.status}`) : 'NETWORK';
      console.warn(`[youtube] thumbnail of video ${videoId} not set: ${reason}`);
    }
  }

  // Views, likes and comments of a published video (videos.list part=statistics, one quota unit). YouTube hides the
  // like count when the owner turned it off, and leaves it out then; a video that is gone answers no item.
  // The channel's subscribers (#645); a channel that hides the count reports none.
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const s = youtubeSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    try {
      const answer = await this.client.call<{ items?: { id?: unknown; statistics?: { subscriberCount?: unknown; hiddenSubscriberCount?: unknown } }[] }>(
        'GET',
        `${API}/channels?part=statistics&mine=true`,
        s.accessToken,
      );
      const item = (answer.body?.items ?? []).find((i) => i.id === input.externalAccountId);
      if (!item) return null;
      const n = item.statistics?.subscriberCount;
      if (item.statistics?.hiddenSubscriberCount === true || typeof n !== 'string' || !/^\d{1,15}$/.test(n)) return { followers: null };
      return { followers: Number(n) };
    } catch (error) {
      if (error instanceof YouTubeError && error.status === 401) return { refused: 'token_expired' };
      if (error instanceof YouTubeError && error.status === 403) return { refused: 'permission' };
      return null;
    }
  }

  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const s = youtubeSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!VIDEO_ID.test(input.externalId)) return { refused: 'gone' };
    try {
      const answer = await this.client.call<{ items?: { id?: unknown; statistics?: { viewCount?: unknown; likeCount?: unknown; commentCount?: unknown } }[] }>(
        'GET',
        `${API}/videos?part=statistics&id=${input.externalId}`,
        s.accessToken,
      );
      const item = (answer.body?.items ?? []).find((i) => i.id === input.externalId);
      if (!item) return { refused: 'gone' };
      // Counts come as decimal strings.
      const n = (v: unknown) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
      const metrics: Partial<Record<MetricName, number>> = {};
      const views = n(item.statistics?.viewCount);
      const likes = n(item.statistics?.likeCount);
      const comments = n(item.statistics?.commentCount);
      if (views !== undefined) metrics.views = views;
      if (likes !== undefined) metrics.reactions = likes;
      if (comments !== undefined) metrics.comments = comments;
      return { metrics };
    } catch (error) {
      if (error instanceof YouTubeError && error.status === 401) return { refused: 'token_expired' };
      return null;
    }
  }

  // The channel's latest uploads with the same title in the window.
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = youtubeSecretOf(input.secret);
    const title = titleOf(input.content);
    const description = descriptionOf(input.content);
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
        // The description too, so a repost with the same title in the window is not taken for this one.
        if (typeof id === 'string' && VIDEO_ID.test(id) && item.snippet?.title === title && sameText(item.snippet?.description, description) && at >= from && at <= to) {
          return { found: true, externalId: id, url: `https://www.youtube.com/watch?v=${id}` };
        }
      }
      return { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }
}
