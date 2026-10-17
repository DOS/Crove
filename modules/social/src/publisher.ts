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
import type { Publisher, PublishResult, ReconcileResult } from '@crove/channel';
import { DomainError, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { PUBLISH_STALE_SECONDS, type BeginResult, type PublishRecord, type PublishWork } from './publishing.ts';

export interface PublishDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The providers this deployment can publish to, by provider id.
  publishers: Readonly<Record<string, Publisher>>;
  // How long one provider call may take before its outcome counts as unknown.
  callTimeoutMs?: number;
  staleSeconds?: number;
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

async function withTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Timeout('provider call timed out')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// Provider answers become record inputs. Messages and codes are clipped to what the columns hold.
const clip = (s: string | undefined, max: number) => (s === undefined ? undefined : s.slice(0, max));

function fromPublish(r: PublishResult): PublishRecord {
  switch (r.kind) {
    case 'accepted':
      return { kind: 'accepted', externalId: r.externalId.slice(0, 500), url: r.url };
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
  if (r.found === true) return { kind: 'found', externalId: r.externalId.slice(0, 500), url: r.url };
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

async function provide(deps: PublishDeps, publisher: Publisher, work: PublishWork, credential: { externalAccountId: string; secret: string }): Promise<PublishRecord> {
  const timeout = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  try {
    switch (work.action) {
      case 'call':
        return fromPublish(
          await withTimeout(timeout, () =>
            publisher.publish({ ...credential, content: work.content, settings: work.settings, callKey: work.callKey, contentHash: work.contentHash }),
          ),
        );
      case 'status':
        if (!publisher.status || !work.externalRef) return { kind: 'unknown', code: 'STATUS_UNAVAILABLE' };
        return fromPublish(await withTimeout(timeout, () => publisher.status!({ ...credential, externalRef: work.externalRef as string })));
      case 'reconcile': {
        if (!publisher.reconcile) return { kind: 'unknowable', code: 'RECONCILE_UNAVAILABLE' };
        // The post would have appeared between a minute before the first call and now.
        const after = new Date(Date.parse(work.callStartedAt) - 60_000);
        return fromReconcile(
          await withTimeout(timeout, () =>
            publisher.reconcile!({ ...credential, callKey: work.callKey, contentHash: work.contentHash, content: work.content, after, before: new Date() }),
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
  const begun = await deps.runtime.execute<BeginResult>(
    'social.publish.begin',
    { variantId, provider, safety: publisher.publishSafety, staleSeconds: deps.staleSeconds ?? PUBLISH_STALE_SECONDS },
    { actor: ACTOR, orgId },
  );
  if (begun.action === 'none') return { action: 'none', reason: begun.reason };
  const credential = await openCredential(deps, orgId, begun.connectionId);
  const result: PublishRecord =
    'blocked' in credential
      ? begun.action === 'call'
        ? { kind: 'blocked', code: credential.blocked }
        : begun.action === 'status'
          ? { kind: 'unknown', code: credential.blocked }
          : { kind: 'unknowable', code: credential.blocked }
      : await provide(deps, publisher, begun, credential);
  const recorded = await deps.runtime.execute<{ recorded: boolean; status?: string; reason?: string }>(
    'social.publish.record',
    { variantId, callKey: begun.callKey, phase: begun.action, result },
    { actor: ACTOR, orgId },
  );
  return { action: begun.action, status: recorded.status ?? recorded.reason ?? 'not_recorded' };
}
