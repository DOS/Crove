// Social figures of one org on the multi-client home (#1261), as Loomly's Master Calendar shows every client in one
// view: an agency sees which client has posts waiting for review or for the client, posts that need a person, channels
// to reconnect, what goes out in the next week and how long the org has been quiet, without opening each org.
//
// The kernel runs social.overview.figures in each org through the overview contribution below (kernel.org.overview,
// in the org's own transaction, as the member). Each figure is read as the screen it links to reads it, so a count
// equals what the member sees there: the Review and Attention tabs' lists (postFilterQuery, the same filter as
// social.post.list, at most the 200 posts those tabs count), the channels the attention inbox names as needing a
// reconnect (for owners and admins, who reconnect them, as the inbox shows them), the posts the Upcoming agenda shows
// going out in the next 7 days (a variant in AGENDA_STATUSES at its time), and the newest post that went out. A member
// limited to some channels (#1081) gets the figures of those channels only.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import type { OverviewContribution } from '@crove/kernel';
import { defineQuery } from '@crove/kernel-runtime';
import { ATTENTION_CHANNEL_STATUSES } from './attention-inbox.ts';
import { channelScope, connectionInScope, postInScope, type ChannelScope } from './channel-access.ts';
import { approvalsInRound } from './domain/approval.ts';
import { AGENDA_STATUSES } from './domain/state.ts';
import { approvalsRequired, decisionsOf } from './policy.ts';
import { postFilterQuery } from './post-filter.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const DAY = 86_400_000;
// The Review and Attention tabs count at most this many posts (their list's limit), and so does the home.
export const SOCIAL_FIGURE_MAX = 200;
// The window of "posts in the next days".
export const SOCIAL_NEXT_DAYS = 7;

export interface SocialClientFigures {
  // Posts with a channel in review (the Review tab).
  review: number;
  // Of those, posts with a channel whose team approvals are all in and that waits only for the client's approval on a
  // review link (#770), as the review shortcuts tell them apart (#1230).
  waitingClient: number;
  // Posts with a channel that failed, needs a person, or waits paused (the Attention tab, #579).
  attention: number;
  // Channels whose sign-in expired or broke (the attention inbox's channels, #771); 0 for members and viewers, who
  // cannot reconnect them.
  reconnect: number;
  // Posts with a channel set to go out in the next 7 days (the Upcoming agenda's lines).
  upcoming: number;
  // When a channel of a post last went out; null when none has.
  lastPostAt: string | null;
}

export function socialFiguresQuery(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return defineQuery({
    name: 'social.overview.figures',
    input: z.object({}),
    access: ALL,
    handler: async (ctx): Promise<SocialClientFigures> => {
      const scope = await channelScope(ctx);
      const count = async (q: ReturnType<typeof postFilterQuery>) => {
        const row = await ctx.trx.selectFrom(q.limit(SOCIAL_FIGURE_MAX).as('x')).select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
        return Number(row.n);
      };
      const from = now();
      const review = await count(postFilterQuery(ctx, scope, { stage: 'review' }));
      const attention = await count(postFilterQuery(ctx, scope, { stage: 'attention' }));
      const upcoming = await upcomingCount(ctx, scope, from, new Date(from.getTime() + SOCIAL_NEXT_DAYS * DAY));
      const admin = ctx.actor.type === 'user' && (ctx.role === 'owner' || ctx.role === 'admin');
      const reconnect = admin
        ? await ctx.trx
            .selectFrom('crove_kernel.channel_connection')
            .select(sql<string>`count(*)`.as('n'))
            .where('org_id', '=', ctx.orgId)
            .where('status', 'in', [...ATTENTION_CHANNEL_STATUSES])
            .executeTakeFirstOrThrow()
        : { n: '0' };
      const last = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select(sql<Date | null>`max(published_at)`.as('at'))
        .where('org_id', '=', ctx.orgId)
        .where('status', 'in', ['published', 'removed'])
        .where(connectionInScope(scope, 'channel_connection_id'))
        .executeTakeFirstOrThrow();
      return { review, waitingClient: await waitingClient(ctx, scope), attention, reconnect: Number(reconnect.n), upcoming, lastPostAt: last.at ? new Date(last.at).toISOString() : null };
    },
  });
}

// Posts the Upcoming agenda shows in [from, to): with a variant the member may use in AGENDA_STATUSES whose time (as
// the post view gives it: a retry, the queue slot, its own time, else the post's) falls in the window. At most
// SOCIAL_FIGURE_MAX, as the lists count.
async function upcomingCount(ctx: Parameters<typeof channelScope>[0], scope: ChannelScope, from: Date, to: Date): Promise<number> {
  const mine = connectionInScope(scope, 'v.channel_connection_id');
  const posts = ctx.trx
    .selectFrom('crove_social.post as p')
    .select('p.id')
    .where('p.org_id', '=', ctx.orgId)
    .where('p.archived_at', 'is', null)
    .where(postInScope(scope))
    .where(
      sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND ${mine} AND v.status IN (${sql.join([...AGENDA_STATUSES])}) AND coalesce(v.error_retry_at, v.queue_slot_at, v.scheduled_at, p.scheduled_at) >= ${from} AND coalesce(v.error_retry_at, v.queue_slot_at, v.scheduled_at, p.scheduled_at) < ${to})`,
    )
    .limit(SOCIAL_FIGURE_MAX);
  const row = await ctx.trx.selectFrom(posts.as('x')).select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
  return Number(row.n);
}

// Posts with a channel in review that waits only for the client: the channel asks for the client's approval and its
// current content has every team approval its policy asks for (an approval that completes the round with the client's
// yes already given moves the channel on, so in review it still waits for the client). Among the posts the Review tab
// lists: its first page, newest change first, of SOCIAL_FIGURE_MAX posts.
async function waitingClient(ctx: Parameters<typeof channelScope>[0], scope: ChannelScope): Promise<number> {
  const page = await postFilterQuery(ctx, scope, { stage: 'review' })
    .orderBy(sql`date_trunc('milliseconds', p.updated_at)`, 'desc')
    .orderBy('p.id', 'desc')
    .limit(SOCIAL_FIGURE_MAX)
    .execute();
  if (page.length === 0) return 0;
  const rows = await ctx.trx
    .selectFrom('crove_social.post_variant as v')
    .innerJoin('crove_social.channel_policy as cp', (j) => j.onRef('cp.org_id', '=', 'v.org_id').onRef('cp.channel_connection_id', '=', 'v.channel_connection_id'))
    .select(['v.id', 'v.post_id', 'v.channel_connection_id', 'v.revision', 'v.content_hash'])
    .where('v.org_id', '=', ctx.orgId)
    .where(
      'v.post_id',
      'in',
      page.map((r) => r.id),
    )
    .where('v.status', '=', 'in_review')
    .where('cp.client_approval', '=', true)
    .where(connectionInScope(scope, 'v.channel_connection_id'))
    .execute();
  if (rows.length === 0) return 0;
  const required = await approvalsRequired(ctx.trx, ctx.orgId, [...new Set(rows.map((r) => r.channel_connection_id))]);
  const decisions = await decisionsOf(
    ctx.trx,
    ctx.orgId,
    rows.map((r) => r.id),
  );
  const posts = new Set<string>();
  for (const r of rows) {
    const given = approvalsInRound(decisions.get(r.id) ?? [], { revision: r.revision, contentHash: r.content_hash });
    if (given.length >= (required.get(r.channel_connection_id) ?? 1)) posts.add(r.post_id);
  }
  return posts.size;
}

export const socialFigures = socialFiguresQuery();

export const clientOverviewQueries = [socialFigures];

// Registered by the composition root when CROVE_MODULES enables Social (#1261).
export const socialOverviewContributions: readonly OverviewContribution[] = [{ module: 'social', query: socialFigures.name }];
