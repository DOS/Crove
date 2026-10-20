// Drafts from a blog's feed (#708), as Buffer, Publer, SocialPilot and Metricool make them: an org adds its blog's RSS
// or Atom feed for some channels, and the worker reads it about every hour (through the egress guard, parsed in
// crove-extract). Each new item becomes a draft (never a scheduled post) for those channels, once, with the item's
// title and summary as its text and its link; the draft is marked as coming from outside (tainted), so each channel
// needs a person's approval as any post does. The items already in the feed when it is added are noted, not drafted,
// except those published after it was added. Five failed reads in a row pause the feed and tell the owners and admins.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { insertVariants } from './posts.ts';
import { POST_COLUMNS, type PostRow } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const MAX_FEEDS = 10;
// Drafts one read makes at most; more new items wait for the next read.
export const DRAFTS_PER_READ = 5;
export const PAUSE_AFTER_FAILURES = 5;
export const FEED_SWEEP_MS = 15 * 60_000;

const zUrl = z.url({ protocol: /^https?$/ }).max(2000);
const zConnections = z
  .array(zId)
  .min(1)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'each channel once');

// What the worker read, as crove-extract returned it (the worker checked it against the contract already).
const zItem = z.strictObject({
  key: z.string().min(1).max(2000),
  title: z.string().min(1).max(300).nullable(),
  link: zUrl.nullable(),
  publishedAt: z.iso.datetime().nullable(),
  summary: z.string().min(1).max(1000).nullable(),
  image: zUrl.nullable(),
});
export const zFeedResult = z.union([
  z.strictObject({ ok: z.literal(true), title: z.string().min(1).max(300).nullable(), items: z.array(zItem).max(50) }),
  z.strictObject({ ok: z.literal(false), error: z.string().regex(/^[a-z_]{1,64}$/) }),
]);
export type FeedResult = z.infer<typeof zFeedResult>;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

async function checkConnections(ctx: CommandContext, ids: readonly string[]): Promise<void> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.channel_connection')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...ids])
    .where('status', '<>', 'revoked')
    .execute();
  if (rows.length !== ids.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh này');
}

const itemKey = (key: string) => createHash('sha256').update(key).digest('hex');

export const feedAdd = defineCommand({
  name: 'social.feed.add',
  input: z.strictObject({ url: zUrl, connectionIds: zConnections }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    await checkConnections(ctx, input.connectionIds);
    // One add at a time per org, so the count below holds until the commit.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.feed:${ctx.orgId}`}))`.execute(ctx.trx);
    const count = await ctx.trx.selectFrom('crove_social.feed').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_FEEDS) throw new DomainError('FEED_LIMIT', 409, `Mỗi tổ chức có tối đa ${MAX_FEEDS} nguồn tin`, { limit: MAX_FEEDS });
    const row = await ctx.trx
      .insertInto('crove_social.feed')
      .values({ org_id: ctx.orgId, url: input.url, connection_ids: input.connectionIds, created_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'url']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new DomainError('FEED_EXISTS', 409, 'Nguồn tin này đã được thêm');
    ctx.audit({ feed_id: row.id });
    return { feedId: row.id };
  },
});

// Changes a feed's channels, or pauses it, or resumes it (which starts its failure count again, and reads it on the\n// worker's next pass).
export const feedUpdate = defineCommand({
  name: 'social.feed.update',
  input: z.strictObject({ feedId: zId, connectionIds: zConnections.optional(), paused: z.boolean().optional() }),
  risk: 'R1',
  access: ADMINS,
  target: (input) => ({ type: 'social.feed', id: input.feedId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    if (input.connectionIds) await checkConnections(ctx, input.connectionIds);
    const done = await ctx.trx
      .updateTable('crove_social.feed')
      .set({
        ...(input.connectionIds ? { connection_ids: input.connectionIds } : {}),
        ...(input.paused === undefined ? {} : input.paused ? { paused: true } : { paused: false, failures: 0, last_error: null, last_checked_at: null }),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.feedId)
      .executeTakeFirst();
    if (Number(done.numUpdatedRows) === 0) throw new DomainError('FEED_NOT_FOUND', 404, 'Không tìm thấy nguồn tin này');
    return { feedId: input.feedId };
  },
});

// Removes a feed; the drafts made from it stay.
export const feedRemove = defineCommand({
  name: 'social.feed.remove',
  input: z.strictObject({ feedId: zId }),
  risk: 'R1',
  access: ADMINS,
  target: (input) => ({ type: 'social.feed', id: input.feedId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const done = await ctx.trx.deleteFrom('crove_social.feed').where('org_id', '=', ctx.orgId).where('id', '=', input.feedId).executeTakeFirst();
    if (Number(done.numDeletedRows) === 0) throw new DomainError('FEED_NOT_FOUND', 404, 'Không tìm thấy nguồn tin này');
    ctx.audit({ feed_id: input.feedId });
    return { feedId: input.feedId };
  },
});

export interface FeedView {
  id: string;
  url: string;
  title: string | null;
  connectionIds: string[];
  paused: boolean;
  failures: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  drafts: number;
  createdAt: string;
}

export const feedList = defineQuery({
  name: 'social.feed.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<FeedView[]> => {
    const { rows } = await sql<{
      id: string;
      url: string;
      title: string | null;
      connection_ids: string[];
      paused: boolean;
      failures: number;
      last_checked_at: Date | null;
      last_error: string | null;
      drafts: string;
      created_at: Date;
    }>`
      SELECT f.id, f.url, f.title, f.connection_ids, f.paused, f.failures, f.last_checked_at, f.last_error, f.created_at,
             (SELECT count(*) FROM crove_social.feed_item i WHERE i.org_id = f.org_id AND i.feed_id = f.id AND i.post_id IS NOT NULL) AS drafts
      FROM crove_social.feed f WHERE f.org_id = ${ctx.orgId}
      ORDER BY f.created_at, f.id`.execute(ctx.trx);
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      connectionIds: r.connection_ids,
      paused: r.paused,
      failures: r.failures,
      lastCheckedAt: r.last_checked_at ? r.last_checked_at.toISOString() : null,
      lastError: r.last_error,
      drafts: Number(r.drafts),
      createdAt: r.created_at.toISOString(),
    }));
  },
});

// The worker's read of a feed to fetch: its URL, while it is not paused.
export const feedLoad = defineQuery({
  name: 'social.feed.load',
  input: z.object({ feedId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ url: string } | null> => {
    const row = await ctx.trx.selectFrom('crove_social.feed').select(['url', 'paused']).where('org_id', '=', ctx.orgId).where('id', '=', input.feedId).executeTakeFirst();
    return row && !row.paused ? { url: row.url } : null;
  },
});

type FeedRow = { id: string; url: string; connection_ids: string[]; paused: boolean; failures: number; last_checked_at: Date | null; created_by: string; created_at: Date };
type Item = z.infer<typeof zItem>;

// A draft for the feed's channels that are still connected; null when none is.
async function draftFrom(ctx: CommandContext, feed: FeedRow, item: Item): Promise<string | null> {
  const live = await ctx.trx
    .selectFrom('crove_kernel.channel_connection')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', feed.connection_ids)
    .where('status', '<>', 'revoked')
    .execute();
  const channels = feed.connection_ids.filter((id) => live.some((c) => c.id === id));
  if (channels.length === 0) return null;
  const body = [item.title, item.summary].filter((s): s is string => Boolean(s)).join('\n\n');
  const inserted = await ctx.trx
    .insertInto('crove_social.post')
    .values({
      org_id: ctx.orgId,
      body,
      title: null,
      link_url: item.link,
      origin: 'human',
      // Text that came from outside Crove: every channel waits for a person's approval of it.
      tainted: true,
      actor_origin: 'system',
      author_user_id: feed.created_by,
    })
    .returning(POST_COLUMNS)
    .executeTakeFirstOrThrow();
  const post: PostRow = { ...inserted, media: [] };
  await insertVariants(
    ctx,
    post,
    channels.map((connectionId) => ({ connectionId })),
    0,
  );
  await ctx.emit('social.post.created', { post_id: post.id, feed_id: feed.id });
  return post.id;
}

// What the worker read of a feed: the new items drafted (and noted), or one more failure.
export const feedRecord = defineCommand({
  name: 'social.feed.record',
  input: z.strictObject({ feedId: zId, result: zFeedResult }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.feed', id: input.feedId }),
  handler: async (ctx, input): Promise<{ drafted: number; paused: boolean }> => {
    const feed = await ctx.trx
      .selectFrom('crove_social.feed')
      .select(['id', 'url', 'connection_ids', 'paused', 'failures', 'last_checked_at', 'created_by', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.feedId)
      .forUpdate()
      .executeTakeFirst();
    if (!feed || feed.paused) return { drafted: 0, paused: Boolean(feed?.paused) };
    const result = input.result;
    if (!result.ok) {
      const failures = Math.min(100, feed.failures + 1);
      const paused = failures >= PAUSE_AFTER_FAILURES;
      await ctx.trx
        .updateTable('crove_social.feed')
        .set({ failures, last_error: result.error, last_checked_at: ctx.now, paused, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', feed.id)
        .execute();
      if (paused) await ctx.emit('social.feed.paused', { feed_id: feed.id, error: result.error });
      return { drafted: 0, paused };
    }
    const seen = await ctx.trx.selectFrom('crove_social.feed_item').select('item_key').where('org_id', '=', ctx.orgId).where('feed_id', '=', feed.id).limit(1).execute();
    // The first read notes what the feed already holds; only items published since the feed was added are drafted.
    const first = feed.last_checked_at === null && seen.length === 0;
    const keyed = new Map<string, Item>();
    for (const item of result.items) {
      const key = itemKey(item.key);
      if (!keyed.has(key)) keyed.set(key, item);
    }
    const known = new Set(
      keyed.size === 0
        ? []
        : (
            await ctx.trx
              .selectFrom('crove_social.feed_item')
              .select('item_key')
              .where('org_id', '=', ctx.orgId)
              .where('feed_id', '=', feed.id)
              .where('item_key', 'in', [...keyed.keys()])
              .execute()
          ).map((r) => r.item_key),
    );
    let drafted = 0;
    for (const [key, item] of keyed) {
      if (known.has(key)) continue;
      const fresh = !first || (item.publishedAt !== null && Date.parse(item.publishedAt) >= feed.created_at.getTime());
      // Past this read's share, a new item waits for the next read; on the first read, older ones are only noted.
      if (fresh && drafted >= DRAFTS_PER_READ) continue;
      const postId = fresh ? await draftFrom(ctx, feed as FeedRow, item) : null;
      if (postId) drafted += 1;
      await ctx.trx
        .insertInto('crove_social.feed_item')
        .values({ org_id: ctx.orgId, feed_id: feed.id, item_key: key, title: item.title, post_id: postId, created_at: ctx.now })
        .onConflict((oc) => oc.columns(['org_id', 'feed_id', 'item_key']).doNothing())
        .execute();
    }
    await ctx.trx
      .updateTable('crove_social.feed')
      .set({ title: result.title, failures: 0, last_error: null, last_checked_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', feed.id)
      .execute();
    return { drafted, paused: false };
  },
});

export const feedCommands = [feedAdd, feedUpdate, feedRemove, feedRecord];
export const feedQueries = [feedList, feedLoad];
