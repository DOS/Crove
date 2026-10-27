// The posting calendar as a feed (#862): owners and admins make a secret address that Google Calendar or Outlook
// subscribes to, and see what goes out next to their own events. An org has one live feed; making a new one revokes
// the old, so a leaked address is cut off by making another. The token is shown once, to the person who made it; the
// database keeps only its SHA-256, as for report links (#643), whose token helpers it reuses. The public side is the
// migration's definer (calendar_feed_events), which the HTTP edge calls with the token.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { newReportToken, reportTokenHash } from './report-links.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// Revokes the org's live feed, if any; true when there was one.
async function revokeLive(ctx: CommandContext, userId: string): Promise<boolean> {
  const done = await ctx.trx
    .updateTable('crove_social.calendar_feed')
    .set({ revoked_at: ctx.now, revoked_by: userId })
    .where('org_id', '=', ctx.orgId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  return done.length > 0;
}

export const calendarFeedCreate = defineCommand({
  name: 'social.calendar_feed.create',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx) => {
    const userId = requireUser(ctx);
    // One create at a time per org, so the revoke below always frees the one live slot.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.calendar_feed:${ctx.orgId}`}))`.execute(ctx.trx);
    await revokeLive(ctx, userId);
    const token = newReportToken();
    await ctx.trx.insertInto('crove_social.calendar_feed').values({ org_id: ctx.orgId, token_sha256: reportTokenHash(token), created_by: userId, created_at: ctx.now }).execute();
    // The token leaves only in this answer: the audit keeps the input, never the output.
    return { token };
  },
});

export const calendarFeedRevoke = defineCommand({
  name: 'social.calendar_feed.revoke',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx) => ({ revoked: await revokeLive(ctx, requireUser(ctx)) }),
});

export interface CalendarFeedView {
  createdAt: string;
  createdBy: string;
}

// Whether the org has a live feed, and who made it when (never its token).
export const calendarFeedGet = defineQuery({
  name: 'social.calendar_feed.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<CalendarFeedView | null> => {
    const row = await ctx.trx.selectFrom('crove_social.calendar_feed').select(['created_at', 'created_by']).where('org_id', '=', ctx.orgId).where('revoked_at', 'is', null).executeTakeFirst();
    return row ? { createdAt: row.created_at.toISOString(), createdBy: row.created_by } : null;
  },
});

export const calendarFeedCommands = [calendarFeedCreate, calendarFeedRevoke];
export const calendarFeedQueries = [calendarFeedGet];
