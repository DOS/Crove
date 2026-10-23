// Bluesky (S9, issue #390), written from the AT Protocol and app.bsky lexicons. No app review: an account connects
// with its handle and an app password (Settings > App passwords on Bluesky), which the account can revoke at any time
// and which cannot change the account's own password or email. The kernel seals the app password; each publish opens
// a fresh session with it, so no rotating refresh token has to be kept.
//
// Accounts on any PDS (#792): the handle or DID is resolved to its DID document (plc.directory for did:plc, the host's
// /.well-known/did.json for did:web), which names the account's PDS. A PDS under bsky.network signs in through
// bsky.social, as before; any other PDS is the tenant's to name, so every call to it goes through the egress fetch the
// kernel hands in (public addresses only, the connection pinned to the checked address, no redirects). Without one,
// such accounts are refused (UnsupportedPds). The resolution is kept 10 minutes, so an account that moves PDS is
// followed on a later call.
import type { CommentInput, CommentResult, GateInput, RepostInput, ConnectedAccount, MetricName, AccountMetricsInput, AccountMetricsResult, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RemoveInput, RemoveResult, RetrySafety } from './index.ts';
import { commentResult, removeResult } from './comment.ts';
import { holdsLink } from './text.ts';
import { requestSignal, type Fetch } from './oauth.ts';

const ENTRYWAY = 'https://bsky.social';
// Bluesky's public AppView: post counts without a session, so reading metrics never spends the account's session quota.
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
// The did:plc directory: DID documents of did:plc accounts, Bluesky-hosted or not.
const PLC_DIRECTORY = 'https://plc.directory';
// Bluesky's video service (#455): it takes the MP4, transcodes it and hands back the blob the post embeds.
const VIDEO_SERVICE = 'https://video.bsky.app';
// One MP4 per post, as the channel rules allow (Bluesky's service takes more; the rules keep the smaller limit).
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
// How much alt text this adapter sends with a video (an image's goes as it is); ALT_TEXT_LIMITS of the Social module follows it (alt-text-limits.test.ts, #1126).
export const BLUESKY_VIDEO_ALT_TEXT_MAX = 1000;
// How long a publish waits for the video service; with the upload it stays inside callTimeoutMs.
const VIDEO_WAIT_MS = 300_000;
const VIDEO_CALL_MARGIN_MS = 90_000;
const RESOLVED_MS = 10 * 60_000;
// Lookups kept at most, so connecting many accounts cannot grow the worker's memory without end.
const RESOLVED_MAX = 1000;
const DID_PLC = /^did:plc:[a-z0-9]{8,64}$/;
const DID_WEB = /^did:web:([a-z0-9.-]{4,253})$/;
// A host name with a dot, never an address: a PDS is reached by its domain, as a Mastodon instance is. A top-level
// domain is letters, or an IDN one in its xn-- form (#804).
const HOST_NAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const POST_COLLECTION = 'app.bsky.feed.post';
// Bluesky's own image limit per blob.
const MAX_IMAGE_BYTES = 1_000_000;
// Handles looked up per post for mention facets (#906), and how long each lookup may take before it stays plain text.
const MAX_MENTION_LOOKUPS = 10;
const MENTION_LOOKUP_MS = 5000;
// A DID as a mention facet names it.
const DID_SYNTAX = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,256}$/;
// The post's languages (#906) when the variant names none: Crove's first market.
const DEFAULT_LANGS = ['vi'];
const LANG_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

export function isBlueskyHost(host: string): boolean {
  return host === 'bsky.social' || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.bsky\.network$/.test(host);
}

// fetch limited to Bluesky's own servers (its PDS hosts, the public AppView, the PLC directory) over https, with a
// timeout and no redirects.
const isBlueskyOrigin = (url: URL) => isBlueskyHost(url.hostname) || url.origin === PUBLIC_APPVIEW || url.origin === PLC_DIRECTORY || url.origin === VIDEO_SERVICE;
function blueskyFetch(fetchImpl: Fetch = fetch, timeoutMs = 15_000): Fetch {
  return async (input, init) => {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.port !== '' || !isBlueskyOrigin(url)) throw new Error(`host not allowed for Bluesky: ${url.hostname}`);
    return fetchImpl(url.toString(), { ...init, redirect: 'manual', signal: requestSignal(init?.signal ?? AbortSignal.timeout(timeoutMs)) });
  };
}

// The origin of a PDS as Crove calls it: https on the default port, a host name and no path; null for anything else.
export function pdsOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  return HOST_NAME.test(host) ? `https://${host}` : null;
}

export class BlueskyError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  // The video service names the job of a video it already has (409 already_exists).
  readonly jobId: string | undefined;
  constructor(status: number, code: string | undefined, message: string, jobId?: string) {
    super(message);
    this.name = 'BlueskyError';
    this.status = status;
    this.code = code;
    this.jobId = jobId;
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

interface DidDocument {
  id?: unknown;
  alsoKnownAs?: unknown;
  service?: { id?: unknown; type?: unknown; serviceEndpoint?: unknown }[];
}

// The PDS a DID document names, or null.
function pdsOf(doc: DidDocument | null | undefined, did: string): string | null {
  const service = doc?.service?.find((x) => x.id === '#atproto_pds' || x.id === `${did}#atproto_pds`);
  return pdsOrigin(service?.serviceEndpoint);
}

// A resolved identity: its DID, its PDS and the handles its DID document claims (at://handle in alsoKnownAs).
interface Own {
  did: string;
  pds: string;
  handles: string[];
}

class Xrpc {
  private readonly fetch: Fetch;
  private readonly egress: Fetch | undefined;
  private readonly resolved = new Map<string, Own & { at: number }>();

  // egress: the kernel's guarded fetch, for a PDS outside Bluesky's own hosts; without it those accounts are refused.
  constructor(fetchImpl?: Fetch, egress?: Fetch) {
    this.fetch = blueskyFetch(fetchImpl);
    this.egress = egress;
  }

  // Bluesky's own servers through the allowlisted fetch; any other host only through the egress guard, over https,
  // with no redirects.
  private route(url: URL): Fetch {
    if (url.protocol === 'https:' && url.port === '' && isBlueskyOrigin(url)) return this.fetch;
    const egress = this.egress;
    if (!egress || url.protocol !== 'https:' || url.port !== '' || !HOST_NAME.test(url.hostname)) throw new BlueskyError(400, 'UnsupportedPds', `accounts hosted on ${url.host} are not supported`);
    return (input, init) => egress(input, { ...init, redirect: 'manual', signal: requestSignal(init?.signal ?? AbortSignal.timeout(30_000)) });
  }

  // signal: a shorter limit than the fetch's own timeout, for a lookup that must not hold the post up.
  async call<T>(base: string, method: 'GET' | 'POST', nsid: string, options: { token?: string; params?: Record<string, string>; json?: unknown; bytes?: { data: Uint8Array; type: string }; signal?: AbortSignal } = {}): Promise<T> {
    const url = new URL(`${base}/xrpc/${nsid}`);
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);
    return this.request<T>(url, method, options);
  }

  // The DID a mentioned handle names, from the public AppView; null when it does not resolve, the answer is not a
  // DID, or the lookup fails or runs past timeoutMs.
  async handleDid(handle: string, timeoutMs: number): Promise<string | null> {
    try {
      const answer = await this.call<{ did?: unknown }>(PUBLIC_APPVIEW, 'GET', 'com.atproto.identity.resolveHandle', { params: { handle }, signal: AbortSignal.timeout(timeoutMs) });
      return typeof answer.did === 'string' && DID_SYNTAX.test(answer.did) ? answer.did : null;
    } catch {
      return null;
    }
  }

  private async request<T>(url: URL, method: 'GET' | 'POST', options: { token?: string; json?: unknown; bytes?: { data: Uint8Array; type: string }; signal?: AbortSignal } = {}): Promise<T> {
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
    const response = await this.route(url)(url.toString(), { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Blob([new Uint8Array(body)]) }), ...(options.signal ? { signal: options.signal } : {}) });
    const json = (await response.json().catch(() => null)) as ({ error?: unknown; message?: unknown } & Record<string, unknown>) | null;
    // A success whose body cannot be read may still have done what was asked: never a refusal.
    if (response.ok && !json) throw new BlueskyError(response.status, 'UnreadableAnswer', 'Bluesky answered without a readable body');
    if (!response.ok || !json) throw new BlueskyError(response.status, typeof json?.error === 'string' ? json.error : undefined, typeof json?.message === 'string' ? json.message : `Bluesky answered ${response.status}`, typeof json?.jobId === 'string' ? json.jobId : undefined);
    return json as T;
  }

  // The account's DID and PDS: a handle through the public AppView, the DID document from the PLC directory or the
  // did:web host. null when the identity cannot be read; the caller then signs in through bsky.social as before.
  private async resolve(identifier: string): Promise<Own | null> {
    let did = identifier;
    if (!identifier.startsWith('did:')) {
      const answer = await this.call<{ did?: unknown }>(PUBLIC_APPVIEW, 'GET', 'com.atproto.identity.resolveHandle', { params: { handle: identifier } }).catch(() => null);
      if (typeof answer?.did !== 'string') return null;
      did = answer.did;
    }
    const web = DID_WEB.exec(did);
    if (!DID_PLC.test(did) && !(web && HOST_NAME.test(web[1] as string))) return null;
    const docUrl = web ? new URL(`https://${web[1]}/.well-known/did.json`) : new URL(`${PLC_DIRECTORY}/${did}`);
    const doc = await this.request<DidDocument>(docUrl, 'GET').catch(() => null);
    if (!doc || doc.id !== did) return null;
    const pds = pdsOf(doc, did);
    const handles = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs.filter((a): a is string => typeof a === 'string' && a.startsWith('at://')).map((a) => a.slice(5).toLowerCase()) : [];
    return pds ? { did, pds, handles } : null;
  }

  // A resolution kept from an earlier call, while it is fresh.
  private kept(identifier: string): Own | null {
    const kept = this.resolved.get(identifier);
    return kept && Date.now() - kept.at < RESOLVED_MS ? kept : null;
  }

  // Keeps a resolution under each name given. Expired lookups go first, then the oldest, so the map stays under its cap.
  private remember(own: Own, ...keys: string[]): void {
    const found = { ...own, at: Date.now() };
    for (const [key, value] of this.resolved) if (found.at - value.at >= RESOLVED_MS) this.resolved.delete(key);
    while (this.resolved.size > RESOLVED_MAX - keys.length) this.resolved.delete(this.resolved.keys().next().value as string);
    // Taken out first, so a refreshed lookup counts as the newest.
    for (const key of keys) {
      this.resolved.delete(key);
      this.resolved.set(key, found);
    }
  }

  // The identity read afresh and kept, wherever it is hosted; null when it cannot be read.
  private async lookup(identifier: string): Promise<Own | null> {
    const own = await this.resolve(identifier).catch(() => null);
    if (own) this.remember(own, identifier);
    return own;
  }

  // createSession where the identity says the account lives: its own PDS outside Bluesky, else bsky.social.
  private openAt(own: Own | null, identifier: string, appPassword: string): Promise<Session> {
    return own && !isBlueskyHost(new URL(own.pds).hostname) ? this.open(own.pds, identifier, appPassword, own) : this.open(ENTRYWAY, identifier, appPassword, null);
  }

  // A session for an app password, on the account's own PDS. Bluesky-hosted accounts sign in through bsky.social, as
  // before. When it refuses the login, the account may live on another PDS: the identity is resolved and, if it names
  // a PDS outside Bluesky, the login is tried there. Later calls go straight to that PDS while the resolution is kept.
  async session(identifier: string, appPassword: string): Promise<Session> {
    const refused = (error: unknown) => error instanceof BlueskyError && (error.status === 400 || error.status === 401) && error.code !== 'UnsupportedPds';
    // A DID's document names its PDS and is read without the app password, so the login goes straight there: bsky.social
    // never sees the password of an account hosted elsewhere (#804). The lookup is kept for Bluesky-hosted accounts too,
    // so a refused password costs no directory read while it is fresh; an account that leaves Bluesky is found when its
    // lookup expires. A document that cannot be read, or names no PDS Crove calls, sends the password nowhere: the
    // session fails as unclear and is tried again later.
    if (identifier.startsWith('did:')) {
      const kept = this.kept(identifier);
      const own = kept ?? (await this.lookup(identifier));
      if (!own) throw new BlueskyError(503, 'IdentityUnavailable', 'the account DID document could not be read');
      try {
        return await this.openAt(own, identifier, appPassword);
      } catch (error) {
        // Refused on its own PDS where a kept lookup pointed: the account may have moved, so it is looked up afresh once.
        if (!kept || !refused(error) || isBlueskyHost(new URL(kept.pds).hostname)) throw error;
        const fresh = await this.lookup(identifier);
        if (!fresh || fresh.pds === kept.pds) throw error;
        return this.openAt(fresh, identifier, appPassword);
      }
    }
    const kept = this.kept(identifier);
    if (kept && !isBlueskyHost(new URL(kept.pds).hostname)) {
      try {
        return await this.open(kept.pds, identifier, appPassword, kept);
      } catch (error) {
        // Refused where it was: the account may have moved, so it is looked up again below.
        if (!refused(error)) throw error;
      }
    }
    try {
      return await this.open(ENTRYWAY, identifier, appPassword, null);
    } catch (error) {
      if (!refused(error)) throw error;
      const own = await this.resolve(identifier).catch(() => null);
      if (!own || isBlueskyHost(new URL(own.pds).hostname)) throw error;
      return this.open(own.pds, identifier, appPassword, own);
    }
  }

  // createSession on base. own: the identity resolved for this login (a PDS outside Bluesky), or null.
  private async open(base: string, identifier: string, appPassword: string, own: Own | null): Promise<Session> {
    const answer = await this.call<{ did?: unknown; handle?: unknown; accessJwt?: unknown; didDoc?: DidDocument }>(base, 'POST', 'com.atproto.server.createSession', { json: { identifier, password: appPassword } });
    if (typeof answer.did !== 'string' || !answer.did.startsWith('did:') || typeof answer.accessJwt !== 'string') throw new BlueskyError(502, 'BadSession', 'Bluesky answered without a session');
    // The server signed in someone other than the account resolved: never use that session.
    if (own && answer.did !== own.did) throw new BlueskyError(502, 'BadSession', 'Bluesky signed in another account');
    // The PDS the session's DID document names, else the one resolved, else the entryway.
    const named = answer.didDoc ? pdsOf(answer.didDoc, answer.did) : null;
    const listed = answer.didDoc?.service?.some((x) => x.id === '#atproto_pds' || x.id === `${answer.did}#atproto_pds`);
    // A PDS named in a form Crove does not call (another port, a path, an address): refused, not guessed.
    if (listed && !named) throw new BlueskyError(400, 'UnsupportedPds', 'the account names a PDS Crove cannot call');
    const pds = named ?? own?.pds ?? ENTRYWAY;
    const host = new URL(pds).hostname;
    // A PDS outside Bluesky is called only when the resolved identity named it, never on a session's word alone.
    if (!isBlueskyHost(host) && pds !== own?.pds) throw new BlueskyError(400, 'UnsupportedPds', `accounts hosted on ${host} are not supported`);
    if (own) this.remember(own, identifier, answer.did);
    // A PDS outside Bluesky says what the account's handle is; it is shown only when the DID document claims it too,
    // else the account is named by its DID.
    const said = typeof answer.handle === 'string' ? answer.handle.toLowerCase() : null;
    const handle = own ? (said && own.handles.includes(said) ? said : answer.did) : (said ?? identifier);
    return { did: answer.did, handle, accessJwt: answer.accessJwt, pds, scope: tokenScope(answer.accessJwt) };
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

// egress: the kernel's guarded fetch, so an account on its own PDS can connect (#792).
export async function connectBluesky(input: { handle: string; appPassword: string }, fetchImpl?: Fetch, egress?: Fetch): Promise<ConnectedAccount> {
  const { handle, appPassword } = blueskyLogin(input);
  const session = await new Xrpc(fetchImpl, egress).session(handle, appPassword);
  // The format check above cannot tell an account password shaped like an app password; the session can (#399). A
  // privileged app password also reads direct messages, which Crove never needs. An unreadable scope is let through:
  // the token format is Bluesky's to change.
  if (session.scope === 'com.atproto.access') throw new BlueskyError(400, 'NotAnAppPassword', 'use an app password, not the account password');
  if (session.scope === 'com.atproto.appPassPrivileged') throw new BlueskyError(400, 'PrivilegedAppPassword', 'use an app password without direct message access');
  const secret: BlueskySecret = { identifier: session.did, appPassword };
  return { provider: 'bluesky', externalAccountId: session.did, displayName: `@${session.handle}`.slice(0, 200), scopes: ['app_password'], expiresAt: null, secret: JSON.stringify(secret) };
}

// A rich text facet (app.bsky.richtext.facet): a range of the text in UTF-8 byte offsets and what it is.
export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: ({ $type: 'app.bsky.richtext.facet#link'; uri: string } | { $type: 'app.bsky.richtext.facet#tag'; tag: string } | { $type: 'app.bsky.richtext.facet#mention'; did: string })[];
}

const encoder = new TextEncoder();
// The UTF-8 byte offset of a UTF-16 index of text.
const byteAt = (text: string, index: number) => encoder.encode(text.slice(0, index)).byteLength;
const range = (text: string, start: number, end: number) => ({ byteStart: byteAt(text, start), byteEnd: byteAt(text, end) });
const overlaps = (a: BlueskyFacet['index'], b: BlueskyFacet['index']) => a.byteStart < b.byteEnd && b.byteStart < a.byteEnd;
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

// Link facets: Bluesky shows a URL as a link only when the post says where it is, in UTF-8 byte offsets.
export function linkFacets(text: string): BlueskyFacet[] {
  const facets: BlueskyFacet[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    facets.push({ index: range(text, match.index, match.index + match[0].length), features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }] });
  }
  return facets;
}

// Hashtags as Bluesky's own client finds them (@atproto/api detectFacets): a # or fullwidth # (U+FF03) at the start or after
// whitespace, running to the next whitespace, with trailing punctuation dropped; not all digits and punctuation, no
// keycap emoji (# with U+FE0F U+20E3), at most 64 graphemes and 640 bytes (the lexicon's limits). Invisible joiners end a tag.
const TAG = /(^|\s)[#\uff03]((?!\ufe0f)[^\s\u20e2\u00ad\u2060\u200a\u200b\u200c\u200d]*[^\d\s\p{P}\u20e2\u00ad\u2060\u200a\u200b\u200c\u200d]+[^\s\u20e2\u00ad\u2060\u200a\u200b\u200c\u200d]*)?/gu;
export function tagFacets(text: string): BlueskyFacet[] {
  const facets: BlueskyFacet[] = [];
  for (const match of text.matchAll(TAG)) {
    const tag = (match[2] ?? '').replace(/\p{P}+$/u, '');
    if (!tag || [...graphemes.segment(tag)].length > 64 || encoder.encode(tag).byteLength > 640) continue;
    const start = match.index + (match[1] as string).length;
    facets.push({ index: range(text, start, start + 1 + tag.length), features: [{ $type: 'app.bsky.richtext.facet#tag', tag }] });
  }
  return facets;
}

// @handle mentions as Bluesky's client finds them: at the start, after whitespace or an opening parenthesis (so an
// email address is not one), a handle with a dot and a top-level domain of letters. The handle is lowercased, as
// handles are case-insensitive.
const MENTION = /(^|\s|\()@([a-zA-Z0-9.-]+)\b/g;
function mentionsIn(text: string): { start: number; end: number; handle: string }[] {
  const found = [];
  for (const match of text.matchAll(MENTION)) {
    const raw = match[2] as string;
    const handle = raw.toLowerCase();
    if (!BLUESKY_HANDLE.test(handle) || !HOST_NAME.test(handle)) continue;
    const start = match.index + (match[1] as string).length;
    found.push({ start, end: start + 1 + raw.length, handle });
  }
  return found;
}

// Every facet of the text as it is sent (#906): links, hashtags and the mentions whose handle resolves to a DID. A tag
// or mention inside a link is left to the link. At most MAX_MENTION_LOOKUPS distinct handles are looked up, in the
// order they appear; one that does not resolve (or a lookup past the cap) stays plain text and never fails the post.
export async function blueskyFacets(text: string, didOf: (handle: string) => Promise<string | null>): Promise<BlueskyFacet[]> {
  const links = linkFacets(text);
  const free = (index: BlueskyFacet['index']) => !links.some((l) => overlaps(l.index, index));
  const tags = tagFacets(text).filter((f) => free(f.index));
  const mentions = mentionsIn(text)
    .map((m) => ({ ...m, index: range(text, m.start, m.end) }))
    .filter((m) => free(m.index));
  const handles = [...new Set(mentions.map((m) => m.handle))].slice(0, MAX_MENTION_LOOKUPS);
  const dids = new Map(await Promise.all(handles.map(async (h) => [h, await didOf(h).catch(() => null)] as const)));
  const mentioned: BlueskyFacet[] = [];
  for (const m of mentions) {
    const did = dids.get(m.handle);
    if (did) mentioned.push({ index: m.index, features: [{ $type: 'app.bsky.richtext.facet#mention', did }] });
  }
  return [...links, ...tags, ...mentioned].sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// The post's languages (#906): the variant's `settings.langs` (one BCP-47 tag or up to three), else Vietnamese. The
// org has no locale of its own yet, so the variant setting is how another language is named.
export function blueskyLangs(settings: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = settings?.langs;
  const given = (Array.isArray(raw) ? raw : [raw]).filter((l): l is string => typeof l === 'string' && LANG_TAG.test(l));
  return given.length > 0 ? [...new Set(given)].slice(0, 3) : DEFAULT_LANGS;
}

// Who may reply to and quote a post (#1102), from the variant's settings: `replySettings` is everyone (the default,
// nothing sent), nobody, or the people the post mentions, the accounts it follows, its followers, one of them or several
// as a list; `quotes: false` turns quote posts off. Bluesky keeps these as records of their own next to the post, with
// its record key (app.bsky.feed.threadgate and app.bsky.feed.postgate): a threadgate on a thread's first post gates
// every reply in the thread, and a postgate covers the post it names.
export const BLUESKY_REPLY_RULES = ['mentionedUsers', 'following', 'followers'] as const;
export type BlueskyReplyRule = (typeof BLUESKY_REPLY_RULES)[number];
export interface BlueskyGates {
  // null: everyone may reply (no threadgate); [] : nobody; else the rules, in BLUESKY_REPLY_RULES order.
  allow: BlueskyReplyRule[] | null;
  quotes: boolean;
}
const THREADGATE_RULE: Record<BlueskyReplyRule, string> = {
  mentionedUsers: 'app.bsky.feed.threadgate#mentionRule',
  following: 'app.bsky.feed.threadgate#followingRule',
  followers: 'app.bsky.feed.threadgate#followerRule',
};
const isReplyRule = (v: unknown): v is BlueskyReplyRule => typeof v === 'string' && (BLUESKY_REPLY_RULES as readonly string[]).includes(v);

// The gates a variant asks for; null when it asks for none (everyone may reply and quote, as before), 'invalid' when
// a value is not one of the above (a list must hold distinct rules).
export function blueskyGatesOf(settings: Readonly<Record<string, unknown>> | undefined): BlueskyGates | null | 'invalid' {
  const replies = settings?.replySettings;
  const quotes = settings?.quotes;
  if (quotes !== undefined && typeof quotes !== 'boolean') return 'invalid';
  let allow: BlueskyReplyRule[] | null;
  if (replies === undefined || replies === 'everyone') allow = null;
  else if (replies === 'nobody') allow = [];
  else if (isReplyRule(replies)) allow = [replies];
  else if (Array.isArray(replies) && replies.length > 0 && replies.every(isReplyRule) && new Set(replies).size === replies.length) allow = BLUESKY_REPLY_RULES.filter((r) => replies.includes(r));
  else return 'invalid';
  return allow === null && quotes !== false ? null : { allow, quotes: quotes !== false };
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

  // A video's upload and processing take minutes (#455); within the job's stale limit (600 s).
  readonly callTimeoutMs = 420_000;
  private readonly videoWaitMs: number;
  private readonly pollMs: number;
  private readonly budgetMs: number;
  private readonly mentionMs: number;

  // egress: the kernel's guarded fetch, for accounts on their own PDS (#792).
  constructor(fetchImpl?: Fetch, egress?: Fetch, timing: { videoWaitMs?: number; pollMs?: number; budgetMs?: number; mentionMs?: number } = {}) {
    this.xrpc = new Xrpc(fetchImpl, egress);
    this.videoWaitMs = timing.videoWaitMs ?? VIDEO_WAIT_MS;
    this.pollMs = timing.pollMs ?? 2000;
    this.budgetMs = timing.budgetMs ?? this.callTimeoutMs - VIDEO_CALL_MARGIN_MS;
    this.mentionMs = timing.mentionMs ?? MENTION_LOOKUP_MS;
  }

  // The text's facets, with mentions looked up on the public AppView (no session, nothing posted).
  private facets(text: string): Promise<BlueskyFacet[]> {
    return blueskyFacets(text, (handle) => this.xrpc.handleDid(handle, this.mentionMs));
  }

  // One MP4 through the video service: a service-auth token from the account's PDS, the upload, then a wait on the
  // job until the service hands back the blob. Nothing is visible before the post names the blob, so any failure here
  // posted nothing; a wait past the budget is a failure to retry.
  private async uploadVideo(session: Session, bytes: Uint8Array, started: number): Promise<{ blob: unknown } | { rejected: PublishResult }> {
    const fail = (error: unknown): { rejected: PublishResult } => {
      const result = blueskyResult(error);
      return { rejected: result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) } };
    };
    let token: string;
    try {
      const auth = await this.xrpc.call<{ token?: unknown }>(session.pds, 'GET', 'com.atproto.server.getServiceAuth', {
        token: session.accessJwt,
        params: { aud: `did:web:${new URL(session.pds).hostname}`, lxm: 'com.atproto.repo.uploadBlob', exp: String(Math.floor(Date.now() / 1000) + 30 * 60) },
      });
      if (typeof auth.token !== 'string' || !auth.token) return { rejected: { kind: 'rejected', error: 'transient', code: 'NO_SERVICE_TOKEN' } };
      token = auth.token;
    } catch (error) {
      return fail(error);
    }
    let jobId: string;
    try {
      const answer = await this.xrpc.call<{ jobStatus?: { jobId?: unknown }; jobId?: unknown }>(VIDEO_SERVICE, 'POST', 'app.bsky.video.uploadVideo', {
        token,
        params: { did: session.did, name: `crove-${Date.now().toString(36)}.mp4` },
        bytes: { data: bytes, type: 'video/mp4' },
      });
      const id = answer.jobStatus?.jobId ?? answer.jobId;
      if (typeof id !== 'string' || !id) return { rejected: { kind: 'rejected', error: 'transient', code: 'NO_VIDEO_JOB' } };
      jobId = id;
    } catch (error) {
      // The same video sent again (a retry): the service names the job it already has.
      if (error instanceof BlueskyError && error.status === 409 && error.jobId) jobId = error.jobId;
      else return fail(error);
    }
    const until = Math.min(started + this.budgetMs, Date.now() + this.videoWaitMs);
    for (;;) {
      let status: { state?: unknown; blob?: unknown; error?: unknown; message?: unknown };
      try {
        const answer = await this.xrpc.call<{ jobStatus?: typeof status }>(VIDEO_SERVICE, 'GET', 'app.bsky.video.getJobStatus', { token, params: { jobId } });
        status = answer.jobStatus ?? {};
      } catch (error) {
        return fail(error);
      }
      if (status.state === 'JOB_STATE_COMPLETED' && status.blob) return { blob: status.blob };
      if (status.state === 'JOB_STATE_FAILED') return { rejected: { kind: 'rejected', error: 'bad_request', code: 'VIDEO_PROCESSING_FAILED', ...(typeof status.message === 'string' ? { message: status.message.slice(0, 500) } : {}) } };
      if (Date.now() + this.pollMs > until) return { rejected: { kind: 'rejected', error: 'transient', code: 'VIDEO_PROCESSING_SLOW' } };
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' };
    // Gates the gate step could not write (#1102) are refused before any call, so the post never goes out ungated.
    if (blueskyGatesOf(input.settings) === 'invalid') return { kind: 'rejected', error: 'bad_request', code: 'GATES_INVALID' };
    let session: Session;
    try {
      session = await this.xrpc.session(s.identifier, s.appPassword);
    } catch (error) {
      // Nothing is posted by opening a session, so an unclear answer is a failure to retry.
      const result = blueskyResult(error);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
    const started = Date.now();
    // One video (#455): through the video service, embedded as app.bsky.embed.video. Not mixed with images.
    const video = input.content.media.find((m) => m.mime.startsWith('video/'));
    let videoEmbed: Record<string, unknown> | null = null;
    if (video) {
      if (input.content.media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'ONE_VIDEO_ALONE' };
      if (video.mime !== 'video/mp4') return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TYPE' };
      if (video.sizeBytes > MAX_VIDEO_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'VIDEO_TOO_LARGE' };
      let bytes: Uint8Array;
      try {
        bytes = await input.readMedia(video.fileId);
      } catch {
        return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      }
      const uploaded = await this.uploadVideo(session, bytes, started);
      if ('rejected' in uploaded) return uploaded.rejected;
      videoEmbed = { $type: 'app.bsky.embed.video', video: uploaded.blob, ...(video.altText ? { alt: video.altText.slice(0, BLUESKY_VIDEO_ALT_TEXT_MAX) } : {}) };
    }
    // Images are uploaded as blobs first; a blob nobody references is never shown, so a failure here posted nothing.
    const images: { alt: string; image: unknown }[] = [];
    for (const m of video ? [] : input.content.media.slice(0, 4)) {
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
    if (!text && images.length === 0 && !videoEmbed) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    const record: Record<string, unknown> = { $type: POST_COLLECTION, text, createdAt: new Date().toISOString(), langs: blueskyLangs(input.settings) };
    const facets = await this.facets(text);
    if (facets.length > 0) record.facets = facets;
    if (images.length > 0) record.embed = { $type: 'app.bsky.embed.images', images };
    if (videoEmbed) record.embed = videoEmbed;
    try {
      const answer = await this.xrpc.call<{ uri?: unknown }>(session.pds, 'POST', 'com.atproto.repo.createRecord', { token: session.accessJwt, json: { repo: session.did, collection: POST_COLLECTION, record } });
      if (typeof answer.uri !== 'string' || !answer.uri.startsWith('at://')) return { kind: 'unknown', code: 'NO_URI' };
      return { kind: 'accepted', externalId: answer.uri, url: postUrl(session.handle, answer.uri) };
    } catch (error) {
      return blueskyResult(error);
    }
  }

  // A repost of the account's own post (#773): an app.bsky.feed.repost record naming the post by URI and content id, so
  // the post is read first for its cid. Reading posts nothing.
  async repost(input: RepostInput): Promise<CommentResult> {
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
    let subject: { uri: string; cid: string };
    try {
      const got = await this.xrpc.call<{ uri?: unknown; cid?: unknown }>(session.pds, 'GET', 'com.atproto.repo.getRecord', { token: session.accessJwt, params: { repo: session.did, collection: POST_COLLECTION, rkey: parts[2] as string } });
      if (typeof got.uri !== 'string' || typeof got.cid !== 'string') return { kind: 'rejected', error: 'transient', code: 'NO_CID' };
      subject = { uri: got.uri, cid: got.cid };
    } catch (error) {
      const result = blueskyResult(error);
      return commentResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    try {
      const record = { $type: 'app.bsky.feed.repost', subject, createdAt: new Date().toISOString() };
      const answer = await this.xrpc.call<{ uri?: unknown }>(session.pds, 'POST', 'com.atproto.repo.createRecord', { token: session.accessJwt, json: { repo: session.did, collection: 'app.bsky.feed.repost', record } });
      if (typeof answer.uri !== 'string' || !answer.uri.startsWith('at://')) return { kind: 'unknown', code: 'NO_URI' };
      return { kind: 'accepted', externalId: answer.uri };
    } catch (error) {
      return commentResult(blueskyResult(error));
    }
  }

  // Who may reply to and quote the account's own post (#1102), once it is out: an app.bsky.feed.threadgate record when
  // replies are limited (allow [] for nobody), then an app.bsky.feed.postgate record with a disableRule when quotes are
  // off, each with the post's record key and naming the post by its URI, as the lexicons require and Bluesky's own app
  // writes them. A gate that fails leaves the post up as it is: the answer says which gate (threadgate: or postgate:).
  async gate(input: GateInput): Promise<CommentResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' };
    const gates = blueskyGatesOf(input.settings);
    if (gates === 'invalid') return { kind: 'rejected', error: 'bad_request', code: 'GATES_INVALID' };
    if (gates === null) return { kind: 'rejected', error: 'bad_request', code: 'NO_GATES' };
    const parts = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/.exec(input.externalId);
    if (!parts) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    let session: Session;
    try {
      session = await this.xrpc.session(s.identifier, s.appPassword);
    } catch (error) {
      // Opening a session writes nothing, so an unclear answer is a failure.
      const result = blueskyResult(error);
      return commentResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    if (parts[1] !== session.did) return { kind: 'rejected', error: 'bad_request', code: 'NOT_OWN_POST' };
    const rkey = parts[2] as string;
    const createdAt = new Date().toISOString();
    const writes: { gate: 'threadgate' | 'postgate'; record: Record<string, unknown> }[] = [];
    if (gates.allow !== null) writes.push({ gate: 'threadgate', record: { $type: 'app.bsky.feed.threadgate', post: input.externalId, allow: gates.allow.map((r) => ({ $type: THREADGATE_RULE[r] })), createdAt } });
    if (!gates.quotes) writes.push({ gate: 'postgate', record: { $type: 'app.bsky.feed.postgate', post: input.externalId, embeddingRules: [{ $type: 'app.bsky.feed.postgate#disableRule' }], createdAt } });
    let made = '';
    for (const { gate, record } of writes) {
      try {
        const answer = await this.xrpc.call<{ uri?: unknown }>(session.pds, 'POST', 'com.atproto.repo.createRecord', { token: session.accessJwt, json: { repo: session.did, collection: record.$type, rkey, record } });
        if (typeof answer.uri !== 'string' || !answer.uri.startsWith('at://')) return { kind: 'unknown', code: `${gate}:NO_URI` };
        made ||= answer.uri;
      } catch (error) {
        const result = commentResult(blueskyResult(error));
        return result.kind === 'accepted' ? result : { ...result, code: `${gate}:${result.code ?? 'FAILED'}` };
      }
    }
    return { kind: 'accepted', externalId: made };
  }

  // Takes the account's own post down (#860): com.atproto.repo.deleteRecord on its PDS, by the record key in its at://
  // URI. Bluesky answers a record already gone like a deletion; a PDS that names it (RecordNotFound, 404) counts too.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' };
    const parts = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/.exec(input.externalId);
    if (!parts) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    let session: Session;
    try {
      session = await this.xrpc.session(s.identifier, s.appPassword);
    } catch (error) {
      // Opening a session removes nothing, so an unclear answer is a failure to try again.
      const result = blueskyResult(error);
      return removeResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    if (parts[1] !== session.did) return { kind: 'rejected', error: 'bad_request', code: 'NOT_OWN_POST' };
    try {
      await this.xrpc.call(session.pds, 'POST', 'com.atproto.repo.deleteRecord', { token: session.accessJwt, json: { repo: session.did, collection: POST_COLLECTION, rkey: parts[2] as string } });
      return { kind: 'removed' };
    } catch (error) {
      if (error instanceof BlueskyError && (error.status === 404 || error.status === 410 || error.code === 'RecordNotFound')) return { kind: 'removed' };
      return removeResult(blueskyResult(error));
    }
  }

  // A reply to the account's own post (#587), as the first comment or a thread's part (#742): Bluesky replies name the
  // post they answer and the thread's first post by URI and content id, so both are read first for their cid. Reading
  // posts nothing.
  async comment(input: CommentInput): Promise<CommentResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_APP_PASSWORD' };
    const POST_URI = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/;
    const parts = POST_URI.exec(input.externalId);
    const rootParts = input.rootExternalId && input.rootExternalId !== input.externalId ? POST_URI.exec(input.rootExternalId) : null;
    if (!parts || (input.rootExternalId && input.rootExternalId !== input.externalId && !rootParts)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    let session: Session;
    try {
      session = await this.xrpc.session(s.identifier, s.appPassword);
    } catch (error) {
      const result = blueskyResult(error);
      return commentResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    if (parts[1] !== session.did || (rootParts && rootParts[1] !== session.did)) return { kind: 'rejected', error: 'bad_request', code: 'NOT_OWN_POST' };
    const strongRef = async (rkey: string) => {
      const got = await this.xrpc.call<{ uri?: unknown; cid?: unknown }>(session.pds, 'GET', 'com.atproto.repo.getRecord', { token: session.accessJwt, params: { repo: session.did, collection: POST_COLLECTION, rkey } });
      return typeof got.uri === 'string' && typeof got.cid === 'string' ? { uri: got.uri, cid: got.cid } : null;
    };
    let parent: { uri: string; cid: string };
    let root: { uri: string; cid: string };
    try {
      const got = await strongRef(parts[2] as string);
      const gotRoot = rootParts ? await strongRef(rootParts[2] as string) : got;
      if (!got || !gotRoot) return { kind: 'rejected', error: 'transient', code: 'NO_CID' };
      parent = got;
      root = gotRoot;
    } catch (error) {
      const result = blueskyResult(error);
      return commentResult(result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) });
    }
    const record: Record<string, unknown> = { $type: POST_COLLECTION, text: input.text, createdAt: new Date().toISOString(), reply: { root, parent } };
    const facets = await this.facets(input.text);
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
  // The account's followers (#645), from the public AppView: no session needed.
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,256}$/.test(input.externalAccountId)) return null;
    try {
      const answer = await this.xrpc.call<{ did?: unknown; followersCount?: unknown }>(PUBLIC_APPVIEW, 'GET', 'app.bsky.actor.getProfile', { params: { actor: input.externalAccountId } });
      if (answer.did !== input.externalAccountId) return null;
      const n = answer.followersCount;
      return { followers: typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null };
    } catch {
      return null;
    }
  }

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
