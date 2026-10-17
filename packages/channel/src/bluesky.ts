// Bluesky (S9, issue #390), written from the AT Protocol and app.bsky lexicons. No app review: an account connects
// with its handle and an app password (Settings > App passwords on Bluesky), which the account can revoke at any time
// and which cannot change the account's own password or email. The kernel seals the app password; each publish opens
// a fresh session with it, so no rotating refresh token has to be kept.
//
// Only Bluesky-hosted accounts are supported for now (PDS hosts under bsky.network, or bsky.social): the PDS address
// comes from the account's DID document, and an arbitrary host there would let anyone point the worker at any server.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RetrySafety } from './index.ts';
import type { Fetch } from './oauth.ts';

const ENTRYWAY = 'https://bsky.social';
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
    if (url.protocol !== 'https:' || url.port !== '' || !isBlueskyHost(url.hostname)) throw new Error(`host not allowed for Bluesky: ${url.hostname}`);
    return fetchImpl(url.toString(), { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
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

// What the kernel seals for a Bluesky connection.
export interface BlueskySecret {
  identifier: string;
  appPassword: string;
  pds: string;
}

function secretOf(secret: string): BlueskySecret | null {
  try {
    const s = JSON.parse(secret) as Partial<BlueskySecret>;
    return typeof s.identifier === 'string' && typeof s.appPassword === 'string' && typeof s.pds === 'string' ? { identifier: s.identifier, appPassword: s.appPassword, pds: s.pds } : null;
  } catch {
    return null;
  }
}

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  pds: string;
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
    return { did: answer.did, handle: typeof answer.handle === 'string' ? answer.handle : identifier, accessJwt: answer.accessJwt, pds };
  }
}

// Connecting checks the app password once by opening a session; the answer names the account.
export async function connectBluesky(input: { handle: string; appPassword: string }, fetchImpl?: Fetch): Promise<ConnectedAccount> {
  const handle = input.handle.trim().replace(/^@/, '').toLowerCase();
  if (!BLUESKY_HANDLE.test(handle)) throw new BlueskyError(400, 'InvalidHandle', 'not a Bluesky handle');
  if (!APP_PASSWORD.test(input.appPassword.trim())) throw new BlueskyError(400, 'NotAnAppPassword', 'use an app password, not the account password');
  const session = await new Xrpc(fetchImpl).session(handle, input.appPassword.trim());
  const secret: BlueskySecret = { identifier: session.did, appPassword: input.appPassword.trim(), pds: session.pds };
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
  return content.linkUrl && !body.includes(content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
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
