// Reposts and evergreen posts (Social plan S9, issue #393). A repost is a new post with the source's content and
// images for the channels the source went out on, linked to it by repost_of; it goes through review like any post.
// An evergreen post is reposted by the worker every N days after its last publish or repost, and the repost is sent
// to review at once: a person approves it before it goes out again.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { effectiveContent } from './domain/approval.ts';
import { insertVariants, writePostMedia } from './posts.ts';
import { POST_COLUMNS, base, issuesOf, lockPost, lockVariants, mediaFor, overrides, refreshPostStatus, setVariant, settingsOf, step, type PostRow } from './variants.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const EVERGREEN_SWEEP_MS = 60 * 60_000;
const ACTOR: SystemActor = { type: 'system', component: 'social.evergreen' };

async function repost(ctx: CommandContext, sourceId: string, submit: boolean): Promise<{ postId: string; submitted: number } | null> {
  const source = await lockPost(ctx.trx, ctx.orgId, sourceId);
  const variants = await lockVariants(ctx.trx, ctx.orgId, source.id);
  // The channels it went out on that are still connected.
  const published = variants.filter((v) => v.status === 'published');
  if (published.length === 0) throw new DomainError('NOTHING_TO_REPOST', 409, 'Bài này chưa đăng lên kênh nào');
  const live = await ctx.trx
    .selectFrom('crove_kernel.channel_connection')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where(
      'id',
      'in',
      published.map((v) => v.channel_connection_id),
    )
    .where('status', '=', 'active')
    .execute();
  const liveIds = new Set(live.map((c) => c.id));
  const targets = published.filter((v) => liveIds.has(v.channel_connection_id));
  if (targets.length === 0) return null;
  const meta = await ctx.trx.selectFrom('crove_social.post').select(['tainted', 'author_user_id', 'origin']).where('org_id', '=', ctx.orgId).where('id', '=', source.id).executeTakeFirstOrThrow();
  const author = ctx.actor.type === 'user' ? ctx.actor.userId : meta.author_user_id;
  const inserted = await ctx.trx
    .insertInto('crove_social.post')
    .values({
      org_id: ctx.orgId,
      body: source.body,
      title: source.title,
      link_url: source.link_url,
      time_zone: source.time_zone,
      origin: meta.origin,
      // A repost of something AI wrote or that came from outside is as tainted as its source.
      tainted: meta.tainted,
      actor_origin: ctx.actor.type === 'user' ? 'ui' : 'system',
      author_user_id: author,
      repost_of: source.id,
    })
    .returning(POST_COLUMNS)
    .executeTakeFirstOrThrow();
  await writePostMedia(ctx, inserted.id, source.media);
  const post: PostRow = { ...inserted, media: source.media };
  // A published variant keeps the content it went out with; where that differs from the base, the repost keeps it as
  // the channel's own text or images.
  const b = base(source);
  const channels = targets.map((v) => {
    const kept = effectiveContent(b, overrides(v), v.content_frozen);
    const media = mediaFor(b, v);
    return {
      connectionId: v.channel_connection_id,
      ...(kept.body !== b.body ? { body: kept.body } : {}),
      ...(kept.title !== b.title ? { title: kept.title } : {}),
      ...(kept.linkUrl !== b.linkUrl ? { linkUrl: kept.linkUrl } : {}),
      settings: settingsOf(v) as Record<string, z.core.util.JSONType>,
      ownMedia: JSON.stringify(media) !== JSON.stringify(b.media) ? media : null,
    };
  });
  const created = await insertVariants(
    ctx,
    post,
    channels.map(({ ownMedia: _own, ...c }) => c),
    0,
  );
  // Variants with their own images keep them.
  for (const [i, c] of channels.entries()) {
    const id = created[i]?.variantId;
    if (id && c.ownMedia) await setVariant(ctx, id, { media: JSON.stringify(c.ownMedia) });
  }
  const submitted: string[] = [];
  if (submit) {
    const fresh = await lockVariants(ctx.trx, ctx.orgId, post.id);
    for (const v of fresh) {
      // One that no longer fits its channel (a rule changed) stays a draft for a person to fix.
      if (issuesOf(base(post), v).length > 0) continue;
      await setVariant(ctx, v.id, { status: step(v, { type: 'submit' }) });
      submitted.push(v.id);
    }
  }
  await refreshPostStatus(ctx, post.id);
  ctx.audit({ post_id: post.id, repost_of: source.id, variants: created.length });
  await ctx.emit('social.post.created', { post_id: post.id, repost_of: source.id });
  if (submitted.length > 0) await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: submitted });
  return { postId: post.id, submitted: submitted.length };
}

export const postRepost = defineCommand({
  name: 'social.post.repost',
  input: z.strictObject({ postId: zId }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const done = await repost(ctx, input.postId, false);
    if (!done) throw new DomainError('NOTHING_TO_REPOST', 409, 'Các kênh của bài này không còn kết nối');
    return { postId: done.postId };
  },
});

export const postRepostEvergreen = defineCommand({
  name: 'social.post.repost_evergreen',
  input: z.strictObject({ postId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const done = await repost(ctx, input.postId, true);
    // No channel left: the post stops being evergreen rather than being tried every hour.
    if (!done) {
      await ctx.trx.updateTable('crove_social.post').set({ evergreen_days: null, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.postId).execute();
      ctx.audit({ post_id: input.postId, evergreen_days: null, reason: 'no_connected_channel' });
      return { postId: null };
    }
    return { postId: done.postId };
  },
});

export const postSetEvergreen = defineCommand({
  name: 'social.post.set_evergreen',
  input: z.strictObject({ postId: zId, days: z.number().int().min(7).max(365).nullable() }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    await lockPost(ctx.trx, ctx.orgId, input.postId);
    await ctx.trx.updateTable('crove_social.post').set({ evergreen_days: input.days, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.postId).execute();
    ctx.audit({ post_id: input.postId, evergreen_days: input.days });
    return { postId: input.postId, evergreenDays: input.days };
  },
});

export const evergreenCommands = [postRepost, postRepostEvergreen, postSetEvergreen];

// One pass: every evergreen post due gets its repost, sent to review.
export async function sweepEvergreen(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; post_id: string }>`SELECT org_id, post_id FROM crove_social.evergreen_due(50::int)`.execute(deps.workerDb);
  let made = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId: row.post_id }, { actor: ACTOR, orgId: row.org_id });
      if (done.postId) made += 1;
    } catch (error) {
      if (!(error instanceof DomainError)) console.warn(`[social-evergreen] post ${row.post_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
    }
  }
  return made;
}

