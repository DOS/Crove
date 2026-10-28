// Reposts and evergreen posts (Social plan S9, issue #393). A repost is a new post with the source's content and
// images for the channels the source went out on, linked to it by repost_of; it goes through review like any post.
// An evergreen post is reposted by the worker every N days after its last publish or repost, and the repost is sent
// to review at once: a person approves it before it goes out again.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zSocialPostDuplicate, type zSocialPostDuplicateResult } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { effectiveContent, inheritedContent } from './domain/approval.ts';
import { refusesDuplicates } from './domain/duplicate.ts';
import { duplicatesOf } from './duplicates.ts';
import { insertVariants, writePostMedia } from './posts.ts';
import { refuseUnusableMedia } from './library.ts';
import { coverOf, linkCardThumbOf } from './domain/channels.ts';
import { POST_COLUMNS, base, hashOf, issuesOf, lockPost, lockVariants, mediaFor, overrides, refreshPostStatus, refuseArchived, setVariant, settingsOf, step, type PostRow, type VariantRow } from './variants.ts';
import { agentTaskOf } from './agent.ts';
import { publishingHeld } from './publish-hold.ts';
import { bannedCheckerOf, isBlocked } from './banned-words.ts';
import { inScope, refusePostOutside, refusePostWholly } from './channel-access.ts';
import { advanceTextVariation, nextTextVariation, type ChosenVariation } from './text-variations.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const EVERGREEN_SWEEP_MS = 60 * 60_000;
const ACTOR: SystemActor = { type: 'system', component: 'social.evergreen' };
// A repost in one of these is no longer on its way; any other status holds the next evergreen repost back.
const REPOST_DONE = ['published', 'partially_published', 'failed', 'cancelled'] as const;
// The sweeps' page (the scan's limit) and the pages one pass asks for at most (#1001), shared with recurring.ts.
export const SWEEP_PAGE = 50;
export const SWEEP_PAGES = 10;

// What a copy made by the repost path carries besides its content: whether it goes to review at once, the time it is
// planned for (a recurring copy's occurrence, #979), the series it belongs to, and whether it takes the post's next
// text variation (#1260: the worker's evergreen and recurring copies; a person's Repost repeats what went out).
export interface RepostOptions {
  submit: boolean;
  scheduledAt?: Date;
  recurrenceSourceId?: string;
  rotate?: boolean;
}

// gone: every channel it went out on is disconnected for good; waiting: some are only expired or failing for now.
// Locks the source, then its variants.
export async function repostCopy(ctx: CommandContext, sourceId: string, options: RepostOptions): Promise<{ postId: string; submitted: number } | 'gone' | 'waiting'> {
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
  // The next variation, chosen and passed on in the same transaction, under the source's lock: two runs never take the
  // same one, and a copy that fails leaves the cursor where it was.
  const variation = options.rotate ? await nextTextVariation(ctx, source.id, targets) : null;
  const done = await copyPost(ctx, source, targets, { ...options, repostOf: source.id, variation });
  if (variation) await advanceTextVariation(ctx, source.id, variation);
  return done;
}

const withoutRemoveAt = (settings: Record<string, unknown>): Record<string, unknown> => {
  const { removeAt: _gone, ...rest } = settings;
  return rest;
};

// A new post with the content of `source`'s channels `targets` (#393, #575). A repost's base is what the channels
// went out with; a duplicate's is the source's own base. Either way a channel whose content or images differ from the
// copy's base keeps them as its own, with its settings. With a text variation (#1260), the variation is the copy's text
// on every channel (a channel's own text gives way to it; its signature stays in its settings), and a variation AI
// wrote makes the copy tainted.
async function copyPost(
  ctx: CommandContext,
  source: PostRow,
  targets: VariantRow[],
  options: RepostOptions & { repostOf: string | null; variation?: ChosenVariation | null },
): Promise<{ postId: string; submitted: number }> {
  const variation = options.variation ?? null;
  const { submit } = options;
  const meta = await ctx.trx.selectFrom('crove_social.post').select(['tainted', 'author_user_id', 'origin']).where('org_id', '=', ctx.orgId).where('id', '=', source.id).executeTakeFirstOrThrow();
  const author = ctx.actor.type === 'user' ? ctx.actor.userId : meta.author_user_id;
  const b = base(source);
  const baseMedia = JSON.stringify(b.media);
  // Each channel once: its own content (its signature, #1190, stays in the settings it keeps), and its images when they
  // are its own (not the base's).
  const outs = targets.map((v) => {
    const media = mediaFor(b, v);
    return { v, kept: inheritedContent(b, overrides(v), v.content_frozen), ownMedia: JSON.stringify(media) !== baseMedia ? media : null };
  });
  const [first] = outs;
  // A repost's base is built from what went out (the source's base may have been edited since): a title or link is
  // left empty there when any channel went out without one, since a channel's own value can add a title or link but
  // not take one away; the others then carry theirs as the channel's own.
  const shared = options.repostOf
    ? {
        body: variation ? variation.text : first ? first.kept.body : b.body,
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
      // A repost of something AI wrote or that came from outside is as tainted as its source, and so is one whose text
      // variation AI wrote.
      tainted: meta.tainted || (variation?.ai ?? false),
      actor_origin: ctx.actor.type === 'user' ? 'ui' : 'system',
      author_user_id: author,
      repost_of: options.repostOf,
      // The copy's planned time, which a person schedules its channels at once they approve them.
      scheduled_at: options.scheduledAt ?? null,
      recurrence_source_id: options.recurrenceSourceId ?? null,
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
      ...(!variation && kept.body !== shared.body ? { body: kept.body } : {}),
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
    { copy: true },
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
    // An evergreen or recurring copy goes through the org's banned words as a submit does (#1055).
    const banned = await bannedCheckerOf(ctx.trx, ctx.orgId);
    for (const v of fresh) {
      // One that no longer fits its channel (a rule changed), or holds a word blocked since, stays a draft for a person
      // to fix.
      if (issuesOf(base(post), v).length > 0 || isBlocked(banned, base(post), v)) continue;
      await setVariant(ctx, v.id, { status: step(v, { type: 'submit' }) });
      submitted.push(v.id);
    }
  }
  await refreshPostStatus(ctx, post.id);
  ctx.audit({ post_id: post.id, ...(options.repostOf ? { repost_of: source.id } : { copy_of: source.id }), variants: created.length, ...(variation ? { text_variation: variation.index } : {}) });
  await ctx.emit('social.post.created', { post_id: post.id, ...(options.repostOf ? { repost_of: source.id } : { copy_of: source.id }) });
  if (submitted.length > 0) await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: submitted, agent_task: await agentTaskOf(ctx, post.id, submitted.length) });
  return { postId: post.id, submitted: submitted.length };
}

export const postRepost = defineCommand({
  name: 'social.post.repost',
  input: z.strictObject({ postId: zId }),
  // The copy stays a draft, but copyPost, which makes it, alerts the org's team chat on Telegram or Discord when a copy
  // is submitted; the check of plan §4.7 counts every caller of an emit, so it is R2 like the copies that do (#1662).
  risk: 'R2',
  sideEffect: 'external',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const done = await repostCopy(ctx, input.postId, { submit: false });
    if (typeof done === 'string') throw new DomainError('NOTHING_TO_REPOST', 409, 'Các kênh của bài này không còn kết nối');
    return { postId: done.postId };
  },
});

export const postRepostEvergreen = defineCommand({
  name: 'social.post.repost_evergreen',
  input: z.strictObject({ postId: zId }),
  // The copy goes to review, which alerts the org's team chat on Telegram or Discord (plan §4.7: a job with egress
  // derives R2; #1662). A system command, so the worker runs it as before.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    // No repost piles up for review while the org's publishing is held (#946); the post stays due for after the release.
    if (await publishingHeld(ctx)) return { postId: null };
    // The scan ran outside this transaction: under the post's lock, check again that it is still evergreen and has no
    // repost on its way (another worker, or a person turning it off, may have come first). An archived repost (#1299)
    // waits for nobody, so it is done, as evergreen_due reads it (#1341).
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
              .where('r.archived_at', 'is', null)
              .where('r.status', 'not in', [...REPOST_DONE]),
          ),
        ),
      )
      .executeTakeFirst();
    if (!still) return { postId: null };
    const done = await repostCopy(ctx, input.postId, { submit: true, rotate: true });
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
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    // A member limited to some channels (#1081) turns reposts on or off only for a post wholly on those: the worker
    // reposts every channel it went out on, so either way the other channels' reposts would change.
    await refusePostWholly(ctx, input.postId);
    // Turned on only for a post out of the archive (#1299); turning it off is always allowed.
    if (input.days !== null) refuseArchived(post);
    // One kind of repeat per post (#979): a series' copies would hold its evergreen reposts back, and the other way round.
    if (input.days !== null) {
      const series = await ctx.trx.selectFrom('crove_social.post').select('recurrence').where('org_id', '=', ctx.orgId).where('id', '=', input.postId).executeTakeFirstOrThrow();
      if (series.recurrence !== null) throw new DomainError('RECURRENCE_WITH_EVERGREEN', 409, 'Bài này đang lặp lại theo lịch; hãy tắt lặp lại trước khi bật tự đăng lại');
    }
    await ctx.trx.updateTable('crove_social.post').set({ evergreen_days: input.days, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.postId).execute();
    ctx.audit({ post_id: input.postId, evergreen_days: input.days });
    return { postId: input.postId, evergreenDays: input.days };
  },
});

// A copy of any post as a new draft (#575): its text, title, link and images, its labels, and each channel still
// connected with its own content and settings (its signature, #1190, among them); never its schedule, approvals or
// history. As tainted as its source. A member limited to some channels (#1081) copies those only, and a post with none
// of theirs is not theirs to copy. The copy is planned for scheduledAt when given, which must be ahead (the bulk bar's
// copies moved by days or weeks, #1192), else undated; either way it is a draft that goes through review again.
export const postDuplicate = defineCommand({
  name: 'social.post.duplicate',
  input: zSocialPostDuplicate,
  // The copy stays a draft, but copyPost, which makes it, alerts the org's team chat on Telegram or Discord when a copy
  // is submitted; the check of plan §4.7 counts every caller of an emit, so it is R2 like the copies that do (#1662).
  risk: 'R2',
  sideEffect: 'external',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input): Promise<DuplicateResult> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const at = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (at && at.getTime() <= ctx.now.getTime()) throw new DomainError('DUPLICATE_IN_PAST', 422, 'Giờ dự kiến của bản sao đã qua; hãy chọn một giờ ở tương lai', { scheduledAt: input.scheduledAt });
    const source = await lockPost(ctx.trx, ctx.orgId, input.postId);
    const scope = await refusePostOutside(ctx, source.id);
    const variants = inScope(scope, await lockVariants(ctx.trx, ctx.orgId, source.id)).filter((v) => v.status !== 'cancelled');
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
    if (targets.length === 0) throw new DomainError('NOTHING_TO_DUPLICATE', 409, 'Các kênh bạn dùng được của bài này không còn kết nối nên chưa nhân bản được');
    // A copy attaches its source's files anew (#1273), its channels' covers among them: an archived file (#1302), or
    // one the member may not use, is refused with 403 MEDIA_NOT_ALLOWED. Reposts, evergreen and recurring copies repeat
    // what already went out and keep them.
    // A link card's image (#1498) the same way.
    const covers = targets.flatMap((v) => {
      const cover = coverOf(settingsOf(v));
      const thumb = linkCardThumbOf(settingsOf(v));
      return [...(cover && 'fileId' in cover ? [cover.fileId] : []), ...(thumb ? [thumb] : [])];
    });
    await refuseUnusableMedia(ctx, [...[...source.media, ...targets.flatMap((v) => mediaFor(base(source), v))].map((m) => m.fileId), ...covers]);
    const { postId } = await copyPost(ctx, source, targets, { repostOf: null, submit: false, ...(at ? { scheduledAt: at } : {}) });
    const labels = await copyLabels(ctx, source.id, postId);
    ctx.audit({ scheduled_at: at ? at.toISOString() : null, labels });
    return { postId, repeats: await repeatsOf(ctx, postId) };
  },
});

export type DuplicateResult = z.infer<typeof zSocialPostDuplicateResult>;

// The source's labels on the copy. Held until the commit, so a label deleted meanwhile waits rather than failing the
// insert; one deleted before is simply not there.
async function copyLabels(ctx: CommandContext, fromId: string, toId: string): Promise<number> {
  const ids = (await ctx.trx.selectFrom('crove_social.post_label').select('label_id').where('org_id', '=', ctx.orgId).where('post_id', '=', fromId).execute()).map((r) => r.label_id);
  if (ids.length === 0) return 0;
  const found = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ids).forKeyShare().execute();
  if (found.length === 0) return 0;
  await ctx.trx
    .insertInto('crove_social.post_label')
    .values(found.map((l) => ({ org_id: ctx.orgId, post_id: toId, label_id: l.id, created_at: ctx.now })))
    .execute();
  return found.length;
}

// The copy's channels on X and LinkedIn whose text, signature included, matches another post there (#1156): those
// platforms refuse it, so the person copying hears of it before a reviewer does. Elsewhere the same text is only
// advice, which the post page gives.
async function repeatsOf(ctx: CommandContext, postId: string): Promise<DuplicateResult['repeats']> {
  const post = await lockPost(ctx.trx, ctx.orgId, postId);
  const variants = (await lockVariants(ctx.trx, ctx.orgId, postId)).filter((v) => refusesDuplicates(v.provider));
  if (variants.length === 0) return [];
  const found = await duplicatesOf(
    ctx.trx,
    ctx.orgId,
    variants.map((v) => ({
      id: v.id,
      postId,
      connectionId: v.channel_connection_id,
      status: v.status,
      body: effectiveContent({ body: post.body, title: null, linkUrl: null }, overrides(v), v.content_frozen, settingsOf(v)).body,
    })),
    ctx.now,
  );
  return variants.flatMap((v) => {
    const match = found.get(v.id);
    return match ? [{ variantId: v.id, connectionId: v.channel_connection_id, provider: v.provider, at: match.at, status: match.status }] : [];
  });
}

export const evergreenCommands = [postRepost, postRepostEvergreen, postSetEvergreen, postDuplicate];

// One pass: every evergreen post due gets its repost, sent to review. The scan is asked again, without the posts already
// tried, until it lists no more (#1001): a post that only waits (its channels expired) comes back every pass and can no
// longer fill the page and keep another org's post out. At most SWEEP_PAGES pages a pass.
export async function sweepEvergreen(deps: { runtime: Runtime; workerDb: Db; pageSize?: number }): Promise<number> {
  const pageSize = deps.pageSize ?? SWEEP_PAGE;
  const tried: string[] = [];
  let made = 0;
  for (let page = 0; page < SWEEP_PAGES; page += 1) {
    const { rows } = await sql<{ org_id: string; post_id: string }>`SELECT org_id, post_id FROM crove_social.evergreen_due(${pageSize}::int, ${tried}::uuid[])`.execute(deps.workerDb);
    for (const row of rows) {
      tried.push(row.post_id);
      try {
        const done = await deps.runtime.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId: row.post_id }, { actor: ACTOR, orgId: row.org_id });
        if (done.postId) made += 1;
      } catch (error) {
        console.warn(`[social-evergreen] post ${row.post_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
      }
    }
    if (rows.length < pageSize) break;
  }
  return made;
}

