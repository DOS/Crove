// Crove Social posts (Social plan §3.2-3.3, step S3, issue #233): compose a post for several channel connections,
// edit it, submit it for review, decide per variant, schedule, cancel. Every write goes through these commands;
// publishing itself is the publish job's (S4).
//
// Rules the commands keep:
// - A variant's effective content is the post's base content with the variant's overrides; its content hash and
//   revision follow every change of it, and a change sends the variant back to draft.
// - A variant in flight (publishing, processing, ambiguous, needs_attention) is never edited or cancelled; a published
//   or cancelled one is history, so its inherited content is copied into it before the base changes.
// - A reviewer decides on the exact revision and content hash they saw; a decision on anything else is refused.
// - Scheduling needs the variant's latest decision to be an approval of its current revision and hash.
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES, zId } from '@crove/kernel-contract';
import type { MemberRole, SocialDecision, SocialVariantStatus } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { approvalCovers, approvalsInRound, effectiveContent, type BaseContent, type PostMedia } from './domain/approval.ts';
import { COVER_IMAGE_MAX_BYTES, COVER_IMAGE_TYPES, coverOf, firstCommentOf, isProvider, threadPartsOf } from './domain/channels.ts';
import { isValidTimeZone, nextFreeSlot, placeQueued, retime, type QueueSpec } from './domain/queue.ts';
import { FROZEN, IN_FLIGHT, type VariantEvent } from './domain/state.ts';
import type { Issue } from './domain/validate.ts';
import { activityCommands, activityQueries } from './activity.ts';
import { accountCommands, accountQueries } from './accounts.ts';
import { reportLinkCommands, reportLinkQueries } from './report-links.ts';
import { linkPreviewCommands, linkPreviewQueries } from './link-preview.ts';
import { notificationCommands, notificationQueries } from './notifications.ts';
import { reminderCommands } from './reminders.ts';
import { assignCommands } from './assign.ts';
import { publishingCommands } from './publishing.ts';
import { snippetCommands, snippetQueries } from './snippets.ts';
import { labelCommands, labelQueries, labelsOfPosts } from './labels.ts';
import { ideaCommands, ideaOfPost, ideaQueries, linkIdeaToPost } from './ideas.ts';
import { bioCommands, bioQueries } from './bio-page.ts';
import { feedCommands, feedQueries } from './feeds.ts';
import { reportScheduleCommands, reportScheduleQueries } from './report-schedules.ts';
import { brandVoiceCommands, brandVoiceQueries } from './brand-voice.ts';
import { reviewLinkCommands, reviewLinkQueries } from './review-links.ts';
import { libraryQueries, likeTerm } from './library.ts';
import { metricsCommands, metricsQueries } from './metrics.ts';
import { evergreenCommands } from './evergreen.ts';
import { commentCallsOf, commentCommands, commentStatus, type CommentStatus } from './comments.ts';
import { threadCallsOf, threadCommands, threadStatus } from './thread.ts';
import { autoReplyCommands } from './auto-reply.ts';
import { approvalsRequired, decisionsOf, fourEyesOn, policyCommands, policyQueries, shortOfPolicy } from './policy.ts';
import { CLEAR_ERROR, MOVABLE, POLICY_RAISED, POST_COLUMNS, SLOT_FREED, approvedValues, base, editValues, mediaFor, type PostContent, freezeValues, hashOf, issuesOf, latestDecision, lockPost, lockVariants, mediaOf, overrides, pick, providerOf, refreshPostStatus, setVariant, settingsOf, step, variantPost, type PostRow, type VariantRow, type Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const MAX_CHANNELS_PER_POST = 20;
const MAX_SLOTS = 100;


const zBody = z.string().max(100_000);
const zTitle = z.string().max(500);
const zLink = z.url({ protocol: /^https?$/ }).max(2000);
const zTimeZone = z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone');
// Provider settings (privacy level, post type...): plain JSON, 16 KiB at most.
const zSettings = z.record(z.string().max(100), z.json()).refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 16_384, 'settings over 16 KiB');
const zVariantIds = z.array(zId).min(1).max(MAX_CHANNELS_PER_POST);
// A post's images, in order: files of the org uploaded for Social (JPEG, PNG or WEBP). The channel rules decide how
// many each channel takes; 20 is the most any supported channel shows in one post.
export const MAX_MEDIA_PER_POST = 20;
const zMedia = z
  .array(z.strictObject({ fileId: zId, altText: z.string().trim().max(1000).nullable().optional() }))
  .max(MAX_MEDIA_PER_POST)
  .refine((list) => new Set(list.map((m) => m.fileId)).size === list.length, 'each image once');
const MEDIA_TYPES: readonly string[] = [...SOCIAL_IMAGE_TYPES, ...SOCIAL_VIDEO_TYPES];
const zChannel = z.strictObject({
  connectionId: zId,
  body: zBody.nullable().optional(),
  title: zTitle.nullable().optional(),
  linkUrl: zLink.nullable().optional(),
  settings: zSettings.optional(),
  // The channel's own images or video instead of the post's (#581); null or absent: the post's.
  media: zMedia.nullable().optional(),
});
// The files a media list names, in its order, as the hash and the channel rules see them. Every file must be an image
// or a video of the org uploaded for posts.
async function resolveMedia(ctx: CommandContext, list: z.infer<typeof zMedia>): Promise<PostMedia[]> {
  if (list.length === 0) return [];
  const files = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select(['id', 'generation', 'content_type', 'size_bytes', 'source', 'duration_ms', 'image_width', 'image_height'])
    .where('org_id', '=', ctx.orgId)
    .where(
      'id',
      'in',
      list.map((m) => m.fileId),
    )
    .execute();
  const byId = new Map(files.map((f) => [f.id, f]));
  return list.map((m) => {
    const f = byId.get(m.fileId);
    // Only images uploaded for posts: an accounting document of the org is never published, whatever its type.
    if (!f || f.source !== 'social') throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này');
    if (!MEDIA_TYPES.includes(f.content_type)) throw new DomainError('MEDIA_TYPE_UNSUPPORTED', 422, 'Bài đăng chỉ nhận ảnh JPG, PNG, WEBP và video MP4, MOV');
    return { fileId: f.id, generation: f.generation, altText: m.altText || null, mime: f.content_type, sizeBytes: Number(f.size_bytes), durationMs: f.duration_ms === null ? null : Number(f.duration_ms), width: f.image_width ?? null, height: f.image_height ?? null };
  });
}

// A video's cover in a variant's settings (#642): a frame (a whole number of milliseconds) or an image of the org
// uploaded for Social, JPEG or PNG, within the channel's size limit. Which channels take which kind, and whether the
// variant shows one video, are channel rules (validateVariant), checked when it goes to review.
async function checkCover(ctx: CommandContext, provider: string, settings: Record<string, unknown> | undefined): Promise<void> {
  if (settings?.cover === undefined) return;
  const cover = coverOf(settings);
  if (!cover) throw new DomainError('COVER_INVALID', 422, 'Ảnh bìa phải là một thời điểm trong video hoặc một ảnh');
  if (!('fileId' in cover)) return;
  // Stored in the lower case ids are kept in, so the hash and the worker's lookup see one spelling.
  (settings.cover as { fileId: string }).fileId = cover.fileId;
  const file = zId.safeParse(cover.fileId).success
    ? await ctx.trx.selectFrom('crove_kernel.file').select(['source', 'content_type', 'size_bytes']).where('org_id', '=', ctx.orgId).where('id', '=', cover.fileId).executeTakeFirst()
    : undefined;
  // Only images uploaded for posts, as for the post's media.
  if (!file || file.source !== 'social') throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh bìa này');
  if (!COVER_IMAGE_TYPES.includes(file.content_type)) throw new DomainError('COVER_TYPE_UNSUPPORTED', 422, 'Ảnh bìa phải là ảnh JPG hoặc PNG');
  const max = isProvider(provider) ? COVER_IMAGE_MAX_BYTES[provider] : undefined;
  if (max !== undefined && Number(file.size_bytes) > max) {
    throw new DomainError('COVER_TOO_LARGE', 422, `Ảnh bìa cho kênh này tối đa ${Math.floor(max / 1_048_576)} MB`, { limit: max, actual: Number(file.size_bytes) });
  }
}

// Replaces a post's media rows with a list, positions from 1.
export async function writePostMedia(ctx: CommandContext, postId: string, media: readonly PostMedia[]): Promise<void> {
  await ctx.trx.deleteFrom('crove_social.post_media').where('org_id', '=', ctx.orgId).where('post_id', '=', postId).execute();
  if (media.length === 0) return;
  await ctx.trx
    .insertInto('crove_social.post_media')
    .values(media.map((m, i) => ({ org_id: ctx.orgId, post_id: postId, file_id: m.fileId, position: i + 1, alt_text: m.altText })))
    .execute();
}

const sameMedia = (a: readonly PostMedia[], b: readonly PostMedia[]) => a.length === b.length && a.every((m, i) => m.fileId === b[i]?.fileId && m.altText === b[i]?.altText);

// JSON with sorted keys, to compare settings whatever order jsonb returns them in.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The org's live connections among ids, with their provider; every id must be one.
async function liveConnections(ctx: CommandContext, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.channel_connection')
    .select(['id', 'provider'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...ids])
    .where('status', '<>', 'revoked')
    .execute();
  const map = new Map(rows.map((r) => [r.id, r.provider]));
  if (map.size !== new Set(ids).size) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
  for (const provider of map.values()) providerOf({ provider });
  return map;
}

export async function insertVariants(ctx: CommandContext, post: PostRow, channels: z.infer<typeof zChannel>[], startAt: number) {
  const providers = await liveConnections(
    ctx,
    channels.map((c) => c.connectionId),
  );
  const created: Array<{ variantId: string; connectionId: string }> = [];
  for (const [i, c] of channels.entries()) {
    const own = c.media ? await resolveMedia(ctx, c.media) : null;
    await checkCover(ctx, providers.get(c.connectionId) as string, c.settings);
    const row = {
      channel_connection_id: c.connectionId,
      provider: providers.get(c.connectionId) as string,
      body: c.body ?? null,
      title: c.title ?? null,
      link_url: c.linkUrl ?? null,
      settings: c.settings ?? {},
      media: own,
    };
    const inserted = await ctx.trx
      .insertInto('crove_social.post_variant')
      .values({
        org_id: ctx.orgId,
        post_id: post.id,
        ...row,
        settings: JSON.stringify(row.settings),
        media: own ? JSON.stringify(own) : null,
        position: startAt + i,
        content_hash: hashOf(base(post), row),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        if ((error as { constraint?: string }).constraint === 'post_variant_live_per_connection') {
          throw new DomainError('CHANNEL_ALREADY_IN_POST', 409, 'Bài đăng đã có kênh này');
        }
        throw error;
      });
    created.push({ variantId: inserted.id, connectionId: c.connectionId });
  }
  return created;
}

function distinctConnections(channels: Array<{ connectionId: string }>): void {
  if (new Set(channels.map((c) => c.connectionId)).size !== channels.length) {
    throw new DomainError('CHANNEL_ALREADY_IN_POST', 409, 'Mỗi kênh chỉ có một bản trong bài đăng');
  }
}

export const zPostCreate = z.strictObject({
  body: zBody,
  title: zTitle.nullable().optional(),
  linkUrl: zLink.nullable().optional(),
  timeZone: zTimeZone.optional(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
  media: zMedia.optional(),
  channels: z.array(zChannel).min(1).max(MAX_CHANNELS_PER_POST),
  // Set by the server only (the AI drafting route); the app's create never sends it. An AI draft is tainted: every
  // variant needs a person's approval of what the model wrote (plan §3.7).
  origin: z.enum(['human', 'ai']).optional(),
  // The member accepted an AI rewrite into the text (#583).
  aiAssisted: z.literal(true).optional(),
  // The idea it is made from (#701).
  ideaId: zId.optional(),
});

async function createPost(ctx: CommandContext, input: z.infer<typeof zPostCreate>) {
  const userId = requireUser(ctx);
  distinctConnections(input.channels);
  const media = await resolveMedia(ctx, input.media ?? []);
  const inserted = await ctx.trx
    .insertInto('crove_social.post')
    .values({
      org_id: ctx.orgId,
      body: input.body,
      title: input.title ?? null,
      link_url: input.linkUrl ?? null,
      // The surface sets actor_origin once API and MCP clients exist; today every write comes from the app.
      origin: input.origin ?? 'human',
      tainted: input.origin === 'ai' || input.aiAssisted === true,
      actor_origin: 'ui',
      author_user_id: userId,
      ...(input.timeZone ? { time_zone: input.timeZone } : {}),
      scheduled_at: input.scheduledAt ?? null,
    })
    .returning(POST_COLUMNS)
    .executeTakeFirstOrThrow();
  await writePostMedia(ctx, inserted.id, media);
  const post: PostRow = { ...inserted, media };
  const variants = await insertVariants(ctx, post, input.channels, 0);
  await ctx.emit('social.post.created', { post_id: post.id });
  return { post, variants, media };
}

export const postCreate = defineCommand({
  name: 'social.post.create',
  input: zPostCreate,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const { post, variants, media } = await createPost(ctx, input);
    if (input.ideaId) await linkIdeaToPost(ctx, input.ideaId, post.id);
    ctx.audit({ post_id: post.id, variants: variants.length, media: media.length, origin: input.origin ?? 'human', ...(input.ideaId ? { idea_id: input.ideaId } : {}) });
    return { postId: post.id, revision: post.revision, variants };
  },
});

// Many drafts at once from a sheet (#586): each row a post for its channels, text only (images are added on the post
// afterwards). With submit, the channels that fit their rules go to review; nothing is published without one.
export const MAX_IMPORT_ROWS = 200;
export const postImport = defineCommand({
  name: 'social.post.import',
  input: z.strictObject({
    posts: z
      .array(
        z.strictObject({
          body: zBody,
          title: zTitle.nullable().optional(),
          linkUrl: zLink.nullable().optional(),
          scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
          timeZone: zTimeZone.optional(),
          connectionIds: z.array(zId).min(1).max(MAX_CHANNELS_PER_POST),
        }),
      )
      .min(1)
      .max(MAX_IMPORT_ROWS),
    submit: z.boolean().optional(),
  }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const created: { postId: string; submitted: number }[] = [];
    for (const row of input.posts) {
      const { post, variants } = await createPost(ctx, {
        body: row.body,
        title: row.title ?? null,
        linkUrl: row.linkUrl ?? null,
        ...(row.scheduledAt ? { scheduledAt: row.scheduledAt } : {}),
        ...(row.timeZone ? { timeZone: row.timeZone } : {}),
        channels: row.connectionIds.map((connectionId) => ({ connectionId })),
      });
      let submitted = 0;
      if (input.submit) {
        const ready = (await lockVariants(ctx.trx, ctx.orgId, post.id)).filter((v) => variants.some((c) => c.variantId === v.id) && issuesOf(base(post), v).length === 0);
        for (const v of ready) await setVariant(ctx, v.id, { status: step(v, { type: 'submit' }) });
        if (ready.length > 0) {
          await refreshPostStatus(ctx, post.id);
          await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: ready.map((v) => v.id) });
        }
        submitted = ready.length;
      }
      created.push({ postId: post.id, submitted });
    }
    ctx.audit({ posts: created.length, submitted: created.reduce((n, c) => n + c.submitted, 0) });
    return { posts: created };
  },
});

export const postAddChannels = defineCommand({
  name: 'social.post.add_channels',
  input: z.strictObject({ postId: zId, channels: z.array(zChannel).min(1).max(MAX_CHANNELS_PER_POST) }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    distinctConnections(input.channels);
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    const existing = await lockVariants(ctx.trx, ctx.orgId, post.id);
    if (existing.length + input.channels.length > MAX_CHANNELS_PER_POST) {
      throw new DomainError('TOO_MANY_CHANNELS', 422, `Một bài đăng có tối đa ${MAX_CHANNELS_PER_POST} kênh`);
    }
    const start = existing.reduce((max, v) => Math.max(max, v.position + 1), 0);
    const variants = await insertVariants(ctx, post, input.channels, start);
    await refreshPostStatus(ctx, post.id);
    return { postId: post.id, variants };
  },
});

// Base content of a post. Every variant that inherits a changed field gets a new hash and revision and goes back to
// draft; a variant in flight refuses the whole edit; a published or cancelled one keeps what it had.
export const postUpdate = defineCommand({
  name: 'social.post.update',
  input: z.strictObject({
    postId: zId,
    revision: z.number().int().positive(),
    body: zBody.optional(),
    title: zTitle.nullable().optional(),
    linkUrl: zLink.nullable().optional(),
    timeZone: zTimeZone.optional(),
    // The planned time of variants not yet scheduled; a scheduled variant keeps the time it was scheduled at.
    scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
    // The whole list of images, replacing the post's; omitted leaves them as they are.
    media: zMedia.optional(),
    // The member accepted an AI rewrite into the text (#583).
    aiAssisted: z.literal(true).optional(),
  }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    if (post.revision !== input.revision) throw new DomainError('STALE_REVISION', 409, 'Bài đăng đã được sửa ở nơi khác, hãy tải lại', { revision: post.revision });
    const next: PostRow = {
      ...post,
      body: input.body ?? post.body,
      title: input.title === undefined ? post.title : input.title,
      link_url: input.linkUrl === undefined ? post.link_url : input.linkUrl,
      time_zone: input.timeZone ?? post.time_zone,
      scheduled_at: input.scheduledAt === undefined ? post.scheduled_at : input.scheduledAt === null ? null : new Date(Date.parse(input.scheduledAt)),
      media: input.media === undefined ? post.media : await resolveMedia(ctx, input.media),
    };
    const mediaChanged = !sameMedia(post.media, next.media);
    const same =
      !mediaChanged &&
      next.body === post.body &&
      next.title === post.title &&
      next.link_url === post.link_url &&
      next.time_zone === post.time_zone &&
      next.scheduled_at?.getTime() === post.scheduled_at?.getTime();
    if (same) return { postId: post.id, revision: post.revision, changedVariants: [] as string[] };
    const variants = await lockVariants(ctx.trx, ctx.orgId, post.id);
    // History whose content is not frozen yet is frozen first, whatever changes.
    for (const v of variants.filter((x) => FROZEN.has(x.status) && !x.content_frozen)) await setVariant(ctx, v.id, freezeValues(post, v));
    const changed = variants.filter((v) => !FROZEN.has(v.status) && hashOf(base(next), v) !== v.content_hash);
    const blocked = changed.filter((v) => IN_FLIGHT.has(v.status));
    if (blocked.length > 0) {
      throw new DomainError('VARIANT_IN_FLIGHT', 409, 'Có kênh đang đăng: chờ kết quả rồi mới sửa nội dung chung', { variantIds: blocked.map((v) => v.id) });
    }
    for (const v of changed) await setVariant(ctx, v.id, { content_hash: hashOf(base(next), v), revision: v.revision + 1, ...editValues(v) });
    if (mediaChanged) await writePostMedia(ctx, post.id, next.media);
    const revision = post.revision + 1;
    await ctx.trx
      .updateTable('crove_social.post')
      .set({ body: next.body, title: next.title, link_url: next.link_url, time_zone: next.time_zone, scheduled_at: next.scheduled_at, revision, updated_at: ctx.now, ...(input.aiAssisted ? { tainted: true } : {}) })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', post.id)
      .execute();
    await refreshPostStatus(ctx, post.id);
    return { postId: post.id, revision, changedVariants: changed.map((v) => v.id) };
  },
});

// One variant's overrides and settings. null inherits the post's value again; omitted leaves it as is.
export const variantUpdate = defineCommand({
  name: 'social.variant.update',
  input: z.strictObject({
    variantId: zId,
    revision: z.number().int().positive(),
    body: zBody.nullable().optional(),
    title: zTitle.nullable().optional(),
    linkUrl: zLink.nullable().optional(),
    settings: zSettings.optional(),
    // The member accepted an AI rewrite into the text (#583): the post is tainted.
    aiAssisted: z.literal(true).optional(),
    // The channel's own images or video (#581); null goes back to the post's.
    media: zMedia.nullable().optional(),
  }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const postId = await variantPost(ctx.trx, ctx.orgId, [input.variantId]);
    const post = await lockPost(ctx.trx, ctx.orgId, postId);
    const [v] = pick(await lockVariants(ctx.trx, ctx.orgId, postId), [input.variantId]) as [VariantRow];
    if (v.revision !== input.revision) throw new DomainError('STALE_REVISION', 409, 'Kênh này đã được sửa ở nơi khác, hãy tải lại', { revision: v.revision });
    if (input.settings) await checkCover(ctx, v.provider, input.settings);
    const next = {
      ...v,
      body: input.body === undefined ? v.body : input.body,
      title: input.title === undefined ? v.title : input.title,
      link_url: input.linkUrl === undefined ? v.link_url : input.linkUrl,
      settings: input.settings ?? settingsOf(v),
      media: input.media === undefined ? v.media : input.media === null ? null : await resolveMedia(ctx, input.media),
    };
    if (v.content_frozen || FROZEN.has(v.status)) step(v, { type: 'edit' });
    const columns = { body: next.body, title: next.title, link_url: next.link_url, settings: JSON.stringify(next.settings), media: next.media === null ? null : JSON.stringify(next.media) };
    const stored =
      v.body === next.body && v.title === next.title && v.link_url === next.link_url && canonicalJson(settingsOf(v)) === canonicalJson(next.settings) && canonicalJson(v.media) === canonicalJson(next.media);
    const hash = hashOf(base(post), next);
    if (hash === v.content_hash) {
      // The effective content is the same (for example an override equal to the base, or inheriting it again): store
      // what the user chose, so later base edits reach the variant or not as they asked, without a new revision.
      if (!stored) await setVariant(ctx, v.id, columns);
      return { variantId: v.id, revision: v.revision, changed: false };
    }
    await setVariant(ctx, v.id, { ...columns, content_hash: hash, revision: v.revision + 1, ...editValues(v) });
    if (input.aiAssisted) await ctx.trx.updateTable('crove_social.post').set({ tainted: true, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', postId).execute();
    await refreshPostStatus(ctx, postId);
    return { variantId: v.id, revision: v.revision + 1, changed: true };
  },
});

// Sends variants (all that can go) to review; a variant that does not fit its channel is refused with its issues.
export const postSubmit = defineCommand({
  name: 'social.post.submit',
  input: z.strictObject({ postId: zId, variantIds: zVariantIds.optional() }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    const all = await lockVariants(ctx.trx, ctx.orgId, post.id);
    const chosen = input.variantIds ? pick(all, input.variantIds) : all.filter((v) => ['draft', 'changes_requested', 'rejected'].includes(v.status));
    if (chosen.length === 0) throw new DomainError('NOTHING_TO_SUBMIT', 409, 'Không có kênh nào cần gửi duyệt');
    const invalid = chosen.map((v) => ({ variantId: v.id, issues: issuesOf(base(post), v) })).filter((x) => x.issues.length > 0);
    if (invalid.length > 0) throw new DomainError('VARIANT_INVALID', 422, 'Có kênh chưa đúng yêu cầu của nền tảng', { variants: invalid });
    for (const v of chosen) await setVariant(ctx, v.id, { status: step(v, { type: 'submit' }) });
    await refreshPostStatus(ctx, post.id);
    await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: chosen.map((v) => v.id) });
    return { postId: post.id, submitted: chosen.map((v) => v.id) };
  },
});

const DECISION_EVENT: Record<SocialDecision, VariantEvent> = {
  approved: { type: 'approve' },
  changes_requested: { type: 'request_changes' },
  rejected: { type: 'reject' },
};

// A reviewer's decision on variants in review, each named with the revision and content hash the reviewer saw. A
// channel may need several approvals (its review policy, S9): each is a different person's approval of the same
// content, and the variant is approved with the last one; until then it stays in review.
export const variantDecide = defineCommand({
  name: 'social.variant.decide',
  input: z.strictObject({
    postId: zId,
    decision: z.enum(['approved', 'changes_requested', 'rejected']),
    comment: z.string().trim().max(2000).optional(),
    variants: z
      .array(z.strictObject({ variantId: zId, revision: z.number().int().positive(), contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }))
      .min(1)
      .max(MAX_CHANNELS_PER_POST),
  }),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    const all = await lockVariants(ctx.trx, ctx.orgId, post.id);
    const chosen = pick(
      all,
      input.variants.map((x) => x.variantId),
    );
    const seen = new Map(input.variants.map((x) => [x.variantId, x]));
    const required = await approvalsRequired(
      ctx.trx,
      ctx.orgId,
      chosen.map((v) => v.channel_connection_id),
    );
    const decisions = await decisionsOf(
      ctx.trx,
      ctx.orgId,
      chosen.map((v) => v.id),
    );
    // Four-eyes (#740): on these channels the author approves nothing of their own post.
    const author = (await ctx.trx.selectFrom('crove_social.post').select('author_user_id').where('org_id', '=', ctx.orgId).where('id', '=', post.id).executeTakeFirst())?.author_user_id ?? null;
    const foureyes = input.decision === 'approved' && author === userId ? await fourEyesOn(ctx.trx, ctx.orgId, chosen.map((v) => v.channel_connection_id)) : new Set<string>();
    const waiting: string[] = [];
    const rescheduled: string[] = [];
    for (const v of chosen) {
      const saw = seen.get(v.id);
      if (!saw || saw.revision !== v.revision || saw.contentHash !== v.content_hash) {
        throw new DomainError('STALE_REVISION', 409, 'Nội dung kênh đã đổi sau khi bạn xem, hãy xem lại trước khi duyệt', { variantId: v.id, revision: v.revision });
      }
      let status = step(v, DECISION_EVENT[input.decision]);
      if (input.decision === 'approved') {
        const given = approvalsInRound(decisions.get(v.id) ?? [], { revision: v.revision, contentHash: v.content_hash });
        if (foureyes.has(v.channel_connection_id)) throw new DomainError('SOCIAL_SELF_APPROVAL', 403, 'Kênh này cần người khác duyệt bài của bạn', { variantId: v.id });
        if (given.includes(userId)) throw new DomainError('ALREADY_APPROVED', 409, 'Bạn đã duyệt nội dung này của kênh, cần người khác duyệt tiếp', { variantId: v.id });
        if (given.length + 1 < (required.get(v.channel_connection_id) ?? 1)) {
          status = v.status;
          waiting.push(v.id);
        }
      }
      const content = effectiveContent(base(post), overrides(v), v.content_frozen);
      await ctx.trx
        .insertInto('crove_social.post_approval')
        .values({
          org_id: ctx.orgId,
          post_id: post.id,
          variant_id: v.id,
          revision: v.revision,
          content_hash: v.content_hash,
          decision: input.decision,
          comment: input.comment || null,
          decided_by: userId,
          actor_origin: 'ui',
          snapshot: JSON.stringify({
            provider: v.provider,
            channel_connection_id: v.channel_connection_id,
            body: content.body,
            title: content.title,
            link_url: content.linkUrl,
            media: mediaFor(base(post), v).map((m) => ({ file_id: m.fileId, generation: m.generation, alt_text: m.altText })),
            settings: settingsOf(v),
          }),
        })
        .execute();
      // The approval that completes the count may put a variant a raised policy took out of the schedule back on it;
      // a request for changes or a rejection ends that.
      const values =
        input.decision !== 'approved' ? { status, ...(v.error_code === POLICY_RAISED ? CLEAR_ERROR : {}) } : waiting.includes(v.id) ? { status } : approvedValues(v, ctx.now);
      await setVariant(ctx, v.id, values);
      if (values.status === 'scheduled') rescheduled.push(v.id);
    }
    await refreshPostStatus(ctx, post.id);
    ctx.audit({ post_id: post.id, decision: input.decision, variants: chosen.map((v) => v.id), waiting });
    await ctx.emit('social.variant.decided', { post_id: post.id, decision: input.decision, variant_ids: chosen.map((v) => v.id), waiting_variant_ids: waiting });
    if (rescheduled.length > 0) await ctx.emit('social.variant.scheduled', { post_id: post.id, variant_ids: rescheduled });
    return { postId: post.id, decision: input.decision, variants: chosen.map((v) => v.id), waiting };
  },
});

interface QueueState {
  id: string;
  spec: QueueSpec;
  paused: boolean;
}

async function lockQueue(trx: Trx, orgId: string, connectionId: string): Promise<QueueState | null> {
  const queue = await trx
    .selectFrom('crove_social.queue')
    .select(['id', 'time_zone', 'paused'])
    .where('org_id', '=', orgId)
    .where('channel_connection_id', '=', connectionId)
    .forUpdate()
    .executeTakeFirst();
  if (!queue) return null;
  const slots = await trx
    .selectFrom('crove_social.queue_slot')
    .select(['weekday', 'minute', 'label_id'])
    .where('org_id', '=', orgId)
    .where('queue_id', '=', queue.id)
    .where('active', '=', true)
    .execute();
  return { id: queue.id, paused: queue.paused, spec: { timeZone: queue.time_zone, slots: slots.map((s) => ({ weekday: s.weekday, minute: s.minute, labelId: s.label_id })) } };
}


async function takenSlots(trx: Trx, orgId: string, connectionId: string, exceptId?: string): Promise<Set<number>> {
  let q = trx
    .selectFrom('crove_social.post_variant')
    .select('queue_slot_at')
    .where('org_id', '=', orgId)
    .where('channel_connection_id', '=', connectionId)
    .where('queue_slot_at', 'is not', null)
    .where('status', 'not in', [...SLOT_FREED]);
  if (exceptId) q = q.where('id', '<>', exceptId);
  const rows = await q.execute();
  return new Set(rows.map((r) => (r.queue_slot_at as Date).getTime()));
}

// Schedules approved variants: at a time (`at`, else the post's default time), or in the next free slot of each
// connection's queue (`queue: true`).
export const variantSchedule = defineCommand({
  name: 'social.variant.schedule',
  input: z
    .strictObject({
      postId: zId,
      variantIds: zVariantIds.optional(),
      at: z.iso.datetime({ offset: true }).optional(),
      queue: z.literal(true).optional(),
      // A time per channel (#576): these variants, each at its own time.
      times: z
        .array(z.strictObject({ variantId: zId, at: z.iso.datetime({ offset: true }) }))
        .min(1)
        .max(MAX_CHANNELS_PER_POST)
        .optional(),
    })
    .refine((x) => !(x.at && x.queue), 'choose a time or the queue, not both')
    .refine((x) => !x.times || (!x.at && !x.queue && !x.variantIds), 'times names the variants and their times on its own'),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    // Lock order: queue rows (sorted by connection), then the post, then its variants. social.queue.set takes the
    // queue row before the variants too, so the two never wait on each other in a cycle.
    const queues = new Map<string, QueueState | null>();
    if (input.queue) {
      const connections = await ctx.trx
        .selectFrom('crove_social.post_variant')
        .select('channel_connection_id')
        .distinct()
        .where('org_id', '=', ctx.orgId)
        .where('post_id', '=', input.postId)
        .orderBy('channel_connection_id')
        .execute();
      for (const c of connections) queues.set(c.channel_connection_id, await lockQueue(ctx.trx, ctx.orgId, c.channel_connection_id));
    }
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    const all = await lockVariants(ctx.trx, ctx.orgId, post.id);
    const times = new Map((input.times ?? []).map((x) => [x.variantId, new Date(Date.parse(x.at))]));
    // The post's labels, read once, for the slots of content categories (#745).
    let labels: Set<string> | null = null;
    const postLabels = async () => (labels ??= new Set(((await labelsOfPosts(ctx.trx, ctx.orgId, [post.id])).get(post.id) ?? []).map((l) => l.id)));
    const chosen = input.times ? pick(all, [...times.keys()]) : input.variantIds ? pick(all, input.variantIds) : all.filter((v) => v.status === 'approved');
    if (chosen.length === 0) throw new DomainError('NOTHING_TO_SCHEDULE', 409, 'Không có kênh nào đã duyệt để lên lịch');
    const shared = input.at ? new Date(Date.parse(input.at)) : post.scheduled_at;
    const timeOf = (v: VariantRow) => times.get(v.id) ?? shared;
    if (!input.queue) {
      for (const v of chosen) {
        const at = timeOf(v);
        if (!at) throw new DomainError('SCHEDULE_REQUIRED', 422, 'Hãy chọn giờ đăng hoặc dùng hàng đợi');
        if (at.getTime() <= ctx.now.getTime()) throw new DomainError('SCHEDULE_IN_PAST', 422, 'Giờ đăng phải ở tương lai', { variantId: v.id });
      }
    }
    const scheduled: Array<{ variantId: string; at: string }> = [];
    for (const v of chosen) {
      const decision = await latestDecision(ctx.trx, ctx.orgId, v.id);
      if (decision?.decision !== 'approved' || !approvalCovers({ revision: decision.revision, contentHash: decision.content_hash }, { revision: v.revision, contentHash: v.content_hash })) {
        throw new DomainError('APPROVAL_REQUIRED', 409, 'Kênh này chưa được duyệt đúng nội dung hiện tại', { variantId: v.id });
      }
      // Approved under a bar its channel has raised since (#408).
      if (await shortOfPolicy(ctx.trx, ctx.orgId, v)) throw new DomainError('APPROVALS_MISSING', 409, 'Kênh này cần thêm người duyệt trước khi lên lịch', { variantId: v.id });
      const status = step(v, { type: 'schedule' });
      if (input.queue) {
        const queue = queues.get(v.channel_connection_id) ?? null;
        if (!queue || queue.spec.slots.length === 0) throw new DomainError('QUEUE_EMPTY', 409, 'Kênh này chưa có khung giờ đăng trong hàng đợi', { variantId: v.id });
        // A post's labels pick the slots of their content categories first (#745).
        const slot = nextFreeSlot(queue.spec, ctx.now.getTime(), await takenSlots(ctx.trx, ctx.orgId, v.channel_connection_id, v.id), 366, await postLabels());
        if (slot === null) throw new DomainError('QUEUE_FULL', 409, 'Hàng đợi của kênh này đã kín trong năm tới', { variantId: v.id });
        await setVariant(ctx, v.id, { status, queue_slot_at: new Date(slot), scheduled_at: null, error_retry_at: null });
        scheduled.push({ variantId: v.id, at: new Date(slot).toISOString() });
      } else {
        // The time is stored on the variant, so a later change of the post's planned time does not move it.
        const at = timeOf(v) as Date;
        await setVariant(ctx, v.id, { status, queue_slot_at: null, scheduled_at: at, error_retry_at: null });
        scheduled.push({ variantId: v.id, at: at.toISOString() });
      }
    }
    await refreshPostStatus(ctx, post.id);
    await ctx.emit('social.variant.scheduled', { post_id: post.id, variant_ids: scheduled.map((s) => s.variantId) });
    return { postId: post.id, scheduled };
  },
});

export const variantUnschedule = defineCommand({
  name: 'social.variant.unschedule',
  input: z.strictObject({ variantIds: zVariantIds }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const postId = await variantPost(ctx.trx, ctx.orgId, input.variantIds);
    await lockPost(ctx.trx, ctx.orgId, postId);
    const chosen = pick(await lockVariants(ctx.trx, ctx.orgId, postId), input.variantIds);
    for (const v of chosen) await setVariant(ctx, v.id, { status: step(v, { type: 'unschedule' }), queue_slot_at: null, scheduled_at: null, error_retry_at: null });
    await refreshPostStatus(ctx, postId);
    return { postId, variants: chosen.map((v) => v.id) };
  },
});

// Moves a scheduled variant to another time (#580, the calendar's drag): its approvals stay, since its content does
// not change. A variant waiting on a queue slot leaves the slot for the exact time.
export const variantReschedule = defineCommand({
  name: 'social.variant.reschedule',
  input: z.strictObject({ variantId: zId, at: z.iso.datetime({ offset: true }) }),
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const postId = await variantPost(ctx.trx, ctx.orgId, [input.variantId]);
    await lockPost(ctx.trx, ctx.orgId, postId);
    const [v] = pick(await lockVariants(ctx.trx, ctx.orgId, postId), [input.variantId]);
    if (!v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
    if (v.status !== 'scheduled') throw new DomainError('VARIANT_STATE', 409, 'Chỉ đổi giờ được kênh đã lên lịch', { variantId: v.id, status: v.status });
    const at = new Date(Date.parse(input.at));
    if (at.getTime() <= ctx.now.getTime()) throw new DomainError('SCHEDULE_IN_PAST', 422, 'Giờ đăng phải ở tương lai', { variantId: v.id });
    // A variant waiting on a slot of a paused queue stays held by the pause: moving it to an exact time would let it go out.
    if (v.queue_slot_at && !v.scheduled_at && !v.error_retry_at) {
      const queue = await ctx.trx.selectFrom('crove_social.queue').select('paused').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', v.channel_connection_id).executeTakeFirst();
      if (queue?.paused) throw new DomainError('QUEUE_PAUSED', 409, 'Hàng đợi của kênh này đang tạm dừng; hãy chạy lại hàng đợi hoặc bỏ lịch trước', { variantId: v.id });
    }
    // The earlier refusal and its retry time belong to the old time.
    await setVariant(ctx, v.id, { ...CLEAR_ERROR, scheduled_at: at, queue_slot_at: null });
    await refreshPostStatus(ctx, postId);
    await ctx.emit('social.variant.scheduled', { post_id: postId, variant_ids: [v.id], rescheduled: true });
    return { postId, variantId: v.id, at: at.toISOString() };
  },
});

export const variantCancel = defineCommand({
  name: 'social.variant.cancel',
  input: z.strictObject({ variantIds: zVariantIds }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const postId = await variantPost(ctx.trx, ctx.orgId, input.variantIds);
    const post = await lockPost(ctx.trx, ctx.orgId, postId);
    const chosen = pick(await lockVariants(ctx.trx, ctx.orgId, postId), input.variantIds);
    // Approved, scheduled or paused work was signed off by an owner or admin: only they take it back.
    if (chosen.some((v) => ['approved', 'scheduled', 'paused'].includes(v.status)) && ctx.role !== 'owner' && ctx.role !== 'admin') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới hủy được kênh đã duyệt hoặc đã lên lịch');
    }
    for (const v of chosen) await setVariant(ctx, v.id, { status: step(v, { type: 'cancel' }), ...freezeValues(post, v) });
    await refreshPostStatus(ctx, postId);
    await ctx.emit('social.variant.cancelled', { post_id: postId, variant_ids: chosen.map((v) => v.id) });
    return { postId, variants: chosen.map((v) => v.id) };
  },
});

// Sets a connection's queue: time zone, pause and weekly slots (replacing the old ones). Queued variants keep their
// slot when it still exists (after a time-zone change, at the same local clock time); the others move to the first
// free slots. Nothing else moves.
export const queueSet = defineCommand({
  name: 'social.queue.set',
  input: z.strictObject({
    connectionId: zId,
    timeZone: zTimeZone,
    paused: z.boolean().optional(),
    slots: z
      .array(z.strictObject({ weekday: z.number().int().min(1).max(7), minute: z.number().int().min(0).max(1439), label: z.string().trim().max(100).optional(), labelId: zId.nullable().optional() }))
      .max(MAX_SLOTS),
  }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    await liveConnections(ctx, [input.connectionId]);
    if (new Set(input.slots.map((s) => `${s.weekday}:${s.minute}`)).size !== input.slots.length) {
      throw new DomainError('DUPLICATE_SLOT', 422, 'Có khung giờ bị trùng');
    }
    // A slot kept for a content category names one of the org's labels (#745).
    const labelIds = [...new Set(input.slots.map((s) => s.labelId).filter((id): id is string => typeof id === 'string'))];
    if (labelIds.length > 0) {
      const found = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', labelIds).execute();
      if (found.length !== labelIds.length) throw new DomainError('LABEL_NOT_FOUND', 404, 'Không tìm thấy nhãn này');
    }
    // Create the row if missing (a concurrent first set waits here instead of failing on the unique key), then lock
    // it: schedule commands lock the same row before any variant.
    const missing = await ctx.trx
      .insertInto('crove_social.queue')
      .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, time_zone: input.timeZone, paused: input.paused ?? false })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    const locked = await lockQueue(ctx.trx, ctx.orgId, input.connectionId);
    const before = missing ? null : locked;
    const queueId = (locked as QueueState).id;
    if (before) {
      await ctx.trx
        .updateTable('crove_social.queue')
        .set({ time_zone: input.timeZone, paused: input.paused ?? before.paused, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', before.id)
        .execute();
      await ctx.trx.deleteFrom('crove_social.queue_slot').where('org_id', '=', ctx.orgId).where('queue_id', '=', before.id).execute();
    }
    if (input.slots.length > 0) {
      await ctx.trx
        .insertInto('crove_social.queue_slot')
        .values(input.slots.map((s) => ({ org_id: ctx.orgId, queue_id: queueId, weekday: s.weekday, minute: s.minute, label: s.label ?? null, label_id: s.labelId ?? null })))
        .execute();
    }
    const spec: QueueSpec = { timeZone: input.timeZone, slots: input.slots.map((x) => ({ weekday: x.weekday, minute: x.minute, labelId: x.labelId ?? null })) };
    // Lock order: queue row, then the posts of the variants holding its slots (sorted), then those variants, as every
    // post command locks a post before its variants. No new slot holder appears meanwhile: only schedule assigns
    // slots, and it waits for the queue row this command holds.
    const holderPosts = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select('post_id')
      .distinct()
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .where('queue_slot_at', 'is not', null)
      .where('status', 'not in', [...SLOT_FREED])
      .orderBy('post_id')
      .execute();
    if (holderPosts.length > 0) {
      await ctx.trx
        .selectFrom('crove_social.post')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where(
          'id',
          'in',
          holderPosts.map((h) => h.post_id),
        )
        .orderBy('id')
        .forUpdate()
        .execute();
    }
    const holders = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['id', 'post_id', 'status', 'queue_slot_at'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .where('queue_slot_at', 'is not', null)
      .where('status', 'not in', [...SLOT_FREED])
      .orderBy('queue_slot_at')
      .orderBy('id')
      .forUpdate()
      .execute();
    const now = ctx.now.getTime();
    // In-flight variants and ones already due keep their slot untouched; nobody else may take it.
    const movable = holders.filter((h) => MOVABLE.includes(h.status) && (h.queue_slot_at as Date).getTime() > now);
    const reserved = new Set(holders.filter((h) => !movable.includes(h)).map((h) => (h.queue_slot_at as Date).getTime()));
    const zoneChanged = before !== null && before.spec.timeZone !== input.timeZone;
    const labelsOf = await labelsOfPosts(
      ctx.trx,
      ctx.orgId,
      [...new Set(movable.map((q) => q.post_id))],
    );
    const placed = placeQueued(
      spec,
      movable.map((q) => {
        const at = (q.queue_slot_at as Date).getTime();
        return { id: q.id, slotAt: zoneChanged ? retime(at, (before as QueueState).spec.timeZone, input.timeZone) : at, labelIds: (labelsOf.get(q.post_id) ?? []).map((l) => l.id) };
      }),
      now,
      reserved,
    );
    const was = new Map(movable.map((q) => [q.id, (q.queue_slot_at as Date).getTime()]));
    const moved = placed.filter((p) => p.slotAt !== was.get(p.id));
    // Clear first, then assign: two posts trading slots never meet on the unique slot index.
    for (const p of moved) await setVariant(ctx, p.id, { queue_slot_at: null });
    const posts = new Set<string>();
    for (const p of moved) {
      const row = movable.find((m) => m.id === p.id) as (typeof movable)[number];
      posts.add(row.post_id);
      if (p.slotAt === null) {
        // No slot left within a year: the variant leaves the queue and waits for a person.
        if (row.status === 'scheduled' || row.status === 'paused') await setVariant(ctx, p.id, { status: step(row, { type: 'unschedule' }) });
        continue;
      }
      await setVariant(ctx, p.id, { queue_slot_at: new Date(p.slotAt) });
    }
    for (const postId of posts) await refreshPostStatus(ctx, postId);
    return { queueId, moved: moved.map((p) => ({ variantId: p.id, at: p.slotAt === null ? null : new Date(p.slotAt).toISOString() })) };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------------

export interface VariantView {
  id: string;
  connectionId: string;
  provider: string;
  position: number;
  overrides: { body: string | null; title: string | null; linkUrl: string | null };
  ownMedia: boolean;
  effective: BaseContent;
  // The images this variant shows: its own list, or the post's.
  media: MediaView[];
  settings: Record<string, unknown>;
  revision: number;
  contentHash: string;
  status: SocialVariantStatus;
  // When it goes out: a retry time after a rate limit, else its queue slot, else its own time, else the post's.
  effectiveAt: string | null;
  queueSlotAt: string | null;
  commentStatus: CommentStatus | null;
  // The thread of a published channel (#742): how many parts are out (the post counts as one) and the next one's state.
  threadStatus: { state: 'pending' | 'posted' | 'failed' | 'unknown'; posted: number; total: number } | null;
  queuePaused: boolean;
  attempt: number;
  externalUrl: string | null;
  publishedAt: string | null;
  error: { kind: string | null; code: string | null; action: string | null; message: string | null; retryAt: string | null } | null;
  issues: Issue[];
  latestDecision: { decision: SocialDecision; comment: string | null; decidedBy: string; at: string; revision: number; current: boolean } | null;
  // The approvals its channel needs (S9) and who approved its current content in the open review round.
  review: { required: number; approvedBy: string[]; fourEyes: boolean };
}

export interface MediaView {
  fileId: string;
  altText: string | null;
  mime: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

const mediaView = (list: readonly PostMedia[]): MediaView[] => list.map((m) => ({ fileId: m.fileId, altText: m.altText, mime: m.mime, sizeBytes: m.sizeBytes, durationMs: m.durationMs ?? null, width: m.width ?? null, height: m.height ?? null }));

export interface PostView {
  id: string;
  body: string;
  title: string | null;
  linkUrl: string | null;
  media: MediaView[];
  // Reposted every N days (S9), or null; and the post this one reposts.
  evergreenDays: number | null;
  repostOf: string | null;
  timeZone: string;
  scheduledAt: string | null;
  revision: number;
  status: string;
  origin: string;
  tainted: boolean;
  authorUserId: string | null;
  // Who should move the post along, and by when (#640).
  assigneeUserId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  variants: VariantView[];
  // Its labels (#639), by label name.
  labelIds: string[];
  // The idea it was made from (#701); on a single post's read only.
  idea?: { id: string; title: string } | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function viewPosts(ctx: QueryContext, postIds: string[]): Promise<PostView[]> {
  if (postIds.length === 0) return [];
  const posts = await ctx.trx.selectFrom('crove_social.post').selectAll().where('org_id', '=', ctx.orgId).where('id', 'in', postIds).execute();
  const variants = await ctx.trx
    .selectFrom('crove_social.post_variant')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('post_id', 'in', postIds)
    .orderBy('position')
    .orderBy('id')
    .execute();
  const decisions = variants.length
    ? await ctx.trx
        .selectFrom('crove_social.post_approval')
        .select(['variant_id', 'decision', 'comment', 'decided_by', 'created_at', 'revision', 'content_hash', 'id'])
        .where('org_id', '=', ctx.orgId)
        .where(
          'variant_id',
          'in',
          variants.map((v) => v.id),
        )
        // Newest by id: written under the post lock, unlike created_at (its transaction's start).
        .orderBy('id', 'desc')
        .execute()
    : [];
  const latest = new Map<string, (typeof decisions)[number]>();
  for (const d of decisions) if (!latest.has(d.variant_id)) latest.set(d.variant_id, d);
  const required = await approvalsRequired(ctx.trx, ctx.orgId, [...new Set(variants.map((v) => v.channel_connection_id))]);
  const foureyes = await fourEyesOn(ctx.trx, ctx.orgId, [...new Set(variants.map((v) => v.channel_connection_id))]);
  // Queues paused by a person (#576): a variant waiting on a slot there does not go out until it is resumed.
  const queued = [...new Set(variants.filter((v) => v.queue_slot_at !== null).map((v) => v.channel_connection_id))];
  const pausedQueues = new Set(
    queued.length === 0
      ? []
      : (await ctx.trx.selectFrom('crove_social.queue').select('channel_connection_id').where('org_id', '=', ctx.orgId).where('channel_connection_id', 'in', queued).where('paused', '=', true).execute()).map(
          (q) => q.channel_connection_id,
        ),
  );
  // The first comment of each published channel that has one (#587).
  const commented = variants.filter((v) => v.status === 'published' && v.external_post_id && firstCommentOf(settingsOf(v)));
  const calls = await commentCallsOf(ctx.trx, ctx.orgId, commented);
  const now = new Date();
  const comments = new Map<string, CommentStatus>(commented.map((v) => [v.id, commentStatus(calls.get(v.id) ?? [], now, v.published_at)]));
  // The thread of each published channel that has one (#742).
  const threaded = variants.filter((v) => v.status === 'published' && v.external_post_id && threadPartsOf(settingsOf(v)));
  const partCalls = await threadCallsOf(ctx.trx, ctx.orgId, threaded);
  const threads = new Map(
    threaded.map((v) => {
      const s = threadStatus((threadPartsOf(settingsOf(v)) as string[]).length, partCalls.get(v.id) ?? [], now, v.published_at);
      return [v.id, { state: s.state, posted: s.posted, total: s.total }] as const;
    }),
  );
  const mediaRows = await ctx.trx
    .selectFrom('crove_social.post_media as m')
    .innerJoin('crove_kernel.file as f', (j) => j.onRef('f.org_id', '=', 'm.org_id').onRef('f.id', '=', 'm.file_id'))
    .select(['m.post_id', 'm.file_id', 'm.alt_text', 'f.generation', 'f.content_type', 'f.size_bytes', 'f.duration_ms', 'f.image_width', 'f.image_height'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.post_id', 'in', postIds)
    .orderBy('m.position')
    .execute();
  const mediaByPost = new Map<string, PostMedia[]>();
  for (const r of mediaRows) {
    const list = mediaByPost.get(r.post_id) ?? [];
    list.push({ fileId: r.file_id, generation: r.generation, altText: r.alt_text, mime: r.content_type, sizeBytes: Number(r.size_bytes), durationMs: r.duration_ms === null ? null : Number(r.duration_ms), width: r.image_width ?? null, height: r.image_height ?? null });
    mediaByPost.set(r.post_id, list);
  }
  const labels = await labelsOfPosts(ctx.trx, ctx.orgId, postIds);
  const byPost = new Map(posts.map((p) => [p.id, p]));
  return postIds
    .map((id) => byPost.get(id))
    .filter((p): p is (typeof posts)[number] => p !== undefined)
    .map((p) => {
      const b: PostContent = { body: p.body, title: p.title, linkUrl: p.link_url, media: mediaByPost.get(p.id) ?? [] };
      return {
        id: p.id,
        body: p.body,
        title: p.title,
        linkUrl: p.link_url,
        media: mediaView(b.media),
        evergreenDays: p.evergreen_days,
        repostOf: p.repost_of,
        timeZone: p.time_zone,
        scheduledAt: iso(p.scheduled_at),
        revision: p.revision,
        status: p.status,
        origin: p.origin,
        tainted: p.tainted,
        authorUserId: p.author_user_id,
        assigneeUserId: p.assignee_user_id,
        dueAt: iso(p.due_at),
        createdAt: iso(p.created_at) ?? '',
        updatedAt: iso(p.updated_at) ?? '',
        labelIds: (labels.get(p.id) ?? []).map((l) => l.id),
        variants: variants
          .filter((v) => v.post_id === p.id)
          .map((v) => {
            const d = latest.get(v.id);
            const row = v as unknown as VariantRow;
            return {
              id: v.id,
              connectionId: v.channel_connection_id,
              provider: v.provider,
              position: v.position,
              overrides: overrides(v),
              ownMedia: !v.content_frozen && mediaOf(v.media) !== null,
              effective: effectiveContent(b, overrides(v), v.content_frozen),
              media: mediaView(mediaFor(b, v)),
              settings: settingsOf(v),
              revision: v.revision,
              contentHash: v.content_hash,
              status: v.status,
              effectiveAt: iso(v.status === 'published' ? v.published_at : (v.error_retry_at ?? v.queue_slot_at ?? v.scheduled_at ?? p.scheduled_at)),
              queueSlotAt: iso(v.queue_slot_at),
              commentStatus: comments.get(v.id) ?? null,
              threadStatus: threads.get(v.id) ?? null,
              // As the publisher decides it (queuePaused in publishing.ts): a retry time goes out whatever the queue does.
              queuePaused: v.queue_slot_at !== null && v.scheduled_at === null && v.error_retry_at === null && pausedQueues.has(v.channel_connection_id),
              attempt: v.attempt,
              externalUrl: v.external_url,
              publishedAt: iso(v.published_at),
              error: v.error_kind || v.error_code || v.error_message ? { kind: v.error_kind, code: v.error_code, action: v.error_action, message: v.error_message, retryAt: iso(v.error_retry_at) } : null,
              issues: isProvider(v.provider) ? issuesOf(b, row) : [],
              latestDecision: d
                ? { decision: d.decision, comment: d.comment, decidedBy: d.decided_by, at: iso(d.created_at) ?? '', revision: d.revision, current: d.revision === v.revision && d.content_hash === v.content_hash }
                : null,
              review: {
                required: required.get(v.channel_connection_id) ?? 1,
                // The author may not approve on this channel (#740).
                fourEyes: foureyes.has(v.channel_connection_id),
                approvedBy: approvalsInRound(
                  decisions.filter((x) => x.variant_id === v.id).map((x) => ({ decision: x.decision, decidedBy: x.decided_by, revision: x.revision, contentHash: x.content_hash })),
                  { revision: v.revision, contentHash: v.content_hash },
                ),
              },
            };
          }),
      };
    });
}

export const postGet = defineQuery({
  name: 'social.post.get',
  input: z.object({ postId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<PostView> => {
    const [view] = await viewPosts(ctx, [input.postId]);
    if (!view) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
    return { ...view, idea: await ideaOfPost(ctx.trx, ctx.orgId, view.id) };
  },
});

// Posts, newest first; with from/to, those with a variant going out in [from, to) (the calendar).
export const postList = defineQuery({
  name: 'social.post.list',
  input: z.object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    status: z.enum(['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled']).optional(),
    // The Social home's lists (#574): posts with a channel in review; drafts with none in review; posts that went out
    // or stopped.
    // attention: a channel failed, needs a person, or waits paused on its channel (#579).
    stage: z.enum(['review', 'drafts', 'done', 'attention']).optional(),
    // Posts with a live channel on this connection.
    connectionId: zId.optional(),
    // Posts with this label (#639).
    labelId: zId.optional(),
    // Posts assigned to the viewer (#640).
    assignee: z.literal('me').optional(),
    // In the post's or a channel's own text or title; wildcards are matched as themselves.
    search: z.string().trim().min(1).max(200).optional(),
    // The last post of the previous page, newest change first.
    before: z.strictObject({ updatedAt: z.iso.datetime({ offset: true }), postId: zId }).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  access: ALL,
  handler: async (ctx, input): Promise<PostView[]> => {
    let q = ctx.trx.selectFrom('crove_social.post as p').select('p.id').where('p.org_id', '=', ctx.orgId);
    if (input.status) q = q.where('p.status', '=', input.status);
    if (input.assignee === 'me') q = q.where('p.assignee_user_id', '=', ctx.actor.type === 'user' ? ctx.actor.userId : '00000000-0000-0000-0000-000000000000');
    const variantWhere = (status: 'in_review' | null) =>
      sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status ${status ? sql`= ${status}` : sql`<> 'cancelled'`}${
        input.connectionId && !status ? sql` AND v.channel_connection_id = ${input.connectionId}::uuid` : sql``
      })`;
    // In review on the chosen channel when one is chosen: the same variant, not any of the post's.
    if (input.stage === 'review') q = q.where(input.connectionId ? sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'in_review' AND v.channel_connection_id = ${input.connectionId}::uuid)` : variantWhere('in_review'));
    if (input.stage === 'drafts') q = q.where('p.status', '=', 'draft').where(sql<boolean>`NOT ${variantWhere('in_review')}`);
    if (input.stage === 'done') q = q.where('p.status', 'in', ['published', 'partially_published', 'failed', 'publishing', 'cancelled']);
    if (input.stage === 'attention') {
      q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status IN ('failed', 'needs_attention', 'paused'))`);
    }
    if (input.connectionId) q = q.where(variantWhere(null));
    if (input.labelId) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = p.org_id AND pl.post_id = p.id AND pl.label_id = ${input.labelId}::uuid)`);
    if (input.search) {
      const term = likeTerm(input.search);
      q = q.where(
        sql<boolean>`(p.body ILIKE ${term} OR p.title ILIKE ${term} OR EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND (v.body ILIKE ${term} OR v.title ILIKE ${term})))`,
      );
    }
    // Ordered and paged by the change time as the answer carries it (milliseconds), so a page boundary inside one
    // millisecond neither repeats nor skips a post.
    const changed = sql`date_trunc('milliseconds', p.updated_at)`;
    const before = input.before;
    if (before) q = q.where(sql<boolean>`(${changed}, p.id) < (${new Date(Date.parse(before.updatedAt))}::timestamptz, ${before.postId}::uuid)`);
    if (input.from || input.to) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('crove_social.post_variant as v')
            .select(sql`1`.as('one'))
            .whereRef('v.org_id', '=', 'p.org_id')
            .whereRef('v.post_id', '=', 'p.id')
            .where('v.status', '<>', 'cancelled')
            .where((w) => {
              const at = sql`CASE WHEN v.status = 'published' THEN v.published_at ELSE coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at) END`;
              const parts = [];
              if (input.from) parts.push(w(at, '>=', new Date(Date.parse(input.from))));
              if (input.to) parts.push(w(at, '<', new Date(Date.parse(input.to))));
              return w.and(parts);
            }),
        ),
      );
    }
    const rows = await q.orderBy(changed, 'desc').orderBy('p.id', 'desc').limit(input.limit ?? 50).execute();
    return viewPosts(
      ctx,
      rows.map((r) => r.id),
    );
  },
});

export const queueGet = defineQuery({
  name: 'social.queue.get',
  input: z.object({ connectionId: zId }),
  access: ALL,
  handler: async (ctx, input) => {
    const queue = await ctx.trx
      .selectFrom('crove_social.queue')
      .select(['id', 'time_zone', 'paused'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .executeTakeFirst();
    if (!queue) return { connectionId: input.connectionId, queueId: null, timeZone: null, paused: false, slots: [], nextFree: [] };
    const slots = await ctx.trx
      .selectFrom('crove_social.queue_slot')
      .select(['weekday', 'minute', 'label', 'label_id', 'active'])
      .where('org_id', '=', ctx.orgId)
      .where('queue_id', '=', queue.id)
      .orderBy('weekday')
      .orderBy('minute')
      .execute();
    // The next open slots (a post without a content category's label takes these).
    const spec: QueueSpec = { timeZone: queue.time_zone, slots: slots.filter((s) => s.active).map((s) => ({ weekday: s.weekday, minute: s.minute, labelId: s.label_id })) };
    const taken = await takenSlots(ctx.trx, ctx.orgId, input.connectionId);
    const nextFree: string[] = [];
    let after = Date.now();
    for (let i = 0; i < 5; i++) {
      const at = nextFreeSlot(spec, after, taken);
      if (at === null) break;
      nextFree.push(new Date(at).toISOString());
      taken.add(at);
      after = at;
    }
    return {
      connectionId: input.connectionId,
      queueId: queue.id,
      timeZone: queue.time_zone,
      paused: queue.paused,
      slots: slots.map((s) => ({ weekday: s.weekday, minute: s.minute, label: s.label, labelId: s.label_id, active: s.active })),
      nextFree,
    };
  },
});

export const socialCommands = [
  postCreate,
  postImport,
  postAddChannels,
  postUpdate,
  variantUpdate,
  postSubmit,
  variantDecide,
  variantSchedule,
  variantUnschedule,
  variantReschedule,
  variantCancel,
  queueSet,
  ...publishingCommands,
  ...metricsCommands,
  ...evergreenCommands,
  ...commentCommands,
  ...threadCommands,
  ...autoReplyCommands,
  ...policyCommands,
  ...assignCommands,
  ...snippetCommands,
  ...labelCommands,
  ...ideaCommands,
  ...bioCommands,
  ...feedCommands,
  ...reportScheduleCommands,
  ...brandVoiceCommands,
  ...reviewLinkCommands,
  ...activityCommands,
  ...accountCommands,
  ...reportLinkCommands,
  ...linkPreviewCommands,
  ...notificationCommands,
  ...reminderCommands,
];
// Where an image of a post is stored, for the publish job (system actor): only a file that a post or a variant of the
// org shows, or a variant's video cover, so the job never reads another kind of file through it.
export const mediaFile = defineQuery({
  name: 'social.media.file',
  input: z.strictObject({ fileId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ storageKey: string; generation: string | null; sha256: string; contentType: string; filename: string }> => {
    const file = await ctx.trx
      .selectFrom('crove_kernel.file as f')
      .select(['f.storage_key', 'f.generation', 'f.sha256', 'f.content_type', 'f.filename'])
      .where('f.org_id', '=', ctx.orgId)
      .where('f.id', '=', input.fileId)
      .where((eb) =>
        eb.or([
          eb.exists(eb.selectFrom('crove_social.post_media as m').select('m.id').whereRef('m.org_id', '=', 'f.org_id').whereRef('m.file_id', '=', 'f.id')),
          eb.exists(
            eb
              .selectFrom('crove_social.post_variant as v')
              .select('v.id')
              .whereRef('v.org_id', '=', 'f.org_id')
              .where(sql<boolean>`v.media @> jsonb_build_array(jsonb_build_object('fileId', ${input.fileId}::text))`),
          ),
          // A video's cover image (#642): only a Social upload, whatever the write-time checks let through.
          eb.and([
            eb('f.source', '=', 'social'),
            eb.exists(
            eb
              .selectFrom('crove_social.post_variant as v')
              .select('v.id')
              .whereRef('v.org_id', '=', 'f.org_id')
              .where(sql<boolean>`lower(v.settings -> 'cover' ->> 'fileId') = lower(${input.fileId}::text)`),
            ),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (!file) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này');
    return { storageKey: file.storage_key, generation: file.generation, sha256: file.sha256, contentType: file.content_type, filename: file.filename };
  },
});

export const socialQueries = [postGet, postList, queueGet, mediaFile, ...metricsQueries, ...libraryQueries, ...policyQueries, ...snippetQueries, ...labelQueries, ...ideaQueries, ...feedQueries, ...reportScheduleQueries, ...brandVoiceQueries, ...bioQueries, ...activityQueries, ...reviewLinkQueries, ...reportLinkQueries, ...notificationQueries, ...linkPreviewQueries, ...accountQueries];
