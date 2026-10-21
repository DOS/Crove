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
import { POST_COLUMNS, base, hashOf, issuesOf, lockPost, lockVariants, mediaFor, overrides, refreshPostStatus, setVariant, settingsOf, step, type PostRow, type VariantRow } from './variants.ts';
import { agentTaskOf } from './agent.ts';
import { publishingHeld } from './publish-hold.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const EVERGREEN_SWEEP_MS = 60 * 60_000;
const ACTOR: SystemActor = { type: 'system', component: 'social.evergreen' };
// A repost in one of these is no longer on its way; any other status holds the next evergreen repost back.
const REPOST_DONE = ['published', 'partially_published', 'failed', 'cancelled'] as const;

// gone: every channel it went out on is disconnected for good; waiting: some are only expired or failing for now.
async function repost(ctx: CommandContext, sourceId: string, submit: boolean): Promise<{ postId: string; submitted: number } | 'gone' | 'waiting'> {
  const source = await lockPost(ctx.trx, ctx.orgId, sourceId);
  const variants = await lockVariants(ctx.trx, ctx.orgId, source.id);
  // The channels it went out on that are still connected.
  const published = variants.filter((v) => v.status === 'published');
  if (published.length === 0) throw new DomainError('NOTHING_TO_REPOST', 409, 'Bài này chưa đăng lên kênh nào');
  const live = await ctx.trx
    .selectFrom('crove_kernel.channel_connection')
    .select(['id', 'status'])
    .where('org_id', '=', ctx.orgId)
    .where(
      'id',
      'in',
      published.map((v) => v.channel_connection_id),
    )
    .execute();
  const liveIds = new Set(live.filter((c) => c.status === 'active').map((c) => c.id));
  const targets = published.filter((v) => liveIds.has(v.channel_connection_id));
  if (targets.length === 0) return live.some((c) => c.status !== 'revoked') ? 'waiting' : 'gone';
  return copyPost(ctx, source, targets, { repostOf: source.id, submit });
}

const withoutRemoveAt = (settings: Record<string, unknown>): Record<string, unknown> => {
  const { removeAt: _gone, ...rest } = settings;
  return rest;
};

// A new post with the content of `source`'s channels `targets` (#393, #575). A repost's base is what the channels
// went out with; a duplicate's is the source's own base. Either way a channel whose content or images differ from the
// copy's base keeps them as its own, with its settings.
async function copyPost(ctx: CommandContext, source: PostRow, targets: VariantRow[], options: { repostOf: string | null; submit: boolean }): Promise<{ postId: string; submitted: number }> {
  const { submit } = options;
  const meta = await ctx.trx.selectFrom('crove_social.post').select(['tainted', 'author_user_id', 'origin']).where('org_id', '=', ctx.orgId).where('id', '=', source.id).executeTakeFirstOrThrow();
  const author = ctx.actor.type === 'user' ? ctx.actor.userId : meta.author_user_id;
  const b = base(source);
  const baseMedia = JSON.stringify(b.media);
  // Each channel once: its effective content, and its images when they are its own (not the base's).
  const outs = targets.map((v) => {
    const media = mediaFor(b, v);
    return { v, kept: effectiveContent(b, overrides(v), v.content_frozen), ownMedia: JSON.stringify(media) !== baseMedia ? media : null };
  });
  const [first] = outs;
  // A repost's base is built from what went out (the source's base may have been edited since): a title or link is
  // left empty there when any channel went out without one, since a channel's own value can add a title or link but
  // not take one away; the others then carry theirs as the channel's own.
  const shared = options.repostOf
    ? {
        body: first ? first.kept.body : b.body,
        title: !first || outs.some((o) => o.kept.title === null) ? null : first.kept.title,
        linkUrl: !first || outs.some((o) => o.kept.linkUrl === null) ? null : first.kept.linkUrl,
      }
    : { body: b.body, title: b.title, linkUrl: b.linkUrl };
  const inserted = await ctx.trx
    .insertInto('crove_social.post')
    .values({
      org_id: ctx.orgId,
      body: shared.body,
      title: shared.title,
      link_url: shared.linkUrl,
      time_zone: source.time_zone,
      origin: meta.origin,
      // A repost of something AI wrote or that came from outside is as tainted as its source.
      tainted: meta.tainted,
      actor_origin: ctx.actor.type === 'user' ? 'ui' : 'system',
      author_user_id: author,
      repost_of: options.repostOf,
    })
    .returning(POST_COLUMNS)
    .executeTakeFirstOrThrow();
  await writePostMedia(ctx, inserted.id, source.media);
  const post: PostRow = { ...inserted, media: source.media };
  // A published variant keeps the content it went out with; where that differs from the repost's base, the repost
  // keeps it as the channel's own text or images. A channel's own images name files with no foreign key: one removed
  // since is left out, rather than failing at publish time (a channel that then lacks images stays a draft).
  const ownIds = [...new Set(outs.flatMap((o) => (o.ownMedia ?? []).map((m) => m.fileId)))];
  const present = new Set(
    ownIds.length === 0
      ? []
      : (await ctx.trx.selectFrom('crove_kernel.file').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ownIds).execute()).map((f) => f.id),
  );
  const channels = outs.map(({ v, kept, ownMedia }) => {
    const own = ownMedia ? ownMedia.filter((m) => present.has(m.fileId)) : null;
    return {
      connectionId: v.channel_connection_id,
      ...(kept.body !== shared.body ? { body: kept.body } : {}),
      ...(kept.title !== shared.title && kept.title !== null ? { title: kept.title } : {}),
      ...(kept.linkUrl !== shared.linkUrl && kept.linkUrl !== null ? { linkUrl: kept.linkUrl } : {}),
      // A copy never takes the source's planned takedown (#861): its time belonged to that post.
      settings: withoutRemoveAt(settingsOf(v)) as Record<string, z.core.util.JSONType>,
      ownMedia: own,
    };
  });
  const created = await insertVariants(
    ctx,
    post,
    channels.map(({ ownMedia: _own, ...c }) => c),
    0,
  );
  // Variants with their own images keep them, and their hash covers those images: a reviewer approves what goes out.
  for (const [i, c] of channels.entries()) {
    const id = created[i]?.variantId;
    if (id && c.ownMedia) await setVariant(ctx, id, { media: JSON.stringify(c.ownMedia) });
  }
  const fresh = await lockVariants(ctx.trx, ctx.orgId, post.id);
  for (const v of fresh) {
    const hash = hashOf(base(post), v);
    if (hash === v.content_hash) continue;
    await setVariant(ctx, v.id, { content_hash: hash });
    v.content_hash = hash;
  }
  const submitted: string[] = [];
  if (submit) {
    for (const v of fresh) {
      // One that no longer fits its channel (a rule changed) stays a draft for a person to fix.
      if (issuesOf(base(post), v).length > 0) continue;
      await setVariant(ctx, v.id, { status: step(v, { type: 'submit' }) });
      submitted.push(v.id);
    }
  }
  await refreshPostStatus(ctx, post.id);
  ctx.audit({ post_id: post.id, ...(options.repostOf ? { repost_of: source.id } : { copy_of: source.id }), variants: created.length });
  await ctx.emit('social.post.created', { post_id: post.id, ...(options.repostOf ? { repost_of: source.id } : { copy_of: source.id }) });
  if (submitted.length > 0) await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: submitted, agent_task: await agentTaskOf(ctx, post.id) });
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
    if (typeof done === 'string') throw new DomainError('NOTHING_TO_REPOST', 409, 'Các kênh của bài này không còn kết nối');
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
    // No repost piles up for review while the org's publishing is held (#946); the post stays due for after the release.
    if (await publishingHeld(ctx)) return { postId: null };
    // The scan ran outside this transaction: under the post's lock, check again that it is still evergreen and has no
    // repost on its way (another worker, or a person turning it off, may have come first).
    await lockPost(ctx.trx, ctx.orgId, input.postId);
    const still = await ctx.trx
      .selectFrom('crove_social.post as p')
      .select('p.id')
      .where('p.org_id', '=', ctx.orgId)
      .where('p.id', '=', input.postId)
      .where('p.evergreen_days', 'is not', null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('crove_social.post as r')
              .select('r.id')
              .whereRef('r.org_id', '=', 'p.org_id')
              .whereRef('r.repost_of', '=', 'p.id')
              .where('r.status', 'not in', [...REPOST_DONE]),
          ),
        ),
      )
      .executeTakeFirst();
    if (!still) return { postId: null };
    const done = await repost(ctx, input.postId, true);
    // A channel that is only expired may be reconnected: try again on a later sweep.
    if (done === 'waiting') return { postId: null };
    // No channel left for good: the post stops being evergreen rather than being tried every hour.
    if (done === 'gone') {
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

// A copy of any post as a new draft (#575): its text, title, link and images, and each channel still connected with
// its own content and settings; never its schedule, approvals or history. As tainted as its source.
export const postDuplicate = defineCommand({
  name: 'social.post.duplicate',
  input: z.strictObject({ postId: zId }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const source = await lockPost(ctx.trx, ctx.orgId, input.postId);
    const variants = (await lockVariants(ctx.trx, ctx.orgId, source.id)).filter((v) => v.status !== 'cancelled');
    const connected =
      variants.length === 0
        ? new Set<string>()
        : new Set(
            (
              await ctx.trx
                .selectFrom('crove_kernel.channel_connection')
                .select('id')
                .where('org_id', '=', ctx.orgId)
                .where(
                  'id',
                  'in',
                  variants.map((v) => v.channel_connection_id),
                )
                .where('status', '<>', 'revoked')
                .execute()
            ).map((c) => c.id),
          );
    const targets = variants.filter((v) => connected.has(v.channel_connection_id));
    if (targets.length === 0) throw new DomainError('NOTHING_TO_DUPLICATE', 409, 'Các kênh của bài này không còn kết nối');
    return { postId: (await copyPost(ctx, source, targets, { repostOf: null, submit: false })).postId };
  },
});

export const evergreenCommands = [postRepost, postRepostEvergreen, postSetEvergreen, postDuplicate];

// One pass: every evergreen post due gets its repost, sent to review.
export async function sweepEvergreen(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; post_id: string }>`SELECT org_id, post_id FROM crove_social.evergreen_due(50::int)`.execute(deps.workerDb);
  let made = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId: row.post_id }, { actor: ACTOR, orgId: row.org_id });
      if (done.postId) made += 1;
    } catch (error) {
      console.warn(`[social-evergreen] post ${row.post_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
    }
  }
  return made;
}

