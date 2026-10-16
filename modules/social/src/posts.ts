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
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Database, MemberRole, SocialDecision, SocialVariantStatus } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { approvalCovers, contentHash, effectiveContent, type BaseContent } from './domain/approval.ts';
import { isProvider } from './domain/channels.ts';
import { isValidTimeZone, nextFreeSlot, placeQueued, retime, type QueueSpec } from './domain/queue.ts';
import { FROZEN, IN_FLIGHT, postStatus, transitionVariant, type VariantEvent } from './domain/state.ts';
import { validateVariant, type Issue } from './domain/validate.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const MAX_CHANNELS_PER_POST = 20;
const MAX_SLOTS = 100;

type Trx = Transaction<Database>;

const zBody = z.string().max(100_000);
const zTitle = z.string().max(500);
const zLink = z.url({ protocol: /^https?$/ }).max(2000);
const zTimeZone = z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone');
// Provider settings (privacy level, post type...): plain JSON, 16 KiB at most.
const zSettings = z.record(z.string().max(100), z.json()).refine((v) => JSON.stringify(v).length <= 16_384, 'settings over 16 KiB');
const zChannel = z.strictObject({
  connectionId: zId,
  body: zBody.nullable().optional(),
  title: zTitle.nullable().optional(),
  linkUrl: zLink.nullable().optional(),
  settings: zSettings.optional(),
});
const zVariantIds = z.array(zId).min(1).max(MAX_CHANNELS_PER_POST);

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

interface PostRow {
  id: string;
  body: string;
  title: string | null;
  link_url: string | null;
  time_zone: string;
  scheduled_at: Date | null;
  revision: number;
}

interface VariantRow {
  id: string;
  post_id: string;
  channel_connection_id: string;
  provider: string;
  position: number;
  body: string | null;
  title: string | null;
  link_url: string | null;
  settings: unknown;
  revision: number;
  content_hash: string;
  status: SocialVariantStatus;
  scheduled_at: Date | null;
  queue_slot_at: Date | null;
  attempt: number;
}

const POST_COLUMNS = ['id', 'body', 'title', 'link_url', 'time_zone', 'scheduled_at', 'revision'] as const;
const VARIANT_COLUMNS = [
  'id',
  'post_id',
  'channel_connection_id',
  'provider',
  'position',
  'body',
  'title',
  'link_url',
  'settings',
  'revision',
  'content_hash',
  'status',
  'scheduled_at',
  'queue_slot_at',
  'attempt',
] as const;

const base = (post: PostRow): BaseContent => ({ body: post.body, title: post.title, linkUrl: post.link_url });
const overrides = (v: Pick<VariantRow, 'body' | 'title' | 'link_url'>) => ({ body: v.body, title: v.title, linkUrl: v.link_url });
const settingsOf = (v: { settings: unknown }): Record<string, unknown> =>
  v.settings !== null && typeof v.settings === 'object' && !Array.isArray(v.settings) ? (v.settings as Record<string, unknown>) : {};

function providerOf(v: { provider: string }) {
  if (!isProvider(v.provider)) throw new DomainError('CHANNEL_PROVIDER_UNSUPPORTED', 422, `Kênh ${v.provider} chưa được hỗ trợ`);
  return v.provider;
}

// The hash a reviewer's decision binds to: the variant's effective content, settings and target.
function hashOf(post: BaseContent, v: Pick<VariantRow, 'channel_connection_id' | 'provider' | 'body' | 'title' | 'link_url' | 'settings'>): string {
  const content = effectiveContent(post, overrides(v));
  return contentHash([
    { channelConnectionId: v.channel_connection_id, provider: providerOf(v), body: content.body, title: content.title, linkUrl: content.linkUrl, media: [], settings: settingsOf(v) },
  ]);
}

function issuesOf(post: BaseContent, v: VariantRow): Issue[] {
  const content = effectiveContent(post, overrides(v));
  return validateVariant({ provider: providerOf(v), body: content.body, title: content.title, media: [] });
}

function step(v: { id: string; status: SocialVariantStatus }, event: VariantEvent): SocialVariantStatus {
  const t = transitionVariant(v.status, event);
  if (!t.ok) {
    throw new DomainError('VARIANT_STATE', 409, `Không thể ${eventLabel(event)} ở trạng thái hiện tại của kênh`, { variantId: v.id, status: v.status, event: event.type });
  }
  return t.status;
}

function eventLabel(event: VariantEvent): string {
  switch (event.type) {
    case 'edit':
      return 'sửa nội dung';
    case 'submit':
      return 'gửi duyệt';
    case 'approve':
    case 'request_changes':
    case 'reject':
      return 'duyệt';
    case 'schedule':
      return 'lên lịch';
    case 'unschedule':
      return 'bỏ lịch';
    case 'cancel':
      return 'hủy';
    default:
      return 'thực hiện việc này';
  }
}

async function lockPost(trx: Trx, orgId: string, postId: string): Promise<PostRow> {
  const post = await trx.selectFrom('crove_social.post').select(POST_COLUMNS).where('org_id', '=', orgId).where('id', '=', postId).forUpdate().executeTakeFirst();
  if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
  return post;
}

async function lockVariants(trx: Trx, orgId: string, postId: string): Promise<VariantRow[]> {
  return trx
    .selectFrom('crove_social.post_variant')
    .select(VARIANT_COLUMNS)
    .where('org_id', '=', orgId)
    .where('post_id', '=', postId)
    .orderBy('position')
    .orderBy('id')
    .forUpdate()
    .execute();
}

// The variants a command names, all of the post; every id must be one of them.
function pick(variants: VariantRow[], ids: readonly string[] | undefined): VariantRow[] {
  if (!ids) return variants;
  const byId = new Map(variants.map((v) => [v.id, v]));
  const chosen = [...new Set(ids)].map((id) => byId.get(id));
  if (chosen.some((v) => v === undefined)) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Có kênh không thuộc bài đăng này');
  return chosen as VariantRow[];
}

async function variantPost(trx: Trx, orgId: string, variantIds: readonly string[]): Promise<string> {
  const rows = await trx.selectFrom('crove_social.post_variant').select(['post_id']).where('org_id', '=', orgId).where('id', 'in', [...variantIds]).execute();
  const posts = new Set(rows.map((r) => r.post_id));
  if (rows.length !== new Set(variantIds).size || posts.size !== 1) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh của bài đăng này');
  return [...posts][0] as string;
}

async function setVariant(ctx: CommandContext, id: string, values: Record<string, unknown>): Promise<void> {
  await ctx.trx
    .updateTable('crove_social.post_variant')
    .set({ ...values, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .execute();
}

async function refreshPostStatus(ctx: CommandContext, postId: string): Promise<void> {
  const rows = await ctx.trx.selectFrom('crove_social.post_variant').select('status').where('org_id', '=', ctx.orgId).where('post_id', '=', postId).execute();
  await ctx.trx
    .updateTable('crove_social.post')
    .set({ status: postStatus(rows.map((r) => r.status)), updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', postId)
    .execute();
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

async function insertVariants(ctx: CommandContext, post: PostRow, channels: z.infer<typeof zChannel>[], startAt: number) {
  const providers = await liveConnections(
    ctx,
    channels.map((c) => c.connectionId),
  );
  const created: Array<{ variantId: string; connectionId: string }> = [];
  for (const [i, c] of channels.entries()) {
    const row = {
      channel_connection_id: c.connectionId,
      provider: providers.get(c.connectionId) as string,
      body: c.body ?? null,
      title: c.title ?? null,
      link_url: c.linkUrl ?? null,
      settings: c.settings ?? {},
    };
    const inserted = await ctx.trx
      .insertInto('crove_social.post_variant')
      .values({
        org_id: ctx.orgId,
        post_id: post.id,
        ...row,
        settings: JSON.stringify(row.settings),
        position: startAt + i,
        content_hash: hashOf(base(post), row),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        if ((error as { constraint?: string }).constraint === 'post_variant_one_per_connection') {
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
  channels: z.array(zChannel).min(1).max(MAX_CHANNELS_PER_POST),
});

export const postCreate = defineCommand({
  name: 'social.post.create',
  input: zPostCreate,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    distinctConnections(input.channels);
    const post = await ctx.trx
      .insertInto('crove_social.post')
      .values({
        org_id: ctx.orgId,
        body: input.body,
        title: input.title ?? null,
        link_url: input.linkUrl ?? null,
        // The surface sets actor_origin once API and MCP clients exist; today every write comes from the app.
        origin: 'human',
        actor_origin: 'ui',
        author_user_id: userId,
        ...(input.timeZone ? { time_zone: input.timeZone } : {}),
        scheduled_at: input.scheduledAt ?? null,
      })
      .returning(POST_COLUMNS)
      .executeTakeFirstOrThrow();
    const variants = await insertVariants(ctx, post, input.channels, 0);
    ctx.audit({ post_id: post.id, variants: variants.length });
    await ctx.emit('social.post.created', { post_id: post.id });
    return { postId: post.id, revision: post.revision, variants };
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
    };
    const variants = await lockVariants(ctx.trx, ctx.orgId, post.id);
    const changed = variants.filter((v) => hashOf(base(next), v) !== v.content_hash);
    const blocked = changed.filter((v) => IN_FLIGHT.has(v.status));
    if (blocked.length > 0) {
      throw new DomainError('VARIANT_IN_FLIGHT', 409, 'Có kênh đang đăng: chờ kết quả rồi mới sửa nội dung chung', { variantIds: blocked.map((v) => v.id) });
    }
    for (const v of changed) {
      if (FROZEN.has(v.status)) {
        // History keeps what it had: copy the inherited content into the variant before the base changes.
        const kept = effectiveContent(base(post), overrides(v));
        await setVariant(ctx, v.id, { body: kept.body, title: kept.title, link_url: kept.linkUrl });
        continue;
      }
      await setVariant(ctx, v.id, { content_hash: hashOf(base(next), v), revision: v.revision + 1, status: step(v, { type: 'edit' }) });
    }
    const revision = post.revision + 1;
    await ctx.trx
      .updateTable('crove_social.post')
      .set({ body: next.body, title: next.title, link_url: next.link_url, time_zone: next.time_zone, revision, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', post.id)
      .execute();
    await refreshPostStatus(ctx, post.id);
    return { postId: post.id, revision, changedVariants: changed.filter((v) => !FROZEN.has(v.status)).map((v) => v.id) };
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
    const next = {
      ...v,
      body: input.body === undefined ? v.body : input.body,
      title: input.title === undefined ? v.title : input.title,
      link_url: input.linkUrl === undefined ? v.link_url : input.linkUrl,
      settings: input.settings ?? settingsOf(v),
    };
    const hash = hashOf(base(post), next);
    if (hash === v.content_hash) return { variantId: v.id, revision: v.revision, changed: false };
    const status = step(v, { type: 'edit' });
    await setVariant(ctx, v.id, {
      body: next.body,
      title: next.title,
      link_url: next.link_url,
      settings: JSON.stringify(next.settings),
      content_hash: hash,
      revision: v.revision + 1,
      status,
    });
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

// A reviewer's decision on variants in review, each named with the revision and content hash the reviewer saw.
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
    for (const v of chosen) {
      const saw = seen.get(v.id);
      if (!saw || saw.revision !== v.revision || saw.contentHash !== v.content_hash) {
        throw new DomainError('STALE_REVISION', 409, 'Nội dung kênh đã đổi sau khi bạn xem, hãy xem lại trước khi duyệt', { variantId: v.id, revision: v.revision });
      }
      const status = step(v, DECISION_EVENT[input.decision]);
      const content = effectiveContent(base(post), overrides(v));
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
            settings: settingsOf(v),
          }),
        })
        .execute();
      await setVariant(ctx, v.id, { status });
    }
    await refreshPostStatus(ctx, post.id);
    ctx.audit({ post_id: post.id, decision: input.decision, variants: chosen.map((v) => v.id) });
    await ctx.emit('social.variant.decided', { post_id: post.id, decision: input.decision, variant_ids: chosen.map((v) => v.id) });
    return { postId: post.id, decision: input.decision, variants: chosen.map((v) => v.id) };
  },
});

async function latestDecision(trx: Trx, orgId: string, variantId: string) {
  return trx
    .selectFrom('crove_social.post_approval')
    .select(['decision', 'revision', 'content_hash'])
    .where('org_id', '=', orgId)
    .where('variant_id', '=', variantId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

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
    .select(['weekday', 'minute'])
    .where('org_id', '=', orgId)
    .where('queue_id', '=', queue.id)
    .where('active', '=', true)
    .execute();
  return { id: queue.id, paused: queue.paused, spec: { timeZone: queue.time_zone, slots } };
}

const HOLDS_SLOT: readonly SocialVariantStatus[] = ['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'paused'];

async function takenSlots(trx: Trx, orgId: string, connectionId: string, exceptId?: string): Promise<Set<number>> {
  let q = trx
    .selectFrom('crove_social.post_variant')
    .select('queue_slot_at')
    .where('org_id', '=', orgId)
    .where('channel_connection_id', '=', connectionId)
    .where('queue_slot_at', 'is not', null)
    .where('status', 'not in', ['cancelled', 'published', 'failed']);
  if (exceptId) q = q.where('id', '<>', exceptId);
  const rows = await q.execute();
  return new Set(rows.map((r) => (r.queue_slot_at as Date).getTime()));
}

// Schedules approved variants: at a time (`at`, else the post's default time), or in the next free slot of each
// connection's queue (`queue: true`).
export const variantSchedule = defineCommand({
  name: 'social.variant.schedule',
  input: z
    .strictObject({ postId: zId, variantIds: zVariantIds.optional(), at: z.iso.datetime({ offset: true }).optional(), queue: z.literal(true).optional() })
    .refine((x) => !(x.at && x.queue), 'choose a time or the queue, not both'),
  risk: 'R2',
  access: ADMINS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    const all = await lockVariants(ctx.trx, ctx.orgId, post.id);
    const chosen = input.variantIds ? pick(all, input.variantIds) : all.filter((v) => v.status === 'approved');
    if (chosen.length === 0) throw new DomainError('NOTHING_TO_SCHEDULE', 409, 'Không có kênh nào đã duyệt để lên lịch');
    const at = input.at ? new Date(Date.parse(input.at)) : post.scheduled_at;
    if (!input.queue) {
      if (!at) throw new DomainError('SCHEDULE_REQUIRED', 422, 'Hãy chọn giờ đăng hoặc dùng hàng đợi');
      if (at.getTime() <= ctx.now.getTime()) throw new DomainError('SCHEDULE_IN_PAST', 422, 'Giờ đăng phải ở tương lai');
    }
    const scheduled: Array<{ variantId: string; at: string }> = [];
    for (const v of chosen) {
      const decision = await latestDecision(ctx.trx, ctx.orgId, v.id);
      if (decision?.decision !== 'approved' || !approvalCovers({ revision: decision.revision, contentHash: decision.content_hash }, { revision: v.revision, contentHash: v.content_hash })) {
        throw new DomainError('APPROVAL_REQUIRED', 409, 'Kênh này chưa được duyệt đúng nội dung hiện tại', { variantId: v.id });
      }
      const status = step(v, { type: 'schedule' });
      if (input.queue) {
        const queue = await lockQueue(ctx.trx, ctx.orgId, v.channel_connection_id);
        if (!queue || queue.spec.slots.length === 0) throw new DomainError('QUEUE_EMPTY', 409, 'Kênh này chưa có khung giờ đăng trong hàng đợi', { variantId: v.id });
        const slot = nextFreeSlot(queue.spec, ctx.now.getTime(), await takenSlots(ctx.trx, ctx.orgId, v.channel_connection_id, v.id));
        if (slot === null) throw new DomainError('QUEUE_FULL', 409, 'Hàng đợi của kênh này đã kín trong năm tới', { variantId: v.id });
        await setVariant(ctx, v.id, { status, queue_slot_at: new Date(slot), scheduled_at: null });
        scheduled.push({ variantId: v.id, at: new Date(slot).toISOString() });
      } else {
        await setVariant(ctx, v.id, { status, queue_slot_at: null, scheduled_at: input.at ? at : null });
        scheduled.push({ variantId: v.id, at: (at as Date).toISOString() });
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
    for (const v of chosen) await setVariant(ctx, v.id, { status: step(v, { type: 'unschedule' }), queue_slot_at: null, scheduled_at: null });
    await refreshPostStatus(ctx, postId);
    return { postId, variants: chosen.map((v) => v.id) };
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
    await lockPost(ctx.trx, ctx.orgId, postId);
    const chosen = pick(await lockVariants(ctx.trx, ctx.orgId, postId), input.variantIds);
    for (const v of chosen) await setVariant(ctx, v.id, { status: step(v, { type: 'cancel' }) });
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
      .array(z.strictObject({ weekday: z.number().int().min(1).max(7), minute: z.number().int().min(0).max(1439), label: z.string().trim().max(100).optional() }))
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
    // Serializes with schedule commands on this connection (they lock the same row).
    const before = await lockQueue(ctx.trx, ctx.orgId, input.connectionId);
    let queueId = before?.id;
    if (before) {
      await ctx.trx
        .updateTable('crove_social.queue')
        .set({ time_zone: input.timeZone, paused: input.paused ?? before.paused, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', before.id)
        .execute();
      await ctx.trx.deleteFrom('crove_social.queue_slot').where('org_id', '=', ctx.orgId).where('queue_id', '=', before.id).execute();
    } else {
      const created = await ctx.trx
        .insertInto('crove_social.queue')
        .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, time_zone: input.timeZone, paused: input.paused ?? false })
        .returning('id')
        .executeTakeFirstOrThrow();
      queueId = created.id;
    }
    if (input.slots.length > 0) {
      await ctx.trx
        .insertInto('crove_social.queue_slot')
        .values(input.slots.map((s) => ({ org_id: ctx.orgId, queue_id: queueId as string, weekday: s.weekday, minute: s.minute, label: s.label ?? null })))
        .execute();
    }
    const spec: QueueSpec = { timeZone: input.timeZone, slots: input.slots };
    const queued = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['id', 'queue_slot_at'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .where('queue_slot_at', 'is not', null)
      .where('status', 'in', [...HOLDS_SLOT])
      .orderBy('queue_slot_at')
      .orderBy('id')
      .forUpdate()
      .execute();
    const zoneChanged = before !== null && before.spec.timeZone !== input.timeZone;
    const placed = placeQueued(
      spec,
      queued.map((q) => {
        const at = (q.queue_slot_at as Date).getTime();
        return { id: q.id, slotAt: zoneChanged ? retime(at, (before as QueueState).spec.timeZone, input.timeZone) : at };
      }),
      ctx.now.getTime(),
    );
    const was = new Map(queued.map((q) => [q.id, (q.queue_slot_at as Date).getTime()]));
    const moved = placed.filter((p) => p.slotAt !== was.get(p.id));
    // Clear first, then assign: two posts trading slots never meet on the unique slot index.
    for (const p of moved) await setVariant(ctx, p.id, { queue_slot_at: null });
    for (const p of moved) {
      if (p.slotAt === null) {
        // No slot left within a year: the variant leaves the queue and waits for a person.
        const [row] = await ctx.trx.selectFrom('crove_social.post_variant').select(['id', 'status', 'post_id']).where('org_id', '=', ctx.orgId).where('id', '=', p.id).execute();
        if (row?.status === 'scheduled') await setVariant(ctx, p.id, { status: step(row, { type: 'unschedule' }) });
        continue;
      }
      await setVariant(ctx, p.id, { queue_slot_at: new Date(p.slotAt) });
    }
    return { queueId: queueId as string, moved: moved.map((p) => ({ variantId: p.id, at: p.slotAt === null ? null : new Date(p.slotAt).toISOString() })) };
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
  effective: BaseContent;
  settings: Record<string, unknown>;
  revision: number;
  contentHash: string;
  status: SocialVariantStatus;
  // When it goes out: its queue slot, else its own time, else the post's.
  effectiveAt: string | null;
  queueSlotAt: string | null;
  attempt: number;
  externalUrl: string | null;
  publishedAt: string | null;
  error: { kind: string | null; code: string | null; action: string | null; message: string | null; retryAt: string | null } | null;
  issues: Issue[];
  latestDecision: { decision: SocialDecision; comment: string | null; decidedBy: string; at: string; revision: number; current: boolean } | null;
}

export interface PostView {
  id: string;
  body: string;
  title: string | null;
  linkUrl: string | null;
  timeZone: string;
  scheduledAt: string | null;
  revision: number;
  status: string;
  origin: string;
  tainted: boolean;
  authorUserId: string | null;
  createdAt: string;
  updatedAt: string;
  variants: VariantView[];
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
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute()
    : [];
  const latest = new Map<string, (typeof decisions)[number]>();
  for (const d of decisions) if (!latest.has(d.variant_id)) latest.set(d.variant_id, d);
  const byPost = new Map(posts.map((p) => [p.id, p]));
  return postIds
    .map((id) => byPost.get(id))
    .filter((p): p is (typeof posts)[number] => p !== undefined)
    .map((p) => {
      const b: BaseContent = { body: p.body, title: p.title, linkUrl: p.link_url };
      return {
        id: p.id,
        body: p.body,
        title: p.title,
        linkUrl: p.link_url,
        timeZone: p.time_zone,
        scheduledAt: iso(p.scheduled_at),
        revision: p.revision,
        status: p.status,
        origin: p.origin,
        tainted: p.tainted,
        authorUserId: p.author_user_id,
        createdAt: iso(p.created_at) ?? '',
        updatedAt: iso(p.updated_at) ?? '',
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
              effective: effectiveContent(b, overrides(v)),
              settings: settingsOf(v),
              revision: v.revision,
              contentHash: v.content_hash,
              status: v.status,
              effectiveAt: iso(v.queue_slot_at ?? v.scheduled_at ?? p.scheduled_at),
              queueSlotAt: iso(v.queue_slot_at),
              attempt: v.attempt,
              externalUrl: v.external_url,
              publishedAt: iso(v.published_at),
              error: v.error_kind || v.error_code ? { kind: v.error_kind, code: v.error_code, action: v.error_action, message: v.error_message, retryAt: iso(v.error_retry_at) } : null,
              issues: isProvider(v.provider) ? issuesOf(b, row) : [],
              latestDecision: d
                ? { decision: d.decision, comment: d.comment, decidedBy: d.decided_by, at: iso(d.created_at) ?? '', revision: d.revision, current: d.revision === v.revision && d.content_hash === v.content_hash }
                : null,
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
    return view;
  },
});

// Posts, newest first; with from/to, those with a variant going out in [from, to) (the calendar).
export const postList = defineQuery({
  name: 'social.post.list',
  input: z.object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    status: z.enum(['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  access: ALL,
  handler: async (ctx, input): Promise<PostView[]> => {
    let q = ctx.trx.selectFrom('crove_social.post as p').select('p.id').where('p.org_id', '=', ctx.orgId);
    if (input.status) q = q.where('p.status', '=', input.status);
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
              const at = sql`coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at)`;
              const parts = [];
              if (input.from) parts.push(w(at, '>=', new Date(Date.parse(input.from))));
              if (input.to) parts.push(w(at, '<', new Date(Date.parse(input.to))));
              return w.and(parts);
            }),
        ),
      );
    }
    const rows = await q.orderBy('p.updated_at', 'desc').orderBy('p.id', 'desc').limit(input.limit ?? 50).execute();
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
      .select(['weekday', 'minute', 'label', 'active'])
      .where('org_id', '=', ctx.orgId)
      .where('queue_id', '=', queue.id)
      .orderBy('weekday')
      .orderBy('minute')
      .execute();
    const spec: QueueSpec = { timeZone: queue.time_zone, slots: slots.filter((s) => s.active) };
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
    return { connectionId: input.connectionId, queueId: queue.id, timeZone: queue.time_zone, paused: queue.paused, slots, nextFree };
  },
});

export const socialCommands = [postCreate, postAddChannels, postUpdate, variantUpdate, postSubmit, variantDecide, variantSchedule, variantUnschedule, variantCancel, queueSet];
export const socialQueries = [postGet, postList, queueGet];
