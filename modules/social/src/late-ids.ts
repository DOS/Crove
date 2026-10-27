// TikTok posts that get their public id later (#1475; the rules are in domain/late-ids.ts). Every 15 minutes the worker
// lists the published TikTok variants still waiting for their id or for the creator to post their inbox draft
// (crove_social.late_id_due, across orgs), asks TikTok's status for each through the adapter's lateId (status/fetch, a
// read: nothing is posted and no call is written to the ledger), and records the answer under the post's lock:
// - the public id (and the address video/query gives, with video.list): the variant keeps it as its external_post_id,
//   so the metrics sweep reads its counts, and a draft posted in the app loses its SENT_TO_APP note;
// - an inbox draft posted with no public id yet: the note goes, and the publish_id stands in for the id until it comes;
// - anything else: asked again later. After 7 days, or once TikTok fails the post, the asking stops: a public post gets
//   the TIKTOK_NO_POST_ID note, a draft never posted keeps SENT_TO_APP.
// A token TikTok refuses marks the connection expired, as the other sweeps do. Credentials stay in the worker
// (ADR-0025): the sweep opens the connection's token with kernel.channel.credential; the commands never see it.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db } from '@crove/db';
import type { LateIdResult, Publisher } from '@crove/channel';
import { DomainError, defineCommand, defineQuery, type CommandContext, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { callRevision, publishCallKey } from './domain/publish.ts';
import { TIKTOK_NO_POST_ID, TIKTOK_POST_ID, lateIdNextCheck, lateIdOver, lateIdStopped, lateIdWait } from './domain/late-ids.ts';
import { lockPost, lockVariants, setVariant, settingsOf, type VariantRow } from './variants.ts';
import { eachBounded } from './metrics.ts';
import { PUBLISH_STEP } from './publishing.ts';

const ACTOR: SystemActor = { type: 'system', component: 'social.late_ids' };
export const LATE_ID_SWEEP_MS = 15 * 60_000;
// Variants asked about per pass, at most.
const LATE_ID_LIMIT = 100;

function requireSystem(ctx: { actor: { type: string } }): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
}

type Waiting = Pick<VariantRow, 'id' | 'provider' | 'status' | 'settings' | 'external_post_id' | 'error_code' | 'published_at' | 'revision' | 'published_revision' | 'attempt'>;

// The publish_id TikTok knows the post by: the variant's external_post_id while it waits for its public id, or, for a
// draft in the app (recorded with no post id), the one its publish call kept on the call ledger.
async function publishIdOf(trx: CommandContext['trx'], orgId: string, v: Waiting, wait: 'sent_to_app' | 'no_id'): Promise<string | null> {
  if (wait === 'no_id') return v.external_post_id;
  const call = await trx
    .selectFrom('crove_kernel.external_call')
    .select('external_ref')
    .where('org_id', '=', orgId)
    .where('key', '=', publishCallKey(v.id, callRevision(v), v.attempt, PUBLISH_STEP))
    .where('state', '=', 'succeeded')
    .executeTakeFirst();
  return call?.external_ref ?? null;
}

export interface LateIdTarget {
  connectionId: string;
  // The connection's updated_at as read now: a refused token marks it expired only if it has not changed since.
  connectionVersion: string;
  scopes: string[];
  publishId: string;
  // When it went out: once the 7 days are over, the end is recorded without asking TikTok.
  publishedAt: string;
}

// What the sweep needs to ask TikTok about a variant: its channel, the publish_id and when it went out; null when
// it no longer waits for anything (settled, removed, edited since the scan).
export const lateIdTarget = defineQuery({
  name: 'social.late_id.target',
  input: z.strictObject({ variantId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<LateIdTarget | null> => {
    requireSystem(ctx);
    const v = await ctx.trx
      .selectFrom('crove_social.post_variant as v')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'v.org_id').onRef('c.id', '=', 'v.channel_connection_id'))
      .select([
        'v.id',
        'v.provider',
        'v.status',
        'v.settings',
        'v.external_post_id',
        'v.error_code',
        'v.published_at',
        'v.revision',
        'v.published_revision',
        'v.attempt',
        'v.channel_connection_id',
        'c.status as connection_status',
        'c.updated_at as connection_version',
        'c.scopes',
      ])
      .where('v.org_id', '=', ctx.orgId)
      .where('v.id', '=', input.variantId)
      .executeTakeFirst();
    if (!v || v.connection_status !== 'active') return null;
    const wait = lateIdWait({ ...v, settings: settingsOf(v) });
    if (!wait || !v.published_at) return null;
    const publishId = await publishIdOf(ctx.trx, ctx.orgId, v, wait);
    if (!publishId) return null;
    return { connectionId: v.channel_connection_id, connectionVersion: v.connection_version.toISOString(), scopes: [...v.scopes], publishId, publishedAt: v.published_at.toISOString() };
  },
});

const zLateResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('posted'), externalId: z.string().regex(TIKTOK_POST_ID), url: z.url({ protocol: /^https$/ }).max(2000).nullable() }),
  z.strictObject({ kind: z.literal('posted_without_id') }),
  z.strictObject({ kind: z.literal('waiting') }),
  z.strictObject({ kind: z.literal('failed'), code: z.string().min(1).max(100) }),
  // TikTok gave no answer worth keeping (an outage, a rate limit, a refused token): asked again at the next turn.
  z.strictObject({ kind: z.literal('no_answer') }),
  // The 7 days are over.
  z.strictObject({ kind: z.literal('over') }),
]);
export type LateIdRecord = z.infer<typeof zLateResult>;

// Records what TikTok said about a published variant waiting for its id, under its post's lock, for the publish_id the
// sweep asked about; a variant that no longer waits, or now goes by another publish_id, is left as it is.
export const lateIdRecord = defineCommand({
  name: 'social.late_id.record',
  input: z.strictObject({ variantId: zId, publishId: z.string().min(1).max(500), result: zLateResult }),
  // Writes what the platform reported into Crove: internal, so R1 (#1578).
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const found = await ctx.trx.selectFrom('crove_social.post_variant').select('post_id').where('org_id', '=', ctx.orgId).where('id', '=', input.variantId).executeTakeFirst();
    if (!found) return { recorded: false as const, reason: 'not_found' };
    const post = await lockPost(ctx.trx, ctx.orgId, found.post_id);
    const v = (await lockVariants(ctx.trx, ctx.orgId, post.id)).find((x) => x.id === input.variantId);
    const wait = v ? lateIdWait({ ...v, settings: settingsOf(v) }) : null;
    if (!v || !wait || !v.published_at) return { recorded: false as const, reason: 'stale' };
    const publishId = await publishIdOf(ctx.trx, ctx.orgId, v, wait);
    if (publishId !== input.publishId) return { recorded: false as const, reason: 'stale' };
    const r = input.result;
    if (r.kind === 'over' && !lateIdOver(v.published_at, ctx.now)) return { recorded: false as const, reason: 'invalid' };
    // A turn that changes nothing anyone sees moves only the next check, not updated_at.
    const later = (at: Date) => ctx.trx.updateTable('crove_social.post_variant').set({ next_check_at: at }).where('org_id', '=', ctx.orgId).where('id', '=', v.id).execute();
    const next = lateIdNextCheck(v.published_at, ctx.now);
    const event = { post_id: post.id, variant_id: v.id, posted_in_app: wait === 'sent_to_app' };
    switch (r.kind) {
      case 'posted':
        // Out with its public id: the metrics sweep reads its counts from now on, and the note of a draft goes.
        await setVariant(ctx, v.id, { external_post_id: r.externalId, external_url: r.url, error_code: null, next_check_at: null });
        await ctx.emit('social.variant.published_late', { ...event, with_id: true });
        return { recorded: true as const, outcome: 'id' };
      case 'posted_without_id':
        if (wait === 'sent_to_app') {
          // The creator posted the draft; its public id comes with moderation (or never, for a post not public). Known
          // by its publish_id meanwhile, as a direct post is.
          await setVariant(ctx, v.id, { external_post_id: publishId, error_code: null, next_check_at: next });
          await ctx.emit('social.variant.published_late', { ...event, with_id: false });
          return { recorded: true as const, outcome: 'posted' };
        }
        await later(next);
        return { recorded: true as const, outcome: 'waiting' };
      case 'waiting':
      case 'no_answer':
        await later(next);
        return { recorded: true as const, outcome: 'waiting' };
      case 'failed':
      case 'over':
        // Asked for the last time. A public post says it never got its id; a draft never posted keeps its note.
        if (wait === 'no_id') {
          await setVariant(ctx, v.id, { error_code: TIKTOK_NO_POST_ID, next_check_at: null });
          await ctx.emit('social.variant.late_id_missing', { post_id: post.id, variant_id: v.id, code: r.kind === 'failed' ? r.code : 'TIMED_OUT' });
        } else {
          await later(lateIdStopped(v.published_at));
        }
        return { recorded: true as const, outcome: 'stopped' };
    }
  },
});

export const lateIdCommands = [lateIdRecord];
export const lateIdQueries = [lateIdTarget];

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export interface LateIdDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  publishers: Readonly<Record<string, Publisher>>;
}

// What the record command takes for an adapter's answer; a refused token is the connection's, asked again later.
const recordOf = (answer: LateIdResult): LateIdRecord => (!answer || answer.kind === 'refused' ? { kind: 'no_answer' } : answer);

// One pass: the variants due a check are asked about, each on its own, at most LATE_ID_LIMIT.
export async function sweepLateIds(deps: LateIdDeps): Promise<{ checked: number; settled: number; expired: number; skipped: number }> {
  const out = { checked: 0, settled: 0, expired: 0, skipped: 0 };
  const publisher = deps.publishers.tiktok;
  if (!publisher?.lateId) return out;
  const { rows } = await sql<{ org_id: string; variant_id: string }>`
    SELECT org_id, variant_id FROM crove_social.late_id_due(${LATE_ID_LIMIT}::int)`.execute(deps.workerDb);
  await eachBounded(
    rows.map((r) => ({ ...r, provider: 'tiktok' })),
    async (row) => {
      const options = { actor: ACTOR, orgId: row.org_id };
      let target: LateIdTarget | null = null;
      try {
        target = await deps.runtime.query<LateIdTarget | null>('social.late_id.target', { variantId: row.variant_id }, options);
        if (!target) {
          out.skipped += 1;
          return;
        }
        let result: LateIdRecord = { kind: 'over' };
        if (!lateIdOver(new Date(target.publishedAt), new Date())) {
          const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.connectionId }, options);
          const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: row.org_id, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
          const answer = await publisher.lateId?.({ externalAccountId: sealed.externalAccountId, secret, externalRef: target.publishId, scopes: target.scopes });
          if (answer?.kind === 'refused') {
            // The connection needs reconnecting, unless it changed since (a reconnect brought a new token).
            const done = await deps.runtime.execute<{ status: string }>('kernel.channel.mark_expired', { connectionId: target.connectionId, reason: 'token_expired', ifVersion: target.connectionVersion }, options);
            if (done.status === 'expired') out.expired += 1;
          }
          result = recordOf(answer ?? null);
          out.checked += 1;
        }
        const done = await deps.runtime.execute<{ recorded: boolean; outcome?: string }>('social.late_id.record', { variantId: row.variant_id, publishId: target.publishId, result }, options);
        if (done.outcome === 'id' || done.outcome === 'posted' || done.outcome === 'stopped') out.settled += 1;
      } catch (error) {
        // A connection whose owner left, or a credential that will not open: nothing to ask; the publish path reports it.
        if (!(error instanceof DomainError)) console.warn(`[social-late-ids] variant ${row.variant_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
        out.skipped += 1;
        // Kept as a turn all the same, so a variant that keeps failing waits for its next check.
        if (target) await deps.runtime.execute('social.late_id.record', { variantId: row.variant_id, publishId: target.publishId, result: { kind: 'no_answer' } }, options).catch(() => undefined);
      }
    },
  );
  return out;
}
