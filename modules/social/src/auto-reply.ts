// Auto-replies on likes (#746). A published variant may carry one reply (settings.autoReply: { text, likes }) that
// Crove posts under the post once the platform counts that many likes: a comment on Facebook Pages and LinkedIn, a
// reply in the thread on Threads, X and Bluesky. The metrics sweep reads the count; the reply is posted once, as its
// own external_call step (autoreply), recorded before the call. No platform tells whether an unclear reply went
// through, and nobody watches the counts, so a reply that failed or is unclear is not tried again: the post's activity
// shows it.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Publisher } from '@crove/channel';
import { DomainError, defineCommand, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { AUTO_REPLY_RULES, autoReplyOf, isProvider } from './domain/channels.ts';
import { publishCallKey } from './domain/publish.ts';
import { COMMENT_STALE_MS, type CommentCall } from './comments.ts';
import { lockPost, lockVariants, settingsOf, variantPost, type Trx, type VariantRow } from './variants.ts';
import { publishingHeld } from './publish-hold.ts';

export const AUTO_REPLY_STEP = 'autoreply';
const ACTOR: SystemActor = { type: 'system', component: 'social.auto_reply' };

export type AutoReplyWork =
  | { action: 'none'; reason: string }
  | { action: 'call'; variantId: string; callKey: string; externalId: string; text: string };

type ReplyVariant = Pick<VariantRow, 'id' | 'revision' | 'attempt'>;
const replyKey = (v: ReplyVariant) => publishCallKey(v.id, v.revision, v.attempt, AUTO_REPLY_STEP);

// The auto-reply calls of variants' current publishes (one at most each), for the post's activity.
export async function autoReplyCallsOf(trx: Trx, orgId: string, variants: readonly ReplyVariant[]): Promise<Map<string, CommentCall & { finished_at: Date | null }>> {
  const out = new Map<string, CommentCall & { finished_at: Date | null }>();
  if (variants.length === 0) return out;
  const keys = new Map(variants.map((v) => [replyKey(v), v.id]));
  const { rows } = await sql<CommentCall & { finished_at: Date | null }>`
    SELECT key, state, external_ref, error_code, started_at, finished_at FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid AND key = ANY(${[...keys.keys()]}::text[])`.execute(trx);
  for (const row of rows) {
    const id = keys.get(row.key);
    if (id) out.set(id, row);
  }
  return out;
}

async function lockVariant(ctx: CommandContext, variantId: string): Promise<VariantRow> {
  const postId = await variantPost(ctx.trx, ctx.orgId, [variantId]);
  await lockPost(ctx.trx, ctx.orgId, postId);
  const v = (await lockVariants(ctx.trx, ctx.orgId, postId)).find((x) => x.id === variantId);
  if (!v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
  return v;
}

const requireSystem = (ctx: CommandContext) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
};

// Decides whether the reply goes now, for the like count the platform just reported, and records the call first.
export const autoReplyBegin = defineCommand({
  name: 'social.auto_reply.begin',
  input: z.strictObject({ variantId: zId, likes: z.number().int().min(0).max(1e12) }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<AutoReplyWork> => {
    requireSystem(ctx);
    // Nothing goes out while the org's publishing is held (#946): no call is recorded, so a later count may still reply.
    if (await publishingHeld(ctx)) return { action: 'none', reason: 'held' };
    const v = await lockVariant(ctx, input.variantId);
    const reply = autoReplyOf(settingsOf(v));
    if (!reply || reply === 'invalid') return { action: 'none', reason: 'no_reply' };
    if (v.status !== 'published' || !v.external_post_id) return { action: 'none', reason: 'not_published' };
    if (!isProvider(v.provider) || !AUTO_REPLY_RULES[v.provider]) return { action: 'none', reason: 'not_supported' };
    if (input.likes < reply.likes) return { action: 'none', reason: 'below' };
    const callKey = replyKey(v);
    // Once: any call made, whatever came of it, settles the reply of this publish.
    const made = await ctx.trx.selectFrom('crove_kernel.external_call').select('key').where('org_id', '=', ctx.orgId).where('key', '=', callKey).executeTakeFirst();
    if (made) return { action: 'none', reason: 'done' };
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step: AUTO_REPLY_STEP, retry_safety: 'never', request_hash: v.content_hash, started_at: ctx.now })
      .execute();
    return { action: 'call', variantId: v.id, callKey, externalId: v.external_post_id, text: reply.text };
  },
});

const zText = (max: number) => z.string().max(max);
const zReplyResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional(), message: zText(2000).optional() }),
]);

// A call still started after this long never got its answer recorded (the worker died mid-call): the post's activity
// shows it as unclear.
export const AUTO_REPLY_STALE_MS = COMMENT_STALE_MS;

// Stores what the platform answered; an answer for a key that is not a started call changes nothing.
export const autoReplyRecord = defineCommand({
  name: 'social.auto_reply.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zReplyResult }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    if (input.callKey !== replyKey(v)) return { recorded: false as const };
    const r = input.result;
    const state = r.kind === 'accepted' ? 'succeeded' : r.kind === 'unknown' ? 'ambiguous' : 'failed';
    const errorCode = r.kind === 'accepted' ? null : r.kind === 'unknown' ? (r.code ?? 'OUTCOME_UNKNOWN') : (r.code ?? null);
    const values: Record<string, unknown> =
      r.kind === 'accepted'
        ? { state, external_ref: r.externalId, finished_at: ctx.now }
        : { state, error_kind: r.kind === 'unknown' ? 'unknown' : r.error, error_code: errorCode, finished_at: ctx.now };
    const updated = await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set({ ...values, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.callKey)
      .where('state', '=', 'started')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) return { recorded: false as const };
    await ctx.emit(r.kind === 'accepted' ? 'social.variant.auto_replied' : 'social.variant.auto_reply_failed', { post_id: v.post_id, variant_id: v.id, ...(r.kind === 'accepted' ? {} : { code: errorCode }) });
    return { recorded: true as const, state };
  },
});

export const autoReplyCommands = [autoReplyBegin, autoReplyRecord];

/**
 * The auto-reply of a published variant whose like count just came in (#746): begin, one call, record. The sweep
 * passes the credential it opened for the metrics.
 */
export async function runAutoReply(
  deps: { runtime: Runtime },
  orgId: string,
  variantId: string,
  publisher: Publisher,
  credential: { externalAccountId: string; secret: string },
  likes: number,
): Promise<{ action: string; reason?: string; state?: string }> {
  if (!publisher.comment) return { action: 'none', reason: 'provider_cannot_reply' };
  const options = { actor: ACTOR, orgId };
  const begun = await deps.runtime.execute<AutoReplyWork>('social.auto_reply.begin', { variantId, likes }, options);
  if (begun.action === 'none') return { action: 'none', reason: begun.reason };
  let result: Awaited<ReturnType<NonNullable<Publisher['comment']>>>;
  try {
    result = await publisher.comment({ ...credential, externalId: begun.externalId, text: begun.text, callKey: begun.callKey });
  } catch {
    result = { kind: 'unknown', code: 'ADAPTER_ERROR' };
  }
  // What the record takes: an adapter's long code or message is cut, so the answer is always recorded.
  const cut = (s: string | undefined, max: number) => (s === undefined ? {} : { [max === 200 ? 'code' : 'message']: s.slice(0, max) });
  const safe = result.kind === 'accepted' ? result : { ...result, ...cut(result.code, 200), ...cut(result.message, 2000) };
  const recorded = await deps.runtime.execute<{ recorded: boolean; state?: string }>('social.auto_reply.record', { variantId, callKey: begun.callKey, result: safe }, options);
  return { action: 'call', ...(recorded.state ? { state: recorded.state } : {}) };
}
