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
import { SOCIAL_IMAGE_TYPES, SOCIAL_REVIEW_CHECKS_MAX, SOCIAL_VIDEO_TYPES, zId } from '@crove/kernel-contract';
import type { MemberRole, SocialDecision, SocialVariantStatus } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { approvalCovers, approvalsInRound, effectiveContent, type BaseContent, type PostMedia } from './domain/approval.ts';
import { firstCommentOf, isProvider, threadPartsOf } from './domain/channels.ts';
import { isValidTimeZone, nextFreeSlot, openSlots, placeQueued, retime, slotRefusal, type QueueSpec } from './domain/queue.ts';
import { FROZEN, IN_FLIGHT, type VariantEvent } from './domain/state.ts';
import type { Issue } from './domain/validate.ts';
import { activityCommands, activityQueries } from './activity.ts';
import { accountCommands, accountQueries } from './accounts.ts';
import { reportLinkCommands, reportLinkQueries } from './report-links.ts';
import { goalCommands, goalQueries } from './goals.ts';
import { linkPreviewCommands, linkPreviewQueries } from './link-preview.ts';
import { channelOptionCommands, channelOptionQueries } from './channel-options.ts';
import { notificationCommands, notificationQueries } from './notifications.ts';
import { reminderCommands } from './reminders.ts';
import { QUEUE_LOW_DAYS_MAX, QUEUE_LOW_DAYS_MIN, queueLowCommands } from './queue-low.ts';
import { digestCommands } from './digest.ts';
import { outperformingCommands } from './outperforming.ts';
import { assignCommands } from './assign.ts';
import { bulkEditCommands, bulkEditQueries } from './bulk-edit.ts';
import { coverProblem } from './cover-check.ts';
import { bulkDraftCommands } from './bulk-drafts.ts';
import { publishingCommands } from './publishing.ts';
import { snippetCommands, snippetQueries } from './snippets.ts';
import { labelCommands, labelQueries, labelsOfPosts } from './labels.ts';
import { openCommentsOf } from './activity.ts';
import { ideaCommands, ideaOfPost, ideaQueries, linkIdeaToPost } from './ideas.ts';
import { bioCommands, bioQueries } from './bio-page.ts';
import { feedCommands, feedQueries } from './feeds.ts';
import { reportScheduleCommands, reportScheduleQueries } from './report-schedules.ts';
import { brandVoiceCommands, brandVoiceQueries } from './brand-voice.ts';
import { watermarkCommands, watermarkQueries } from './watermark.ts';
import { reportBrandingCommands, reportBrandingQueries } from './report-branding.ts';
import { publishHoldCommands, publishHoldQueries } from './publish-hold.ts';
import { chatAlertCommands, chatAlertQueries } from './chat-alerts.ts';
import { channelSetCommands, channelSetQueries } from './channel-sets.ts';
import { calendarNoteCommands, calendarNoteQueries } from './calendar-notes.ts';
import { calendarFeedCommands, calendarFeedQueries } from './calendar-feed.ts';
import { CONTENT_MANAGER_TEMPLATE, preReviewTask, type PreReview } from './agent.ts';
import { reviewLinkCommands, reviewLinkQueries } from './review-links.ts';
import { reviewInboxQueries } from './review-inbox.ts';
import { attentionInboxQueries } from './attention-inbox.ts';
import { libraryQueries, likeTerm } from './library.ts';
import { mediaTagCommands, mediaTagQueries } from './media-tags.ts';
import { stockPhotoCommands } from './stock-photos.ts';
import { metricsCommands, metricsQueries } from './metrics.ts';
import { externalPostCommands, externalPostQueries } from './external-posts.ts';
import { planExportCommands } from './plan-export.ts';
import { evergreenCommands } from './evergreen.ts';
import { recurringCommands } from './recurring.ts';
import { parseRecurrence, type Recurrence } from './domain/recurrence.ts';
import { commentCallsOf, commentCommands, commentStatus, type CommentStatus } from './comments.ts';
import { threadCallsOf, threadCommands, threadStatus } from './thread.ts';
import { autoReplyCommands } from './auto-reply.ts';
import { repostCommands } from './repost.ts';
import { pinCallsOf, pinCommands, pinStatus, wantsPin, type PinStatus } from './pin.ts';
import { gateCallsOf, gateCommands, gateStatus, wantsGate, type GateStatus } from './gate.ts';
import { playlistCallsOf, playlistCommands, playlistsOf, playlistStatus, type PlaylistStatus } from './playlists.ts';
import { removeCallsOf, removeCommands, removeState, type RemoveState } from './remove.ts';
import { approvalsRequired, clientApprovalOn, clientVerdict, decisionsOf, fourEyesOn, policyCommands, policyQueries, shortOfPolicy } from './policy.ts';
import { clientReviewCommands } from './client-review.ts';
import { CLEAR_ERROR, MOVABLE, POLICY_RAISED, POST_COLUMNS, SLOT_FREED, approvedValues, base, editValues, mediaFor, type PostContent, freezeValues, hashOf, issuesOf, latestDecision, lockPost, lockQueue, lockVariants, mediaOf, overrides, pick, providerOf, refreshPostStatus, refuseRemoveAtMisfit, setVariant, settingsOf, step, takenSlots, variantPost, type PostRow, type QueueState, type VariantRow } from './variants.ts';
import { queueOrderCommands } from './queue-order.ts';
import { versionQueries, withVersion } from './versions.ts';
import { bannedChecker, bannedCheckerOf, bannedCommandBudget, bannedForView, bannedWordsOf, bannedWordCommands, bannedWordQueries, isBlocked, refuseBannedWords, type BannedWordsStatus } from './banned-words.ts';
import type { BannedFieldMatch } from './domain/banned-words.ts';
import { teamReportQueries } from './team-report.ts';
import { duplicatesOf } from './duplicates.ts';
import { refusesDuplicates, type DuplicateOf } from './domain/duplicate.ts';
import { checklistFor, checklistForApproval, reviewChecklistCommands, reviewChecklistQueries, reviewChecksOf, tickedChecklist, type ReviewCheck } from './review-checklist.ts';
import { channelAccessCommands, channelAccessQueries, channelNotAllowed, channelScope, connectionInScope, inScope, mayUse, postInScope, refuseChannels, refuseOutside, refusePostOutside } from './channel-access.ts';

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
    if (!MEDIA_TYPES.includes(f.content_type)) throw new DomainError('MEDIA_TYPE_UNSUPPORTED', 422, 'Bài đăng chỉ nhận ảnh JPG, PNG, WEBP, video MP4, MOV và tệp PDF');
    return { fileId: f.id, generation: f.generation, altText: m.altText || null, mime: f.content_type, sizeBytes: Number(f.size_bytes), durationMs: f.duration_ms === null ? null : Number(f.duration_ms), width: f.image_width ?? null, height: f.image_height ?? null };
  });
}

// A video's cover in a variant's settings (#642): a frame (a whole number of milliseconds) or an image of the org
// uploaded for Social, JPEG or PNG, within the channel's size limit. Which channels take which kind, and whether the
// variant shows one video, are channel rules (validateVariant), checked when it goes to review.
async function checkCover(ctx: CommandContext, provider: string, settings: Record<string, unknown> | undefined): Promise<void> {
  const problem = await coverProblem(ctx, provider, settings);
  if (problem) throw problem;
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
  // A member limited to some channels (#1081) adds a variant on those only.
  await refuseChannels(
    ctx,
    channels.map((c) => c.connectionId),
  );
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
    // A channel whose text holds a blocked word (#1055) stays a draft, like one that breaks its channel's rules.
    // One checker and one budget for the whole import, so the rows do not multiply it; past it a row's channels stay
    // drafts.
    const banned = input.submit ? bannedChecker(await bannedWordsOf(ctx.trx, ctx.orgId), bannedCommandBudget()) : null;
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
      if (banned) {
        const ready = (await lockVariants(ctx.trx, ctx.orgId, post.id)).filter(
          (v) => variants.some((c) => c.variantId === v.id) && issuesOf(base(post), v).length === 0 && !isBlocked(banned, base(post), v),
        );
        for (const v of ready) await setVariant(ctx, v.id, { status: step(v, { type: 'submit' }) });
        if (ready.length > 0) {
          await refreshPostStatus(ctx, post.id);
          await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: ready.map((v) => v.id), agent_task: preReviewTask({ ...post, tainted: await postTainted(ctx, post.id) }) });
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
    // Not on a post the member cannot see (#1081): its content belongs to other channels.
    await refusePostOutside(ctx, post.id);
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

const zPostUpdate = z.strictObject({
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
});
type PostEdit = Omit<z.infer<typeof zPostUpdate>, 'postId' | 'revision'>;

// The edit of a post's base content, on the post its caller locked and checked the revision of (social.post.update, and
// social.post.restore_version for a saved version).
async function editPost(ctx: CommandContext, post: PostRow, input: PostEdit): Promise<{ postId: string; revision: number; changedVariants: string[] }> {
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
  // A member limited to some channels (#1081) changes no variant on another channel through the shared content, nor
  // the planned time every open variant follows (it is not in the content hash).
  const timing = next.time_zone !== post.time_zone || next.scheduled_at?.getTime() !== post.scheduled_at?.getTime();
  refuseOutside(
    await channelScope(ctx),
    (timing ? variants.filter((v) => !FROZEN.has(v.status)) : changed).map((v) => v.channel_connection_id),
  );
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
}

// Base content of a post. Every variant that inherits a changed field gets a new hash and revision and goes back to
// draft; a variant in flight refuses the whole edit; a published or cancelled one keeps what it had. A change of the
// content appends a version (#1021).
export const postUpdate = defineCommand({
  name: 'social.post.update',
  input: zPostUpdate,
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    if (post.revision !== input.revision) throw new DomainError('STALE_REVISION', 409, 'Bài đăng đã được sửa ở nơi khác, hãy tải lại', { revision: post.revision });
    await refusePostOutside(ctx, post.id);
    const { postId: _postId, revision: _revision, ...edit } = input;
    return withVersion(ctx, post.id, () => editPost(ctx, post, edit));
  },
});

interface VariantEdit {
  body?: string | null | undefined;
  title?: string | null | undefined;
  linkUrl?: string | null | undefined;
  settings?: Record<string, unknown> | undefined;
  media?: z.infer<typeof zMedia> | null | undefined;
}

// The edit of one variant's own content, on the post and variant its caller locked (social.variant.update, and
// social.post.restore_version). changed: its effective content changed, so it has a new revision and went back to draft.
async function editVariant(ctx: CommandContext, post: PostRow, v: VariantRow, input: VariantEdit): Promise<{ revision: number; changed: boolean }> {
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
    return { revision: v.revision, changed: false };
  }
  await setVariant(ctx, v.id, { ...columns, content_hash: hash, revision: v.revision + 1, ...editValues(v) });
  return { revision: v.revision + 1, changed: true };
}

// One variant's overrides and settings. null inherits the post's value again; omitted leaves it as is. A change of the
// stored content appends a version of the post (#1021).
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
    await refuseChannels(ctx, [v.channel_connection_id]);
    if (v.revision !== input.revision) throw new DomainError('STALE_REVISION', 409, 'Kênh này đã được sửa ở nơi khác, hãy tải lại', { revision: v.revision });
    return withVersion(ctx, postId, async () => {
      const { revision, changed } = await editVariant(ctx, post, v, input);
      if (changed) {
        if (input.aiAssisted) await ctx.trx.updateTable('crove_social.post').set({ tainted: true, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', postId).execute();
        await refreshPostStatus(ctx, postId);
      }
      return { variantId: v.id, revision, changed };
    });
  },
});

// Saves a version of the post again as a new edit (#1021), through the edits above: the base content first, then each
// channel of the version that can still be edited. A changed channel goes back to draft and is reviewed again under its
// channel's policy, as after any edit. A channel that is history (published, cancelled, removed) keeps what it has: a
// published post is never changed in place, and a post with no channel left to edit is refused. A channel in flight
// refuses the restore, as it refuses an edit; a channel added after the version keeps its content.
//
// The version's content passes the same input schemas as an edit before anything is written (VERSION_INVALID
// otherwise), and its files are resolved again as for an edit (MEDIA_NOT_FOUND for one the org no longer has).
const zVersionContent = z.object({
  body: zBody,
  title: zTitle.nullable(),
  linkUrl: zLink.nullable(),
  media: zMedia,
  variants: z.array(z.object({ variantId: zId, body: zBody.nullable(), title: zTitle.nullable(), linkUrl: zLink.nullable(), settings: zSettings, media: zMedia.nullable() })),
});
export const postRestoreVersion = defineCommand({
  name: 'social.post.restore_version',
  input: z.strictObject({
    postId: zId,
    versionId: zId,
    revision: z.number().int().positive(),
    // The revision of each channel as the member saw it; a channel edited since refuses the restore.
    variantRevisions: z
      .record(zId, z.number().int().positive())
      .refine((r) => Object.keys(r).length <= MAX_CHANNELS_PER_POST, 'too many channels')
      .optional(),
  }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    if (post.revision !== input.revision) throw new DomainError('STALE_REVISION', 409, 'Bài đăng đã được sửa ở nơi khác, hãy tải lại', { revision: post.revision });
    const version = await ctx.trx
      .selectFrom('crove_social.post_version')
      .select(['id', 'number', 'body', 'title', 'link_url', 'media', 'variants'])
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', post.id)
      .where('id', '=', input.versionId)
      .executeTakeFirst();
    if (!version) throw new DomainError('VERSION_NOT_FOUND', 404, 'Không tìm thấy phiên bản này của bài đăng');
    const parsed = zVersionContent.safeParse({ body: version.body, title: version.title, linkUrl: version.link_url, media: version.media, variants: version.variants });
    if (!parsed.success) throw new DomainError('VERSION_INVALID', 422, 'Phiên bản này bị hỏng nên không khôi phục được', { versionId: version.id });
    const content = parsed.data;
    const editable = (v: VariantRow) => !FROZEN.has(v.status) && !v.content_frozen;
    const current = await lockVariants(ctx.trx, ctx.orgId, post.id);
    // A member limited to some channels (#1081) restores a version only when it touches none of the post's other
    // channels: the version also holds what those channels said.
    const scope = await refusePostOutside(ctx, post.id);
    refuseOutside(
      scope,
      current.filter((v) => editable(v) && content.variants.some((s) => s.variantId === v.id)).map((v) => v.channel_connection_id),
    );
    const seen = Object.entries(input.variantRevisions ?? {});
    const stale = seen.filter(([id, revision]) => current.find((v) => v.id === id)?.revision !== revision).map(([id]) => id);
    if (stale.length > 0) throw new DomainError('STALE_REVISION', 409, 'Có kênh đã được sửa ở nơi khác, hãy tải lại', { variantIds: stale });
    // A post without channels takes its base content back; one whose every channel is history is refused.
    if (current.length > 0 && !current.some(editable)) {
      throw new DomainError('POST_PUBLISHED', 409, 'Bài đã đăng hoặc đã hủy trên mọi kênh: không khôi phục vào bài đã đăng được', { postId: post.id });
    }
    const saved = new Map(content.variants.map((v) => [v.variantId, v]));
    const result = await withVersion(ctx, post.id, async () => {
      const edited = await editPost(ctx, post, { body: content.body, title: content.title, linkUrl: content.linkUrl, media: content.media });
      const changed = new Set(edited.changedVariants);
      const next = await lockPost(ctx.trx, ctx.orgId, post.id);
      const kept: string[] = [];
      for (const v of await lockVariants(ctx.trx, ctx.orgId, post.id)) {
        const s = saved.get(v.id);
        if (!s) continue;
        if (!editable(v)) {
          kept.push(v.id);
          continue;
        }
        const r = await editVariant(ctx, next, v, { body: s.body, title: s.title, linkUrl: s.linkUrl, settings: s.settings, media: s.media });
        if (r.changed) changed.add(v.id);
      }
      await refreshPostStatus(ctx, post.id);
      return { revision: edited.revision, changedVariants: [...changed], kept };
    });
    ctx.audit({ post_id: post.id, version_id: version.id, version_number: version.number, changed_variants: result.changedVariants.length });
    return { postId: post.id, ...result };
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
    // A member limited to some channels (#1081) submits those: by default the ones they may use, and never another.
    const scope = await refusePostOutside(ctx, post.id);
    const chosen = input.variantIds ? pick(all, input.variantIds) : inScope(scope, all).filter((v) => ['draft', 'changes_requested', 'rejected'].includes(v.status));
    refuseOutside(
      scope,
      chosen.map((v) => v.channel_connection_id),
    );
    if (chosen.length === 0) throw new DomainError('NOTHING_TO_SUBMIT', 409, 'Không có kênh nào cần gửi duyệt');
    const invalid = chosen.map((v) => ({ variantId: v.id, issues: issuesOf(base(post), v) })).filter((x) => x.issues.length > 0);
    if (invalid.length > 0) throw new DomainError('VARIANT_INVALID', 422, 'Có kênh chưa đúng yêu cầu của nền tảng', { variants: invalid });
    // The org's blocked words (#1055); a warning goes to review and shows there.
    await refuseBannedWords(ctx, base(post), chosen);
    for (const v of chosen) await setVariant(ctx, v.id, { status: step(v, { type: 'submit' }) });
    await refreshPostStatus(ctx, post.id);
    await ctx.emit('social.post.submitted', { post_id: post.id, variant_ids: chosen.map((v) => v.id), agent_task: preReviewTask({ ...post, tainted: await postTainted(ctx, post.id) }) });
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
      .array(
        z.strictObject({
          variantId: zId,
          revision: z.number().int().positive(),
          contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          // The review checklist items the reviewer ticked (#1105); only an approval reads them.
          checks: z.array(zId).max(SOCIAL_REVIEW_CHECKS_MAX).optional(),
        }),
      )
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
    await refuseChannels(
      ctx,
      chosen.map((v) => v.channel_connection_id),
    );
    const seen = new Map(input.variants.map((x) => [x.variantId, x]));
    // A channel with a blocked word (#1055), added to the list since it was submitted, is not approved; a request for
    // changes or a rejection still goes.
    if (input.decision === 'approved') await refuseBannedWords(ctx, base(post), chosen);
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
    // The client's approval (#770): on its channels, the team's last approval leaves the variant waiting for the client's
    // "Approved" on a review link, unless it was given for this content already.
    const clientOn = input.decision === 'approved' ? await clientApprovalOn(ctx.trx, ctx.orgId, chosen.map((v) => v.channel_connection_id)) : new Set<string>();
    const client = clientOn.size > 0 ? await clientVerdict(ctx.trx, ctx.orgId, post.id) : null;
    // The review checklist (#1105): an approval needs every item of the channel's list ticked, read now, in this
    // transaction; the items it keeps are copied from that list.
    const checks: readonly ReviewCheck[] = input.decision === 'approved' ? await checklistForApproval(ctx) : [];
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
        if (given.length + 1 < (required.get(v.channel_connection_id) ?? 1) || (clientOn.has(v.channel_connection_id) && client !== 'approved')) {
          status = v.status;
          waiting.push(v.id);
        }
      }
      const checklist = input.decision === 'approved' ? tickedChecklist(checks, v, saw.checks) : null;
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
          checklist: checklist === null ? null : JSON.stringify(checklist),
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

// Schedules approved variants: at a time (`at`, else the post's default time), or in the next free slot of each
// connection's queue (`queue: true`). With `slotAt` (#1158, a drop on the calendar's open slot), one variant, approved or
// already scheduled, takes exactly that slot of its queue: an instant of the queue within the year ahead
// (SLOT_NOT_IN_QUEUE) and after now (SCHEDULE_IN_PAST), held by no other post (SLOT_TAKEN), open or kept for one of the
// post's labels (SLOT_KEPT_FOR_LABEL), and one its planned takedown fits, all decided under the queue row's lock as for
// the next free slot.
export const variantSchedule = defineCommand({
  name: 'social.variant.schedule',
  input: z
    .strictObject({
      postId: zId,
      variantIds: zVariantIds.optional(),
      at: z.iso.datetime({ offset: true }).optional(),
      queue: z.literal(true).optional(),
      // Exactly this slot of the queue (#1158), for one variant.
      slotAt: z.iso.datetime({ offset: true }).optional(),
      // A time per channel (#576): these variants, each at its own time.
      times: z
        .array(z.strictObject({ variantId: zId, at: z.iso.datetime({ offset: true }) }))
        .min(1)
        .max(MAX_CHANNELS_PER_POST)
        .optional(),
    })
    .refine((x) => !(x.at && x.queue), 'choose a time or the queue, not both')
    .refine((x) => !x.times || (!x.at && !x.queue && !x.variantIds), 'times names the variants and their times on its own')
    .refine((x) => !x.slotAt || (x.queue && x.variantIds?.length === 1), 'slotAt takes the queue and one variant'),
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
    // A channel added between the read of the queues and the lock of the post (#851) has no queue locked: the post
    // changed meanwhile, so the member tries again rather than seeing its channel as having no queue.
    if (input.queue && all.some((v) => !queues.has(v.channel_connection_id))) {
      throw new DomainError('STALE_REVISION', 409, 'Bài đăng đã được sửa ở nơi khác, hãy tải lại', { revision: post.revision });
    }
    const times = new Map((input.times ?? []).map((x) => [x.variantId, new Date(Date.parse(x.at))]));
    // The post's labels, read once, for the slots of content categories (#745).
    let labels: Set<string> | null = null;
    const postLabels = async () => (labels ??= new Set(((await labelsOfPosts(ctx.trx, ctx.orgId, [post.id])).get(post.id) ?? []).map((l) => l.id)));
    // By default the approved variants on the channels the caller may use (#1081); a named one elsewhere is refused.
    const scope = await refusePostOutside(ctx, post.id);
    const chosen = input.times ? pick(all, [...times.keys()]) : input.variantIds ? pick(all, input.variantIds) : inScope(scope, all).filter((v) => v.status === 'approved');
    refuseOutside(
      scope,
      chosen.map((v) => v.channel_connection_id),
    );
    if (chosen.length === 0) throw new DomainError('NOTHING_TO_SCHEDULE', 409, 'Không có kênh nào đã duyệt để lên lịch');
    // A blocked word (#1055), also one added to the list after the approval, refuses this schedule. A variant already
    // scheduled, queued, retried or resumed is not checked again before it goes out.
    await refuseBannedWords(ctx, base(post), chosen);
    const shared = input.at ? new Date(Date.parse(input.at)) : post.scheduled_at;
    const timeOf = (v: VariantRow) => times.get(v.id) ?? shared;
    if (!input.queue) {
      for (const v of chosen) {
        const at = timeOf(v);
        if (!at) throw new DomainError('SCHEDULE_REQUIRED', 422, 'Hãy chọn giờ đăng hoặc dùng hàng đợi');
        if (at.getTime() <= ctx.now.getTime()) throw new DomainError('SCHEDULE_IN_PAST', 422, 'Giờ đăng phải ở tương lai', { variantId: v.id });
        refuseRemoveAtMisfit(v, at);
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
      // A variant already scheduled moves into the slot it is dropped on (#1158) and stays scheduled.
      const moving = input.slotAt !== undefined && v.status === 'scheduled';
      const status = moving ? v.status : step(v, { type: 'schedule' });
      if (input.queue) {
        const queue = queues.get(v.channel_connection_id) ?? null;
        if (!queue || queue.spec.slots.length === 0) throw new DomainError('QUEUE_EMPTY', 409, 'Kênh này chưa có khung giờ đăng trong hàng đợi', { variantId: v.id });
        const taken = await takenSlots(ctx.trx, ctx.orgId, v.channel_connection_id, v.id);
        // A post's labels pick the slots of their content categories first (#745).
        const slot =
          input.slotAt !== undefined ? await exactSlot(ctx, queue, v.id, Date.parse(input.slotAt), taken, await postLabels()) : nextFreeSlot(queue.spec, ctx.now.getTime(), taken, 366, await postLabels());
        if (slot === null) throw new DomainError('QUEUE_FULL', 409, 'Hàng đợi của kênh này đã kín trong năm tới', { variantId: v.id });
        refuseRemoveAtMisfit(v, new Date(slot));
        // A move leaves the variant's own time and an earlier refusal with its retry time, which belong to the old time.
        await setVariant(ctx, v.id, { ...(moving ? CLEAR_ERROR : {}), status, queue_slot_at: new Date(slot), scheduled_at: null, error_retry_at: null });
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

// The slot a drop names (#1158), checked against the queue the caller locked and the clock: the later of the
// transaction's and the command's, so a slot either has passed is never taken.
async function exactSlot(ctx: CommandContext, queue: QueueState, variantId: string, atMs: number, taken: ReadonlySet<number>, labels: ReadonlySet<string>): Promise<number> {
  const clock = await sql<{ now: Date }>`SELECT pg_catalog.now() AS now`.execute(ctx.trx);
  const now = Math.max(ctx.now.getTime(), clock.rows[0]?.now.getTime() ?? 0);
  const at = new Date(atMs).toISOString();
  switch (slotRefusal(queue.spec, atMs, now, taken, labels)) {
    case 'not_in_queue':
      throw new DomainError('SLOT_NOT_IN_QUEUE', 422, 'Giờ này không phải một khung giờ đăng trong hàng đợi của kênh', { variantId, at });
    case 'past':
      throw new DomainError('SCHEDULE_IN_PAST', 422, 'Khung giờ này đã qua', { variantId, at });
    case 'taken':
      throw new DomainError('SLOT_TAKEN', 409, 'Khung giờ này của kênh đã có bài khác', { variantId, at });
    case 'label':
      throw new DomainError('SLOT_KEPT_FOR_LABEL', 409, 'Khung giờ này dành cho bài có nhãn khác', { variantId, at });
    case null:
      return atMs;
  }
}

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
    await refuseChannels(
      ctx,
      chosen.map((v) => v.channel_connection_id),
    );
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
    await refuseChannels(ctx, [v.channel_connection_id]);
    if (v.status !== 'scheduled') throw new DomainError('VARIANT_STATE', 409, 'Chỉ đổi giờ được kênh đã lên lịch', { variantId: v.id, status: v.status });
    const at = new Date(Date.parse(input.at));
    if (at.getTime() <= ctx.now.getTime()) throw new DomainError('SCHEDULE_IN_PAST', 422, 'Giờ đăng phải ở tương lai', { variantId: v.id });
    refuseRemoveAtMisfit(v, at);
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
    await refuseChannels(
      ctx,
      chosen.map((v) => v.channel_connection_id),
    );
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
// free slots. Nothing else moves. lowDays (#1079) turns on the warning when the queue runs low (null turns it off,
// left out keeps it); a new value starts a new dip, so the team is told again if the queue is low by it.
export const queueSet = defineCommand({
  name: 'social.queue.set',
  input: z.strictObject({
    connectionId: zId,
    timeZone: zTimeZone,
    paused: z.boolean().optional(),
    lowDays: z.number().int().min(QUEUE_LOW_DAYS_MIN).max(QUEUE_LOW_DAYS_MAX).nullable().optional(),
    slots: z
      .array(z.strictObject({ weekday: z.number().int().min(1).max(7), minute: z.number().int().min(0).max(1439), label: z.string().trim().max(100).optional(), labelId: zId.nullable().optional() }))
      .max(MAX_SLOTS),
  }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    await refuseChannels(ctx, [input.connectionId]);
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
      .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, time_zone: input.timeZone, paused: input.paused ?? false, low_days: input.lowDays ?? null })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    const locked = await lockQueue(ctx.trx, ctx.orgId, input.connectionId);
    const before = missing ? null : locked;
    const queueId = (locked as QueueState).id;
    if (before && input.lowDays !== undefined) {
      // Under the queue row's lock, which the low check takes too.
      await ctx.trx
        .updateTable('crove_social.queue')
        .set({ low_days: input.lowDays, low_alerted_at: sql<Date | null>`CASE WHEN low_days IS NOT DISTINCT FROM ${input.lowDays}::int THEN low_alerted_at END` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', before.id)
        .execute();
    }
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
  // The pin of a published Telegram channel that asks for one (#982); null without one.
  pinStatus: PinStatus | null;
  // Who may reply to and quote a published Bluesky post that limits either (#1102); null without a limit.
  gateStatus: GateStatus | null;
  // The playlists of a published YouTube video that names some (#1018): how many took it, of how many; null without any.
  playlistStatus: PlaylistStatus | null;
  // The thread of a published channel (#742): how many parts are out (the post counts as one) and the next one's state.
  threadStatus: { state: 'pending' | 'posted' | 'failed' | 'unknown'; posted: number; total: number } | null;
  queuePaused: boolean;
  attempt: number;
  externalUrl: string | null;
  publishedAt: string | null;
  // Taken down from its platform (#860): when the platform confirmed it, and who asked and why. removal: where a
  // person's ask to remove a published channel stands, until it is removed.
  removedAt: string | null;
  removedBy: string | null;
  removeReason: string | null;
  removal: RemoveState | null;
  error: { kind: string | null; code: string | null; action: string | null; message: string | null; retryAt: string | null } | null;
  issues: Issue[];
  // The org's banned or sensitive words in its effective content (#1055), one per word and field: 'block' ones refuse
  // submit, approval and scheduling; 'warn' ones are for the writer and the reviewer to see.
  bannedWords: BannedFieldMatch[];
  // checked: the list above is complete; not_checked: a read that does not check them (the post list); too_complex:
  // the text or the word list was too large to check within the budget, and the list is empty.
  bannedWordsStatus: BannedWordsStatus;
  // The newest other post on the same channel with the same text (#1156), published in the last 30 days or scheduled
  // or queued there, while this channel can still change; null without one, and on reads that do not check (lists).
  duplicateOf: DuplicateOf | null;
  latestDecision: { decision: SocialDecision; comment: string | null; decidedBy: string; at: string; revision: number; current: boolean } | null;
  // The review checklist of its channel (#1105): the org-wide items and the channel's, in order; empty without one.
  checklist: ReviewCheck[];
  // The approvals its channel needs (S9) and who approved its current content in the open review round.
  // client: the channel also waits for the client's approval (#770); clientVerdict: the client's standing answer.
  review: { required: number; approvedBy: string[]; fourEyes: boolean; client: boolean; clientVerdict: 'approved' | 'changes_requested' | null };
}

export interface MediaView {
  fileId: string;
  altText: string | null;
  mime: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  // A PDF's name (#1119), for its document card; null for images and videos.
  filename: string | null;
}

const mediaView = (list: readonly PostMedia[], names: ReadonlyMap<string, string>): MediaView[] =>
  list.map((m) => ({ fileId: m.fileId, altText: m.altText, mime: m.mime, sizeBytes: m.sizeBytes, durationMs: m.durationMs ?? null, width: m.width ?? null, height: m.height ?? null, filename: names.get(m.fileId) ?? null }));

export interface PostView {
  id: string;
  body: string;
  title: string | null;
  linkUrl: string | null;
  media: MediaView[];
  // Reposted every N days (S9), or null; and the post this one reposts.
  evergreenDays: number | null;
  repostOf: string | null;
  // A series post's rule and the copies of its current run; on a copy, the series post it was made for (#979).
  recurrence: Recurrence | null;
  recurrenceCount: number;
  recurrenceSourceId: string | null;
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
  // Its internal comments not resolved yet (#1168), on the whole post or a channel the caller may use.
  openComments: number;
  // The idea it was made from (#701); on a single post's read only.
  idea?: { id: string; title: string } | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// The posts as the caller may see them (#1081): a member limited to some channels sees only the variants on those, and
// not a post with none there.
async function viewPosts(ctx: QueryContext, requested: string[], options: { bannedWords?: boolean; duplicates?: boolean } = {}): Promise<PostView[]> {
  if (requested.length === 0) return [];
  const scope = await channelScope(ctx);
  const variants = await ctx.trx
    .selectFrom('crove_social.post_variant')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('post_id', 'in', requested)
    .where(connectionInScope(scope, 'channel_connection_id'))
    .orderBy('position')
    .orderBy('id')
    .execute();
  const postIds = scope === null ? requested : requested.filter((id) => variants.some((v) => v.post_id === id));
  if (postIds.length === 0) return [];
  const posts = await ctx.trx.selectFrom('crove_social.post').selectAll().where('org_id', '=', ctx.orgId).where('id', 'in', postIds).execute();
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
  const clientOn = await clientApprovalOn(ctx.trx, ctx.orgId, [...new Set(variants.map((v) => v.channel_connection_id))]);
  const clientVerdicts = new Map<string, Awaited<ReturnType<typeof clientVerdict>>>();
  for (const postId of new Set(variants.filter((v) => clientOn.has(v.channel_connection_id)).map((v) => v.post_id))) clientVerdicts.set(postId, await clientVerdict(ctx.trx, ctx.orgId, postId));
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
  // The pin of each published channel that asks for one (#982).
  const pinned = variants.filter((v) => v.status === 'published' && v.external_post_id && wantsPin(v));
  const pinCalls = await pinCallsOf(ctx.trx, ctx.orgId, pinned);
  const pins = new Map<string, PinStatus>(pinned.map((v) => [v.id, pinStatus(pinCalls.get(v.id), now, v.published_at)]));
  // The reply and quote gates of each published channel that asks for them (#1102).
  const gated = variants.filter((v) => v.status === 'published' && v.external_post_id && wantsGate(v));
  const gateCalls = await gateCallsOf(ctx.trx, ctx.orgId, gated);
  const gates = new Map<string, GateStatus>(gated.map((v) => [v.id, gateStatus(gateCalls.get(v.id), now, v.published_at)]));
  // The playlists of each published channel that names some (#1018).
  const listed = variants.filter((v) => v.status === 'published' && v.external_post_id && playlistsOf(v));
  const listCalls = await playlistCallsOf(ctx.trx, ctx.orgId, listed);
  const lists = new Map<string, PlaylistStatus>(listed.map((v) => [v.id, playlistStatus(playlistsOf(v)?.length ?? 0, listCalls.get(v.id) ?? [], now, v.published_at)]));
  // The thread of each published channel that has one (#742).
  const threaded = variants.filter((v) => v.status === 'published' && v.external_post_id && threadPartsOf(settingsOf(v)));
  const partCalls = await threadCallsOf(ctx.trx, ctx.orgId, threaded);
  const threads = new Map(
    threaded.map((v) => {
      const s = threadStatus((threadPartsOf(settingsOf(v)) as string[]).length, partCalls.get(v.id) ?? [], now, v.published_at);
      return [v.id, { state: s.state, posted: s.posted, total: s.total }] as const;
    }),
  );
  // The removals people asked for on published channels (#860).
  const asked = variants.filter((v) => v.status === 'published' && v.remove_requested_at !== null);
  const removeCalls = await removeCallsOf(ctx.trx, ctx.orgId, asked);
  const removals = new Map(asked.map((v) => [v.id, removeState(removeCalls.get(v.id) ?? [], v.remove_requested_at, now)]));
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
  // The names of the PDFs the view shows (#1119), the post's and its channels' own, read once.
  const pdfIds = new Set([
    ...mediaRows.filter((r) => r.content_type === 'application/pdf').map((r) => r.file_id),
    ...variants.flatMap((v) => (mediaOf(v.media) ?? []).filter((m) => m.mime === 'application/pdf').map((m) => m.fileId)),
  ]);
  const names = new Map<string, string>(
    pdfIds.size === 0
      ? []
      : (await ctx.trx.selectFrom('crove_kernel.file').select(['id', 'filename']).where('org_id', '=', ctx.orgId).where('id', 'in', [...pdfIds]).execute()).map((r) => [r.id, r.filename] as const),
  );
  const labels = await labelsOfPosts(ctx.trx, ctx.orgId, postIds);
  const openComments = await openCommentsOf(ctx.trx, ctx.orgId, scope, postIds);
  // The review checklist (#1105), read once for every variant of the view.
  const checks = variants.length > 0 ? await reviewChecksOf(ctx.trx, ctx.orgId) : [];
  // Lists and the other reads leave the words out ('not_checked'); one budget covers every variant of the view.
  const banned = options.bannedWords ? await bannedCheckerOf(ctx.trx, ctx.orgId) : null;
  const byPost = new Map(posts.map((p) => [p.id, p]));
  // The same text again on a channel (#1156): only on the single post's reads, and only on the channels in view.
  const duplicates = options.duplicates
    ? await duplicatesOf(
        ctx.trx,
        ctx.orgId,
        variants.map((v) => {
          const p = byPost.get(v.post_id);
          return { id: v.id, postId: v.post_id, connectionId: v.channel_connection_id, status: v.status, body: effectiveContent({ body: p?.body ?? '', title: null, linkUrl: null }, overrides(v), v.content_frozen).body };
        }),
        new Date(),
      )
    : new Map<string, DuplicateOf>();
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
        media: mediaView(b.media, names),
        evergreenDays: p.evergreen_days,
        repostOf: p.repost_of,
        recurrence: parseRecurrence(p.recurrence),
        recurrenceCount: p.recurrence_count,
        recurrenceSourceId: p.recurrence_source_id,
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
        openComments: openComments.get(p.id) ?? 0,
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
              media: mediaView(mediaFor(b, v), names),
              settings: settingsOf(v),
              revision: v.revision,
              contentHash: v.content_hash,
              status: v.status,
              effectiveAt: iso(v.status === 'published' || v.status === 'removed' ? v.published_at : (v.error_retry_at ?? v.queue_slot_at ?? v.scheduled_at ?? p.scheduled_at)),
              queueSlotAt: iso(v.queue_slot_at),
              commentStatus: comments.get(v.id) ?? null,
              pinStatus: pins.get(v.id) ?? null,
              gateStatus: gates.get(v.id) ?? null,
              playlistStatus: lists.get(v.id) ?? null,
              threadStatus: threads.get(v.id) ?? null,
              // As the publisher decides it (queuePaused in publishing.ts): a retry time goes out whatever the queue does.
              queuePaused: v.queue_slot_at !== null && v.scheduled_at === null && v.error_retry_at === null && pausedQueues.has(v.channel_connection_id),
              attempt: v.attempt,
              externalUrl: v.external_url,
              publishedAt: iso(v.published_at),
              removedAt: iso(v.removed_at),
              removedBy: v.status === 'removed' ? v.removed_by : null,
              removeReason: v.status === 'removed' ? v.remove_reason : null,
              removal: removals.get(v.id) ?? null,
              error: v.error_kind || v.error_code || v.error_message ? { kind: v.error_kind, code: v.error_code, action: v.error_action, message: v.error_message, retryAt: iso(v.error_retry_at) } : null,
              issues: isProvider(v.provider) ? issuesOf(b, row) : [],
              ...(banned ? bannedForView(banned, b, row) : { bannedWords: [], bannedWordsStatus: 'not_checked' as const }),
              duplicateOf: duplicates.get(v.id) ?? null,
              latestDecision: d
                ? { decision: d.decision, comment: d.comment, decidedBy: d.decided_by, at: iso(d.created_at) ?? '', revision: d.revision, current: d.revision === v.revision && d.content_hash === v.content_hash }
                : null,
              checklist: checklistFor(checks, v.channel_connection_id),
              review: {
                required: required.get(v.channel_connection_id) ?? 1,
                // The author may not approve on this channel (#740).
                fourEyes: foureyes.has(v.channel_connection_id),
                client: clientOn.has(v.channel_connection_id),
                clientVerdict: clientOn.has(v.channel_connection_id) ? (clientVerdicts.get(v.post_id) ?? null) : null,
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
    // The one read that checks the banned words (#1055): the composer, the post page and its review panel use it.
    const [view] = await viewPosts(ctx, [input.postId], { bannedWords: true, duplicates: true });
    if (!view) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
    return { ...view, idea: await ideaOfPost(ctx.trx, ctx.orgId, view.id) };
  },
});

// What a variant says, as the review diff compares it (#944): its text, its images or video in order with their
// descriptions, and its settings.
export interface ReviewContent {
  body: string;
  title: string | null;
  linkUrl: string | null;
  // mime: null for a file the org no longer has.
  media: Array<{ fileId: string; altText: string | null; mime: string | null }>;
  settings: Record<string, unknown>;
}

export interface ReviewDiffVariant {
  variantId: string;
  current: ReviewContent;
  // The variant's last decision (an approval, a request for changes or a rejection) with the content it was made on;
  // null before the first. changed: the content is no longer the one decided on (another revision or content hash).
  lastDecision: { decision: SocialDecision; at: string; decidedBy: string; decidedByName: string | null; revision: number; changed: boolean; content: ReviewContent } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// A decision's snapshot as social.variant.decide writes it. Read defensively: a field it lacks reads as empty.
function snapshotContent(raw: unknown, mimes: ReadonlyMap<string, string>): ReviewContent {
  const s = isRecord(raw) ? raw : {};
  const media = Array.isArray(s.media) ? s.media.filter(isRecord).filter((m) => typeof m.file_id === 'string') : [];
  return {
    body: typeof s.body === 'string' ? s.body : '',
    title: textOrNull(s.title),
    linkUrl: textOrNull(s.link_url),
    media: media.map((m) => ({ fileId: m.file_id as string, altText: textOrNull(m.alt_text), mime: mimes.get(m.file_id as string) ?? null })),
    settings: isRecord(s.settings) ? s.settings : {},
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What changed since the last review (#944): per variant, the content of its last decision next to its content now,
// for the review panel's diff. Whoever may read the post may read this; it changes nothing.
export const postReviewDiff = defineQuery({
  name: 'social.post.review_diff',
  input: z.strictObject({ postId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<{ postId: string; variants: ReviewDiffVariant[] }> => {
    const [view] = await viewPosts(ctx, [input.postId]);
    if (!view) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
    const ids = view.variants.map((v) => v.id);
    const decisions =
      ids.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_social.post_approval')
            .select(['id', 'variant_id', 'decision', 'decided_by', 'created_at', 'revision', 'content_hash', 'snapshot'])
            .where('org_id', '=', ctx.orgId)
            .where('post_id', '=', view.id)
            // The newest per variant, by id as viewPosts orders them: written under the post lock, unlike created_at.
            .distinctOn('variant_id')
            .orderBy('variant_id')
            .orderBy('id', 'desc')
            .execute();
    const last = new Map(decisions.map((d) => [d.variant_id, d]));
    // The type of each file a snapshot names, to show a removed video as a video.
    const fileIds = [
      ...new Set(
        decisions.flatMap((d) => {
          const media = isRecord(d.snapshot) && Array.isArray(d.snapshot.media) ? d.snapshot.media : [];
          return media.filter(isRecord).map((m) => m.file_id).filter((id): id is string => typeof id === 'string' && UUID.test(id));
        }),
      ),
    ];
    const mimes = new Map(
      fileIds.length === 0 ? [] : (await ctx.trx.selectFrom('crove_kernel.file').select(['id', 'content_type']).where('org_id', '=', ctx.orgId).where('id', 'in', fileIds).execute()).map((f) => [f.id, f.content_type]),
    );
    // Names while they are members (crove_kernel.member_profiles answers only members of the org).
    const people = [...new Set(decisions.map((d) => d.decided_by))];
    const names = new Map<string, string>();
    if (people.length > 0) {
      const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${people}::uuid[])`.execute(ctx.trx);
      for (const r of rows) names.set(r.user_id, r.display_name ?? r.email);
    }
    return {
      postId: view.id,
      variants: view.variants.map((v) => {
        const d = last.get(v.id);
        return {
          variantId: v.id,
          current: { body: v.effective.body, title: v.effective.title, linkUrl: v.effective.linkUrl, media: v.media.map((m) => ({ fileId: m.fileId, altText: m.altText, mime: m.mime })), settings: v.settings },
          lastDecision: d
            ? {
                decision: d.decision as SocialDecision,
                at: iso(d.created_at) ?? '',
                decidedBy: d.decided_by,
                decidedByName: names.get(d.decided_by) ?? null,
                revision: d.revision,
                changed: d.revision !== v.revision || d.content_hash !== v.contentHash,
                content: snapshotContent(d.snapshot, mimes),
              }
            : null,
        };
      }),
    };
  },
});

// A post's taint (AI-drafted or AI-assisted), for the agent task its submission makes (#799); unknown counts as tainted.
async function postTainted(ctx: CommandContext, postId: string): Promise<boolean> {
  const row = await ctx.trx.selectFrom('crove_social.post').select('tainted').where('org_id', '=', ctx.orgId).where('id', '=', postId).executeTakeFirst();
  return row?.tainted ?? true;
}

// The pre-review finding for a channel whose text another post on it already has (#1156), in the post's time zone.
const DUPLICATE_STANDING = { published: 'đã đăng', scheduled: 'đã hẹn đăng', queued: 'đang chờ trong hàng đợi, dự kiến đăng' } as const;
const DUPLICATE_PLATFORM: Readonly<Record<string, string>> = { x: 'X', linkedin: 'LinkedIn', linkedin_page: 'LinkedIn' };
function duplicateFinding(provider: string, of: DuplicateOf, timeZone: string): string {
  const when = of.at ? ` lúc ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(of.at))}` : '';
  const same = `nội dung trùng với một bài ${DUPLICATE_STANDING[of.status]}${when} trên kênh này`;
  return refusesDuplicates(provider) ? `${same}; ${DUPLICATE_PLATFORM[provider] ?? provider} sẽ từ chối bài trùng, cần sửa nội dung.` : `${same}; nên sửa để người theo dõi không thấy lặp lại.`;
}

// What a reviewer should look at before deciding (#799), from deterministic checks only: each waiting channel's rule
// issues, the brand voice's words to avoid in its text, and images without a description. Members and the
// social.content_manager agent read it; it changes nothing.
const PRE_REVIEW_FINDINGS_MAX = 30;
export const postPreReview = defineQuery({
  name: 'social.post.pre_review',
  input: z.strictObject({ postId: zId }),
  access: ALL,
  agent: { roles: [CONTENT_MANAGER_TEMPLATE] },
  handler: async (ctx, input): Promise<PreReview> => {
    const [view] = await viewPosts(ctx, [input.postId], { duplicates: true });
    if (!view) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
    const waiting = view.variants.filter((v) => v.status === 'in_review');
    const voices = await ctx.trx.selectFrom('crove_social.brand_voice').select(['channel_connection_id', 'avoid_words']).where('org_id', '=', ctx.orgId).execute();
    const names = new Map(
      (
        await ctx.trx
          .selectFrom('crove_kernel.channel_connection')
          .select(['id', 'display_name'])
          .where('org_id', '=', ctx.orgId)
          .where(
            'id',
            'in',
            waiting.length > 0 ? waiting.map((v) => v.connectionId) : [input.postId],
          )
          .execute()
      ).map((c) => [c.id, c.display_name]),
    );
    const findings: string[] = [];
    // Notes of the team not dealt with yet (#1168), first: the reviewer should know what is still open.
    if (view.openComments > 0) findings.push(`${view.openComments} bình luận nội bộ chưa xử lý.`);
    for (const v of waiting) {
      const name = names.get(v.connectionId) ?? v.provider;
      const codes = [...new Set(v.issues.map((i) => i.code))];
      if (codes.length > 0) findings.push(`${name}: chưa đúng yêu cầu của nền tảng (${codes.slice(0, 5).join(', ')}).`);
      const text = v.effective.body.toLowerCase();
      const avoid = voices.filter((x) => x.channel_connection_id === null || x.channel_connection_id === v.connectionId).flatMap((x) => x.avoid_words);
      const used = [...new Set(avoid.map((w) => w.trim()).filter((w) => w && text.includes(w.toLowerCase())))];
      if (used.length > 0) findings.push(`${name}: có từ nên tránh theo giọng thương hiệu (${used.slice(0, 5).join(', ')}).`);
      // A PDF (#1119) goes out as a document with its title and takes no alt text.
      const undescribed = v.media.filter((m) => !m.altText && m.mime !== 'application/pdf').length;
      if (undescribed > 0) findings.push(`${name}: ${undescribed} ảnh hoặc video chưa có mô tả cho người đọc màn hình (alt text).`);
      // The same text as another post on this channel (#1156): X and LinkedIn refuse it, elsewhere followers see it twice.
      if (v.duplicateOf) findings.push(`${name}: ${duplicateFinding(v.provider, v.duplicateOf, view.timeZone)}`);
    }
    const title = view.title?.trim() || view.body.replace(/\s+/g, ' ').trim().slice(0, 120);
    return { postId: view.id, title, waiting: waiting.length, findings: findings.slice(0, PRE_REVIEW_FINDINGS_MAX) };
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
    // Drafts with no planned time and no channel time (#1145), the calendar's side list.
    undated: z.literal(true).optional(),
    // In the post's or a channel's own text or title; wildcards are matched as themselves.
    search: z.string().trim().min(1).max(200).optional(),
    // The last post of the previous page, newest change first.
    before: z.strictObject({ updatedAt: z.iso.datetime({ offset: true }), postId: zId }).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  access: ALL,
  handler: async (ctx, input): Promise<PostView[]> => {
    // A member limited to some channels (#1081) lists the posts with a variant there, and every filter on a variant
    // looks at those variants only; a channel they may not use lists nothing.
    const scope = await channelScope(ctx);
    if (input.connectionId && scope !== null && !scope.has(input.connectionId)) return [];
    const mine = connectionInScope(scope, 'v.channel_connection_id');
    let q = ctx.trx.selectFrom('crove_social.post as p').select('p.id').where('p.org_id', '=', ctx.orgId).where(postInScope(scope));
    if (input.status) q = q.where('p.status', '=', input.status);
    if (input.assignee === 'me') q = q.where('p.assignee_user_id', '=', ctx.actor.type === 'user' ? ctx.actor.userId : '00000000-0000-0000-0000-000000000000');
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
    // Not the queue of a channel the caller may not use (#1081).
    if (!mayUse(await channelScope(ctx), input.connectionId)) throw channelNotAllowed([input.connectionId]);
    const queue = await ctx.trx
      .selectFrom('crove_social.queue')
      .select(['id', 'time_zone', 'paused', 'low_days', 'low_alerted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .executeTakeFirst();
    if (!queue) return { connectionId: input.connectionId, queueId: null, timeZone: null, paused: false, slots: [], nextFree: [], lowDays: null, low: false };
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
    // The transaction's own clock (#851): the same instant the slots taken were read at, whatever the host's clock says.
    const clock = await sql<{ now: Date }>`SELECT pg_catalog.now() AS now`.execute(ctx.trx);
    let after = (clock.rows[0]?.now ?? new Date()).getTime();
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
      // The warning when the queue runs low (#1079), and whether the last check found it low.
      lowDays: queue.low_days,
      low: queue.low_alerted_at !== null,
    };
  },
});

// The most days and slots one open-slots answer covers (#1158): a month view's month.
export const OPEN_SLOT_DAYS = 31;
export const OPEN_SLOT_LIMIT = 500;

// The open slots of a channel's queue in a range (#1158), for the calendar's gaps: its active slots after now (the
// transaction's clock, the instant the slots taken are read at) that no post holds, each with the label it is kept for
// (#745). At most 31 days and 500 slots (capped: more were left out). Only a channel the caller may use (#1081).
export const queueOpenSlots = defineQuery({
  name: 'social.queue.open_slots',
  input: z
    .strictObject({ connectionId: zId, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
    .refine((x) => Date.parse(x.from) < Date.parse(x.to), 'the range ends after it starts')
    .refine((x) => Date.parse(x.to) - Date.parse(x.from) <= OPEN_SLOT_DAYS * 86_400_000, `at most ${OPEN_SLOT_DAYS} days`),
  access: ALL,
  handler: async (ctx, input) => {
    if (!mayUse(await channelScope(ctx), input.connectionId)) throw channelNotAllowed([input.connectionId]);
    const queue = await ctx.trx
      .selectFrom('crove_social.queue')
      .select(['id', 'time_zone', 'paused'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .executeTakeFirst();
    if (!queue) return { connectionId: input.connectionId, timeZone: null, paused: false, slots: [], capped: false };
    const rows = await ctx.trx
      .selectFrom('crove_social.queue_slot as s')
      .leftJoin('crove_social.label as l', (j) => j.onRef('l.org_id', '=', 's.org_id').onRef('l.id', '=', 's.label_id'))
      .select(['s.weekday', 's.minute', 's.label_id', 'l.name as label_name'])
      .where('s.org_id', '=', ctx.orgId)
      .where('s.queue_id', '=', queue.id)
      .where('s.active', '=', true)
      .execute();
    const spec: QueueSpec = { timeZone: queue.time_zone, slots: rows.map((s) => ({ weekday: s.weekday, minute: s.minute, labelId: s.label_id })) };
    const names = new Map(rows.filter((r) => r.label_id !== null).map((r) => [r.label_id as string, r.label_name]));
    const taken = await takenSlots(ctx.trx, ctx.orgId, input.connectionId);
    const clock = await sql<{ now: Date }>`SELECT pg_catalog.now() AS now`.execute(ctx.trx);
    const from = Math.max(Date.parse(input.from), (clock.rows[0]?.now ?? new Date()).getTime());
    const open = openSlots(spec, from, Date.parse(input.to), taken, OPEN_SLOT_LIMIT + 1);
    return {
      connectionId: input.connectionId,
      timeZone: queue.time_zone,
      paused: queue.paused,
      slots: open.slice(0, OPEN_SLOT_LIMIT).map((e) => ({ at: new Date(e.at).toISOString(), labelId: e.labelId, label: e.labelId === null ? null : (names.get(e.labelId) ?? null) })),
      capped: open.length > OPEN_SLOT_LIMIT,
    };
  },
});

export const socialCommands = [
  postCreate,
  postImport,
  postAddChannels,
  postUpdate,
  variantUpdate,
  postRestoreVersion,
  postSubmit,
  variantDecide,
  variantSchedule,
  variantUnschedule,
  variantReschedule,
  variantCancel,
  queueSet,
  ...queueOrderCommands,
  ...publishingCommands,
  ...publishHoldCommands,
  ...metricsCommands,
  ...externalPostCommands,
  ...planExportCommands,
  ...evergreenCommands,
  ...recurringCommands,
  ...commentCommands,
  ...threadCommands,
  ...autoReplyCommands,
  ...repostCommands,
  ...pinCommands,
  ...gateCommands,
  ...playlistCommands,
  ...removeCommands,
  ...policyCommands,
  ...clientReviewCommands,
  ...assignCommands,
  ...snippetCommands,
  ...labelCommands,
  ...bulkEditCommands,
  ...bulkDraftCommands,
  ...mediaTagCommands,
  ...stockPhotoCommands,
  ...ideaCommands,
  ...bioCommands,
  ...feedCommands,
  ...reportScheduleCommands,
  ...brandVoiceCommands,
  ...bannedWordCommands,
  ...watermarkCommands,
  ...reportBrandingCommands,
  ...chatAlertCommands,
  ...channelSetCommands,
  ...calendarNoteCommands,
  ...calendarFeedCommands,
  ...reviewLinkCommands,
  ...activityCommands,
  ...accountCommands,
  ...reportLinkCommands,
  ...goalCommands,
  ...linkPreviewCommands,
  ...channelOptionCommands,
  ...notificationCommands,
  ...reminderCommands,
  ...channelAccessCommands,
  ...reviewChecklistCommands,
  ...queueLowCommands,
  ...digestCommands,
  ...outperformingCommands,
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

export const socialQueries = [postGet, postReviewDiff, postPreReview, postList, queueGet, queueOpenSlots, mediaFile, ...metricsQueries, ...externalPostQueries, ...libraryQueries, ...mediaTagQueries, ...policyQueries, ...snippetQueries, ...labelQueries, ...ideaQueries, ...feedQueries, ...reportScheduleQueries, ...brandVoiceQueries, ...watermarkQueries, ...reportBrandingQueries, ...chatAlertQueries, ...channelSetQueries, ...calendarNoteQueries, ...calendarFeedQueries, ...bioQueries, ...activityQueries, ...reviewLinkQueries, ...reviewInboxQueries, ...attentionInboxQueries, ...reportLinkQueries, ...notificationQueries, ...linkPreviewQueries, ...channelOptionQueries, ...accountQueries, ...publishHoldQueries, ...versionQueries, ...teamReportQueries, ...goalQueries, ...bannedWordQueries, ...channelAccessQueries, ...reviewChecklistQueries, ...bulkEditQueries];
