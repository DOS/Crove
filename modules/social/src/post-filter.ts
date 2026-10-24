// Which posts the Social lists show for a filter (#574, #579, #1081, #1300): the one place social.post.list and the
// multi-client home's figures (#1261, client-overview.ts) decide it, so a count on the home equals the list it opens.
// Archived posts (#1299) are left out of every list, the calendar and the board, and are the only ones listed with
// archived.
import { sql } from 'kysely';
import type { QueryContext } from '@crove/kernel-runtime';
import { connectionInScope, postInScope, type ChannelScope } from './channel-access.ts';
import { likeTerm } from './library.ts';

export interface PostFilter {
  from?: string | undefined;
  to?: string | undefined;
  status?: 'draft' | 'scheduled' | 'publishing' | 'published' | 'partially_published' | 'failed' | 'cancelled' | undefined;
  stage?: 'review' | 'drafts' | 'done' | 'attention' | undefined;
  connectionId?: string | undefined;
  labelId?: string | undefined;
  // Whose posts (#640, #1300): assigned to or written by the viewer ('me') or a member (their id). The caller checks
  // that an id is a member of the org (memberFilterProblem) before.
  assignee?: string | undefined;
  author?: string | undefined;
  undated?: true | undefined;
  // Archived posts only (#1299); without it, none.
  archived?: true | undefined;
  search?: string | undefined;
}

const NOBODY = '00000000-0000-0000-0000-000000000000';
// The user a member filter names: the viewer for 'me' (nobody outside a user context), else the id given.
const memberOf = (ctx: Pick<QueryContext, 'actor'>, value: string) => (value !== 'me' ? value : ctx.actor.type === 'user' ? ctx.actor.userId : NOBODY);

// The member ids of the filter that are not members of the org (crove_kernel.member_profiles answers for members
// only), so the list refuses a filter on someone else's org or a stranger. 'me' needs no check.
export async function membersOutside(ctx: Pick<QueryContext, 'trx'>, input: Pick<PostFilter, 'assignee' | 'author'>): Promise<string[]> {
  const ids = [...new Set([input.assignee, input.author].filter((v): v is string => v !== undefined && v !== 'me'))];
  if (ids.length === 0) return [];
  const { rows } = await sql<{ user_id: string }>`SELECT user_id FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(ctx.trx);
  const members = new Set(rows.map((r) => r.user_id));
  return ids.filter((id) => !members.has(id));
}

// The ids of the posts the filter keeps, unordered and unpaged. A member limited to some channels (#1081) gets the
// posts with a variant there, and every filter on a variant looks at those variants only. The caller refuses a
// connectionId outside the scope before (it lists nothing).
export function postFilterQuery(ctx: Pick<QueryContext, 'trx' | 'orgId' | 'actor'>, scope: ChannelScope, input: PostFilter) {
  const mine = connectionInScope(scope, 'v.channel_connection_id');
  let q = ctx.trx
    .selectFrom('crove_social.post as p')
    .select('p.id')
    .where('p.org_id', '=', ctx.orgId)
    .where('p.archived_at', input.archived ? 'is not' : 'is', null)
    .where(postInScope(scope));
  if (input.status) q = q.where('p.status', '=', input.status);
  if (input.assignee) q = q.where('p.assignee_user_id', '=', memberOf(ctx, input.assignee));
  if (input.author) q = q.where('p.author_user_id', '=', memberOf(ctx, input.author));
  const variantWhere = (status: 'in_review' | null) =>
    sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND ${mine} AND v.status ${status ? sql`= ${status}` : sql`<> 'cancelled'`}${
      input.connectionId && !status ? sql` AND v.channel_connection_id = ${input.connectionId}::uuid` : sql``
    })`;
  // In review on the chosen channel when one is chosen: the same variant, not any of the post's.
  if (input.stage === 'review') q = q.where(input.connectionId ? sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'in_review' AND v.channel_connection_id = ${input.connectionId}::uuid)` : variantWhere('in_review'));
  if (input.stage === 'drafts') q = q.where('p.status', '=', 'draft').where(sql<boolean>`NOT ${variantWhere('in_review')}`);
  if (input.stage === 'done') q = q.where('p.status', 'in', ['published', 'partially_published', 'failed', 'publishing', 'cancelled']);
  if (input.stage === 'attention') {
    q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND ${mine} AND v.status IN ('failed', 'needs_attention', 'paused'))`);
  }
  if (input.connectionId) q = q.where(variantWhere(null));
  // Every channel the member may use is cancelled, rejected or a draft with no time of its own, at least one is a
  // draft, and the post has no planned time: what the calendar cannot place yet.
  if (input.undated) {
    q = q
      .where('p.scheduled_at', 'is', null)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND ${mine} AND v.status IN ('draft', 'in_review', 'changes_requested', 'approved'))`)
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND ${mine} AND v.status NOT IN ('cancelled', 'rejected') AND (v.status NOT IN ('draft', 'in_review', 'changes_requested', 'approved') OR v.scheduled_at IS NOT NULL OR v.queue_slot_at IS NOT NULL))`,
      );
    // A limited member may plan a post only when no open channel of it is another's (editPost refuses the time
    // otherwise), so the list offers them only those.
    if (scope !== null) {
      q = q.where(sql<boolean>`NOT EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND NOT ${mine} AND v.status NOT IN ('published', 'cancelled', 'removed'))`);
    }
  }
  if (input.labelId) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = p.org_id AND pl.post_id = p.id AND pl.label_id = ${input.labelId}::uuid)`);
  if (input.search) {
    const term = likeTerm(input.search);
    q = q.where(
      sql<boolean>`(p.body ILIKE ${term} OR p.title ILIKE ${term} OR EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND ${mine} AND (v.body ILIKE ${term} OR v.title ILIKE ${term})))`,
    );
  }
  if (input.from || input.to) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom('crove_social.post_variant as v')
          .select(sql`1`.as('one'))
          .whereRef('v.org_id', '=', 'p.org_id')
          .whereRef('v.post_id', '=', 'p.id')
          .where('v.status', '<>', 'cancelled')
          .where(mine)
          .where((w) => {
            const at = sql`CASE WHEN v.status IN ('published', 'removed') THEN v.published_at ELSE coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) END`;
            const parts = [];
            if (input.from) parts.push(w(at, '>=', new Date(Date.parse(input.from))));
            if (input.to) parts.push(w(at, '<', new Date(Date.parse(input.to))));
            return w.and(parts);
          }),
      ),
    );
  }
  return q;
}
