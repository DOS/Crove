// A hold on all of the org's publishing (#946), for a crisis or a mourning day, as Hootsuite's "suspend all scheduled"
// and Sprout's "pause publishing" do. A queue pause leaves posts set for an exact time going out; a hold stops every
// one. Owners and admins put it on with a reason (social.publishing.hold) and take it off (social.publishing.release),
// both R2 and audited with the reason; every member reads it (social.publishing.hold_get) for the banner.
//
// While a hold is live nothing of the org goes out: the publish step, the status check of a channel whose check posts
// the processed upload (STATUS_PUBLISHES: Instagram, Threads) and the post-publish actions (first comments, thread
// parts, auto-replies, reposts) answer "held" and leave everything as it was, and the scans skip the org, so no
// evergreen repost piles up for review. A takedown still goes: removing a post is often what a crisis asks for.
// On release, posts still due go out on the next sweep, once each (the variants never left scheduled). A variant whose
// time passed more than an hour before the release does not go out by itself: it fails with HELD_TOO_LONG, where a
// person publishes it now, edits it or cancels it, so a hold over a morning does not flood the afternoon with stale
// posts. A variant waiting in a paused queue is left to its queue.
//
// One live hold per org: the commands take a per-org advisory lock, and the publish commands take the same lock shared
// before anything else, so once a hold commits no publish step of the org begins (a call begun just before it finishes).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { CLEAR_ERROR, lockPost, lockVariants, refreshPostStatus, setVariant, step, type Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const HOLD_REASON_MAX = 500;
// The error code of a variant the hold kept more than HELD_TOO_LONG_MS past its time.
export const HELD_TOO_LONG = 'HELD_TOO_LONG';
export const HELD_TOO_LONG_MS = 60 * 60_000;

export const zHoldReason = z.string().trim().min(1).max(HOLD_REASON_MAX);

const lockKey = (orgId: string) => `crove_social.publish_hold:${orgId}`;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

interface HoldRow {
  id: string;
  reason: string;
  held_by: string;
  held_at: Date;
}

async function liveHold(trx: Trx, orgId: string): Promise<HoldRow | undefined> {
  return trx
    .selectFrom('crove_social.publish_hold')
    .select(['id', 'reason', 'held_by', 'held_at'])
    .where('org_id', '=', orgId)
    .where('released_at', 'is', null)
    .orderBy('held_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

/**
 * Whether the org's publishing is held, for a command about to send something. Takes the hold's lock shared first, so
 * a hold or a release in progress commits before the answer; call it before locking any post.
 */
export async function publishingHeld(ctx: Pick<CommandContext, 'trx' | 'orgId'>): Promise<boolean> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext(${lockKey(ctx.orgId)}))`.execute(ctx.trx);
  return (await liveHold(ctx.trx, ctx.orgId)) !== undefined;
}

async function lockHolds(ctx: CommandContext): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${lockKey(ctx.orgId)}))`.execute(ctx.trx);
}

export const publishingHold = defineCommand({
  name: 'social.publishing.hold',
  input: z.strictObject({ reason: zHoldReason }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    await lockHolds(ctx);
    // A second hold while one is live changes nothing and answers the live one.
    const live = await liveHold(ctx.trx, ctx.orgId);
    if (live) return { holdId: live.id, heldAt: live.held_at.toISOString(), created: false };
    const row = await ctx.trx
      .insertInto('crove_social.publish_hold')
      // held_at and released_at from the database clock (its default, now()), so the row's order check never compares
      // the clocks of two app instances.
      .values({ org_id: ctx.orgId, reason: input.reason, held_by: userId })
      .returning(['id', 'held_at'])
      .executeTakeFirstOrThrow();
    ctx.audit({ hold_id: row.id, reason: input.reason });
    await ctx.emit('social.publishing.held', { hold_id: row.id });
    return { holdId: row.id, heldAt: row.held_at.toISOString(), created: true };
  },
});

// Fails, with HELD_TOO_LONG, the scheduled variants of the org due more than HELD_TOO_LONG_MS before now, except one
// waiting in a paused queue (its queue holds it, not this hold). Posts are locked one by one in id order, as every
// command locks a post before its variants. Returns how many variants failed.
async function failStale(ctx: CommandContext): Promise<number> {
  const cutoff = new Date(ctx.now.getTime() - HELD_TOO_LONG_MS);
  const stale = (postId: string | null) => sql<{ id: string; post_id: string }>`
    SELECT v.id, v.post_id FROM crove_social.post_variant v
    WHERE v.org_id = ${ctx.orgId}::uuid AND v.status = 'scheduled' AND (${postId}::uuid IS NULL OR v.post_id = ${postId}::uuid)
      AND coalesce(v.error_retry_at, v.scheduled_at, v.queue_slot_at) < ${cutoff}
      AND NOT (v.error_retry_at IS NULL AND v.scheduled_at IS NULL AND EXISTS (
        SELECT 1 FROM crove_social.queue q
        WHERE q.org_id = v.org_id AND q.channel_connection_id = v.channel_connection_id AND q.paused))
    ORDER BY v.post_id, v.id`;
  const { rows } = await stale(null).execute(ctx.trx);
  const posts = [...new Set(rows.map((r) => r.post_id))];
  let failed = 0;
  for (const postId of posts) {
    await lockPost(ctx.trx, ctx.orgId, postId);
    const variants = new Map((await lockVariants(ctx.trx, ctx.orgId, postId)).map((v) => [v.id, v]));
    // Read again under the post's lock: a person may have moved one meanwhile.
    for (const { id } of (await stale(postId).execute(ctx.trx)).rows) {
      const v = variants.get(id);
      if (!v) continue;
      await setVariant(ctx, id, { ...CLEAR_ERROR, status: step(v, { type: 'held_too_long' }), error_code: HELD_TOO_LONG });
      failed += 1;
    }
    await refreshPostStatus(ctx, postId);
  }
  return failed;
}

export const publishingRelease = defineCommand({
  name: 'social.publishing.release',
  input: z.strictObject({}),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx) => {
    const userId = requireUser(ctx);
    await lockHolds(ctx);
    const live = await liveHold(ctx.trx, ctx.orgId);
    if (!live) return { released: false, heldTooLong: 0 };
    await ctx.trx
      .updateTable('crove_social.publish_hold')
      .set({ released_by: userId, released_at: sql<Date>`pg_catalog.now()` })
      .where('org_id', '=', ctx.orgId)
      .where('released_at', 'is', null)
      .execute();
    const heldTooLong = await failStale(ctx);
    ctx.audit({ hold_id: live.id, reason: live.reason, held_too_long: heldTooLong });
    await ctx.emit('social.publishing.released', { hold_id: live.id, held_too_long: heldTooLong });
    return { released: true, heldTooLong };
  },
});

export interface PublishHoldView {
  held: boolean;
  hold: { id: string; reason: string; heldBy: string; heldByName: string | null; heldAt: string } | null;
}

// The live hold, for every member: who put it on, when and why.
export const publishingHoldGet = defineQuery({
  name: 'social.publishing.hold_get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<PublishHoldView> => {
    const live = await liveHold(ctx.trx, ctx.orgId);
    if (!live) return { held: false, hold: null };
    // The name while they are a member (crove_kernel.member_profiles answers only members of the org).
    const { rows } = await sql<{ email: string; display_name: string | null }>`
      SELECT email, display_name FROM crove_kernel.member_profiles(${[live.held_by]}::uuid[])`.execute(ctx.trx);
    const who = rows[0];
    return { held: true, hold: { id: live.id, reason: live.reason, heldBy: live.held_by, heldByName: who ? (who.display_name ?? who.email) : null, heldAt: live.held_at.toISOString() } };
  },
});

export const publishHoldCommands = [publishingHold, publishingRelease];
export const publishHoldQueries = [publishingHoldGet];
