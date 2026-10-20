// Bluesky (S9, issue #390), written from the AT Protocol and app.bsky lexicons. No app review: an account connects
// with its handle and an app password (Settings > App passwords on Bluesky), which the account can revoke at any time
// and which cannot change the account's own password or email. The kernel seals the app password; each publish opens
// a fresh session with it, so no rotating refresh token has to be kept.
//
// Only Bluesky-hosted accounts are supported for now (PDS hosts under bsky.network, or bsky.social): the PDS address
// comes from the account's DID document, and an arbitrary host there would let anyone point the worker at any server.
import type { CommentInput, CommentResult, ConnectedAccount, MetricName, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RetrySafety } from './index.ts';
import { commentResult } from './comment.ts';
import { holdsLink } from './text.ts';
import { requestSignal, type Fetch } from './oauth.ts';

const ENTRYWAY = 'https://bsky.social';
// Bluesky's public AppView: post counts without a session, so reading metrics never spends the account's session quota.
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const POST_COLLECTION = 'app.bsky.feed.post';
// Bluesky's own image limit per blob.
const MAX_IMAGE_BYTES = 1_000_000;

export function isBlueskyHost(host: string): boolean {
  return host === 'bsky.social' || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.bsky\.network$/.test(host);
}

// fetch limited to Bluesky-hosted servers over https, with a timeout and no redirects.
function blueskyFetch(fetchImpl: Fetch = fetch, timeoutMs = 15_000): Fetch {
  return async (input, init) => {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.port !== '' || !(isBlueskyHost(url.hostname) || url.origin === PUBLIC_APPVIEW)) throw new Error(`host not allowed for Bluesky: ${url.hostname}`);
    return fetchImpl(url.toString(), { ...init, redirect: 'manual', signal: requestSignal(init?.signal ?? AbortSignal.timeout(timeoutMs)) });
  };
}

export class BlueskyError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'BlueskyError';
    this.status = status;
    this.code = code;
  }
}

// What the kernel seals for a Bluesky connection. Each call opens a session, which names the account's PDS, so none
// is kept (secrets sealed before #399 also carry a `pds`, which is ignored).
export interface BlueskySecret {
  identifier: string;
  appPassword: string;
}

function secretOf(secret: string): BlueskySecret | null {
  try {
    const s = JSON.parse(secret) as Partial<BlueskySecret>;
    return typeof s.identifier === 'string' && typeof s.appPassword === 'string' ? { identifier: s.identifier, appPassword: s.appPassword } : null;
  } catch {
    return null;
  }
}

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  pds: string;
  // The access token's `scope` claim: com.atproto.appPass for an app password, com.atproto.appPassPrivileged for one
  // that may also read direct messages, com.atproto.access for the account password; null when it cannot be read.
  scope: string | null;
}

function tokenScope(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { scope?: unknown };
    return typeof payload.scope === 'string' ? payload.scope : null;
  } catch {
    return null;
  }
}

// App passwords look like xxxx-xxxx-xxxx-xxxx; the account password is refused here so it is never stored.
export const APP_PASSWORD = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
export const BLUESKY_HANDLE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

class Xrpc {
  private readonly fetch: Fetch;

  constructor(fetchImpl?: Fetch) {
    this.fetch = blueskyFetch(fetchImpl);
  }

  async call<T>(base: string, method: 'GET' | 'POST', nsid: string, options: { token?: string; params?: Record<string, string>; json?: unknown; bytes?: { data: Uint8Array; type: string } } = {}): Promise<T> {
    const url = new URL(`${base}/xrpc/${nsid}`);
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let body: string | Uint8Array | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.bytes) {
      headers['content-type'] = options.bytes.type;
      body = options.bytes.data;
    }
    const response = await this.fetch(url.toString(), { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Blob([new Uint8Array(body)]) }) });
    const json = (await response.json().catch(() => null)) as ({ error?: unknown; message?: unknown } & Record<string, unknown>) | null;
    // A success whose body cannot be read may still have done what was asked: never a refusal.
    if (response.ok && !json) throw new BlueskyError(response.status, 'UnreadableAnswer', 'Bluesky answered without a readable body');
    if (!response.ok || !json) throw new BlueskyError(response.status, typeof json?.error === 'string' ? json.error : undefined, typeof json?.message === 'string' ? json.message : `Bluesky answered ${response.status}`);
    return json as T;
  }

  // A session for an app password, on the account's own PDS.
  async session(identifier: string, appPassword: string): Promise<Session> {
    const answer = await this.call<{ did?: unknown; handle?: unknown; accessJwt?: unknown; didDoc?: { service?: { id?: unknown; serviceEndpoint?: unknown }[] } }>(ENTRYWAY, 'POST', 'com.atproto.server.createSession', {
      json: { identifier, password: appPassword },
    });
    if (typeof answer.did !== 'string' || !answer.did.startsWith('did:') || typeof answer.accessJwt !== 'string') throw new BlueskyError(502, 'BadSession', 'Bluesky answered without a session');
    const endpoint = answer.didDoc?.service?.find((s) => s.id === '#atproto_pds')?.serviceEndpoint;
    const pds = typeof endpoint === 'string' ? endpoint.replace(/\/$/, '') : ENTRYWAY;
    let url: URL | null = null;
    try {
      url = new URL(pds);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:' || url.port !== '' || url.pathname !== '/' || !isBlueskyHost(url.hostname)) {
      throw new BlueskyError(400, 'UnsupportedPds', `accounts hosted on ${url?.host ?? 'this server'} are not supported yet`);
    }
    return { did: answer.did, handle: typeof answer.handle === 'string' ? answer.handle : identifier, accessJwt: answer.accessJwt, pds, scope: tokenScope(answer.accessJwt) };
  }
}

// Connecting checks the app password once by opening a session; the answer names the account.
// The handle and app password as Bluesky takes them, checked here without a call (so a typo costs no login try).
export function blueskyLogin(input: { handle: string; appPassword: string }): { handle: string; appPassword: string } {
  const handle = input.handle.trim().replace(/^@/, '').toLowerCase();
  if (!BLUESKY_HANDLE.test(handle)) throw new BlueskyError(400, 'InvalidHandle', 'not a Bluesky handle');
  // App passwords are lowercase; one typed in capitals is the same password.
  const appPassword = input.appPassword.trim().toLowerCase();
  if (!APP_PASSWORD.test(appPassword)) throw new BlueskyError(400, 'NotAnAppPassword', 'use an app password, not the account password');
  return { handle, appPassword };
}

export async function connectBluesky(input: { handle: string; appPassword: string }, fetchImpl?: Fetch): Promise<ConnectedAccount> {
  const { handle, appPassword } = blueskyLogin(input);
  const session = await new Xrpc(fetchImpl).session(handle, appPassword);
  // The format check above cannot tell an account password shaped like an app password; the session can (#399). A
  // privileged app password also reads direct messages, which Crove never needs. An unreadable scope is let through:
  // the token format is Bluesky's to change.
  if (session.scope === 'com.atproto.access') throw new BlueskyError(400, 'NotAnAppPassword', 'use an app password, not the account password');
  if (session.scope === 'com.atproto.appPassPrivileged') throw new BlueskyError(400, 'PrivilegedAppPassword', 'use an app password without direct message access');
  const secret: BlueskySecret = { identifier: session.did, appPassword };
  return { provider: 'bluesky', externalAccountId: session.did, displayName: `@${session.handle}`.slice(0, 200), scopes: ['app_password'], expiresAt: null, secret: JSON.stringify(secret) };
}

// Link facets: Bluesky shows a URL as a link only when the post says where it is, in UTF-8 byte offsets.
export function linkFacets(text: string): { index: { byteStart: number; byteEnd: number }; features: { $type: string; uri: string }[] }[] {
  const facets = [];
  const encoder = new TextEncoder();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    const start = encoder.encode(text.slice(0, match.index)).byteLength;
    facets.push({ index: { byteStart: start, byteEnd: start + encoder.encode(match[0]).byteLength }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }] });
  }
  return facets;
}

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};

function blueskyResult(error: unknown): PublishResult {
  if (!(error instanceof BlueskyError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.code ?? `HTTP_${error.status}`;
  // Anything but a clear 4xx (a 5xx, a 2xx or 3xx without a readable answer) may have gone through.
  if (error.status < 400 || error.status >= 500) return { kind: 'unknown', code, message: error.message };
  if (error.status === 401 || error.code === 'AuthenticationRequired' || error.code === 'ExpiredToken' || error.code === 'AccountTakedown' || error.code === 'AccountDeactivated')
    return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

interface PostsAnswer {
  posts?: { uri?: unknown; likeCount?: unknown; replyCount?: unknown; repostCount?: unknown; quoteCount?: unknown }[];
}

interface ListAnswer {
  records?: { uri?: unknown; value?: { text?: unknown; createdAt?: unknown } }[];
}

const postUrl = (handle: string, uri: string) => `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(uri.split('/').pop() ?? '')}`;

export class BlueskyPublisher implements Publisher {
  readonly provider = 'bluesky' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly xrpc: Xrpc;

  constructor(fetchImpl?: Fetch) {
    this.xrpc = new Xrpc(fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' };
    let session: Session;
    try {
      session = await this.xrpc.session(s.identifier, s.appPassword);
    } catch (error) {
      // Nothing is posted by opening a session, so an unclear answer is a failure to retry.
      const result = blueskyResult(error);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
    // Images are uploaded as blobs first; a blob nobody references is never shown, so a failure here posted nothing.
    const images: { alt: string; image: unknown }[] = [];
    for (const m of input.content.media.slice(0, 4)) {
      if (m.sizeBytes > MAX_IMAGE_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'IMAGE_TOO_LARGE' };
      let bytes: Uint8Array;
      try {
        bytes = await input.readMedia(m.fileId);
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
      try {
        const blob = await this.xrpc.call<{ blob?: unknown }>(session.pds, 'POST', 'com.atproto.repo.uploadBlob', { token: session.accessJwt, bytes: { data: bytes, type: m.mime } });
        if (!blob.blob) return { kind: 'rejected', error: 'transient', code: 'NO_BLOB' };
        images.push({ alt: m.altText ?? '', image: blob.blob });
      } catch (error) {
        const result = blueskyResult(error);
        return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
      }
    }
    const text = textOf(input.content);
    if (!text && images.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    const record: Record<string, unknown> = { $type: POST_COLLECTION, text, createdAt: new Date().toISOString() };
    const facets = linkFacets(text);
    if (facets.length > 0) record.facets = facets;
    if (images.length > 0) record.embed = { $type: 'app.bsky.embed.images', images };
    try {
      const answer = await this.xrpc.call<{ uri?: unknown }>(session.pds, 'POST', 'com.atproto.repo.createRecord', { token: session.accessJwt, json: { repo: session.did, collection: POST_COLLECTION, record } });
      if (typeof answer.uri !== 'string' || !answer.uri.startsWith('at://')) return { kind: 'unknown', code: 'NO_URI' };
      return { kind: 'accepted', externalId: answer.uri, url: postUrl(session.handle, answer.uri) };
    } catch (error) {
      return blueskyResult(error);
    }
  }

  // A reply to the account's own post (#587), as the first comment: Bluesky threads name the post they answer by its
  // URI and content id, so the post is read first for its cid. Reading posts nothing.
  async comment(input: CommentInput): Promise<CommentResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' };
    const parts = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/.exec(input.externalId);
    if (!parts) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    let session: Session;
    try {
      session = await this.xrpc.session(s.identifier, s.appPassword);
    } catch (error) {
      const result = blueskyResult(error);
      return commentResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    if (parts[1] !== session.did) return { kind: 'rejected', error: 'bad_request', code: 'NOT_OWN_POST' };
    let parent: { uri: string; cid: string };
    try {
      const got = await this.xrpc.call<{ uri?: unknown; cid?: unknown }>(session.pds, 'GET', 'com.atproto.repo.getRecord', { token: session.accessJwt, params: { repo: session.did, collection: POST_COLLECTION, rkey: parts[2] as string } });
      if (typeof got.uri !== 'string' || typeof got.cid !== 'string') return { kind: 'rejected', error: 'transient', code: 'NO_CID' };
      parent = { uri: got.uri, cid: got.cid };
    } catch (error) {
      const result = blueskyResult(error);
      return commentResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    const record: Record<string, unknown> = { $type: POST_COLLECTION, text: input.text, createdAt: new Date().toISOString(), reply: { root: parent, parent } };
    const facets = linkFacets(input.text);
    if (facets.length > 0) record.facets = facets;
    try {
      const answer = await this.xrpc.call<{ uri?: unknown }>(session.pds, 'POST', 'com.atproto.repo.createRecord', { token: session.accessJwt, json: { repo: session.did, collection: POST_COLLECTION, record } });
      if (typeof answer.uri !== 'string' || !answer.uri.startsWith('at://')) return { kind: 'unknown', code: 'NO_URI' };
      return { kind: 'accepted', externalId: answer.uri };
    } catch (error) {
      return commentResult(blueskyResult(error));
    }
  }

  // Likes, replies, reposts and quotes of a post, from the public AppView. A post of another account is never read; a
  // post the AppView no longer lists was deleted.
  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const match = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,256})\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:-]{1,512}$/.exec(input.externalId);
    if (!match || match[1] !== input.externalAccountId) return { refused: 'gone' };
    try {
      const answer = await this.xrpc.call<PostsAnswer>(PUBLIC_APPVIEW, 'GET', 'app.bsky.feed.getPosts', { params: { uris: input.externalId } });
      const post = answer.posts?.find((p) => p.uri === input.externalId);
      if (!post) return { refused: 'gone' };
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
      const metrics: Partial<Record<MetricName, number>> = {};
      const likes = n(post.likeCount);
      const replies = n(post.replyCount);
      const reposts = n(post.repostCount);
      const quotes = n(post.quoteCount);
      if (likes !== undefined) metrics.reactions = likes;
      if (replies !== undefined) metrics.comments = replies;
      if (reposts !== undefined || quotes !== undefined) metrics.shares = (reposts ?? 0) + (quotes ?? 0);
      return { metrics, ...(quotes !== undefined ? { extra: { quotes } } : {}) };
    } catch {
      return null;
    }
  }

  // The account's posts in the window with the same text.
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = secretOf(input.secret);
    const text = textOf(input.content);
    if (!s || !text) return { found: 'unknown' };
    try {
      const session = await this.xrpc.session(s.identifier, s.appPassword);
      const answer = await this.xrpc.call<ListAnswer>(session.pds, 'GET', 'com.atproto.repo.listRecords', { token: session.accessJwt, params: { repo: session.did, collection: POST_COLLECTION, limit: '50' } });
      const from = input.after.getTime() - 60_000;
      const to = input.before.getTime() + 60_000;
      for (const r of answer.records ?? []) {
        const at = typeof r.value?.createdAt === 'string' ? Date.parse(r.value.createdAt) : Number.NaN;
        if (typeof r.uri === 'string' && r.value?.text === text && at >= from && at <= to) return { found: true, externalId: r.uri, url: postUrl(session.handle, r.uri) };
      }
      return { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }
}
