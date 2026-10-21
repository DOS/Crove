// Mastodon accounts (#748), written from the Mastodon API docs (docs.joinmastodon.org/methods). Any instance, no app
// review: the account owner makes an application in their instance's settings (Preferences > Development > New
// application, scopes read and write) and gives Crove its access token with the instance address. The token is sealed
// like any credential; the account id with the instance's host is the account id.
//
// The instance is the tenant's to name, so every call goes through the fetch the kernel hands in: the egress guard
// (public addresses only, the connection pinned to the checked address, no redirects). This module never calls fetch
// itself, and only over https.
//
// Publish: each file is uploaded (POST /api/v2/media, waiting while the instance processes a video), then the status
// is posted (POST /api/v1/statuses) with the call's key as its Idempotency-Key, so a repeat of the same call within the
// instance's window posts nothing new. A content warning (spoiler text) and the visibility (public or unlisted) come
// from the variant's settings. The limits are the instance's own (GET /api/v2/instance), read before the post.
import type { CommentInput, CommentResult, RepostInput, ConnectedAccount, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, RemoveInput, RemoveResult, RetrySafety } from './index.ts';
import { commentResult, removeResult } from './comment.ts';
import { holdsLink } from './text.ts';
import { ConnectorError, type Fetch } from './oauth.ts';

const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const STATUS_ID = /^[0-9A-Za-z]{1,64}$/;
const ACCOUNT_ID = /^[0-9A-Za-z]{1,64}@[a-z0-9.-]{1,253}$/;
// How long a video may take to process before the post is given up (nothing was posted yet).
const MEDIA_WAIT_MS = 120_000;
const MEDIA_POLL_MS = 2_000;
export const MASTODON_VISIBILITIES = ['public', 'unlisted'] as const;
export type MastodonVisibility = (typeof MASTODON_VISIBILITIES)[number];

export interface MastodonSecret {
  // https://host, no path.
  instance: string;
  accessToken: string;
}

// The instance as Crove keeps it: https on the default port, a host name and nothing else.
export function mastodonInstance(raw: string): string | null {
  // Trailing slashes cut by hand: a regular expression for them is slow on a long run of slashes.
  let trimmed = raw.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  // A name with a dot, not an address: an instance is reached by its domain.
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  return `https://${host}`;
}

export function mastodonSecretOf(secret: string): MastodonSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<MastodonSecret>;
    const instance = typeof s.instance === 'string' ? mastodonInstance(s.instance) : null;
    if (!instance || instance !== s.instance || typeof s.accessToken !== 'string' || !TOKEN.test(s.accessToken)) return null;
    return { instance, accessToken: s.accessToken };
  } catch {
    return null;
  }
}

export class MastodonError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message.slice(0, 500));
    this.name = 'MastodonError';
    this.status = status;
  }
}

class MastodonClient {
  private readonly fetch: Fetch;
  constructor(fetchImpl: Fetch) {
    this.fetch = fetchImpl;
  }

  async call<T>(s: MastodonSecret, method: 'GET' | 'POST' | 'DELETE', path: string, body?: { json?: unknown; form?: FormData }, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
    const response = await this.fetch(`${s.instance}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${s.accessToken}`, ...(body?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body?.json !== undefined ? { body: JSON.stringify(body.json) } : body?.form ? { body: body.form } : {}),
    });
    const json = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (response.status >= 300) throw new MastodonError(response.status, typeof json?.error === 'string' ? json.error : `Mastodon answered ${response.status}`);
    if (json === null) throw new MastodonError(502, 'Mastodon answered without a readable body');
    return { status: response.status, data: json };
  }
}

// The connect form's fields, checked before any call.
export function mastodonLogin(input: { instance: string; accessToken: string }): MastodonSecret {
  const instance = mastodonInstance(input.instance);
  if (!instance) throw new ConnectorError('denied', 'not a Mastodon instance address', 'MASTODON_INSTANCE_INVALID');
  const accessToken = input.accessToken.trim();
  if (!TOKEN.test(accessToken)) throw new ConnectorError('denied', 'not a Mastodon access token', 'MASTODON_TOKEN_INVALID');
  return { instance, accessToken };
}

export async function connectMastodon(login: MastodonSecret, fetchImpl: Fetch): Promise<ConnectedAccount> {
  const client = new MastodonClient(fetchImpl);
  let me: { id?: unknown; username?: unknown; acct?: unknown; display_name?: unknown };
  try {
    me = (await client.call<typeof me>(login, 'GET', '/api/v1/accounts/verify_credentials')).data;
  } catch (error) {
    if (error instanceof MastodonError && (error.status === 401 || error.status === 403)) throw new ConnectorError('denied', 'the instance refused the token', 'MASTODON_TOKEN_REFUSED');
    if (error instanceof MastodonError && error.status === 404) throw new ConnectorError('denied', 'not a Mastodon instance', 'MASTODON_NOT_AN_INSTANCE');
    throw new ConnectorError('provider', 'the instance did not answer');
  }
  const host = new URL(login.instance).hostname;
  if (typeof me.id !== 'string' || !STATUS_ID.test(me.id) || typeof me.username !== 'string') throw new ConnectorError('denied', 'not a Mastodon instance', 'MASTODON_NOT_AN_INSTANCE');
  const name = typeof me.display_name === 'string' && me.display_name.trim() ? me.display_name.trim() : `@${me.username}`;
  return { provider: 'mastodon', externalAccountId: `${me.id}@${host}`, displayName: `${name} (@${me.username}@${host})`.slice(0, 200), scopes: ['access_token'], expiresAt: null, secret: JSON.stringify(login) };
}

// The variant's Mastodon settings, as validation checks them: a content warning and the visibility.
export function mastodonSettingsOf(settings: Readonly<Record<string, unknown>> | undefined): { spoilerText: string | null; visibility: MastodonVisibility } {
  const cw = settings?.contentWarning;
  const visibility = settings?.visibility;
  return {
    spoilerText: typeof cw === 'string' && cw.trim() ? cw.trim() : null,
    visibility: visibility === 'unlisted' ? 'unlisted' : 'public',
  };
}

interface InstanceLimits {
  maxCharacters: number;
  maxMedia: number;
  imageBytes: number | null;
  videoBytes: number | null;
}

function mastodonResult(error: unknown): PublishResult {
  if (!(error instanceof MastodonError)) return { kind: 'unknown', code: 'NETWORK' };
  const base = { code: `MASTODON_${error.status}`, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', ...base };
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', ...base };
  if (error.status === 403) return { kind: 'rejected', error: 'permission', ...base };
  if (error.status === 400 || error.status === 404 || error.status === 422) return { kind: 'rejected', error: 'bad_request', ...base };
  // A redirect (the guard follows none) or a server error: the post may have been made.
  return { kind: 'unknown', code: base.code, message: error.message };
}

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};
const codepoints = (s: string) => [...s].length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MastodonPublisher implements Publisher {
  readonly provider = 'mastodon' as const;
  // The Idempotency-Key makes a repeat of the same call within the instance's window post nothing new.
  readonly publishSafety: RetrySafety = 'idempotent';
  // Video uploads wait for the instance to process them.
  readonly callTimeoutMs = 420_000;
  private readonly client: MastodonClient;
  private readonly wait: number;

  // The fetch is the kernel's egress guard; there is no default, so this adapter never calls an instance unguarded.
  constructor(fetchImpl: Fetch, options: { mediaPollMs?: number } = {}) {
    this.client = new MastodonClient(fetchImpl);
    this.wait = options.mediaPollMs ?? MEDIA_POLL_MS;
  }

  private async limits(s: MastodonSecret): Promise<InstanceLimits> {
    const fallback: InstanceLimits = { maxCharacters: 500, maxMedia: 4, imageBytes: null, videoBytes: null };
    try {
      const { data } = await this.client.call<{ configuration?: { statuses?: { max_characters?: unknown; max_media_attachments?: unknown }; media_attachments?: { image_size_limit?: unknown; video_size_limit?: unknown } } }>(s, 'GET', '/api/v2/instance');
      const c = data.configuration;
      const n = (v: unknown, d: number | null) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : d);
      return { maxCharacters: n(c?.statuses?.max_characters, 500) as number, maxMedia: n(c?.statuses?.max_media_attachments, 4) as number, imageBytes: n(c?.media_attachments?.image_size_limit, null), videoBytes: n(c?.media_attachments?.video_size_limit, null) };
    } catch {
      return fallback;
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = mastodonSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!ACCOUNT_ID.test(input.externalAccountId) || !input.externalAccountId.endsWith(`@${new URL(s.instance).hostname}`)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    const text = textOf(input.content);
    const media = input.content.media;
    const { spoilerText, visibility } = mastodonSettingsOf(input.settings);
    if (!text && media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    const limits = await this.limits(s);
    if (codepoints(text) + (spoilerText ? codepoints(spoilerText) : 0) > limits.maxCharacters) return { kind: 'rejected', error: 'bad_request', code: 'TEXT_TOO_LONG', message: `this instance takes ${limits.maxCharacters} characters` };
    if (media.length > limits.maxMedia) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_MEDIA' };
    for (const m of media) {
      const cap = m.mime.startsWith('video/') ? limits.videoBytes : limits.imageBytes;
      if (cap !== null && m.sizeBytes > cap) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_TOO_LARGE' };
    }
    // Uploads make nothing visible: a failure here posts nothing.
    const mediaIds: string[] = [];
    for (const m of media) {
      const bytes = await input.readMedia(m.fileId).catch(() => null);
      if (!bytes) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      const form = new FormData();
      form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: m.mime }), m.mime.startsWith('video/') ? 'video' : 'image');
      if (m.altText) form.append('description', m.altText.slice(0, 1500));
      try {
        const { status, data } = await this.client.call<{ id?: unknown; url?: unknown }>(s, 'POST', '/api/v2/media', { form });
        if (typeof data.id !== 'string' || !STATUS_ID.test(data.id)) return { kind: 'rejected', error: 'transient', code: 'NO_MEDIA_ID' };
        // 202: still processing (a video); the post waits until the file has its URL.
        if (status === 202 || data.url === null) {
          const ready = await this.processed(s, data.id);
          if (!ready) return { kind: 'rejected', error: 'transient', code: 'MEDIA_PROCESSING' };
        }
        mediaIds.push(data.id);
      } catch (error) {
        const result = mastodonResult(error);
        return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', code: (result.kind === 'unknown' && result.code) || 'MEDIA_UPLOAD' };
      }
    }
    try {
      const { data } = await this.client.call<{ id?: unknown; url?: unknown }>(
        s,
        'POST',
        '/api/v1/statuses',
        { json: { status: text, media_ids: mediaIds, visibility, ...(spoilerText ? { spoiler_text: spoilerText } : {}) } },
        { 'idempotency-key': input.callKey },
      );
      if (typeof data.id !== 'string' || !STATUS_ID.test(data.id)) return { kind: 'unknown', code: 'NO_STATUS_ID' };
      const url = typeof data.url === 'string' && data.url.startsWith(`${s.instance}/`) ? data.url : null;
      return { kind: 'accepted', externalId: data.id, url };
    } catch (error) {
      return mastodonResult(error);
    }
  }

  private async processed(s: MastodonSecret, id: string): Promise<boolean> {
    const until = Date.now() + MEDIA_WAIT_MS;
    while (Date.now() < until) {
      await sleep(this.wait);
      try {
        const { status, data } = await this.client.call<{ url?: unknown }>(s, 'GET', `/api/v1/media/${id}`);
        if (status === 200 && typeof data.url === 'string') return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // A boost of the account's own status (#773): POST /api/v1/statuses/:id/reblog, which answers with the boost.
  async repost(input: RepostInput): Promise<CommentResult> {
    const s = mastodonSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!STATUS_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const { data } = await this.client.call<{ id?: unknown }>(s, 'POST', `/api/v1/statuses/${input.externalId}/reblog`, { json: { visibility: 'public' } }, { 'idempotency-key': input.callKey });
      if (typeof data.id !== 'string' || !STATUS_ID.test(data.id)) return { kind: 'unknown', code: 'NO_STATUS_ID' };
      return { kind: 'accepted', externalId: data.id };
    } catch (error) {
      return commentResult(mastodonResult(error));
    }
  }

  // A reply to the account's own status (#587, #742), as the first comment or a thread's part.
  async comment(input: CommentInput): Promise<CommentResult> {
    const s = mastodonSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!STATUS_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const { data } = await this.client.call<{ id?: unknown }>(s, 'POST', '/api/v1/statuses', { json: { status: input.text, in_reply_to_id: input.externalId, visibility: 'public' } }, { 'idempotency-key': input.callKey });
      if (typeof data.id !== 'string' || !STATUS_ID.test(data.id)) return { kind: 'unknown', code: 'NO_STATUS_ID' };
      return { kind: 'accepted', externalId: data.id };
    } catch (error) {
      return commentResult(mastodonResult(error));
    }
  }

  // Deletes the account's own status (#860): DELETE /api/v1/statuses/:id. A status the instance no longer has (404) is
  // gone already.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const s = mastodonSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!STATUS_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      await this.client.call(s, 'DELETE', `/api/v1/statuses/${input.externalId}`);
      return { kind: 'removed' };
    } catch (error) {
      if (error instanceof MastodonError && (error.status === 404 || error.status === 410)) return { kind: 'removed' };
      return removeResult(mastodonResult(error));
    }
  }

  // Favourites, replies and boosts of a status; a status the instance no longer has is gone.
  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const s = mastodonSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!STATUS_ID.test(input.externalId)) return { refused: 'gone' };
    try {
      const { data } = await this.client.call<{ favourites_count?: unknown; replies_count?: unknown; reblogs_count?: unknown }>(s, 'GET', `/api/v1/statuses/${input.externalId}`);
      const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
      const metrics = Object.fromEntries(Object.entries({ reactions: n(data.favourites_count), comments: n(data.replies_count), shares: n(data.reblogs_count) }).filter(([, v]) => v !== undefined));
      return { metrics };
    } catch (error) {
      if (error instanceof MastodonError && error.status === 404) return { refused: 'gone' };
      if (error instanceof MastodonError && error.status === 401) return { refused: 'token_expired' };
      return null;
    }
  }
}
