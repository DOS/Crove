// Posts a connected account published outside Crove (#1054). Agencies often post part of their content straight on
// Facebook or Instagram, and the Metrics tab and the client report count only what Crove published. The worker lists
// each connected account's own posts of the last 30 days through its adapter (listRecentPosts), keeps the ones that are
// not a variant Crove published on that channel (crove_social.external_post), and reads their counts through the same
// metrics() the published variants use. Every read leaves out a post whose id is (by then) a variant's, so a post is
// never counted twice. The Metrics tab counts them only when asked ("Tính cả bài đăng ngoài Crove"), and a report link
// only when it was made with that option; otherwise every total stays as it was.
//
// Credentials stay in the worker (ADR-0025): the sweep opens a connection's token with kernel.channel.credential and
// hands it to the adapter; the commands it runs never see it. A token the platform refuses marks the connection
// expired, so an owner or admin reconnects it, as publishing does.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { METRIC_NAMES, RECENT_POSTS_MAX, RECENT_POSTS_MAX_DAYS, type Publisher, type RecentPost, type RecentPostsResult } from '@crove/channel';
import { DomainError, defineCommand, defineQuery, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { eachBounded } from './metrics.ts';
import { channelScope, connectionInScope } from './channel-access.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ACTOR: SystemActor = { type: 'system', component: 'social.external_posts' };
// How often the worker looks for work, how often a channel is listed again and a post's counts read again.
export const EXTERNAL_SWEEP_MS = 15 * 60_000;
export const EXTERNAL_INTERVAL_SECONDS = 6 * 3600;
// Channels listed and posts measured per pass, at most.
const IMPORT_LIMIT = 100;
const MEASURE_LIMIT = 200;
// The excerpt kept of a post's text, in characters, and what the screens show of it.
export const EXTERNAL_EXCERPT_MAX = 500;
const SHOWN_EXCERPT = 160;
// What the Metrics tab lists at most.
const EXTERNAL_LIST_LIMIT = 500;
// The platform ids the table takes (Graph's numeric ids and <page>_<post>).
export const EXTERNAL_POST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const zCount = z.number().int().min(0).max(1e12);
const zMetrics = z.partialRecord(z.enum(METRIC_NAMES), zCount);
const zPermalink = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'https only');
const zBroughtPost = z.strictObject({
  externalId: z.string().regex(EXTERNAL_POST_ID),
  excerpt: z
    .string()
    .max(EXTERNAL_EXCERPT_MAX)
    .refine((v) => !INVISIBLE.test(v), 'no control, zero-width or direction marks'),
  permalink: zPermalink.nullable(),
  publishedAt: z.iso.datetime({ offset: true }),
});

// Control characters, the soft hyphen, zero-width and direction marks (U+061C, U+200B-U+200F, U+202A-U+202E,
// U+2060-U+2064, U+2066-U+2069) and the byte order mark: what an excerpt never keeps, so a post's text cannot hide or
// reorder what the screens and a client report show.
// oxlint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'g');

// A post's text as the excerpt keeps it: one line, without control, zero-width or direction marks, at most
// EXTERNAL_EXCERPT_MAX characters (code points, as PostgreSQL counts them).
export function excerptOf(text: string): string {
  const clean = text
    .normalize('NFC')
    .replace(INVISIBLE_ALL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, EXTERNAL_EXCERPT_MAX).join('').trim();
}

function requireSystem(ctx: { actor: { type: string } }): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
}

// One bring-in of a channel's recent posts: the ones Crove did not publish on it are kept (their text and link
// refreshed when already there), and the channel's last bring-in is noted, with why nothing came when nothing did.
export const externalPostImport = defineCommand({
  name: 'social.external_post.import',
  input: z.strictObject({
    connectionId: zId,
    posts: z.array(zBroughtPost).max(RECENT_POSTS_MAX),
    error: z.enum(['no_answer', 'token_expired', 'permission']).optional(),
  }),
  risk: 'R0',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const connection = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).executeTakeFirst();
    if (!connection) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    const byId = new Map(input.posts.map((p) => [p.externalId, p] as const));
    const listed = [...byId.values()];
    // What Crove published on this channel (a published variant with the platform id, or with the same page address:
    // a Facebook video or Reel Crove stored as <page>_<video> may be listed under another post id) is counted as the
    // variant, never again as an outside post. The same check every read makes (crove_social.external_post_is_crove).
    const crove =
      listed.length === 0
        ? []
        : (
            await sql<{ id: string }>`
              SELECT p.id FROM ROWS FROM (pg_catalog.unnest(${listed.map((p) => p.externalId)}::text[]), pg_catalog.unnest(${listed.map((p) => p.permalink)}::text[])) AS p(id, link)
              WHERE crove_social.external_post_is_crove(${ctx.orgId}::uuid, ${connection.id}::uuid, p.id, p.link)`.execute(ctx.trx)
          ).rows;
    for (const v of crove) byId.delete(v.id);
    const fresh = [...byId.values()];
    if (fresh.length > 0) {
      await ctx.trx
        .insertInto('crove_social.external_post')
        .values(
          fresh.map((p) => ({
            org_id: ctx.orgId,
            channel_connection_id: connection.id,
            external_post_id: p.externalId,
            excerpt: p.excerpt,
            permalink: p.permalink,
            published_at: p.publishedAt,
            created_at: ctx.now,
            updated_at: ctx.now,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['org_id', 'channel_connection_id', 'external_post_id']).doUpdateSet((eb) => ({ excerpt: eb.ref('excluded.excerpt'), permalink: eb.ref('excluded.permalink'), updated_at: ctx.now })),
        )
        .execute();
    }
    await ctx.trx
      .insertInto('crove_social.external_import')
      .values({ org_id: ctx.orgId, channel_connection_id: connection.id, ran_at: ctx.now, found: input.posts.length, error: input.error ?? null })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id']).doUpdateSet({ ran_at: ctx.now, found: input.posts.length, error: input.error ?? null }))
      .execute();
    return { kept: fresh.length, crove: input.posts.length - fresh.length };
  },
});

// What the platform answered for a brought-in post: its counts (kept only when it reported some, so a failed try never
// hides the last real answer), or that it is gone (never asked again). Every try moves checked_at, so the post waits
// for the next capture like the others.
export const externalPostRecord = defineCommand({
  name: 'social.external_post.record',
  input: z.strictObject({ externalId: zId, metrics: zMetrics.optional(), gone: z.literal(true).optional() }),
  risk: 'R0',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const counted = input.metrics && Object.keys(input.metrics).length > 0 ? input.metrics : null;
    const row = await ctx.trx
      .updateTable('crove_social.external_post')
      .set({
        checked_at: ctx.now,
        updated_at: ctx.now,
        ...(counted ? { metrics: JSON.stringify(counted), captured_at: ctx.now } : {}),
        ...(input.gone ? { gone: true } : {}),
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.externalId)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new DomainError('EXTERNAL_POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng ngoài Crove này');
    return { recorded: Boolean(counted) };
  },
});

// What the sweep needs to ask a platform about a brought-in post: its channel and the platform's id.
export const externalPostTarget = defineQuery({
  name: 'social.external_post.target',
  input: z.strictObject({ externalId: zId }),
  access: 'system',
  handler: async (ctx, input) => {
    const row = await ctx.trx
      .selectFrom('crove_social.external_post')
      .select(['channel_connection_id', 'external_post_id', 'gone'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.externalId)
      .executeTakeFirst();
    if (!row || row.gone) throw new DomainError('EXTERNAL_POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng ngoài Crove này');
    return { connectionId: row.channel_connection_id, externalPostId: row.external_post_id };
  },
});

export interface ExternalPostRow {
  id: string;
  connectionId: string;
  provider: string;
  excerpt: string;
  publishedAt: string;
  // The post's page on the platform (https), or null.
  url: string | null;
  metrics: Record<string, number>;
  capturedAt: string | null;
}

// The posts published outside Crove in the window, newest first, with their latest counts (#1054): what the Metrics
// tab lists beside Crove's own when its switch is on. A post that is (by now) Crove's own (external_post_is_crove) is
// left out, so it shows once, as Crove's.
export const metricsExternal = defineQuery({
  name: 'social.metrics.external',
  input: z.object({ days: z.number().int().min(1).max(365).optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<ExternalPostRow[]> => {
    const { rows } = await sql<{
      id: string;
      channel_connection_id: string;
      provider: string;
      excerpt: string;
      published_at: Date;
      permalink: string | null;
      metrics: Record<string, unknown> | null;
      captured_at: Date | null;
    }>`
      SELECT e.id, e.channel_connection_id, c.provider, e.excerpt, e.published_at, e.permalink, e.metrics, e.captured_at
      FROM crove_social.external_post e
      JOIN crove_kernel.channel_connection c ON c.org_id = e.org_id AND c.id = e.channel_connection_id
      WHERE e.org_id = ${ctx.orgId}
        AND e.published_at > pg_catalog.now() - pg_catalog.make_interval(days => ${input.days ?? 30}::int)
        AND NOT crove_social.external_post_is_crove(e.org_id, e.channel_connection_id, e.external_post_id, e.permalink)
        -- A member limited to some channels (#1081) sees those only.
        AND ${connectionInScope(await channelScope(ctx), 'e.channel_connection_id')}
      ORDER BY e.published_at DESC, e.id
      LIMIT ${EXTERNAL_LIST_LIMIT}`.execute(ctx.trx);
    return rows.map((r) => {
      const metrics: Record<string, number> = {};
      for (const [name, value] of Object.entries(r.metrics ?? {})) if (typeof value === 'number' && Number.isFinite(value)) metrics[name] = value;
      return {
        id: r.id,
        connectionId: r.channel_connection_id,
        provider: r.provider,
        excerpt: Array.from(r.excerpt).slice(0, SHOWN_EXCERPT).join(''),
        publishedAt: r.published_at.toISOString(),
        url: r.permalink && r.permalink.startsWith('https://') ? r.permalink : null,
        metrics,
        capturedAt: r.captured_at ? r.captured_at.toISOString() : null,
      };
    });
  },
});

export const externalPostCommands = [externalPostImport, externalPostRecord];
export const externalPostQueries = [externalPostTarget, metricsExternal];

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export interface ExternalPostDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  publishers: Readonly<Record<string, Publisher>>;
  now?: () => Date;
}

// A listed post as the import command takes it; one with an id the table would refuse is left out.
function broughtPost(p: RecentPost): z.infer<typeof zBroughtPost> | null {
  if (!EXTERNAL_POST_ID.test(p.externalId) || !Number.isFinite(p.publishedAt.getTime())) return null;
  const permalink = p.permalink && p.permalink.length <= 2000 && p.permalink.startsWith('https://') ? p.permalink : null;
  return { externalId: p.externalId, excerpt: excerptOf(p.text), permalink, publishedAt: p.publishedAt.toISOString() };
}

async function openSecret(deps: ExternalPostDeps, orgId: string, connectionId: string) {
  const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId }, { actor: ACTOR, orgId });
  const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  return { externalAccountId: sealed.externalAccountId, secret };
}

const warn = (what: string, id: string, error: unknown) => {
  if (!(error instanceof DomainError)) console.warn(`[social-external] ${what} ${id.slice(0, 8)}`, error instanceof Error ? error.message : error);
};

// One pass: the channels due a bring-in are listed, then the brought-in posts due their counts are measured.
export async function sweepExternalPosts(deps: ExternalPostDeps): Promise<{ imported: number; expired: number; measured: number; skipped: number }> {
  const out = { imported: 0, expired: 0, measured: 0, skipped: 0 };
  const listing = Object.entries(deps.publishers)
    .filter(([, p]) => typeof p.listRecentPosts === 'function')
    .map(([id]) => id);
  if (listing.length === 0) return out;
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - RECENT_POSTS_MAX_DAYS * 86_400_000);

  const due = await sql<{ org_id: string; connection_id: string; provider: string; version: Date }>`
    SELECT org_id, connection_id, provider, version FROM crove_social.external_import_due(${IMPORT_LIMIT}::int, ${listing}::text[], ${EXTERNAL_INTERVAL_SECONDS}::int)`.execute(deps.workerDb);
  await eachBounded(due.rows, async (row) => {
    const options = { actor: ACTOR, orgId: row.org_id };
    const publisher = deps.publishers[row.provider];
    let result: RecentPostsResult = null;
    try {
      const { externalAccountId, secret } = await openSecret(deps, row.org_id, row.connection_id);
      result = (await publisher?.listRecentPosts?.({ externalAccountId, secret, since })) ?? null;
    } catch (error) {
      // A connection whose owner left, or a credential that will not open: nothing to list; the publish path reports it.
      warn('channel', row.connection_id, error);
    }
    try {
      if (result && 'refused' in result && result.refused === 'token_expired') {
        // The connection needs reconnecting, unless it changed since the scan read it (a reconnect brought a new token).
        const done = await deps.runtime.execute<{ status: string }>('kernel.channel.mark_expired', { connectionId: row.connection_id, reason: 'token_expired', ifVersion: row.version.toISOString() }, options);
        if (done.status === 'expired') out.expired += 1;
      }
      const posts = result && 'posts' in result ? result.posts.map(broughtPost).filter((p) => p !== null) : [];
      const error = !result ? ('no_answer' as const) : 'refused' in result ? result.refused : undefined;
      await deps.runtime.execute('social.external_post.import', { connectionId: row.connection_id, posts, ...(error ? { error } : {}) }, options);
      if (error) out.skipped += 1;
      else out.imported += 1;
    } catch (error) {
      warn('channel', row.connection_id, error);
      out.skipped += 1;
    }
  });

  const measuring = listing.filter((id) => typeof deps.publishers[id]?.metrics === 'function');
  if (measuring.length === 0) return out;
  const posts = await sql<{ org_id: string; external_id: string; provider: string }>`
    SELECT org_id, external_id, provider FROM crove_social.external_metrics_due(${MEASURE_LIMIT}::int, ${measuring}::text[], ${EXTERNAL_INTERVAL_SECONDS}::int)`.execute(deps.workerDb);
  await eachBounded(posts.rows, async (row) => {
    const options = { actor: ACTOR, orgId: row.org_id };
    const publisher = deps.publishers[row.provider];
    try {
      const target = await deps.runtime.query<{ connectionId: string; externalPostId: string }>('social.external_post.target', { externalId: row.external_id }, options);
      const { externalAccountId, secret } = await openSecret(deps, row.org_id, target.connectionId);
      const result = await publisher?.metrics?.({ externalAccountId, secret, externalId: target.externalPostId });
      const input = !result ? {} : 'refused' in result ? (result.refused === 'gone' ? { gone: true as const } : {}) : { metrics: result.metrics };
      const done = await deps.runtime.execute<{ recorded: boolean }>('social.external_post.record', { externalId: row.external_id, ...input }, options);
      if (done.recorded) out.measured += 1;
      else out.skipped += 1;
    } catch (error) {
      warn('post', row.external_id, error);
      out.skipped += 1;
      // Kept as a try all the same, so a post that keeps failing waits for the next capture.
      await deps.runtime.execute('social.external_post.record', { externalId: row.external_id }, options).catch(() => undefined);
    }
  });
  return out;
}
