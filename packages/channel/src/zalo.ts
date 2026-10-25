// Zalo Official Account (S6.4, issue #374). Endpoints and fields from Zalo's OA API v2 and OAuth v4, cross-checked with
// a community SDK; not yet tried against a live OA (docs/plan/social-research.md §4 marks the open points). One Zalo
// app serves every org of a deployment: CHANNEL_ZALO_APP_ID and CHANNEL_ZALO_APP_SECRET.
//
// Connect: OAuth v4 with PKCE. The OA admin grants the app; the code becomes an access token (about 25 hours) and a
// refresh token (3 months, single use: every refresh returns a new one, and the old one stops working). The refresh
// schedule in the worker renews tokens before they expire and seals the new pair at once.
//
// Publish: an article is created asynchronously (`article/create` answers a token), then `article/verify` turns the
// token into the article id once Zalo has processed it. Zalo fetches every image from a public URL (1 MB at most each):
// the first is the cover, the others follow the text as image blocks (#943).
//
// A video article (#1429), per the OA content docs (developers.zalo.me, "Tải video lên cho nội dung bài viết" and
// "Nội dung dạng bài viết có gắn video"): the video goes up first as a multipart POST to
// `article/upload_video/preparevideo` (MP4 or AVI, 50 MB at most), which answers a token; `article/upload_video/verify`
// (a GET with the token as a header) reports its status (1 ready, 3 processing, 2 locked, 4 failed, 5 deleted, 0
// unknown) and its video_id. Only then is the article created, `type: 'video'` with the video_id and a thumbnail URL
// (avatar), and checked with `article/verify` like any article.
import type { ConnectedAccount, MetricName, AccountMetricsInput, AccountMetricsResult, MetricsInput, MetricsResult, Publisher, Refresher, PublishInput, PublishMedia, PublishResult, ReconcileInput, ReconcileResult, RetrySafety, StatusInput } from './index.ts';
import { videoCoverOf } from './cover.ts';
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
// Images per article (#943): Zalo's article docs set no count, so this is Crove's cap, kept in step with the zalo_oa
// media rule of @crove/mod-social. Zalo refuses an image file over 1 MB.
const IMAGES_MAX = 10;
const IMAGE_MAX_BYTES = 1024 * 1024;
// A video article's file (#1429): Zalo takes MP4 and AVI up to 50 MB; Crove's uploads are MP4 or QuickTime, so MP4.
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
// The upload of a video of up to 50 MB; with the processing wait it stays inside callTimeoutMs.
const VIDEO_UPLOAD_TIMEOUT_MS = 180_000;
// How long a publish waits for Zalo to process a video; with the upload it stays inside callTimeoutMs.
const PROCESSING_WAIT_MS = 300_000;
// The last status check, the article and its check (15 s each at most) plus slack fit between the budget and
// callTimeoutMs.
const VIDEO_CALL_MARGIN_MS = 90_000;
// Zalo's video statuses that end the wait without a video (upload_video/verify): locked, failed, deleted.
const VIDEO_DEAD: Readonly<Record<number, string>> = { 2: 'ZALO_VIDEO_LOCKED', 4: 'ZALO_VIDEO_FAILED', 5: 'ZALO_VIDEO_DELETED' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ZaloAppConfig {
  appId: string;
  appSecret: string;
  // The article's author when the channel sets none: the product name users see (BRAND_NAME, #1045), "Crove" when not
  // given.
  defaultAuthor?: string;
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

  // headers: more request headers (the video check's token); multipart: a form whose content type fetch sets with its
  // boundary (a video upload); timeoutMs: longer than the default, for an upload.
  async api<T>(method: 'GET' | 'POST', path: string, token: string, options: { params?: Record<string, string>; json?: unknown; headers?: Record<string, string>; multipart?: FormData; timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...options.headers, access_token: token, accept: 'application/json' };
    let body: string | FormData | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.multipart) {
      body = options.multipart;
    }
    const response = await this.fetch(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });
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
interface VideoTokenAnswer {
  token?: unknown;
}
interface VideoStatusAnswer {
  status?: unknown;
  video_id?: unknown;
  status_message?: unknown;
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

// One image of the article: the URL Zalo fetches it from, and its alt text as the caption Zalo shows under it.
interface ArticleImage {
  url: string;
  caption: string | null;
}

// The article's description: the text's first line, cut to Zalo's 300 characters.
function descriptionOf(input: PublishInput): string {
  const body = input.content.body.trim();
  return (body.split('\n').find((line) => line.trim()) ?? body).trim().slice(0, DESCRIPTION_MAX);
}

// A video article (#1429): the title, the description, the processed video and its thumbnail; Zalo's video article
// has no author or body. Its status defaults to hidden, so it is shown at once like the other articles.
function videoArticleOf(input: PublishInput, videoId: string, avatar: string) {
  return {
    type: 'video',
    title: (input.content.title ?? '').trim().slice(0, TITLE_MAX),
    description: descriptionOf(input),
    video_id: videoId,
    avatar,
    status: 'show',
    comment: input.settings.comments === false ? 'hide' : 'show',
  };
}

// Nothing is visible before the article, so a failure while uploading or waiting for the video posted nothing.
const beforeArticle = (result: PublishResult): PublishResult =>
  result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };

// The article Zalo shows: the post's title and text, the text's first lines as the description, the first image as
// the cover. The cover is shown at the top of the article, so the other images follow the text as image blocks, in
// order, each captioned with its alt text (Zalo's caption is optional). Comments are on unless settings.comments is
// false (#943).
function articleOf(input: PublishInput, images: readonly ArticleImage[], defaultAuthor = 'Crove') {
  const body = input.content.body.trim();
  const description = descriptionOf(input);
  const author = typeof input.settings.author === 'string' && input.settings.author.trim() ? input.settings.author.trim().slice(0, AUTHOR_MAX) : defaultAuthor.slice(0, AUTHOR_MAX);
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (input.content.linkUrl) paragraphs.push(input.content.linkUrl);
  const [cover, ...rest] = images;
  return {
    type: 'normal',
    title: (input.content.title ?? '').trim().slice(0, TITLE_MAX),
    author,
    cover: { cover_type: 'photo', photo_url: cover?.url ?? '', status: 'show' },
    description,
    body: [
      ...paragraphs.map((content) => ({ type: 'text', content })),
      ...rest.map((image) => ({ type: 'image', url: image.url, ...(image.caption ? { caption: image.caption } : {}) })),
    ],
    status: 'show',
    comment: input.settings.comments === false ? 'hide' : 'show',
  };
}

export class ZaloOaPublisher implements Publisher {
  readonly provider = 'zalo_oa' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  // A video's upload and processing take minutes; within the job's stale limit (600 s).
  readonly callTimeoutMs = 420_000;
  private readonly client: ZaloClient;
  private readonly defaultAuthor: string;
  private readonly processingWaitMs: number;
  private readonly pollMs: number;
  private readonly budgetMs: number;

  constructor(app: ZaloAppConfig, fetchImpl?: Fetch, timing: { processingWaitMs?: number; pollMs?: number; budgetMs?: number } = {}) {
    this.client = new ZaloClient(app, fetchImpl);
    this.defaultAuthor = app.defaultAuthor ?? 'Crove';
    this.processingWaitMs = timing.processingWaitMs ?? PROCESSING_WAIT_MS;
    this.pollMs = timing.pollMs ?? 5000;
    this.budgetMs = timing.budgetMs ?? this.callTimeoutMs - VIDEO_CALL_MARGIN_MS;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = zaloSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    const media = input.content.media;
    if (media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_REQUIRED' };
    if (media.some((m) => m.mime.startsWith('video/'))) return this.publishVideo(input, s.accessToken);
    // The channel checks hold these back already; a post past them is refused whole, never cut.
    if (media.length > IMAGES_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_MEDIA' };
    if (media.some((m) => m.sizeBytes > IMAGE_MAX_BYTES)) return { kind: 'rejected', error: 'bad_request', code: 'IMAGE_TOO_LARGE' };
    if (!(input.content.title ?? '').trim()) return { kind: 'rejected', error: 'bad_request', code: 'TITLE_REQUIRED' };
    // One URL per image, as for the cover alone before: Zalo fetches them itself, so this makes no call to Zalo.
    const urls = await Promise.all(media.map((m) => input.mediaUrl(m.fileId).catch(() => null)));
    if (urls.some((url) => !url)) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
    const images = media.map((m, i) => ({ url: urls[i] as string, caption: m.altText?.trim() || null }));
    let token: string;
    try {
      const answer = await this.client.api<CreateAnswer>('POST', 'article/create', s.accessToken, { json: articleOf(input, images, this.defaultAuthor) });
      if (typeof answer?.token !== 'string' || !answer.token) return { kind: 'unknown', code: 'NO_ARTICLE_TOKEN' };
      token = answer.token;
    } catch (error) {
      return zaloPublishResult(error);
    }
    return this.created(s.accessToken, token);
  }

  // The article exists once article/create answered a token; the token tells where it stands. Nothing after this point
  // is a rejection.
  private async created(accessToken: string, token: string): Promise<PublishResult> {
    const verified = await this.verify(accessToken, token);
    return verified.kind === 'rejected' ? { kind: 'pending', externalRef: token, checkAfterSeconds: CHECK_AFTER_SECONDS } : verified;
  }

  // One video as a video article (#1429): the upload, a wait until Zalo has processed it, then the article. Nothing is
  // visible before article/create, so every failure before it posted nothing and the next attempt uploads again; a
  // video still processing when the wait ends is transient. article/create is the one visible step: its unclear answer
  // is unknown, and the job reconciles through getslice before anything is tried again.
  private async publishVideo(input: PublishInput, accessToken: string): Promise<PublishResult> {
    const { media } = input.content;
    // One budget for the reads, the upload and the wait, ending well before the job gives up on the call
    // (callTimeoutMs): past it nothing is visible yet, so the call stops as transient instead of creating an article
    // after the job recorded unknown.
    const budgetEnd = Date.now() + this.budgetMs;
    const video: PublishMedia | undefined = media[0];
    if (!video || media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_REQUIRED' };
    // Zalo takes MP4 and AVI; a QuickTime file would be refused after its upload. The validator compares in lower case.
    if (video.mime.toLowerCase() !== 'video/mp4') return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TYPE' };
    if (video.sizeBytes > VIDEO_MAX_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TOO_LARGE' };
    if (!(input.content.title ?? '').trim()) return { kind: 'rejected', error: 'bad_request', code: 'TITLE_REQUIRED' };
    // The thumbnail is required: the variant's cover image (#642), fetched by Zalo from a public URL like the images.
    const cover = videoCoverOf(input.settings);
    if (!cover) return { kind: 'rejected', error: 'bad_request', code: 'ZALO_VIDEO_COVER_REQUIRED' };
    if (!('fileId' in cover)) return { kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' };
    // Asked here only to learn that the storage can give one (local disk cannot) before anything is uploaded: a presigned
    // URL lives a minute, far less than the upload and the wait, so the one Zalo fetches is asked for again right before
    // article/create.
    if (!(await input.mediaUrl(cover.fileId).catch(() => null))) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    if (bytes.byteLength > VIDEO_MAX_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TOO_LARGE' };
    const processing = (): PublishResult => ({ kind: 'rejected', error: 'transient', code: 'ZALO_VIDEO_PROCESSING' });
    let videoId: string;
    try {
      const form = new FormData();
      // The bytes as they are, not another copy of up to 50 MB.
      form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }), 'video.mp4');
      const upload = await this.client.api<VideoTokenAnswer>('POST', 'article/upload_video/preparevideo', accessToken, { multipart: form, timeoutMs: VIDEO_UPLOAD_TIMEOUT_MS });
      if (typeof upload?.token !== 'string' || !upload.token) return { kind: 'rejected', error: 'transient', code: 'NO_VIDEO_TOKEN' };
      const uploadToken = upload.token;
      const deadline = Math.min(Date.now() + this.processingWaitMs, budgetEnd);
      for (;;) {
        const got = await this.client.api<VideoStatusAnswer>('GET', 'article/upload_video/verify', accessToken, { headers: { token: uploadToken } });
        const status = typeof got?.status === 'number' ? got.status : typeof got?.status === 'string' && /^\d$/.test(got.status) ? Number(got.status) : 0;
        const id = typeof got?.video_id === 'string' || typeof got?.video_id === 'number' ? String(got.video_id) : '';
        if (status === 1 && id) {
          videoId = id;
          break;
        }
        const dead = VIDEO_DEAD[status];
        if (dead) return { kind: 'rejected', error: 'bad_request', code: dead, ...(typeof got?.status_message === 'string' ? { message: got.status_message.slice(0, 500) } : {}) };
        // 3 (processing), 0 (unknown) or a status Crove does not know: asked again until the wait ends.
        if (Date.now() >= deadline) return processing();
        await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
      }
    } catch (error) {
      return beforeArticle(zaloPublishResult(error));
    }
    if (Date.now() >= budgetEnd) return processing();
    // A fresh URL for the thumbnail, fetched by Zalo right after the call that names it; nothing is visible yet.
    const avatar = await input.mediaUrl(cover.fileId).catch(() => null);
    if (!avatar) return { kind: 'rejected', error: 'transient', code: 'MEDIA_URL_UNAVAILABLE' };
    let token: string;
    try {
      const answer = await this.client.api<CreateAnswer>('POST', 'article/create', accessToken, { json: videoArticleOf(input, videoId, avatar) });
      if (typeof answer?.token !== 'string' || !answer.token) return { kind: 'unknown', code: 'NO_ARTICLE_TOKEN' };
      token = answer.token;
    } catch (error) {
      return zaloPublishResult(error);
    }
    return this.created(accessToken, token);
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
    // Zalo lists normal and video articles apart (#1429): a post with a video is looked for among the video articles.
    const type = input.content.media.some((m) => m.mime.startsWith('video/')) ? 'video' : 'normal';
    try {
      const answer = await this.client.api<SliceAnswer>('GET', 'article/getslice', s.accessToken, { params: { offset: '0', limit: '20', type } });
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

  // The OA's followers (#645), from its profile.
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const s = zaloSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    try {
      const oa = await this.client.api<OaAnswer & { num_follower?: unknown }>('GET', 'oa/getoa', s.accessToken);
      const id = typeof oa?.oa_id === 'string' || typeof oa?.oa_id === 'number' ? String(oa.oa_id) : '';
      if (id !== input.externalAccountId) return null;
      return { followers: count(oa?.num_follower) ?? null };
    } catch (error) {
      const result = zaloPublishResult(error);
      if (result.kind === 'rejected' && (result.error === 'token_expired' || result.error === 'permission')) return { refused: result.error };
      return null;
    }
  }

  // Views and shares of an article, when Zalo reports them on its detail. A video article is read through the same
  // article/getdetail (#1429); Zalo's sample answer for one carries no counts, so it may report none.
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
