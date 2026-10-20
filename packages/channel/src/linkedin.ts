// LinkedIn member posts (S9, issue #392), written from LinkedIn's "Share on LinkedIn", Posts API and Images API docs.
// A self-serve app (products "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn"):
// CHANNEL_LINKEDIN_CLIENT_ID and CHANNEL_LINKEDIN_CLIENT_SECRET.
//
// Connect: the OAuth dialog for openid, profile and w_member_social; the access token lives 60 days and self-serve apps
// get no refresh token, so the member reconnects before it expires (the channels screen says when).
// Publish: images are uploaded first (initializeUpload, then a PUT of the bytes; nothing is visible until the post
// names them), then one POST /rest/posts. A member app cannot list the member's posts, so an unclear answer cannot be
// checked: publishSafety 'never', and such a post waits for a person.
import type { CommentInput, CommentResult, ConnectedAccount, Publisher, PublishInput, PublishResult, RetrySafety } from './index.ts';
import { commentResult } from './comment.ts';
import { holdsLink } from './text.ts';
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

  // A PUT of bytes to an upload URL LinkedIn handed out; returns the part's ETag (a video's parts are named by it).
  async upload(url: string, token: string, bytes: Uint8Array, type: string): Promise<string | null> {
    const response = await this.fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: new Blob([new Uint8Array(bytes)], { type }) });
    if (!response.ok) throw new LinkedInError(response.status, null);
    return response.headers.get('etag');
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
  return content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};

const VIDEO_URN = /^urn:li:video:[A-Za-z0-9_-]{1,64}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// How long a publish waits for LinkedIn to process a video; with the upload it stays inside callTimeoutMs.
const PROCESSING_WAIT_MS = 300_000;
const VIDEO_CALL_MARGIN_MS = 90_000;

export class LinkedInPublisher implements Publisher {
  readonly provider = 'linkedin' as const;
  readonly publishSafety: RetrySafety = 'never';
  // A video's upload and processing take minutes; within the job's stale limit (600 s).
  readonly callTimeoutMs = 420_000;
  private readonly client: LinkedInClient;
  private readonly processingWaitMs: number;
  private readonly pollMs: number;
  private readonly budgetMs: number;

  constructor(app: Pick<LinkedInAppConfig, 'version'> = {}, fetchImpl?: Fetch, timing: { processingWaitMs?: number; pollMs?: number; budgetMs?: number } = {}) {
    this.client = new LinkedInClient(app.version ?? LINKEDIN_VERSION, fetchImpl);
    this.processingWaitMs = timing.processingWaitMs ?? PROCESSING_WAIT_MS;
    this.pollMs = timing.pollMs ?? 5000;
    // The last status check and the post (30 s each at most) plus slack fit between the budget and callTimeoutMs.
    this.budgetMs = timing.budgetMs ?? this.callTimeoutMs - VIDEO_CALL_MARGIN_MS;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = tokenIn(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!MEMBER_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    const author = `urn:li:person:${input.externalAccountId}`;
    if (input.content.media.some((m) => m.mime.startsWith('video/'))) return this.publishVideo(input, token, author);
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
    if (images.length === 1) return this.post(token, author, text, { media: images[0] });
    if (images.length > 1) return this.post(token, author, text, { multiImage: { images } });
    return this.post(token, author, text, null);
  }

  // One video (#451): the Videos API's multipart upload (initialize, a PUT per part, finalize with the parts' ETags),
  // a wait until LinkedIn has processed it, then the post. Nothing is visible before the post, so every failure before
  // it posted nothing; a video still processing when the wait ends is transient and uploaded again next time.
  private async publishVideo(input: PublishInput, token: string, author: string): Promise<PublishResult> {
    const { media } = input.content;
    const video = media[0];
    if (!video || media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_REQUIRED' };
    // LinkedIn takes MP4 only.
    if (video.mime !== 'video/mp4') return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TYPE' };
    let bytes: Uint8Array;
    try {
      bytes = await input.readMedia(video.fileId);
    } catch {
      return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    }
    // One budget for the whole call, upload included, ending well before the job gives up on it (callTimeoutMs): past
    // it nothing is visible yet, so the call stops as transient instead of posting after the job recorded unknown.
    const budgetEnd = Date.now() + this.budgetMs;
    const late = (): PublishResult => ({ kind: 'rejected', error: 'transient', code: 'VIDEO_TOO_SLOW' });
    let urn: string;
    try {
      const init = await this.client.call<{ value?: { video?: unknown; uploadToken?: unknown; uploadInstructions?: { uploadUrl?: unknown; firstByte?: unknown; lastByte?: unknown }[] } }>(
        'POST',
        '/rest/videos?action=initializeUpload',
        token,
        { initializeUploadRequest: { owner: author, fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: false } },
      );
      const value = init.body?.value;
      const parts = value?.uploadInstructions ?? [];
      if (typeof value?.video !== 'string' || !VIDEO_URN.test(value.video) || parts.length === 0) return { kind: 'rejected', error: 'transient', code: 'NO_UPLOAD_URL' };
      urn = value.video;
      // The parts must cover the file exactly, in order: each starts where the last ended, the last ends at its end.
      let next = 0;
      for (const part of parts) {
        // Numbers as LinkedIn sends them (Number(null) would read 0).
        const first = typeof part.firstByte === 'number' ? part.firstByte : Number.NaN;
        const last = typeof part.lastByte === 'number' ? part.lastByte : Number.NaN;
        if (typeof part.uploadUrl !== 'string' || first !== next || !Number.isInteger(last) || last < first || last >= bytes.byteLength) return { kind: 'rejected', error: 'transient', code: 'BAD_UPLOAD_PART' };
        next = last + 1;
      }
      if (next !== bytes.byteLength) return { kind: 'rejected', error: 'transient', code: 'BAD_UPLOAD_PART' };
      const etags: string[] = [];
      for (const part of parts) {
        if (Date.now() >= budgetEnd) return late();
        const etag = await this.client.upload(part.uploadUrl as string, token, bytes.slice(Number(part.firstByte), Number(part.lastByte) + 1), 'application/octet-stream');
        if (!etag) return { kind: 'rejected', error: 'transient', code: 'NO_PART_ETAG' };
        etags.push(etag);
      }
      await this.client.call('POST', '/rest/videos?action=finalizeUpload', token, {
        finalizeUploadRequest: { video: urn, uploadToken: typeof value.uploadToken === 'string' ? value.uploadToken : '', uploadedPartIds: etags },
      });
      const deadline = Math.min(Date.now() + this.processingWaitMs, budgetEnd);
      for (;;) {
        const got = await this.client.call<{ status?: unknown; processingFailureReason?: unknown }>('GET', `/rest/videos/${encodeURIComponent(urn)}`, token);
        const status = got.body?.status;
        if (status === 'AVAILABLE') break;
        if (status === 'PROCESSING_FAILED') {
          const reason = got.body?.processingFailureReason;
          return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_PROCESSING_FAILED', ...(typeof reason === 'string' ? { message: reason.slice(0, 500) } : {}) };
        }
        if (Date.now() >= deadline) return { kind: 'rejected', error: 'transient', code: 'VIDEO_STILL_PROCESSING' };
        await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
      }
    } catch (error) {
      return beforePost(publishResult(error));
    }
    if (Date.now() >= budgetEnd) return late();
    return this.post(token, author, textOf(input.content), { media: { id: urn } });
  }

  // A comment under the member's post (#587), through the Social Actions API with the same w_member_social grant.
  async comment(input: CommentInput): Promise<CommentResult> {
    const token = tokenIn(input.secret);
    if (!token) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!MEMBER_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    if (!/^urn:li:(share|ugcPost):\d{1,32}$/.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    const actor = `urn:li:person:${input.externalAccountId}`;
    try {
      const answer = await this.client.call('POST', `/rest/socialActions/${encodeURIComponent(input.externalId)}/comments`, token, { actor, object: input.externalId, message: { text: input.text } });
      const id = answer.id ?? '';
      if (!id) return { kind: 'unknown', code: 'NO_COMMENT_ID' };
      return { kind: 'accepted', externalId: id.slice(0, 500) };
    } catch (error) {
      return commentResult(publishResult(error));
    }
  }

  // The one visible step.
  private async post(token: string, author: string, text: string, content: Record<string, unknown> | null): Promise<PublishResult> {
    const post: Record<string, unknown> = {
      author,
      commentary: littleText(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (content) post.content = content;
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
