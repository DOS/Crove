// YouTube playlists (#1018). After a variant with settings.youtube.playlistIds is published, the worker puts the video
// into each of those playlists, one external_call step a playlist (playlist_<n>, n its place in the list), recorded
// before the call, like a pin: an insert never touches the video, so a refused one (a playlist deleted since the post
// was written) leaves the variant published, and the post page shows it. One playlist's refusal does not stop the
// others. An unclear insert is a person's to check in YouTube, so none is tried again by itself.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { YOUTUBE_PLAYLISTS_MAX, isProvider, youtubePlaylistsOf, type Provider } from './domain/channels.ts';
import { callRevision, publishCallKey } from './domain/publish.ts';
import { COMMENT_STALE_MS, type CommentCall } from './comments.ts';
import { lockPost, lockVariants, settingsOf, variantPost, type Trx, type VariantRow } from './variants.ts';

export const PLAYLIST_STEP = 'playlist';
// The channels whose adapter adds a published video to playlists.
export const PLAYLIST_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['youtube']);
// What the YouTube adapter answers for a playlist that is gone, and for a grant without the scope to add to one.
export const PLAYLIST_NOT_FOUND = 'PLAYLIST_NOT_FOUND';
export const PLAYLIST_RECONNECT = 'RECONNECT_FOR_PLAYLISTS';
const PLAYLIST_KEY = /:playlist_(\d)$/;

export type PlaylistWork =
  | { action: 'none'; reason: string }
  | { action: 'call'; variantId: string; connectionId: string; callKey: string; externalId: string; playlistId: string; index: number };

type PlaylistVariant = Pick<VariantRow, 'id' | 'revision' | 'published_revision' | 'attempt'>;
const playlistKey = (v: PlaylistVariant, n: number) => publishCallKey(v.id, callRevision(v), v.attempt, `${PLAYLIST_STEP}_${n}`);
const playlistPrefix = (v: PlaylistVariant) => publishCallKey(v.id, callRevision(v), v.attempt, PLAYLIST_STEP);

// The place in the list (1 is the first playlist) a call key inserts into, or null for a key that is not an insert.
export const playlistIndexOf = (key: string): number | null => {
  const m = PLAYLIST_KEY.exec(key);
  return m ? Number(m[1]) : null;
};

// The playlists a variant's video goes into: its settings name them, on a channel that has playlists. Never more than
// the maximum, whatever was stored.
export function playlistsOf(v: { provider: string; settings: unknown }): string[] | null {
  if (!isProvider(v.provider) || !PLAYLIST_PROVIDERS.has(v.provider)) return null;
  const ids = youtubePlaylistsOf(settingsOf(v));
  return ids === null || ids === 'invalid' ? null : ids.slice(0, YOUTUBE_PLAYLISTS_MAX);
}

// The insert calls of each variant's current publish, in one query.
export async function playlistCallsOf(trx: Trx, orgId: string, variants: readonly PlaylistVariant[]): Promise<Map<string, CommentCall[]>> {
  const out = new Map<string, CommentCall[]>(variants.map((v) => [v.id, []]));
  if (variants.length === 0) return out;
  const prefixes = variants.map(playlistPrefix);
  const { rows } = await sql<CommentCall>`
    SELECT key, state, external_ref, error_code, started_at FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid AND key LIKE ANY(${prefixes.map((p) => `${p}\\_%`)}::text[])
    ORDER BY started_at, key`.execute(trx);
  for (const row of rows) {
    const i = prefixes.findIndex((p) => row.key.startsWith(`${p}_`));
    if (i >= 0 && playlistIndexOf(row.key) !== null) out.get((variants[i] as PlaylistVariant).id)?.push(row);
  }
  return out;
}

// What a variant's playlists show on the post screen: how many took the video, of how many, and the state of the rest.
// missing: a playlist is gone; reconnect: the channel was connected without the scope to add to playlists. A call or a
// job that went quiet past COMMENT_STALE_MS is unclear or failed, as for a first comment.
export type PlaylistState = 'pending' | 'added' | 'failed' | 'missing' | 'reconnect' | 'unknown';
export interface PlaylistStatus {
  state: PlaylistState;
  added: number;
  total: number;
}

export function playlistStatus(total: number, calls: readonly CommentCall[], now: Date, publishedAt: Date | null): PlaylistStatus {
  const quiet = (since: Date | null) => since !== null && now.getTime() - since.getTime() > COMMENT_STALE_MS;
  const states: PlaylistState[] = [];
  for (let n = 1; n <= total; n += 1) {
    const call = calls.find((c) => playlistIndexOf(c.key) === n);
    if (!call) states.push(quiet(publishedAt) ? 'failed' : 'pending');
    else if (call.state === 'succeeded') states.push('added');
    else if (call.state === 'failed') states.push(call.error_code === PLAYLIST_NOT_FOUND ? 'missing' : call.error_code === PLAYLIST_RECONNECT ? 'reconnect' : 'failed');
    else if (call.state === 'ambiguous') states.push('unknown');
    else states.push(quiet(call.started_at) ? 'unknown' : 'pending');
  }
  const added = states.filter((s) => s === 'added').length;
  // Still on its way while any insert is; once all are settled, the warning that asks the most of a person comes first.
  const order: PlaylistState[] = ['pending', 'reconnect', 'missing', 'failed', 'unknown'];
  const state = order.find((s) => states.includes(s)) ?? 'added';
  return { state, added, total };
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

// Decides whether the worker adds the video to its next playlist now, and records the call as started first. Once
// per playlist and publish: any call made, whatever came of it, settles that playlist.
export const playlistBegin = defineCommand({
  name: 'social.playlist.begin',
  input: z.strictObject({ variantId: zId, provider: z.string().min(1).max(32) }),
  // Commits the provider call as started; the worker then makes it, an effect outside Crove (#1578).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<PlaylistWork> => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    if (v.provider !== input.provider) return { action: 'none', reason: 'provider_mismatch' };
    const ids = playlistsOf(v);
    if (!ids) return { action: 'none', reason: 'no_playlists' };
    if (v.status !== 'published' || !v.external_post_id) return { action: 'none', reason: 'not_published' };
    const calls = (await playlistCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    const index = ids.findIndex((_, i) => !calls.some((c) => playlistIndexOf(c.key) === i + 1)) + 1;
    if (index === 0) return { action: 'none', reason: 'done' };
    const step = `${PLAYLIST_STEP}_${index}`;
    const callKey = playlistKey(v, index);
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step, retry_safety: 'never', request_hash: v.content_hash, started_at: ctx.now })
      .execute();
    return { action: 'call', variantId: v.id, connectionId: v.channel_connection_id, callKey, externalId: v.external_post_id, playlistId: ids[index - 1] as string, index };
  },
});

const zText = (max: number) => z.string().max(max);
const zPlaylistResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), externalId: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional(), message: zText(2000).optional() }),
  // Nothing was called: the channel's credential could not be used.
  z.strictObject({ kind: z.literal('blocked'), code: zText(200) }),
]);

// Stores what the platform answered for one insert call; an answer for a key that is not a started insert of the
// variant's current publish changes nothing. The variant itself is never touched: it stays published whatever the
// answer.
export const playlistRecord = defineCommand({
  name: 'social.playlist.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zPlaylistResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const v = await lockVariant(ctx, input.variantId);
    const ids = playlistsOf(v) ?? [];
    const index = playlistIndexOf(input.callKey);
    if (index === null || index > ids.length || input.callKey !== playlistKey(v, index)) return { recorded: false as const };
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
    const playlist = ids[index - 1] as string;
    await ctx.emit(r.kind === 'accepted' ? 'social.variant.playlist_added' : 'social.variant.playlist_failed', {
      post_id: v.post_id,
      variant_id: v.id,
      playlist_id: playlist,
      ...(r.kind === 'accepted' ? {} : { code: errorCode }),
    });
    return { recorded: true as const, state };
  },
});

export const playlistCommands = [playlistBegin, playlistRecord];
