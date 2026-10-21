// Removing a published post from its platform (#860). An owner or admin asks (social.variant.remove, with a short
// reason; the ask is audited) and the worker runs the remove job: social.remove.begin records the call as started (its
// own external_call step next to the publish call: remove, then remove_2... for each later ask), the adapter takes the
// post down, and social.remove.record stores the answer. The variant stays published until the platform confirms; it
// is then removed, with the time and who asked, and what reads published variants only (metrics, first comments,
// threads, reposts, evergreen) leaves it alone. A post the platform no longer has counts as removed, so asking again
// after a failed or unclear call is harmless; nothing asks again by itself. A post may also be set to come down at a
// time (#861, settings.removeAt): the worker's sweep asks once when it comes (social.remove.schedule).
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { REMOVE_READY, isProvider, removeAtOf } from './domain/channels.ts';
import { publishCallKey } from './domain/publish.ts';
import { COMMENT_STALE_MS, type CommentCall } from './comments.ts';
import { lockPost, lockVariants, refreshPostStatus, setVariant, settingsOf, step, variantPost, type Trx, type VariantRow } from './variants.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const REMOVE_STEP = 'remove';
// An ask with no call after this long never had its job run, and a call still started this long never got its answer
// recorded (the worker died mid-call): either way a person may ask again.
export const REMOVE_STALE_MS = COMMENT_STALE_MS;
export const REMOVE_REASON_MAX = 500;

export type RemoveWork =
  | { action: 'none'; reason: string }
  | { action: 'call'; variantId: string; provider: string; connectionId: string; callKey: string; externalId: string; settings: Record<string, unknown> };

type RemoveVariant = Pick<VariantRow, 'id' | 'revision' | 'attempt'>;
const removePrefix = (v: RemoveVariant) => publishCallKey(v.id, v.revision, v.attempt, REMOVE_STEP);

// The remove calls of each variant's current publish, oldest first, in one query.
export async function removeCallsOf(trx: Trx, orgId: string, variants: readonly RemoveVariant[]): Promise<Map<string, CommentCall[]>> {
  const out = new Map<string, CommentCall[]>(variants.map((v) => [v.id, []]));
  if (variants.length === 0) return out;
  const prefixes = variants.map(removePrefix);
  const { rows } = await sql<CommentCall>`
    SELECT key, state, external_ref, error_code, started_at FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid
      AND (key = ANY(${prefixes}::text[]) OR key LIKE ANY(${prefixes.map((p) => `${p}\\_%`)}::text[]))
    ORDER BY started_at, key`.execute(trx);
  for (const row of rows) {
    const i = prefixes.findIndex((p) => row.key === p || row.key.startsWith(`${p}_`));
    if (i >= 0) out.get((variants[i] as RemoveVariant).id)?.push(row);
  }
  return out;
}

// Where a person's removal of a published variant stands, for the post screen; null when nobody asked. pending: the
// job has not answered yet; failed: the platform refused (code says why), or the job never ran; unknown: the call went
// out and its answer is unclear or never came.
export type RemoveState = { state: 'pending' | 'failed' | 'unknown'; code: string | null };
export function removeState(calls: readonly CommentCall[], requestedAt: Date | null, now: Date): RemoveState | null {
  if (!requestedAt) return null;
  const last = calls.at(-1);
  // The ask came after the last call: its job has not made one yet.
  if (!last || last.started_at.getTime() < requestedAt.getTime()) {
    return now.getTime() - requestedAt.getTime() > REMOVE_STALE_MS ? { state: 'failed', code: 'REMOVE_NOT_RUN' } : { state: 'pending', code: null };
  }
  if (last.state === 'failed') return { state: 'failed', code: last.error_code };
  if (last.state === 'ambiguous') return { state: 'unknown', code: last.error_code };
  if (last.state === 'started') return now.getTime() - last.started_at.getTime() > REMOVE_STALE_MS ? { state: 'unknown', code: 'OUTCOME_UNKNOWN' } : { state: 'pending', code: null };
  // Succeeded: the variant is removed; nothing to show here.
  return null;
}

async function lockVariant(ctx: CommandContext, variantId: string): Promise<VariantRow & { remove_requested_at: Date | null }> {
  const postId = await variantPost(ctx.trx, ctx.orgId, [variantId]);
  await lockPost(ctx.trx, ctx.orgId, postId);
  const v = (await lockVariants(ctx.trx, ctx.orgId, postId)).find((x) => x.id === variantId);
  if (!v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
  const asked = await ctx.trx.selectFrom('crove_social.post_variant').select('remove_requested_at').where('org_id', '=', ctx.orgId).where('id', '=', v.id).executeTakeFirstOrThrow();
  return { ...v, remove_requested_at: asked.remove_requested_at };
}

const requireSystem = (ctx: CommandContext) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
};

// An owner or admin asks for a published variant to come down from its platform. Asking again while the last ask is
// on its way changes nothing; after a failed or unclear one, it asks again.
export const variantRemove = defineCommand({
  name: 'social.variant.remove',
  input: z.strictObject({ variantId: zId, reason: z.string().trim().max(REMOVE_REASON_MAX).optional() }),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const userId = ctx.actor.userId;
    const v = await lockVariant(ctx, input.variantId);
    if (v.status === 'removed') return { postId: v.post_id, variantId: v.id, status: v.status, queued: false };
    if (v.status !== 'published') throw new DomainError('VARIANT_NOT_PUBLISHED', 409, 'Chỉ gỡ được kênh đã đăng', { variantId: v.id, status: v.status });
    if (!isProvider(v.provider) || !REMOVE_READY.has(v.provider)) throw new DomainError('REMOVE_NOT_SUPPORTED', 422, 'Crove chưa gỡ được bài trên kênh này; hãy gỡ trực tiếp trên nền tảng', { variantId: v.id });
    // Confirmed by hand as published (social.variant.resolve) without the platform's id: nothing to name in the call.
    if (!v.external_post_id) throw new DomainError('REMOVE_NO_PLATFORM_ID', 409, 'Crove không có mã bài trên nền tảng nên không gỡ được; hãy gỡ trực tiếp trên nền tảng', { variantId: v.id });
    const calls = (await removeCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    if (removeState(calls, v.remove_requested_at, ctx.now)?.state === 'pending') return { postId: v.post_id, variantId: v.id, status: v.status, queued: false };
    const reason = input.reason ? input.reason : null;
    await setVariant(ctx, v.id, { removed_by: userId, remove_reason: reason, remove_requested_at: ctx.now });
    ctx.audit({ post_id: v.post_id, variant_id: v.id, provider: v.provider, reason });
    // The job's begin goes only while the last call is still the one this ask saw, so a second job of it stops.
    await ctx.emit('social.variant.remove_requested', { post_id: v.post_id, variant_id: v.id, provider: v.provider, after: calls.at(-1)?.key ?? null });
    return { postId: v.post_id, variantId: v.id, status: v.status, queued: true };
  },
});

// Decides whether the worker makes the remove call now, and records the call as started first.
export const removeBegin = defineCommand({
  name: 'social.remove.begin',
  // after: the last remove call the ask saw (null: none was made).
  input: z.strictObject({ variantId: zId, provider: z.string().min(1).max(32), after: z.string().min(1).max(300).nullable() }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<RemoveWork> => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    if (v.provider !== input.provider) return { action: 'none', reason: 'provider_mismatch' };
    if (v.status !== 'published' || !v.external_post_id) return { action: 'none', reason: v.status === 'removed' ? 'removed' : 'not_published' };
    if (!isProvider(v.provider) || !REMOVE_READY.has(v.provider)) return { action: 'none', reason: 'not_supported' };
    if (!v.remove_requested_at) return { action: 'none', reason: 'not_asked' };
    const calls = (await removeCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    if ((calls.at(-1)?.key ?? null) !== input.after) return { action: 'none', reason: 'stale' };
    const stepName = calls.length === 0 ? REMOVE_STEP : `${REMOVE_STEP}_${calls.length + 1}`;
    const callKey = publishCallKey(v.id, v.revision, v.attempt, stepName);
    // Idempotent: the platform answers a post already gone like a removal.
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step: stepName, retry_safety: 'idempotent', request_hash: v.content_hash, started_at: ctx.now })
      .execute();
    return { action: 'call', variantId: v.id, provider: v.provider, connectionId: v.channel_connection_id, callKey, externalId: v.external_post_id, settings: settingsOf(v) };
  },
});

const zText = (max: number) => z.string().max(max);
const zRemoveResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('removed') }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional() }),
  // Nothing was called: the channel's credential could not be used.
  z.strictObject({ kind: z.literal('blocked'), code: zText(200) }),
]);
export type RemoveRecord = z.infer<typeof zRemoveResult>;

// Stores what the platform answered for the remove call; an answer for a call that is not started changes nothing.
export const removeRecord = defineCommand({
  name: 'social.remove.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zRemoveResult }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    const calls = (await removeCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    const call = calls.find((c) => c.key === input.callKey);
    if (!call || call.state !== 'started') return { recorded: false as const };
    const r = input.result;
    const state = r.kind === 'removed' ? 'succeeded' : r.kind === 'unknown' ? 'ambiguous' : 'failed';
    const errorCode = r.kind === 'removed' ? null : r.kind === 'unknown' ? (r.code ?? 'OUTCOME_UNKNOWN') : (r.code ?? null);
    const errorKind = r.kind === 'removed' ? null : r.kind === 'unknown' ? 'unknown' : r.kind === 'blocked' ? (r.code === 'CHANNEL_NOT_ACTIVE' ? 'token_expired' : 'permission') : r.error;
    await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set({ state, error_kind: errorKind, error_code: errorCode, ...(state === 'ambiguous' ? {} : { finished_at: ctx.now }), updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.callKey)
      .where('state', '=', 'started')
      .execute();
    // Only a published variant moves; the call is recorded whatever the variant became meanwhile.
    if (r.kind === 'removed' && v.status === 'published') {
      await setVariant(ctx, v.id, { status: step(v, { type: 'removed' }), removed_at: ctx.now });
      await refreshPostStatus(ctx, v.post_id);
      const by = await ctx.trx.selectFrom('crove_social.post_variant').select('removed_by').where('org_id', '=', ctx.orgId).where('id', '=', v.id).executeTakeFirstOrThrow();
      await ctx.emit('social.variant.removed', { post_id: v.post_id, variant_id: v.id, provider: v.provider, by: by.removed_by });
      return { recorded: true as const, state, status: 'removed' as const };
    }
    if (r.kind !== 'removed') await ctx.emit('social.variant.remove_failed', { post_id: v.post_id, variant_id: v.id, provider: v.provider, code: errorCode });
    return { recorded: true as const, state, status: v.status };
  },
});

// A post set to come down by itself (#861): its planned time (settings.removeAt) has come and is after the time it went
// out (a post published late, after that time, is never taken down by it).
export function removeDue(settings: Readonly<Record<string, unknown>>, publishedAt: Date | null, now: Date): boolean {
  const at = removeAtOf(settings);
  if (at === null || at === 'invalid' || !publishedAt) return false;
  const t = Date.parse(at);
  return t <= now.getTime() && t > publishedAt.getTime();
}

// The worker's sweep asks for the removal of a published variant whose planned time has come, as a person's ask would:
// the same columns (no member, no reason) and the same event, so the remove job does the rest. Checked again under the
// lock; once anyone asked (a person, or this before), it asks nothing more: a failed or unclear removal waits for a person.
export const removeSchedule = defineCommand({
  name: 'social.remove.schedule',
  input: z.strictObject({ variantId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<{ queued: boolean; reason?: string }> => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    if (v.status !== 'published' || !v.external_post_id) return { queued: false, reason: 'not_published' };
    if (!isProvider(v.provider) || !REMOVE_READY.has(v.provider)) return { queued: false, reason: 'not_supported' };
    if (v.remove_requested_at) return { queued: false, reason: 'asked' };
    const settings = settingsOf(v);
    if (!removeDue(settings, v.published_at, ctx.now)) return { queued: false, reason: 'not_due' };
    const calls = (await removeCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    await setVariant(ctx, v.id, { removed_by: null, remove_reason: null, remove_requested_at: ctx.now });
    ctx.audit({ post_id: v.post_id, variant_id: v.id, provider: v.provider, scheduled: true, remove_at: removeAtOf(settings) });
    await ctx.emit('social.variant.remove_requested', { post_id: v.post_id, variant_id: v.id, provider: v.provider, after: calls.at(-1)?.key ?? null });
    return { queued: true };
  },
});

const SWEEP_ACTOR: SystemActor = { type: 'system', component: 'social.remove' };
// How often the worker looks for planned takedowns, and how many it takes per pass: a post comes down within a minute
// of its time, plus the remove job's own run.
export const REMOVE_SWEEP_MS = 60_000;
export const REMOVE_SWEEP_LIMIT = 200;

// One pass: each published variant whose planned takedown is due, on the providers this worker can remove from, gets its
// removal asked for. Logs ids and codes only.
export async function sweepRemovals(deps: { runtime: Runtime; workerDb: Db }, providers: ReadonlySet<string>): Promise<number> {
  const removable = [...providers].filter((p) => isProvider(p) && REMOVE_READY.has(p));
  if (removable.length === 0) return 0;
  const { rows } = await sql<{ org_id: string; variant_id: string }>`
    SELECT org_id, variant_id FROM crove_social.remove_due(${REMOVE_SWEEP_LIMIT}::int, ${removable}::text[])`.execute(deps.workerDb);
  let queued = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ queued: boolean }>('social.remove.schedule', { variantId: row.variant_id }, { actor: SWEEP_ACTOR, orgId: row.org_id });
      if (done.queued) queued += 1;
    } catch (error) {
      console.warn(`[social-remove] planned removal of variant ${row.variant_id.slice(0, 8)}: ${error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error'}`);
    }
  }
  return queued;
}

export const removeCommands = [variantRemove, removeBegin, removeRecord, removeSchedule];
