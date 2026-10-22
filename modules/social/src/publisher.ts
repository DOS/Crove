// The publish job (Social plan §3.4, step S4): one run for one variant. social.publish.begin decides what to do and
// commits the external_call row before anything visible happens; then the credential is opened, the provider called,
// and social.publish.record stores the answer. The plaintext token lives only in this function's scope.
//
// What happens if this run dies at each point:
// - before begin commits: nothing changed; the next sweep starts over;
// - after begin, before the call: the call row says 'started', so the next run (once the variant is stale) cannot
//   tell whether the call went out and reconciles or asks a person; it never calls blindly;
// - after the call, before record: the same, and that is the case the ledger exists for;
// - record failing: the job throws, pg-boss retries it, and the retry's begin finds the variant in flight.
import { withCallSignal, type Publisher, type PublishResult, type ReconcileResult } from '@crove/channel';
import { DomainError, readVerified, type BlobStore, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { COVER_RULES, THREAD_PARTS_MAX, VIDEO_READY, coverKind, coverOf, isProvider, scopeNeeded, type Provider } from './domain/channels.ts';
import { PUBLISH_STALE_SECONDS, type BeginResult, type PublishRecord, type PublishWork } from './publishing.ts';
import type { CommentWork } from './comments.ts';
import type { PinWork } from './pin.ts';
import type { RemoveRecord, RemoveWork } from './remove.ts';
import type { ThreadWork } from './thread.ts';import { shortened, shortenedSettings, shortUrl } from './short-links.ts';


export interface PublishDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The providers this deployment can publish to, by provider id.
  publishers: Readonly<Record<string, Publisher>>;
  // How long one provider call may take before its outcome counts as unknown.
  callTimeoutMs?: number;
  // Where the images of posts are stored. Unset: a post with images is refused by the adapter with nothing posted.
  store?: BlobStore;
  staleSeconds?: number;
  // The deployment's public URL (PUBLIC_URL), where short links (#706) point. Unset: a post goes out with its own link.
  publicUrl?: string;
}

const ACTOR: SystemActor = { type: 'system', component: 'social.publisher' };
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

class Timeout extends Error {}

// The job stops waiting after ms and records unknown; at the same moment it aborts the call, so every request the
// adapter would still make in it (a post after a slow upload) fails instead of reaching the platform (#382).
async function withTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const call = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      withCallSignal(call.signal, run),
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(() => {
            // The race settles on Timeout first; only then are the adapter's requests aborted (an adapter that catches
            // the abort and answers cannot win the race).
            reject(new Timeout('provider call timed out'));
            call.abort(new Timeout('provider call timed out'));
          }, ms)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Provider answers become record inputs. Messages and codes are clipped to what the columns hold.
const clip = (s: string | undefined, max: number) => (s === undefined ? undefined : s.slice(0, max));

function fromPublish(r: PublishResult): PublishRecord {
  switch (r.kind) {
    case 'accepted':
      return { kind: 'accepted', externalId: r.externalId.slice(0, 500), url: r.url, ...(r.sentToApp ? { sentToApp: true as const } : {}), ...(r.draft ? { draft: r.draft } : {}) };
    case 'pending':
      return { kind: 'pending', externalRef: r.externalRef.slice(0, 500), checkAfterSeconds: Math.min(86_400, Math.max(5, Math.round(r.checkAfterSeconds))) };
    case 'rejected': {
      const out: PublishRecord = { kind: 'rejected', error: r.error };
      if (r.code !== undefined) out.code = clip(r.code, 200);
      if (r.message !== undefined) out.message = clip(r.message, 2000);
      if (r.httpStatus !== undefined) out.httpStatus = r.httpStatus;
      if (r.retryAt !== undefined) out.retryAt = r.retryAt.toISOString();
      return out;
    }
    case 'unknown': {
      const out: PublishRecord = { kind: 'unknown' };
      if (r.code !== undefined) out.code = clip(r.code, 200);
      if (r.message !== undefined) out.message = clip(r.message, 2000);
      return out;
    }
  }
}

function fromReconcile(r: ReconcileResult): PublishRecord {
  if (r.found === true) return { kind: 'found', externalId: r.externalId.slice(0, 500), url: r.url, ...(r.draft ? { draft: r.draft } : {}) };
  return r.found === false ? { kind: 'missing' } : { kind: 'unknowable' };
}

// The channel's token, opened for this one call. Any failure means nothing was called.
async function openCredential(deps: PublishDeps, orgId: string, connectionId: string): Promise<{ externalAccountId: string; secret: string } | { blocked: string }> {
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId }, { actor: ACTOR, orgId });
    const secret = deps.broker.open(
      { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') },
      { orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId },
    );
    return { externalAccountId: sealed.externalAccountId, secret };
  } catch (error) {
    if (error instanceof DomainError) return { blocked: error.code };
    console.error(`[social-publish] credential of connection ${connectionId.slice(0, 8)} could not be opened`, (error as Error).message);
    return { blocked: 'CREDENTIAL_UNREADABLE' };
  }
}

async function provide(deps: PublishDeps, orgId: string, publisher: Publisher, work: PublishWork, credential: { externalAccountId: string; secret: string }): Promise<PublishRecord> {
  // A deployment's (or a test's) own limit first, then the adapter's (video uploads take minutes), then the default.
  const timeout = deps.callTimeoutMs ?? publisher.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  // Only the variant's own images and its video's cover image (#642), of this org.
  const cover = coverOf(work.settings);
  const mediaFile = async (fileId: string) => {
    if (!work.content.media.some((m) => m.fileId === fileId) && !(cover && 'fileId' in cover && cover.fileId === fileId)) throw new Error('not an image of this variant');
    return deps.runtime.query<{ storageKey: string; generation: string | null; sha256: string; contentType: string; filename: string }>('social.media.file', { fileId }, { actor: ACTOR, orgId });
  };
  // A presigned GET of the exact version, where the store hands them out (S3); valid briefly, enough for the platform
  // to fetch it right after the call that names it.
  const mediaUrl = async (fileId: string): Promise<string | null> => {
    const direct = deps.store?.direct;
    if (!direct) return null;
    const file = await mediaFile(fileId);
    return direct.presignDownload({ key: file.storageKey, generation: file.generation, sha256: file.sha256 }, { filename: file.filename, contentType: file.contentType });
  };
  const readMedia = async (fileId: string): Promise<Uint8Array> => {
    if (!deps.store) throw new Error('media storage not available');
    const file = await mediaFile(fileId);
    // The exact version the post was approved with, checked against its hash.
    return readVerified(deps.store, { key: file.storageKey, generation: file.generation, sha256: file.sha256 });
  };
  // The content as it goes out: with its short link (#706) when it has one.
  const short = work.shortLink && deps.publicUrl ? { target: work.shortLink.target, url: shortUrl(deps.publicUrl, work.shortLink.code) } : null;
  const content = short ? shortened(work.content, short) : work.content;
  // A Telegram button to the post's link goes out through the same short link (#1017).
  const settings = short ? shortenedSettings(work.settings, short) : work.settings;
  try {
    switch (work.action) {
      case 'call': {
        // The channel rules hold a video back from a channel whose adapter cannot post it; this keeps it so if a rule changed.
        if (!VIDEO_READY.has(publisher.provider as Provider) && work.content.media.some((m) => m.mime.startsWith('video/'))) {
          return fromPublish({ kind: 'rejected', error: 'bad_request', code: 'VIDEO_NOT_SUPPORTED' });
        }
        // Likewise a cover the channel's adapter cannot send (#642): refused, never published without it.
        if (cover && !COVER_RULES[publisher.provider as Provider]?.includes(coverKind(cover))) {
          return fromPublish({ kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' });
        }
        // Settings this deployment's adapter cannot send (#903: TikTok's inbox mode without CHANNEL_TIKTOK_INBOX):
        // refused for good with nothing sent, before the permission check, since no reconnect would bring it.
        const refusal = publisher.refusal?.(work.settings);
        if (refusal) return fromPublish({ kind: 'rejected', error: 'bad_request', code: refusal });
        // A permission the variant needs that its connection was not granted (#903: a TikTok connection made before
        // Crove asked for video.upload): nothing is sent, and the variant waits paused for a reconnect.
        const scope = isProvider(publisher.provider) ? scopeNeeded(publisher.provider, work.settings) : null;
        if (scope && !work.scopes.includes(scope)) return { kind: 'blocked', code: 'CHANNEL_SCOPE_MISSING' };
        return fromPublish(
          await withTimeout(timeout, () =>
            publisher.publish({ ...credential, content, readMedia, mediaUrl, settings, callKey: work.callKey, contentHash: work.contentHash }),
          ),
        );
      }
      case 'status':
        if (!publisher.status || !work.externalRef) return { kind: 'unknown', code: 'STATUS_UNAVAILABLE' };
        return fromPublish(await withTimeout(timeout, () => publisher.status!({ ...credential, externalRef: work.externalRef as string })));
      case 'reconcile': {
        if (!publisher.reconcile) return { kind: 'unknowable', code: 'RECONCILE_UNAVAILABLE' };
        // The post would have appeared between a minute before the first call and now.
        const after = new Date(Date.parse(work.callStartedAt) - 60_000);
        return fromReconcile(
          await withTimeout(timeout, () =>
            publisher.reconcile!({ ...credential, callKey: work.callKey, contentHash: work.contentHash, content, settings, after, before: new Date() }),
          ),
        );
      }
    }
  } catch (error) {
    // A throw or a timeout after the call may have reached the platform: unknown, never a failure.
    const code = error instanceof Timeout ? 'TIMEOUT' : 'ADAPTER_ERROR';
    console.warn(`[social-publish] ${publisher.provider} ${work.action} for variant ${work.variantId.slice(0, 8)}: ${code}`);
    return work.action === 'reconcile' ? { kind: 'unknowable', code } : { kind: 'unknown', code };
  }
}

export interface PublishOutcome {
  action: BeginResult['action'];
  reason?: string;
  status?: string;
}

/** One run of the publish job for a variant. Returns what it did, for the log. */
// provider: the variant's provider, as the sweep read it (a variant's provider never changes); begin re-reads the
// variant itself.
export async function runPublishJob(deps: PublishDeps, orgId: string, variantId: string, provider: string): Promise<PublishOutcome> {
  const publisher = deps.publishers[provider];
  if (!publisher) return { action: 'none', reason: 'provider_not_configured' };
  const begunAt = Date.now();
  const begun = await deps.runtime.execute<BeginResult>(
    'social.publish.begin',
    { variantId, provider, safety: publisher.publishSafety, staleSeconds: deps.staleSeconds ?? PUBLISH_STALE_SECONDS },
    { actor: ACTOR, orgId },
  );
  if (begun.action === 'none') return { action: 'none', reason: begun.reason };
  const credential = await openCredential(deps, orgId, begun.connectionId);
  // A run that stalled after begin (a paused VM, a long GC) for half the stale time may already have been taken over
  // by another run's reconcile: it does not call, and records the outcome as unknown.
  const late = Date.now() - begunAt > ((deps.staleSeconds ?? PUBLISH_STALE_SECONDS) * 1000) / 2;
  const result: PublishRecord =
    begun.action === 'call' && late
      ? { kind: 'unknown', code: 'LATE_START' }
      : 'blocked' in credential
      ? begun.action === 'call'
        ? { kind: 'blocked', code: credential.blocked }
        : begun.action === 'status'
          ? { kind: 'unknown', code: credential.blocked }
          : { kind: 'unknowable', code: credential.blocked }
      : await provide(deps, orgId, publisher, begun, credential);
  const recorded = await deps.runtime.execute<{ recorded: boolean; status?: string; reason?: string }>(
    'social.publish.record',
    { variantId, callKey: begun.callKey, phase: begun.action, result, connectionVersion: begun.connectionVersion },
    { actor: ACTOR, orgId },
  );
  // Published now: its first comment, if it has one (#587). A failure there never touches the post. A draft sent to
  // the platform's app (#903) or kept on the site (#981) is not out yet and has no post to comment on.
  if ((result.kind === 'accepted' && !result.sentToApp && !result.draft) || (result.kind === 'found' && !result.draft)) {
    await runCommentJob(deps, orgId, variantId, provider).catch((error: unknown) => console.error(`[social-comment] variant ${variantId.slice(0, 8)}`, (error as Error).message));
    // And its thread (#742), part after part.
    await runThreadJob(deps, orgId, variantId, provider).catch((error: unknown) => console.error(`[social-thread] variant ${variantId.slice(0, 8)}`, (error as Error).message));
    // And its pin (#982), after the rest so it pins the post itself. A refused pin never touches the post either.
    await runPinJob(deps, orgId, variantId, provider).catch((error: unknown) => console.error(`[social-pin] variant ${variantId.slice(0, 8)}`, (error as Error).message));
  }
  return { action: begun.action, status: recorded.status ?? recorded.reason ?? 'not_recorded' };
}

/** The first comment of a published variant (#587): begin, one call, record. retry: a person asked again, after the call they saw last. */
export async function runCommentJob(deps: PublishDeps, orgId: string, variantId: string, provider: string, retry?: { after: string | null }): Promise<{ action: string; reason?: string; state?: string }> {
  const publisher = deps.publishers[provider];
  if (!publisher?.comment) return { action: 'none', reason: 'provider_not_configured' };
  const begun = await deps.runtime.execute<CommentWork>('social.comment.begin', { variantId, provider, ...(retry ? { retry } : {}) }, { actor: ACTOR, orgId });
  if (begun.action === 'none') return { action: 'none', reason: begun.reason };
  const credential = await openCredential(deps, orgId, begun.connectionId);
  let result: Awaited<ReturnType<NonNullable<Publisher['comment']>>> | { kind: 'blocked'; code: string };
  if ('blocked' in credential) result = { kind: 'blocked', code: credential.blocked };
  else {
    const timeout = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      result = await withTimeout(timeout, () => publisher.comment!({ ...credential, externalId: begun.externalId, text: begun.text, callKey: begun.callKey }));
    } catch (error) {
      result = { kind: 'unknown', code: error instanceof Timeout ? 'TIMEOUT' : 'ADAPTER_ERROR' };
    }
  }
  const recorded = await deps.runtime.execute<{ recorded: boolean; state?: string }>('social.comment.record', { variantId, callKey: begun.callKey, result }, { actor: ACTOR, orgId });
  return { action: 'call', ...(recorded.state ? { state: recorded.state } : {}) };
}

/** The pin of a published variant (#982): begin, one call, record, once per publish. */
export async function runPinJob(deps: PublishDeps, orgId: string, variantId: string, provider: string): Promise<{ action: string; reason?: string; state?: string }> {
  const publisher = deps.publishers[provider];
  if (!publisher?.pin) return { action: 'none', reason: 'provider_not_configured' };
  const begun = await deps.runtime.execute<PinWork>('social.pin.begin', { variantId, provider }, { actor: ACTOR, orgId });
  if (begun.action === 'none') return { action: 'none', reason: begun.reason };
  const credential = await openCredential(deps, orgId, begun.connectionId);
  let result: Awaited<ReturnType<NonNullable<Publisher['pin']>>> | { kind: 'blocked'; code: string };
  if ('blocked' in credential) result = { kind: 'blocked', code: credential.blocked };
  else {
    const timeout = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      const r = await withTimeout(timeout, () => publisher.pin!({ ...credential, externalId: begun.externalId, silent: begun.silent, callKey: begun.callKey }));
      // What the record takes: an adapter's long code or message is cut, so the answer is always recorded.
      result = r.kind === 'accepted' ? { kind: 'accepted', externalId: r.externalId.slice(0, 500) } : { ...r, ...(r.code !== undefined ? { code: r.code.slice(0, 200) } : {}), ...(r.message !== undefined ? { message: r.message.slice(0, 2000) } : {}) };
    } catch (error) {
      result = { kind: 'unknown', code: error instanceof Timeout ? 'TIMEOUT' : 'ADAPTER_ERROR' };
    }
  }
  const recorded = await deps.runtime.execute<{ recorded: boolean; state?: string }>('social.pin.record', { variantId, callKey: begun.callKey, result }, { actor: ACTOR, orgId });
  return { action: 'call', ...(recorded.state ? { state: recorded.state } : {}) };
}

/** The removal of a published variant a person asked for (#860): begin, one call, record. after: the last remove call the ask saw. */
export async function runRemoveJob(deps: PublishDeps, orgId: string, variantId: string, provider: string, after: string | null): Promise<{ action: string; reason?: string; state?: string }> {
  const publisher = deps.publishers[provider];
  if (!publisher?.remove) return { action: 'none', reason: 'provider_not_configured' };
  const begun = await deps.runtime.execute<RemoveWork>('social.remove.begin', { variantId, provider, after }, { actor: ACTOR, orgId });
  if (begun.action === 'none') return { action: 'none', reason: begun.reason };
  const credential = await openCredential(deps, orgId, begun.connectionId);
  let result: RemoveRecord;
  if ('blocked' in credential) result = { kind: 'blocked', code: credential.blocked };
  else {
    const timeout = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      const r = await withTimeout(timeout, () => publisher.remove!({ ...credential, externalId: begun.externalId, settings: begun.settings }));
      // What the record takes: codes and messages cut to their columns; a retry time is not kept (a person asks again).
      result =
        r.kind === 'removed'
          ? r
          : r.kind === 'unknown'
            ? { kind: 'unknown', ...(r.code !== undefined ? { code: r.code.slice(0, 200) } : {}) }
            : { kind: 'rejected', error: r.error, ...(r.code !== undefined ? { code: r.code.slice(0, 200) } : {}), ...(r.message !== undefined ? { message: r.message.slice(0, 2000) } : {}) };
    } catch (error) {
      // A throw or a timeout after the call may have reached the platform.
      result = { kind: 'unknown', code: error instanceof Timeout ? 'TIMEOUT' : 'ADAPTER_ERROR' };
    }
  }
  const recorded = await deps.runtime.execute<{ recorded: boolean; state?: string }>('social.remove.record', { variantId, callKey: begun.callKey, result }, { actor: ACTOR, orgId });
  return { action: 'call', ...(recorded.state ? { state: recorded.state } : {}) };
}

/**
 * The thread parts of a published variant (#742): begin, one call, record, for each part in turn, as replies to the
 * part before. It stops at the first part that does not go out. retry: a person asked again, after the call they saw
 * last.
 */
export async function runThreadJob(deps: PublishDeps, orgId: string, variantId: string, provider: string, retry?: { after: string | null }): Promise<{ action: string; reason?: string; state?: string; parts: number }> {
  const publisher = deps.publishers[provider];
  if (!publisher?.comment) return { action: 'none', reason: 'provider_not_configured', parts: 0 };
  let credential: Awaited<ReturnType<typeof openCredential>> | null = null;
  let parts = 0;
  for (let i = 0; i < THREAD_PARTS_MAX; i += 1) {
    const begun = await deps.runtime.execute<ThreadWork>('social.thread.begin', { variantId, provider, ...(retry && i === 0 ? { retry } : {}) }, { actor: ACTOR, orgId });
    // Nothing more to post: the chain is out, or waits on a person. state: the last part this job posted.
    if (begun.action === 'none') return parts > 0 ? { action: 'call', state: 'succeeded', reason: begun.reason, parts } : { action: 'none', reason: begun.reason, parts };
    credential ??= await openCredential(deps, orgId, begun.connectionId);
    let result: Awaited<ReturnType<NonNullable<Publisher['comment']>>> | { kind: 'blocked'; code: string };
    if ('blocked' in credential) result = { kind: 'blocked', code: credential.blocked };
    else {
      const open = credential;
      const timeout = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      try {
        result = await withTimeout(timeout, () => publisher.comment!({ ...open, externalId: begun.externalId, rootExternalId: begun.rootExternalId, text: begun.text, callKey: begun.callKey }));
      } catch (error) {
        result = { kind: 'unknown', code: error instanceof Timeout ? 'TIMEOUT' : 'ADAPTER_ERROR' };
      }
    }
    const recorded = await deps.runtime.execute<{ recorded: boolean; state?: string }>('social.thread.record', { variantId, callKey: begun.callKey, result }, { actor: ACTOR, orgId });
    parts += 1;
    if (recorded.state !== 'succeeded') return { action: 'call', ...(recorded.state ? { state: recorded.state } : {}), parts };
  }
  return { action: 'call', state: 'succeeded', parts };
}
