// Social work that needs a person, in the kernel inbox (#771): channels whose sign-in expired or broke, and posts a
// channel of which failed, needs a person to settle an unclear outcome, or waits paused on such a channel. Each opens
// where it is fixed. Owners and admins fix them (reconnect, retry, resolve), so members and viewers get an empty list.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EXCERPT = 200;
// The most posts the inbox lists; the Social home's "needs attention" list holds the rest.
export const ATTENTION_INBOX_MAX = 50;
const ATTENTION_SCAN_MAX = 500;

export interface AttentionChannel {
  connectionId: string;
  provider: string;
  displayName: string;
  status: 'expired' | 'error';
}

export interface AttentionPost {
  postId: string;
  excerpt: string;
  channels: { variantId: string; provider: string; displayName: string; status: string; errorCode: string | null }[];
  updatedAt: string;
}

const excerptOf = (text: string) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > EXCERPT ? `${chars.slice(0, EXCERPT - 1).join('')}…` : chars.join('');
};

export const attentionInbox = defineQuery({
  name: 'social.attention.inbox',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ channels: AttentionChannel[]; posts: AttentionPost[]; total: number }> => {
    if (ctx.actor.type !== 'user' || (ctx.role !== 'owner' && ctx.role !== 'admin')) return { channels: [], posts: [], total: 0 };
    const channels = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'display_name', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('status', 'in', ['expired', 'error'])
      .orderBy('updated_at', 'asc')
      .limit(ATTENTION_INBOX_MAX)
      .execute();
    const rows = await ctx.trx
      .selectFrom('crove_social.post_variant as v')
      .innerJoin('crove_social.post as p', (j) => j.onRef('p.org_id', '=', 'v.org_id').onRef('p.id', '=', 'v.post_id'))
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'v.org_id').onRef('c.id', '=', 'v.channel_connection_id'))
      .select(['v.id as variant_id', 'v.post_id', 'v.provider', 'v.status', 'v.error_code', 'v.updated_at', 'v.body as variant_body', 'p.body', 'c.display_name'])
      .where('v.org_id', '=', ctx.orgId)
      // A paused variant waits on its channel: it needs a person only while that channel is not active.
      .where((w) => w.or([w('v.status', 'in', ['failed', 'needs_attention']), w.and([w('v.status', '=', 'paused'), w('c.status', '<>', 'active')])]))
      .orderBy('v.updated_at', 'asc')
      .orderBy('v.id', 'asc')
      .limit(ATTENTION_SCAN_MAX)
      .execute();
    const posts = new Map<string, AttentionPost>();
    for (const r of rows) {
      const item = posts.get(r.post_id) ?? { postId: r.post_id, excerpt: excerptOf(r.variant_body ?? r.body ?? ''), channels: [], updatedAt: r.updated_at.toISOString() };
      item.channels.push({ variantId: r.variant_id, provider: r.provider, displayName: r.display_name, status: r.status, errorCode: r.error_code });
      posts.set(r.post_id, item);
    }
    const list = [...posts.values()];
    return {
      channels: channels.map((c) => ({ connectionId: c.id, provider: c.provider, displayName: c.display_name, status: c.status as 'expired' | 'error' })),
      posts: list.slice(0, ATTENTION_INBOX_MAX),
      total: channels.length + list.length,
    };
  },
});

export const attentionInboxQueries = [attentionInbox];
