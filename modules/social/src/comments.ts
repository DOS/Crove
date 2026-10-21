// First comments (Social MVP, issue #587). After a variant is published, the worker posts its first comment
// (settings.firstComment) once, as its own external_call step next to the publish call: a comment on LinkedIn, a reply
// in the thread on X and Bluesky. The comment never touches the post: a failure is shown on it, and a person may try
// again. No platform tells whether an unclear comment went through, so an unclear answer is never retried by itself.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { COMMENT_RULES, firstCommentOf, isProvider } from './domain/channels.ts';
import { publishCallKey } from './domain/publish.ts';
import { lockPost, lockVariants, settingsOf, variantPost, type Trx, type VariantRow } from './variants.ts';
import { publishingHeld } from './publish-hold.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const COMMENT_STEP = 'comment';
// A call still started after this long never got its answer recorded (the worker died mid-call), and a published
// variant with no call after this long never had its comment job run: both are a person's to settle.
export const COMMENT_STALE_MS = 10 * 60_000;

export type CommentWork =
  | { action: 'none'; reason: string }
  | { action: 'call'; variantId: string; provider: string; connectionId: string; callKey: string; externalId: string; text: string };

export interface CommentCall {
  key: string;
  state: 'started' | 'succeeded' | 'failed' | 'ambiguous';
  external_ref: string | null;
  error_code: string | null;
  started_at: Date;
}

type CommentVariant = Pick<VariantRow, 'id' | 'revision' | 'attempt'>;
const commentPrefix = (v: CommentVariant) => publishCallKey(v.id, v.revision, v.attempt, COMMENT_STEP);

// The comment calls of each variant's current publish, oldest first, in one query. Each retry is a new step
// (comment, comment_2...).
export async function commentCallsOf(trx: Trx, orgId: string, variants: readonly CommentVariant[]): Promise<Map<string, CommentCall[]>> {
  const out = new Map<string, CommentCall[]>(variants.map((v) => [v.id, []]));
  if (variants.length === 0) return out;
  const prefixes = variants.map(commentPrefix);
  const { rows } = await sql<CommentCall>`
    SELECT key, state, external_ref, error_code, started_at FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid
      AND (key = ANY(${prefixes}::text[]) OR key LIKE ANY(${prefixes.map((p) => `${p}\\_%`)}::text[]))
    ORDER BY started_at, key`.execute(trx);
  for (const row of rows) {
    const i = prefixes.findIndex((p) => row.key === p || row.key.startsWith(`${p}_`));
    if (i >= 0) out.get((variants[i] as CommentVariant).id)?.push(row);
  }
  return out;
}

export async function commentCalls(trx: Trx, orgId: string, v: CommentVariant): Promise<CommentCall[]> {
  return (await commentCallsOf(trx, orgId, [v])).get(v.id) ?? [];
}

// What a variant's first comment shows on the post screen. now and publishedAt tell a call or a job that went quiet
// from one still on its way.
// reconnect: the last call failed because the channel was connected without the permission to comment (#791).
export type CommentStatus = 'pending' | 'posted' | 'failed' | 'reconnect' | 'unknown';
export const RECONNECT_FOR_COMMENTS = 'RECONNECT_FOR_COMMENTS';
export function commentStatus(calls: readonly CommentCall[], now: Date, publishedAt: Date | null): CommentStatus {
  const last = calls.at(-1);
  if (!last) return publishedAt && now.getTime() - publishedAt.getTime() > COMMENT_STALE_MS ? 'failed' : 'pending';
  if (calls.some((c) => c.state === 'succeeded')) return 'posted';
  if (last.state === 'failed') return last.error_code === RECONNECT_FOR_COMMENTS ? 'reconnect' : 'failed';
  if (last.state === 'ambiguous') return 'unknown';
  return now.getTime() - last.started_at.getTime() > COMMENT_STALE_MS ? 'unknown' : 'pending';
}

async function lockVariant(ctx: CommandContext, variantId: string): Promise<VariantRow> {
  const postId = await variantPost(ctx.trx, ctx.orgId, [variantId]);
  await lockPost(ctx.trx, ctx.orgId, postId);
  const v = (await lockVariants(ctx.trx, ctx.orgId, postId)).find((x) => x.id === variantId);
  if (!v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
  return v;
}

const requireSystem = (ctx: CommandContext) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình đăng bài mới thực hiện được việc này');
};

// Decides whether the worker posts the comment now, and records the call as started first.
export const commentBegin = defineCommand({
  name: 'social.comment.begin',
  // retry: a person asked again, after the call with this key (null: no call was made).
  input: z.strictObject({ variantId: zId, provider: z.string().min(1).max(32), retry: z.strictObject({ after: z.string().min(1).max(300).nullable() }).optional() }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input): Promise<CommentWork> => {
    requireSystem(ctx);
    // Nothing goes out while the org's publishing is held (#946); a person asks again after the release.
    if (await publishingHeld(ctx)) return { action: 'none', reason: 'held' };
    const v = await lockVariant(ctx, input.variantId);
    if (v.provider !== input.provider) return { action: 'none', reason: 'provider_mismatch' };
    const text = firstCommentOf(settingsOf(v));
    if (!text) return { action: 'none', reason: 'no_comment' };
    if (v.status !== 'published' || !v.external_post_id) return { action: 'none', reason: 'not_published' };
    if (!isProvider(v.provider) || !COMMENT_RULES[v.provider]) return { action: 'none', reason: 'not_supported' };
    const calls = await commentCalls(ctx.trx, ctx.orgId, v);
    const status = commentStatus(calls, ctx.now, v.published_at);
    if (status === 'posted') return { action: 'none', reason: 'posted' };
    // The job after publishing posts the first call only. A call started or unclear is a person's to settle; a failed
    // one goes again only when a person asked, once per ask: the ask names the last call it saw, so a second job from
    // the same ask finds a newer call and stops.
    const go = input.retry
      ? (status === 'failed' || status === 'reconnect' || status === 'unknown') && (calls.at(-1)?.key ?? null) === input.retry.after
      : calls.length === 0;
    if (!go) return { action: 'none', reason: status };
    const step = calls.length === 0 ? COMMENT_STEP : `${COMMENT_STEP}_${calls.length + 1}`;
    const callKey = publishCallKey(v.id, v.revision, v.attempt, step);
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step, retry_safety: 'never', request_hash: v.content_hash, started_at: ctx.now })
      .execute();
    return { action: 'call', variantId: v.id, provider: v.provider, connectionId: v.channel_connection_id, callKey, externalId: v.external_post_id, text };
  },
});

const zText = (max: number) => z.string().max(max);
const zCommentResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional(), message: zText(2000).optional() }),
  // Nothing was called: the channel's credential could not be used.
  z.strictObject({ kind: z.literal('blocked'), code: zText(200) }),
]);

// Stores what the platform answered for the comment call; an answer for a key that is no longer the variant's changes
// nothing.
export const commentRecord = defineCommand({
  name: 'social.comment.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zCommentResult }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    const calls = await commentCalls(ctx.trx, ctx.orgId, v);
    const call = calls.find((c) => c.key === input.callKey);
    if (!call || call.state !== 'started') return { recorded: false as const };
    const r = input.result;
    const state = r.kind === 'accepted' ? 'succeeded' : r.kind === 'unknown' ? 'ambiguous' : 'failed';
    const errorCode = r.kind === 'accepted' ? null : r.kind === 'unknown' ? (r.code ?? 'OUTCOME_UNKNOWN') : (r.code ?? null);
    const values: Record<string, unknown> =
      r.kind === 'accepted'
        ? { state, external_ref: r.externalId, finished_at: ctx.now }
        : { state, error_kind: r.kind === 'unknown' ? 'unknown' : r.kind === 'blocked' ? (r.code === 'CHANNEL_NOT_ACTIVE' ? 'token_expired' : 'permission') : r.error, error_code: errorCode, ...(state === 'failed' ? { finished_at: ctx.now } : {}) };
    await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set({ ...values, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.callKey)
      .where('state', '=', 'started')
      .execute();
    await ctx.emit(r.kind === 'accepted' ? 'social.variant.comment_posted' : 'social.variant.comment_failed', { post_id: v.post_id, variant_id: v.id, ...(r.kind === 'accepted' ? {} : { code: errorCode }) });
    return { recorded: true as const, state };
  },
});

// A person asks for the comment again (it failed, or its outcome is unclear and they checked it is not there): the
// worker picks it up from the event.
export const commentRetry = defineCommand({
  name: 'social.comment.retry',
  input: z.strictObject({ variantId: zId }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const v = await lockVariant(ctx, input.variantId);
    const calls = await commentCalls(ctx.trx, ctx.orgId, v);
    const status = commentStatus(calls, ctx.now, v.published_at);
    if (v.status !== 'published' || !v.external_post_id || !firstCommentOf(settingsOf(v)) || (status !== 'failed' && status !== 'reconnect' && status !== 'unknown')) {
      throw new DomainError('COMMENT_NOT_RETRYABLE', 409, 'Bình luận của kênh này không cần thử lại');
    }
    await ctx.emit('social.comment.retry_requested', { post_id: v.post_id, variant_id: v.id, provider: v.provider, after: calls.at(-1)?.key ?? null });
    return { variantId: v.id };
  },
});

export const commentCommands = [commentBegin, commentRecord, commentRetry];