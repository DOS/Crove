// Thread posts (#742). After a variant is published on Threads, X or Bluesky, the worker posts its thread parts
// (settings.threadParts) as a chain of replies: part 2 answers the post, part 3 answers part 2, and so on. Each part is
// its own external_call step (part_<n>, a person's retry part_<n>_<k>), recorded before the call, so a crash leaves
// the parts that went out recorded and none is posted twice. No platform tells whether an unclear reply went through,
// so a part that failed or is unclear stops the chain until a person asks again.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { THREAD_RULES, isProvider, threadPartsOf } from './domain/channels.ts';
import { callRevision, publishCallKey } from './domain/publish.ts';
import { COMMENT_STALE_MS, type CommentCall } from './comments.ts';
import { lockPost, lockVariants, settingsOf, variantPost, type Trx, type VariantRow } from './variants.ts';
import { publishingHeld } from './publish-hold.ts';
import { refuseChannels } from './channel-access.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const THREAD_STEP = 'part';
const PART_STEP = /:part_(\d{1,2})(?:_(\d{1,3}))?$/;

export type ThreadWork =
  | { action: 'none'; reason: string }
  | { action: 'call'; variantId: string; provider: string; connectionId: string; callKey: string; part: number; externalId: string; rootExternalId: string; text: string };

type ThreadVariant = Pick<VariantRow, 'id' | 'revision' | 'published_revision' | 'attempt'>;
const threadPrefix = (v: ThreadVariant) => publishCallKey(v.id, callRevision(v), v.attempt, THREAD_STEP);

// The part a call key posts (2 is the first reply), or null for a key that is not a thread part.
export const partOf = (key: string): number | null => {
  const m = PART_STEP.exec(key);
  return m ? Number(m[1]) : null;
};

// The thread calls of each variant's current publish, oldest first, in one query.
export async function threadCallsOf(trx: Trx, orgId: string, variants: readonly ThreadVariant[]): Promise<Map<string, CommentCall[]>> {
  const out = new Map<string, CommentCall[]>(variants.map((v) => [v.id, []]));
  if (variants.length === 0) return out;
  const prefixes = variants.map(threadPrefix);
  const { rows } = await sql<CommentCall>`
    SELECT key, state, external_ref, error_code, started_at FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid AND key LIKE ANY(${prefixes.map((p) => `${p}\\_%`)}::text[])
    ORDER BY started_at, key`.execute(trx);
  for (const row of rows) {
    const i = prefixes.findIndex((p) => row.key.startsWith(`${p}_`));
    if (i >= 0 && partOf(row.key) !== null) out.get((variants[i] as ThreadVariant).id)?.push(row);
  }
  return out;
}

// Where a variant's thread stands: the parts posted (the post itself counts as part 1), and the state of the next one.
// now and the time of the last step tell a chain still on its way from one that went quiet.
export type ThreadState = 'pending' | 'posted' | 'failed' | 'unknown';
export interface ThreadStatus {
  state: ThreadState;
  // Parts out, counting the post; total counts it too.
  posted: number;
  total: number;
  // The part to post next (null when all are out), and the key of the last call, which a person's retry names.
  next: number | null;
  lastKey: string | null;
}

export function threadStatus(partCount: number, calls: readonly CommentCall[], now: Date, publishedAt: Date | null): ThreadStatus {
  const total = partCount + 1;
  const lastKey = calls.at(-1)?.key ?? null;
  let next: number | null = null;
  for (let n = 2; n <= total; n += 1) {
    if (!calls.some((c) => partOf(c.key) === n && c.state === 'succeeded')) {
      next = n;
      break;
    }
  }
  if (next === null) return { state: 'posted', posted: total, total, next, lastKey };
  const posted = next - 1;
  const mine = calls.filter((c) => partOf(c.key) === next);
  const last = mine.at(-1);
  const quiet = (since: Date | null | undefined) => Boolean(since && now.getTime() - since.getTime() > COMMENT_STALE_MS);
  let state: ThreadState;
  if (!last) {
    // No call yet for this part: the chain is on its way unless the step before it went quiet.
    const before = next === 2 ? publishedAt : calls.filter((c) => partOf(c.key) === (next as number) - 1 && c.state === 'succeeded').at(-1)?.started_at;
    state = quiet(before) ? 'failed' : 'pending';
  } else if (last.state === 'failed') state = 'failed';
  else if (last.state === 'ambiguous') state = 'unknown';
  else state = quiet(last.started_at) ? 'unknown' : 'pending';
  return { state, posted, total, next, lastKey };
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

// Decides whether the worker posts the next part now, and records the call as started first.
export const threadBegin = defineCommand({
  name: 'social.thread.begin',
  // retry: a person asked again, after the call with this key (null: no call was made).
  input: z.strictObject({ variantId: zId, provider: z.string().min(1).max(32), retry: z.strictObject({ after: z.string().min(1).max(300).nullable() }).optional() }),
  // Commits the provider call as started; the worker then makes it, an effect outside Crove (#1578).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input): Promise<ThreadWork> => {
    requireSystem(ctx);
    // Nothing goes out while the org's publishing is held (#946); a person asks again after the release.
    if (await publishingHeld(ctx)) return { action: 'none', reason: 'held' };
    const v = await lockVariant(ctx, input.variantId);
    if (v.provider !== input.provider) return { action: 'none', reason: 'provider_mismatch' };
    const parts = threadPartsOf(settingsOf(v));
    if (!parts) return { action: 'none', reason: 'no_thread' };
    if (v.status !== 'published' || !v.external_post_id) return { action: 'none', reason: 'not_published' };
    if (!isProvider(v.provider) || !THREAD_RULES[v.provider]) return { action: 'none', reason: 'not_supported' };
    const calls = (await threadCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    const status = threadStatus(parts.length, calls, ctx.now, v.published_at);
    if (status.next === null) return { action: 'none', reason: 'posted' };
    const n = status.next;
    const mine = calls.filter((c) => partOf(c.key) === n);
    // The job goes on to a part no call was made for. A call started or unclear is a person's to settle; a failed one,
    // or a chain that went quiet, goes again only when a person asked, once per ask: the ask names the last call it
    // saw, so a second job from the same ask finds a newer call and stops.
    const go = input.retry ? (status.state === 'failed' || status.state === 'unknown') && status.lastKey === input.retry.after : mine.length === 0;
    if (!go) return { action: 'none', reason: status.state };
    const parent = n === 2 ? v.external_post_id : calls.filter((c) => partOf(c.key) === n - 1 && c.state === 'succeeded').at(-1)?.external_ref;
    if (!parent) return { action: 'none', reason: 'no_parent' };
    const step = mine.length === 0 ? `${THREAD_STEP}_${n}` : `${THREAD_STEP}_${n}_${mine.length + 1}`;
    const callKey = publishCallKey(v.id, callRevision(v), v.attempt, step);
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step, retry_safety: 'never', request_hash: v.content_hash, started_at: ctx.now })
      .execute();
    return { action: 'call', variantId: v.id, provider: v.provider, connectionId: v.channel_connection_id, callKey, part: n, externalId: parent, rootExternalId: v.external_post_id, text: parts[n - 2] as string };
  },
});

const zText = (max: number) => z.string().max(max);
const zPartResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional(), message: zText(2000).optional() }),
  // Nothing was called: the channel's credential could not be used.
  z.strictObject({ kind: z.literal('blocked'), code: zText(200) }),
]);

// Stores what the platform answered for a part's call; an answer for a key that is not a started call of the
// variant's current publish changes nothing.
export const threadRecord = defineCommand({
  name: 'social.thread.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zPartResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    const calls = (await threadCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
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
    const part = partOf(input.callKey);
    await ctx.emit(r.kind === 'accepted' ? 'social.variant.thread_part_posted' : 'social.variant.thread_failed', { post_id: v.post_id, variant_id: v.id, part, ...(r.kind === 'accepted' ? {} : { code: errorCode }) });
    return { recorded: true as const, state };
  },
});

// A person asks for the rest of the thread again (a part failed, its outcome is unclear and they checked it is not
// there, or the chain went quiet): the worker picks it up from the event, from the first part not out.
export const threadRetry = defineCommand({
  name: 'social.thread.retry',
  input: z.strictObject({ variantId: zId }),
  risk: 'R2',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const v = await lockVariant(ctx, input.variantId);
    // Only on a channel the caller may use (#1081).
    await refuseChannels(ctx, [v.channel_connection_id]);
    const parts = threadPartsOf(settingsOf(v));
    const calls = (await threadCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    const status = parts ? threadStatus(parts.length, calls, ctx.now, v.published_at) : null;
    if (v.status !== 'published' || !v.external_post_id || !status || (status.state !== 'failed' && status.state !== 'unknown')) {
      throw new DomainError('THREAD_NOT_RETRYABLE', 409, 'Chuỗi bài của kênh này không cần thử lại');
    }
    await ctx.emit('social.thread.retry_requested', { post_id: v.post_id, variant_id: v.id, provider: v.provider, after: status.lastKey });
    return { variantId: v.id };
  },
});

export const threadCommands = [threadBegin, threadRecord, threadRetry];
