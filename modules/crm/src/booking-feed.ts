// A member's bookings as a feed (#1382, plan docs/plan/calendar.md §2): a member who hosts makes a secret address that
// Google Calendar, Outlook or Apple Calendar subscribes to, and sees their Crove bookings next to their own events.
// Each member has one live feed, for their own bookings only; making a new one revokes the old, so a leaked address is
// cut off by making another. The token is shown once, to the member; the database keeps only its SHA-256, as for the
// posting calendar feed (#862). The public side is the migration's definer (booking_feed_events), which the HTTP edge
// calls with the token on GET /cal/<token>.ics.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

// Who may have a feed: anyone who can host a booking.
const HOSTS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// 32 random bytes, base64url without padding (43 characters, the shape the definer accepts).
export const newFeedToken = () => randomBytes(32).toString('base64url');
export const feedTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// Revokes the member's live feed, if any; true when there was one.
async function revokeLive(ctx: CommandContext, userId: string): Promise<boolean> {
  const done = await ctx.trx
    .updateTable('crove_crm.booking_feed')
    .set({ revoked_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  return done.length > 0;
}

export const bookingFeedCreate = defineCommand({
  name: 'crm.booking_feed.create',
  input: z.strictObject({}),
  risk: 'R1',
  access: HOSTS,
  handler: async (ctx) => {
    const userId = requireUser(ctx);
    // One create at a time per member, so the revoke below always frees the one live slot.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_crm.booking_feed:${ctx.orgId}:${userId}`}, 0))`.execute(ctx.trx);
    await revokeLive(ctx, userId);
    const token = newFeedToken();
    await ctx.trx.insertInto('crove_crm.booking_feed').values({ org_id: ctx.orgId, user_id: userId, token_sha256: feedTokenHash(token), created_at: ctx.now }).execute();
    // The token leaves only in this answer: the audit keeps the input, never the output.
    return { token };
  },
});

export const bookingFeedRevoke = defineCommand({
  name: 'crm.booking_feed.revoke',
  input: z.strictObject({}),
  risk: 'R1',
  access: HOSTS,
  handler: async (ctx) => ({ revoked: await revokeLive(ctx, requireUser(ctx)) }),
});

export interface BookingFeedView {
  createdAt: string;
}

// Whether the member asking has a live feed, and since when (never its token).
export const bookingFeedGet = defineQuery({
  name: 'crm.booking_feed.get',
  input: z.object({}),
  access: HOSTS,
  handler: async (ctx): Promise<BookingFeedView | null> => {
    if (ctx.actor.type !== 'user') return null;
    const row = await ctx.trx
      .selectFrom('crove_crm.booking_feed')
      .select('created_at')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return row ? { createdAt: row.created_at.toISOString() } : null;
  },
});

export const bookingFeedCommands = [bookingFeedCreate, bookingFeedRevoke];
export const bookingFeedQueries = [bookingFeedGet];
