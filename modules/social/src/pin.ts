// Pinned posts (#982, Telegram). After a variant with settings.telegram.pin is published, the worker pins it to the top
// of its channel once, as its own external_call step (pin) next to the publish call, like a first comment: the pin
// never touches the post, so a refused pin (the bot may not pin there) leaves the variant published, and the post page
// shows it. An album is pinned by its first message, the one publish returned. Telegram cannot be asked whether an
// unclear pin went through (a person sees it in the channel), so a pin is never tried again by itself.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { isProvider, telegramOptionsOf, type Provider } from './domain/channels.ts';
import { callRevision, publishCallKey } from './domain/publish.ts';
import { COMMENT_STALE_MS, type CommentCall } from './comments.ts';
import { lockPost, lockVariants, settingsOf, variantPost, type Trx, type VariantRow } from './variants.ts';

export const PIN_STEP = 'pin';
// The channels whose adapter pins a published post.
export const PIN_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['telegram']);
// What the Telegram adapter answers when the bot lacks the right to pin.
export const PIN_NOT_ALLOWED = 'TELEGRAM_CANNOT_PIN';

export type PinWork = { action: 'none'; reason: string } | { action: 'call'; variantId: string; connectionId: string; callKey: string; externalId: string; silent: boolean };

type PinVariant = Pick<VariantRow, 'id' | 'revision' | 'published_revision' | 'attempt'>;
const pinKey = (v: PinVariant) => publishCallKey(v.id, callRevision(v), v.attempt, PIN_STEP);

// Whether a variant asks for a pin: its settings say so, on a channel that pins.
export function wantsPin(v: { provider: string; settings: unknown }): boolean {
  const options = telegramOptionsOf(settingsOf(v));
  return isProvider(v.provider) && PIN_PROVIDERS.has(v.provider) && options !== null && options !== 'invalid' && options.pin;
}

// The pin call of each variant's current publish (one at most each), in one query.
export async function pinCallsOf(trx: Trx, orgId: string, variants: readonly PinVariant[]): Promise<Map<string, CommentCall>> {
  const out = new Map<string, CommentCall>();
  if (variants.length === 0) return out;
  const keys = new Map(variants.map((v) => [pinKey(v), v.id]));
  const { rows } = await sql<CommentCall>`
    SELECT key, state, external_ref, error_code, started_at FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid AND key = ANY(${[...keys.keys()]}::text[])`.execute(trx);
  for (const row of rows) {
    const id = keys.get(row.key);
    if (id) out.set(id, row);
  }
  return out;
}

// What a variant's pin shows on the post screen. not_allowed: the bot may not pin in the channel. A call or a job that
// went quiet past COMMENT_STALE_MS is unclear or failed, as for a first comment.
export type PinStatus = 'pending' | 'pinned' | 'failed' | 'not_allowed' | 'unknown';
export function pinStatus(call: CommentCall | undefined, now: Date, publishedAt: Date | null): PinStatus {
  if (!call) return publishedAt !== null && now.getTime() - publishedAt.getTime() > COMMENT_STALE_MS ? 'failed' : 'pending';
  if (call.state === 'succeeded') return 'pinned';
  if (call.state === 'failed') return call.error_code === PIN_NOT_ALLOWED ? 'not_allowed' : 'failed';
  if (call.state === 'ambiguous') return 'unknown';
  return now.getTime() - call.started_at.getTime() > COMMENT_STALE_MS ? 'unknown' : 'pending';
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

// Decides whether the worker pins the post now, and records the call as started first. Once per publish: any call
// made, whatever came of it, settles the pin.
export const pinBegin = defineCommand({
  name: 'social.pin.begin',
  input: z.strictObject({ variantId: zId, provider: z.string().min(1).max(32) }),
  // Commits the provider call as started; the worker then makes it, an effect outside Crove (#1578).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<PinWork> => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    if (v.provider !== input.provider) return { action: 'none', reason: 'provider_mismatch' };
    if (!wantsPin(v)) return { action: 'none', reason: 'no_pin' };
    if (v.status !== 'published' || !v.external_post_id) return { action: 'none', reason: 'not_published' };
    const callKey = pinKey(v);
    const made = await ctx.trx.selectFrom('crove_kernel.external_call').select('key').where('org_id', '=', ctx.orgId).where('key', '=', callKey).executeTakeFirst();
    if (made) return { action: 'none', reason: 'done' };
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step: PIN_STEP, retry_safety: 'never', request_hash: v.content_hash, started_at: ctx.now })
      .execute();
    const options = telegramOptionsOf(settingsOf(v));
    const silent = options !== null && options !== 'invalid' && options.silent;
    return { action: 'call', variantId: v.id, connectionId: v.channel_connection_id, callKey, externalId: v.external_post_id, silent };
  },
});

const zText = (max: number) => z.string().max(max);
const zPinResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional(), message: zText(2000).optional() }),
  // Nothing was called: the channel's credential could not be used.
  z.strictObject({ kind: z.literal('blocked'), code: zText(200) }),
]);

// Stores what the platform answered for the pin call; an answer for a key that is not a started call changes nothing.
// The variant itself is never touched: it stays published whatever the pin's answer.
export const pinRecord = defineCommand({
  name: 'social.pin.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zPinResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    if (input.callKey !== pinKey(v)) return { recorded: false as const };
    const r = input.result;
    const state = r.kind === 'accepted' ? 'succeeded' : r.kind === 'unknown' ? 'ambiguous' : 'failed';
    const errorCode = r.kind === 'accepted' ? null : r.kind === 'unknown' ? (r.code ?? 'OUTCOME_UNKNOWN') : (r.code ?? null);
    const values: Record<string, unknown> =
      r.kind === 'accepted'
        ? { state, external_ref: r.externalId, finished_at: ctx.now }
        : { state, error_kind: r.kind === 'unknown' ? 'unknown' : r.kind === 'blocked' ? (r.code === 'CHANNEL_NOT_ACTIVE' ? 'token_expired' : 'permission') : r.error, error_code: errorCode, ...(state === 'failed' ? { finished_at: ctx.now } : {}) };
    const updated = await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set({ ...values, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.callKey)
      .where('state', '=', 'started')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) return { recorded: false as const };
    await ctx.emit(r.kind === 'accepted' ? 'social.variant.pinned' : 'social.variant.pin_failed', { post_id: v.post_id, variant_id: v.id, ...(r.kind === 'accepted' ? {} : { code: errorCode }) });
    return { recorded: true as const, state };
  },
});

export const pinCommands = [pinBegin, pinRecord];
