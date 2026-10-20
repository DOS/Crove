// Publishing a variant exactly once (Social plan §3.4, step S4, issue #234). The publish job (publisher.ts) runs two
// system commands around the one visible provider call:
// - social.publish.begin re-reads the variant under its post's lock and decides what the job may do: make the call
//   (the external_call row is written as 'started' and committed first), check a pending post's status, reconcile an
//   unknown outcome, resume a paused variant, or nothing. A call already started under the variant's current key is
//   made again only when the adapter declares the step safe or idempotent; otherwise the outcome is reconciled or
//   handed to a human.
// - social.publish.record stores what the provider answered, for the key the job was given; an answer for a key that
//   is no longer the variant's (an edit, a cancel, a new attempt) changes nothing.
// People decide what the job cannot: social.variant.retry publishes a failed or needs_attention variant again (a new
// attempt with fresh keys), social.variant.resolve records that a needs_attention post is on the platform after all,
// or drops it.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole, SocialVariantStatus } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { approvalCovers, effectiveContent, type BaseContent } from './domain/approval.ts';
import { shortOfPolicy } from './policy.ts';
import { isProvider } from './domain/channels.ts';
import { sentLink } from './domain/utm.ts';
import { nextAction, publishCallKey, type RetrySafety } from './domain/publish.ts';
import { startsNewAttempt, type VariantEvent } from './domain/state.ts';
import {
  base,
  freezeValues,
  latestDecision,
  lockPost,
  lockVariants,
  mediaFor,
  overrides,
  pick,
  refreshPostStatus,
  regateValues,
  setVariant,
  settingsOf,
  step,
  variantPost,
  type PostRow,
  type VariantRow,
} from './variants.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const PUBLISH_STEP = 'publish';
// A variant still 'publishing' this long after its call started belongs to a worker that died (the job's own
// timeout is far shorter).
export const PUBLISH_STALE_SECONDS = 600;
// Automatic new attempts after a rate limit or a transient failure; then the variant fails and waits for a person.
export const MAX_AUTO_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
// A pending post whose status check cannot be answered is checked again after this long.
const STATUS_RECHECK_MS = 60_000;
// An ambiguous variant waits this long before its reconcile asks the platform (crove_social.publish_due waits as long),
// so the platform has had time to show a post that went through.
export const RECONCILE_WAIT_MS = 60_000;
// A post still processing on the platform this long after its call is reconciled: found, or a person decides.
const MAX_PROCESSING_MS = 24 * 3_600_000;

const zSafety = z.enum(['safe', 'idempotent', 'reconcile_only', 'never']);
const zVariantIds = z.array(zId).min(1).max(20);
const NO_ERROR = { error_kind: null, error_code: null, error_http_status: null, error_message: null, error_action: null, error_retry_at: null };

export type PublishPhase = 'call' | 'status' | 'reconcile';

export interface PublishWork {
  action: PublishPhase;
  variantId: string;
  postId: string;
  provider: string;
  connectionId: string;
  callKey: string;
  contentHash: string;
  // Text and images; the images by file, which the job reads from storage for the provider.
  content: BaseContent & { media: { fileId: string; mime: string; sizeBytes: number; altText: string | null; durationSeconds: number | null }[] };
  settings: Record<string, unknown>;
  // The pending post's platform id, for a status check.
  externalRef: string | null;
  // When the call under callKey was first made, for the reconcile's time window.
  callStartedAt: string;
  // The connection's updated_at as begin saw it: an expired token marks the connection only if it has not changed
  // since (a reconnect in between brought a new token).
  connectionVersion: string | null;
}

export type BeginResult = { action: 'none'; reason: string } | PublishWork;

function requireSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình đăng bài mới thực hiện được việc này');
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// Moves a variant by an event, in the database and in memory; an event that starts a new attempt bumps it.
async function move(ctx: CommandContext, v: VariantRow, event: VariantEvent, values: Record<string, unknown> = {}): Promise<void> {
  const status = step(v, event);
  const attempt = startsNewAttempt(event) ? v.attempt + 1 : v.attempt;
  await setVariant(ctx, v.id, { ...values, status, attempt });
  v.status = status;
  v.attempt = attempt;
  v.updated_at = ctx.now;
}

interface CallRow {
  state: 'started' | 'succeeded' | 'failed' | 'ambiguous';
  calls: number;
  started_at: Date;
}

async function callRow(ctx: CommandContext, key: string): Promise<CallRow | undefined> {
  return ctx.trx
    .selectFrom('crove_kernel.external_call')
    .select(['state', 'calls', 'started_at'])
    .where('org_id', '=', ctx.orgId)
    .where('key', '=', key)
    .forUpdate()
    .executeTakeFirst();
}

// Updates a call that has no outcome yet. A call with its outcome is history (the guard trigger refuses any change), so
// a later answer for the same key (a reconcile after a pending submission went through) leaves it as it is.
async function setCall(ctx: CommandContext, key: string, values: Record<string, unknown>): Promise<void> {
  await ctx.trx
    .updateTable('crove_kernel.external_call')
    .set({ ...values, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('key', '=', key)
    .where('state', 'in', ['started', 'ambiguous'])
    .execute();
}

// Records the call as made (again): a new row, or one more call on the row of a safe or idempotent step.
async function startCall(ctx: CommandContext, v: VariantRow, key: string, safety: RetrySafety, existing: CallRow | undefined): Promise<Date> {
  if (existing) {
    await setCall(ctx, key, { state: 'started', calls: existing.calls + 1 });
    return existing.started_at;
  }
  await ctx.trx
    .insertInto('crove_kernel.external_call')
    .values({ org_id: ctx.orgId, key, module: 'social', target: v.provider, step: PUBLISH_STEP, retry_safety: safety, request_hash: v.content_hash, started_at: ctx.now })
    .execute();
  return ctx.now;
}

function work(action: PublishPhase, post: PostRow, v: VariantRow, key: string, startedAt: Date, connection: ConnectionState | null): PublishWork {
  return {
    action,
    variantId: v.id,
    postId: post.id,
    provider: v.provider,
    connectionId: v.channel_connection_id,
    callKey: key,
    contentHash: v.content_hash,
    content: {
      ...withSentLink(v, effectiveContent(base(post), overrides(v), v.content_frozen)),
      media: mediaFor(base(post), v).map((m) => ({ fileId: m.fileId, mime: m.mime, sizeBytes: m.sizeBytes, altText: m.altText, durationSeconds: m.durationMs == null ? null : m.durationMs / 1000, width: m.width ?? null, height: m.height ?? null })),
    },
    settings: settingsOf(v),
    externalRef: v.external_post_id,
    callStartedAt: startedAt.toISOString(),
    connectionVersion: connection ? connection.updatedAt.toISOString() : null,
  };
}

const none = (reason: string): BeginResult => ({ action: 'none', reason });

// The link as the channel sends it, with its UTM tags (#585).
const withSentLink = (v: VariantRow, content: BaseContent): BaseContent => ({ ...content, linkUrl: isProvider(v.provider) ? sentLink(v.provider, content.linkUrl, settingsOf(v), content.body) : content.linkUrl });

async function lockVariant(ctx: CommandContext, variantId: string): Promise<{ post: PostRow; v: VariantRow } | null> {
  const found = await ctx.trx.selectFrom('crove_social.post_variant').select('post_id').where('org_id', '=', ctx.orgId).where('id', '=', variantId).executeTakeFirst();
  if (!found) return null;
  const post = await lockPost(ctx.trx, ctx.orgId, found.post_id);
  const v = (await lockVariants(ctx.trx, ctx.orgId, post.id)).find((x) => x.id === variantId);
  return v ? { post, v } : null;
}

// A call already started under this key, by a worker that is gone: make it again only when that is safe, else ask
// the provider (reconcile) or a person.
async function resume(
  ctx: CommandContext,
  post: PostRow,
  v: VariantRow,
  key: string,
  safety: RetrySafety,
  existing: CallRow | undefined,
  connection: ConnectionState | null,
): Promise<BeginResult> {
  // A call with its outcome on a variant still publishing: the two are written together, so this is not expected;
  // a person looks.
  if (existing?.state === 'succeeded' || existing?.state === 'failed') return needsHuman(ctx, post, v);
  const action = nextAction(existing ? existing.state : 'none', safety);
  if (action === 'call') return work('call', post, v, key, await startCall(ctx, v, key, safety, existing), connection);
  if (existing?.state === 'started') await setCall(ctx, key, { state: 'ambiguous' });
  if (action === 'reconcile') {
    await move(ctx, v, { type: 'unknown' }, { error_kind: 'unknown', error_code: 'OUTCOME_UNKNOWN' });
    return work('reconcile', post, v, key, existing?.started_at ?? ctx.now, connection);
  }
  return needsHuman(ctx, post, v);
}

async function needsHuman(ctx: CommandContext, post: PostRow, v: VariantRow): Promise<BeginResult> {
  await move(ctx, v, { type: 'needs_human' }, { error_kind: 'unknown', error_code: 'OUTCOME_UNKNOWN' });
  await ctx.emit('social.variant.needs_attention', { post_id: post.id, variant_id: v.id });
  return none('needs_attention');
}

interface ConnectionState {
  status: string;
  updatedAt: Date;
}

// The variant's connection, read under a share lock (after the post and its variants), so a reconnect or a disconnect
// in progress commits first and is seen.
// lock 'update' where the same transaction may go on to update the connection (mark_expired): a share lock upgraded
// later would deadlock two jobs of one channel.
async function connectionOf(ctx: CommandContext, connectionId: string, lock: 'share' | 'update' = 'share'): Promise<ConnectionState | null> {
  const q = ctx.trx.selectFrom('crove_kernel.channel_connection').select(['status', 'updated_at']).where('org_id', '=', ctx.orgId).where('id', '=', connectionId);
  const row = await (lock === 'update' ? q.forUpdate() : q.forShare()).executeTakeFirst();
  return row ? { status: row.status, updatedAt: row.updated_at } : null;
}

// Pauses a variant on its channel and stamps the connection's version as stored now (in SQL, never through a
// clock), so it resumes once the connection is active and has changed since.
async function pauseOnChannel(ctx: CommandContext, v: VariantRow, values: Record<string, unknown>): Promise<void> {
  await move(ctx, v, { type: 'pause' }, values);
  await sql`
    UPDATE crove_social.post_variant SET paused_connection_version = (
      SELECT c.updated_at FROM crove_kernel.channel_connection c WHERE c.org_id = ${ctx.orgId}::uuid AND c.id = ${v.channel_connection_id}::uuid)
    WHERE org_id = ${ctx.orgId}::uuid AND id = ${v.id}::uuid`.execute(ctx.trx);
}

// Whether the connection changed since begin read it at `version` (a reconnect in between).
async function channelChanged(ctx: CommandContext, connectionId: string, version: string | null | undefined): Promise<boolean> {
  if (!version) return false;
  const connection = await connectionOf(ctx, connectionId, 'update');
  return connection !== null && connection.updatedAt.getTime() !== Date.parse(version);
}

// A variant waiting in a queue that was paused after the sweep read it waits on.
async function queuePaused(ctx: CommandContext, v: VariantRow): Promise<boolean> {
  if (v.error_retry_at || v.scheduled_at || !v.queue_slot_at) return false;
  const q = await ctx.trx
    .selectFrom('crove_social.queue')
    .select('paused')
    .where('org_id', '=', ctx.orgId)
    .where('channel_connection_id', '=', v.channel_connection_id)
    .executeTakeFirst();
  return q?.paused === true;
}

export const publishBegin = defineCommand({
  name: 'social.publish.begin',
  input: z.strictObject({ variantId: zId, provider: z.string().min(1).max(32), safety: zSafety, staleSeconds: z.number().int().min(60).max(86_400).optional() }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input): Promise<BeginResult> => {
    requireSystem(ctx);
    const locked = await lockVariant(ctx, input.variantId);
    if (!locked) return none('not_found');
    const { post, v } = locked;
    // The safety declared is the adapter's for this provider; another provider's would not apply.
    if (v.provider !== input.provider) return none('provider_mismatch');
    const now = ctx.now.getTime();
    const key = publishCallKey(v.id, v.revision, v.attempt, PUBLISH_STEP);
    let result: BeginResult;
    switch (v.status) {
      case 'scheduled': {
        const due = v.error_retry_at ?? v.scheduled_at ?? v.queue_slot_at;
        if (!due || due.getTime() > now) return none('not_due');
        const decision = await latestDecision(ctx.trx, ctx.orgId, v.id);
        if (decision?.decision !== 'approved' || !approvalCovers({ revision: decision.revision, contentHash: decision.content_hash }, { revision: v.revision, contentHash: v.content_hash })) {
          // Cannot happen through the commands (an edit sends a variant back to draft); never publish it if it does.
          await move(ctx, v, { type: 'edit' }, { error_kind: null, error_code: 'APPROVAL_MISMATCH' });
          result = none('approval');
          break;
        }
        if (await shortOfPolicy(ctx.trx, ctx.orgId, v)) {
          // Its channel now asks for more approvals than it has (set_policy re-checks too; a retry or a resume can
          // bring one back to scheduled): back to review, never published short.
          await move(ctx, v, { type: 'regate' }, regateValues(v));
          await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: [v.id], by_policy: true });
          result = none('approval');
          break;
        }
        if (await queuePaused(ctx, v)) return none('queue_paused');
        const connection = await connectionOf(ctx, v.channel_connection_id);
        if (connection?.status !== 'active') {
          // A disconnected channel never comes back (connecting the account again makes a new connection); an expired
          // one does, and the variant then resumes.
          const code = connection?.status === 'revoked' || !connection ? 'CHANNEL_REVOKED' : 'CHANNEL_NOT_ACTIVE';
          await pauseOnChannel(ctx, v, { ...NO_ERROR, error_kind: 'token_expired', error_code: code });
          await ctx.emit('social.variant.paused', { post_id: post.id, variant_id: v.id, reason: code });
          result = none('paused');
          break;
        }
        let callKey = key;
        let existing = await callRow(ctx, callKey);
        if (existing?.state === 'failed') {
          // This attempt's call was refused before anything was posted, and the variant was scheduled again since
          // (unscheduled while paused, then scheduled): a new attempt with a fresh key.
          v.attempt += 1;
          callKey = publishCallKey(v.id, v.revision, v.attempt, PUBLISH_STEP);
          existing = await callRow(ctx, callKey);
        }
        await move(ctx, v, { type: 'start' });
        result = existing
          ? await resume(ctx, post, v, callKey, input.safety, existing, connection)
          : work('call', post, v, callKey, await startCall(ctx, v, callKey, input.safety, undefined), connection);
        break;
      }
      case 'publishing': {
        if (now - v.updated_at.getTime() < (input.staleSeconds ?? PUBLISH_STALE_SECONDS) * 1000) return none('in_flight');
        const existing = await callRow(ctx, key);
        result = await resume(ctx, post, v, key, input.safety, existing, await connectionOf(ctx, v.channel_connection_id));
        if (result.action === 'call') await setVariant(ctx, v.id, {});
        break;
      }
      case 'processing': {
        if (!v.next_check_at || v.next_check_at.getTime() > now) return none('not_due');
        const existing = await callRow(ctx, key);
        const startedAt = existing?.started_at ?? v.updated_at;
        const connection = await connectionOf(ctx, v.channel_connection_id);
        if (now - startedAt.getTime() < MAX_PROCESSING_MS) return work('status', post, v, key, startedAt, connection);
        // Processing for a day: ask whether it is on the platform; if not, a person decides.
        await move(ctx, v, { type: 'unknown' }, { error_kind: 'unknown', error_code: 'PROCESSING_TOO_LONG', next_check_at: null });
        result = work('reconcile', post, v, key, startedAt, connection);
        break;
      }
      case 'ambiguous': {
        // The platform needs a moment to show a post that went through; a reconcile right after the unknown answer
        // could miss it and send a person to publish it again.
        if (now - v.updated_at.getTime() < RECONCILE_WAIT_MS) return none('reconcile_wait');
        const existing = await callRow(ctx, key);
        return work('reconcile', post, v, key, existing?.started_at ?? v.updated_at, await connectionOf(ctx, v.channel_connection_id));
      }
      case 'paused': {
        // Paused on its channel: once the channel is active and has changed since the pause (reconnected), a new
        // attempt goes out. Compared as stored values, so no clock decides it.
        const connection = await connectionOf(ctx, v.channel_connection_id);
        const { rows } = await sql<{ version: Date | null }>`
          SELECT paused_connection_version AS version FROM crove_social.post_variant WHERE org_id = ${ctx.orgId}::uuid AND id = ${v.id}::uuid`.execute(ctx.trx);
        const pausedAt = rows[0]?.version ?? null;
        if (connection?.status !== 'active' || (pausedAt !== null && pausedAt.getTime() === connection.updatedAt.getTime())) return none('paused');
        await move(ctx, v, { type: 'resume' }, { ...NO_ERROR, paused_connection_version: null });
        result = none('resumed');
        break;
      }
      default:
        return none(v.status);
    }
    await refreshPostStatus(ctx, post.id);
    return result;
  },
});

const zText = (max: number) => z.string().max(max);
const zResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(500), url: z.url({ protocol: /^https?$/ }).max(2000).nullable() }),
  z.strictObject({ kind: z.literal('pending'), externalRef: z.string().min(1).max(500), checkAfterSeconds: z.number().int().min(5).max(86_400) }),
  z.strictObject({
    kind: z.literal('rejected'),
    error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']),
    code: zText(200).optional(),
    message: zText(2000).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    retryAt: z.iso.datetime({ offset: true }).optional(),
  }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional(), message: zText(2000).optional() }),
  // Reconcile answers: the post is on the platform, it is not, or the provider cannot tell.
  z.strictObject({ kind: z.literal('found'), externalId: z.string().min(1).max(500), url: z.url({ protocol: /^https?$/ }).max(2000).nullable() }),
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({ kind: z.literal('unknowable'), code: zText(200).optional() }),
  // Nothing was called: the channel's credential could not be used (disconnected, its connector left the org, no
  // credential key configured).
  z.strictObject({ kind: z.literal('blocked'), code: zText(200) }),
]);
export type PublishRecord = z.infer<typeof zResult>;

const EXPECTED: Record<PublishPhase, SocialVariantStatus> = { call: 'publishing', status: 'processing', reconcile: 'ambiguous' };

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.max(0, attempt - 1));
}

export const publishRecord = defineCommand({
  name: 'social.publish.record',
  input: z.strictObject({
    variantId: zId,
    callKey: z.string().min(1).max(500),
    phase: z.enum(['call', 'status', 'reconcile']),
    result: zResult,
    connectionVersion: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const locked = await lockVariant(ctx, input.variantId);
    if (!locked) return { recorded: false as const, reason: 'not_found' };
    const { post, v } = locked;
    const key = publishCallKey(v.id, v.revision, v.attempt, PUBLISH_STEP);
    if (key !== input.callKey || v.status !== EXPECTED[input.phase]) return { recorded: false as const, reason: 'stale' };
    const r = input.result;
    const done = { finished_at: ctx.now };
    // A published channel keeps the content it went out with (#335): copied into its own columns now, so a later edit
    // of the post's shared text, by any path, never changes what this channel is recorded as having published.
    const published = (externalId: string, url: string | null) => ({ ...NO_ERROR, external_post_id: externalId, external_url: url, published_at: ctx.now, next_check_at: null, ...freezeValues(post, v) });
    const failure = (kind: string | null, code: string | null, message: string | null, http: number | null) => ({
      ...NO_ERROR,
      error_kind: kind,
      error_code: code,
      error_message: message,
      error_http_status: http,
    });
    let event: string | null = null;
    // Marks the channel expired, unless it changed since begin read it (a reconnect brought a new token meanwhile).
    const expire = (code: string | undefined) =>
      ctx.run('kernel.channel.mark_expired', {
        connectionId: v.channel_connection_id,
        reason: code ?? 'token_expired',
        ...(input.connectionVersion ? { ifVersion: input.connectionVersion } : {}),
      });
    switch (r.kind) {
      case 'accepted':
      case 'found': {
        await move(ctx, v, input.phase === 'reconcile' ? { type: 'reconciled', found: true } : { type: 'accepted' }, published(r.externalId, r.url));
        if (input.phase !== 'status') await setCall(ctx, key, { state: 'succeeded', external_ref: r.externalId, error_kind: null, error_code: null, ...done });
        event = 'social.variant.published';
        break;
      }
      case 'pending': {
        if (input.phase === 'reconcile') return { recorded: false as const, reason: 'invalid' };
        const values = { ...NO_ERROR, external_post_id: r.externalRef, next_check_at: new Date(ctx.now.getTime() + r.checkAfterSeconds * 1000) };
        if (input.phase === 'call') {
          await move(ctx, v, { type: 'pending' }, values);
          await setCall(ctx, key, { state: 'succeeded', external_ref: r.externalRef, ...done });
        } else {
          await setVariant(ctx, v.id, values);
        }
        break;
      }
      case 'rejected': {
        if (input.phase === 'reconcile') return { recorded: false as const, reason: 'invalid' };
        const values = failure(r.error, r.code ?? null, r.message ?? null, r.httpStatus ?? null);
        if (input.phase === 'call') await setCall(ctx, key, { state: 'failed', error_kind: r.error, error_code: r.code ?? null, ...done });
        if (r.error === 'bad_request' || r.error === 'permission') {
          await move(ctx, v, { type: 'failed' }, values);
          event = 'social.variant.failed';
        } else if (input.phase === 'status') {
          // The post went through; only its status check failed. Check again later.
          await setVariant(ctx, v.id, { ...values, next_check_at: new Date(ctx.now.getTime() + (r.error === 'token_expired' ? 60 : 1) * STATUS_RECHECK_MS) });
          if (r.error === 'token_expired') await expire(r.code);
        } else if (r.error === 'token_expired' && (await channelChanged(ctx, v.channel_connection_id, input.connectionVersion))) {
          // The refused token was the one before a reconnect: nothing was posted, and the new token goes out now.
          await move(ctx, v, { type: 'rate_limited' }, { ...values, error_retry_at: ctx.now });
        } else if (r.error === 'token_expired') {
          // Nothing was posted. The channel needs reconnecting; this and every other variant of it waits paused.
          await expire(r.code);
          await pauseOnChannel(ctx, v, values);
          event = 'social.variant.paused';
        } else if (v.attempt >= MAX_AUTO_ATTEMPTS) {
          await move(ctx, v, { type: 'failed' }, { ...values, error_code: r.code ?? 'TOO_MANY_ATTEMPTS' });
          event = 'social.variant.failed';
        } else {
          // Rate limited, or a failure the adapter knows posted nothing: a new attempt at the provider's retry time.
          const at = r.retryAt ? new Date(Date.parse(r.retryAt)) : new Date(ctx.now.getTime() + retryDelay(v.attempt));
          await move(ctx, v, { type: 'rate_limited' }, { ...values, error_retry_at: at });
        }
        break;
      }
      case 'unknown': {
        if (input.phase === 'reconcile') return { recorded: false as const, reason: 'invalid' };
        if (input.phase === 'status') {
          await setVariant(ctx, v.id, { next_check_at: new Date(ctx.now.getTime() + STATUS_RECHECK_MS) });
          break;
        }
        await setCall(ctx, key, { state: 'ambiguous', error_kind: 'unknown', error_code: r.code ?? null });
        await move(ctx, v, { type: 'unknown' }, failure('unknown', r.code ?? 'OUTCOME_UNKNOWN', r.message ?? null, null));
        break;
      }
      case 'missing':
      case 'unknowable': {
        if (input.phase !== 'reconcile') return { recorded: false as const, reason: 'invalid' };
        await move(ctx, v, { type: 'reconciled', found: false }, failure('unknown', r.kind === 'missing' ? 'NOT_FOUND_ON_PLATFORM' : (r.code ?? 'RECONCILE_UNAVAILABLE'), null, null));
        event = 'social.variant.needs_attention';
        break;
      }
      case 'blocked': {
        if (input.phase !== 'call') return { recorded: false as const, reason: 'invalid' };
        await setCall(ctx, key, { state: 'failed', error_code: r.code, ...done });
        await pauseOnChannel(ctx, v, failure(r.code === 'CHANNEL_NOT_ACTIVE' ? 'token_expired' : 'permission', r.code, null, null));
        event = 'social.variant.paused';
        break;
      }
    }
    await refreshPostStatus(ctx, post.id);
    if (event) await ctx.emit(event, { post_id: post.id, variant_id: v.id });
    return { recorded: true as const, status: v.status };
  },
});

// Publishes failed or needs_attention variants again, now: a new attempt with fresh call keys. On needs_attention the
// person has checked the platform; the earlier attempt's outcome stays in the ledger.
export const variantRetry = defineCommand({
  name: 'social.variant.retry',
  input: z.strictObject({ variantIds: zVariantIds }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const postId = await variantPost(ctx.trx, ctx.orgId, input.variantIds);
    await lockPost(ctx.trx, ctx.orgId, postId);
    const chosen = pick(await lockVariants(ctx.trx, ctx.orgId, postId), input.variantIds);
    for (const v of chosen) {
      // Refused first for a variant that is not failed or waiting on a person.
      step(v, { type: 'retry' });
      const decision = await latestDecision(ctx.trx, ctx.orgId, v.id);
      if (decision?.decision !== 'approved' || !approvalCovers({ revision: decision.revision, contentHash: decision.content_hash }, { revision: v.revision, contentHash: v.content_hash })) {
        throw new DomainError('APPROVAL_REQUIRED', 409, 'Kênh này chưa được duyệt đúng nội dung hiện tại', { variantId: v.id });
      }
      // Approved under a bar its channel has raised since (#408), as social.variant.schedule refuses.
      if (await shortOfPolicy(ctx.trx, ctx.orgId, v)) throw new DomainError('APPROVALS_MISSING', 409, 'Kênh này cần thêm người duyệt trước khi đăng lại', { variantId: v.id });
      await move(ctx, v, { type: 'retry' }, { ...NO_ERROR, scheduled_at: ctx.now, queue_slot_at: null, next_check_at: null });
    }
    await refreshPostStatus(ctx, postId);
    await ctx.emit('social.variant.retried', { post_id: postId, variant_ids: chosen.map((v) => v.id) });
    return { postId, variants: chosen.map((v) => v.id) };
  },
});

// A person settles a needs_attention variant: it is on the platform after all (with its address when they have it),
// or it is dropped.
export const variantResolve = defineCommand({
  name: 'social.variant.resolve',
  input: z.strictObject({
    variantIds: zVariantIds,
    outcome: z.enum(['published', 'dropped']),
    url: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional(),
  }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const postId = await variantPost(ctx.trx, ctx.orgId, input.variantIds);
    const post = await lockPost(ctx.trx, ctx.orgId, postId);
    const chosen = pick(await lockVariants(ctx.trx, ctx.orgId, postId), input.variantIds);
    for (const v of chosen) {
      if (input.outcome === 'published') {
        await move(ctx, v, { type: 'confirm_published' }, { ...NO_ERROR, external_url: input.url ?? null, published_at: ctx.now, ...freezeValues(post, v) });
      } else {
        await move(ctx, v, { type: 'drop' }, freezeValues(post, v));
      }
    }
    await refreshPostStatus(ctx, postId);
    await ctx.emit('social.variant.resolved', { post_id: postId, outcome: input.outcome, variant_ids: chosen.map((v) => v.id) });
    return { postId, variants: chosen.map((v) => v.id), outcome: input.outcome };
  },
});

export const publishingCommands = [publishBegin, publishRecord, variantRetry, variantResolve];
