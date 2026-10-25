// Reposts when a post takes off (#773, plan §1 Later: post-publish actions). A published variant may carry one repost
// rule (settings.repost: { likes?, afterHours? }): once the platform counts that many likes, or that many hours after it
// went out, Crove reposts it on its own account (a repost on Threads and Bluesky, a boost on Mastodon). The metrics
// sweep reads the count and checks the time; the repost is made once, as its own external_call step (repost), recorded
// before the call. An unclear or failed repost is not tried again by itself: the post's activity shows it.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Publisher } from '@crove/channel';
import { DomainError, defineCommand, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { REPOST_PROVIDERS, isProvider, repostRuleOf } from './domain/channels.ts';
import { callRevision, publishCallKey } from './domain/publish.ts';
import { COMMENT_STALE_MS, type CommentCall } from './comments.ts';
import { lockPost, lockVariants, settingsOf, variantPost, type Trx, type VariantRow } from './variants.ts';
import { publishingHeld } from './publish-hold.ts';

export const REPOST_STEP = 'repost';
const ACTOR: SystemActor = { type: 'system', component: 'social.repost' };

export type RepostWork = { action: 'none'; reason: string } | { action: 'call'; variantId: string; callKey: string; externalId: string };

type RepostVariant = Pick<VariantRow, 'id' | 'revision' | 'published_revision' | 'attempt'>;
const repostKey = (v: RepostVariant) => publishCallKey(v.id, callRevision(v), v.attempt, REPOST_STEP);

// The repost calls of variants' current publishes (one at most each), for the post's activity.
export async function repostCallsOf(trx: Trx, orgId: string, variants: readonly RepostVariant[]): Promise<Map<string, CommentCall & { finished_at: Date | null }>> {
  const out = new Map<string, CommentCall & { finished_at: Date | null }>();
  if (variants.length === 0) return out;
  const keys = new Map(variants.map((v) => [repostKey(v), v.id]));
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

// Decides whether the repost goes now, for the like count the platform just reported (null: none) and the time since
// the post went out, and records the call first.
export const repostBegin = defineCommand({
  name: 'social.repost.begin',
  input: z.strictObject({ variantId: zId, likes: z.number().int().min(0).max(1e12).nullable() }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<RepostWork> => {
    requireSystem(ctx);
    // Nothing goes out while the org's publishing is held (#946): no call is recorded, so a sweep after the release
    // makes the one repost.
    if (await publishingHeld(ctx)) return { action: 'none', reason: 'held' };
    const v = await lockVariant(ctx, input.variantId);
    const rule = repostRuleOf(settingsOf(v));
    if (!rule || rule === 'invalid') return { action: 'none', reason: 'no_repost' };
    if (v.status !== 'published' || !v.external_post_id || !v.published_at) return { action: 'none', reason: 'not_published' };
    if (!isProvider(v.provider) || !REPOST_PROVIDERS.has(v.provider)) return { action: 'none', reason: 'not_supported' };
    const byLikes = rule.likes !== null && input.likes !== null && input.likes >= rule.likes;
    const byTime = rule.afterHours !== null && ctx.now.getTime() - v.published_at.getTime() >= rule.afterHours * 3_600_000;
    if (!byLikes && !byTime) return { action: 'none', reason: 'not_yet' };
    const callKey = repostKey(v);
    // Once: any call made, whatever came of it, settles the repost of this publish.
    const made = await ctx.trx.selectFrom('crove_kernel.external_call').select('key').where('org_id', '=', ctx.orgId).where('key', '=', callKey).executeTakeFirst();
    if (made) return { action: 'none', reason: 'done' };
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step: REPOST_STEP, retry_safety: 'never', request_hash: v.content_hash, started_at: ctx.now })
      .execute();
    return { action: 'call', variantId: v.id, callKey, externalId: v.external_post_id };
  },
});

const zText = (max: number) => z.string().max(max);
const zRepostResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional(), message: zText(2000).optional() }),
]);

// A call still started after this long never got its answer recorded (the worker died mid-call): the post's activity
// shows it as unclear.
export const REPOST_STALE_MS = COMMENT_STALE_MS;

// Stores what the platform answered; an answer for a key that is not a started call changes nothing.
export const repostRecord = defineCommand({
  name: 'social.repost.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zRepostResult }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    if (input.callKey !== repostKey(v)) return { recorded: false as const };
    const r = input.result;
    const state = r.kind === 'accepted' ? 'succeeded' : r.kind === 'unknown' ? 'ambiguous' : 'failed';
    const errorCode = r.kind === 'accepted' ? null : r.kind === 'unknown' ? (r.code ?? 'OUTCOME_UNKNOWN') : (r.code ?? null);
    // An unclear answer has no finish (the call ledger allows finished_at only with an outcome, #992), as publish and
    // remove record it.
    const values: Record<string, unknown> =
      r.kind === 'accepted'
        ? { state, external_ref: r.externalId, finished_at: ctx.now }
        : r.kind === 'unknown'
          ? { state, error_kind: 'unknown', error_code: errorCode }
          : { state, error_kind: r.error, error_code: errorCode, finished_at: ctx.now };
    const updated = await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set({ ...values, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.callKey)
      .where('state', '=', 'started')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) return { recorded: false as const };
    await ctx.emit(r.kind === 'accepted' ? 'social.variant.reposted' : 'social.variant.repost_failed', { post_id: v.post_id, variant_id: v.id, ...(r.kind === 'accepted' ? {} : { code: errorCode }) });
    return { recorded: true as const, state };
  },
});

export const repostCommands = [repostBegin, repostRecord];

/**
 * The repost of a published variant whose metrics just came in (#773): begin, one call, record. The sweep passes the
 * credential it opened for the metrics, and the like count when the platform gave one.
 */
export async function runRepost(
  deps: { runtime: Runtime },
  orgId: string,
  variantId: string,
  publisher: Publisher,
  credential: { externalAccountId: string; secret: string },
  likes: number | null,
): Promise<{ action: string; reason?: string; state?: string }> {
  if (!publisher.repost) return { action: 'none', reason: 'provider_cannot_repost' };
  const options = { actor: ACTOR, orgId };
  const begun = await deps.runtime.execute<RepostWork>('social.repost.begin', { variantId, likes }, options);
  if (begun.action === 'none') return { action: 'none', reason: begun.reason };
  let result: Awaited<ReturnType<NonNullable<Publisher['repost']>>>;
  try {
    result = await publisher.repost({ ...credential, externalId: begun.externalId, callKey: begun.callKey });
  } catch {
    result = { kind: 'unknown', code: 'ADAPTER_ERROR' };
  }
  // What the record takes: an adapter's long code or message is cut, so the answer is always recorded.
  const safe = result.kind === 'accepted' ? result : { ...result, ...(result.code !== undefined ? { code: result.code.slice(0, 200) } : {}), ...(result.message !== undefined ? { message: result.message.slice(0, 2000) } : {}) };
  const recorded = await deps.runtime.execute<{ recorded: boolean; state?: string }>('social.repost.record', { variantId, callKey: begun.callKey, result: safe }, options);
  return { action: 'call', ...(recorded.state ? { state: recorded.state } : {}) };
}
