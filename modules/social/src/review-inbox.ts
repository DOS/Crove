// Social reviews in the kernel inbox (#749): the posts waiting for the viewer's review, beside the documents to approve.
// A post is listed when one of its channels is in review and the viewer may approve it now: an owner or admin, who has
// not approved this content yet, and is not its author on a channel that wants another person's approval (#740).
// Members and viewers decide nothing, so they get an empty list.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';
import { approvalsInRound } from './domain/approval.ts';
import { decisionsOf, fourEyesOn } from './policy.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EXCERPT = 200;
// The most posts the inbox lists; the Social home holds the rest.
export const REVIEW_INBOX_MAX = 50;

export interface ReviewInboxItem {
  postId: string;
  title: string | null;
  // The start of the post's text, at most 200 characters.
  excerpt: string;
  // The channels waiting for the viewer, in the order they were added.
  channels: { variantId: string; provider: string; displayName: string }[];
  // When it is meant to go out, if it has a time.
  at: string | null;
  submittedAt: string;
}

const excerptOf = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > EXCERPT ? `${chars.slice(0, EXCERPT - 1).join('')}…` : flat;
};

export const reviewInbox = defineQuery({
  name: 'social.review.inbox',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ items: ReviewInboxItem[]; total: number }> => {
    if (ctx.actor.type !== 'user' || (ctx.role !== 'owner' && ctx.role !== 'admin')) return { items: [], total: 0 };
    const userId = ctx.actor.userId;
    const rows = await ctx.trx
      .selectFrom('crove_social.post_variant as v')
      .innerJoin('crove_social.post as p', (j) => j.onRef('p.org_id', '=', 'v.org_id').onRef('p.id', '=', 'v.post_id'))
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'v.org_id').onRef('c.id', '=', 'v.channel_connection_id'))
      .select(['v.id as variant_id', 'v.post_id', 'v.provider', 'v.revision', 'v.content_hash', 'v.channel_connection_id', 'v.scheduled_at', 'v.updated_at', 'v.body as variant_body', 'c.display_name', 'p.body', 'p.title', 'p.scheduled_at as post_scheduled_at', 'p.author_user_id'])
      .where('v.org_id', '=', ctx.orgId)
      .where('v.status', '=', 'in_review')
      .orderBy('v.updated_at', 'asc')
      .orderBy('v.id', 'asc')
      .execute();
    const decisions = await decisionsOf(ctx.trx, ctx.orgId, rows.map((r) => r.variant_id));
    const ownChannels = [...new Set(rows.filter((r) => r.author_user_id === userId).map((r) => r.channel_connection_id))];
    const fourEyes = await fourEyesOn(ctx.trx, ctx.orgId, ownChannels);
    const posts = new Map<string, ReviewInboxItem>();
    for (const r of rows) {
      if (r.author_user_id === userId && fourEyes.has(r.channel_connection_id)) continue;
      if (approvalsInRound(decisions.get(r.variant_id) ?? [], { revision: r.revision, contentHash: r.content_hash }).includes(userId)) continue;
      const at = r.scheduled_at ?? r.post_scheduled_at;
      const item = posts.get(r.post_id) ?? {
        postId: r.post_id,
        title: r.title,
        excerpt: excerptOf(r.body || r.variant_body || ''),
        channels: [],
        at: null,
        submittedAt: r.updated_at.toISOString(),
      };
      item.channels.push({ variantId: r.variant_id, provider: r.provider, displayName: r.display_name });
      if (at && (!item.at || at.toISOString() < item.at)) item.at = at.toISOString();
      posts.set(r.post_id, item);
    }
    const items = [...posts.values()];
    return { items: items.slice(0, REVIEW_INBOX_MAX), total: items.length };
  },
});

export const reviewInboxQueries = [reviewInbox];
