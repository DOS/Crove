// Rows of posts and variants as the commands read them, and the helpers every Social command shares: locking (post
// first, then its variants), effective content and its hash, state steps, and the post status refresh. Internal to the
// module; posts.ts and publishing.ts use it.
import type { Transaction } from 'kysely';
import type { Database, SocialVariantStatus } from '@crove/db';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import { contentHash, effectiveContent, effectiveMedia, inheritedContent, type BaseContent, type PostMedia } from './domain/approval.ts';
import { REMOVE_AT_MIN_GAP_MS, isProvider, mediaKindOf, removeAtFit, type MediaKind } from './domain/channels.ts';
import type { QueueSpec } from './domain/queue.ts';
import { postStatus, transitionVariant, type VariantEvent } from './domain/state.ts';
import { validateVariant, type Issue } from './domain/validate.ts';

export type Trx = Transaction<Database>;

// The most channels one post has, cancelled ones included (social.post.add_channels, social.post.bulk_add_channel).
export const MAX_CHANNELS_PER_POST = 20;

export interface PostRow {
  id: string;
  body: string;
  title: string | null;
  link_url: string | null;
  time_zone: string;
  scheduled_at: Date | null;
  revision: number;
  // When it was archived (#1299); null while it is not.
  archived_at: Date | null;
  // The post's images in order (crove_social.post_media), loaded with the row.
  media: readonly PostMedia[];
}

export interface VariantRow {
  id: string;
  post_id: string;
  channel_connection_id: string;
  provider: string;
  position: number;
  body: string | null;
  title: string | null;
  link_url: string | null;
  settings: unknown;
  // The variant's own media list (jsonb), null to inherit the post's.
  media: unknown;
  revision: number;
  // The revision it went out under, once a correction of its published text moved its revision on (#1223); else null.
  published_revision: number | null;
  content_hash: string;
  content_frozen: boolean;
  status: SocialVariantStatus;
  scheduled_at: Date | null;
  queue_slot_at: Date | null;
  attempt: number;
  error_retry_at: Date | null;
  error_code: string | null;
  error_action: string | null;
  next_check_at: Date | null;
  external_post_id: string | null;
  published_at: Date | null;
  updated_at: Date;
}

export const POST_COLUMNS = ['id', 'body', 'title', 'link_url', 'time_zone', 'scheduled_at', 'revision', 'archived_at'] as const;
export const VARIANT_COLUMNS = [
  'id',
  'post_id',
  'channel_connection_id',
  'provider',
  'position',
  'body',
  'title',
  'link_url',
  'settings',
  'media',
  'revision',
  'published_revision',
  'content_hash',
  'content_frozen',
  'status',
  'scheduled_at',
  'queue_slot_at',
  'attempt',
  'error_retry_at',
  'error_code',
  'error_action',
  'next_check_at',
  'external_post_id',
  'published_at',
  'updated_at',
] as const;

// A post's base content: text and images, which every variant inherits unless it overrides them.
export type PostContent = BaseContent & { media: readonly PostMedia[] };
export const base = (post: Pick<PostRow, 'body' | 'title' | 'link_url' | 'media'>): PostContent => ({ body: post.body, title: post.title, linkUrl: post.link_url, media: post.media });
export const overrides = (v: Pick<VariantRow, 'body' | 'title' | 'link_url'>) => ({ body: v.body, title: v.title, linkUrl: v.link_url });

// A variant's own media column, as the commands wrote it; a value that is not a list reads as no list (inherit). A
// list with an entry the commands never write is refused rather than read shorter (#379): the hash and the publish
// read the same list, and a post must never go out with fewer images than its reviewers saw.
export function mediaOf(value: unknown): PostMedia[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((m: unknown) => {
    const { fileId, mime, sizeBytes, generation, altText, durationMs, width, height } = m !== null && typeof m === 'object' ? (m as Record<string, unknown>) : {};
    if (typeof fileId !== 'string' || typeof mime !== 'string' || typeof sizeBytes !== 'number') {
      throw new DomainError('VARIANT_MEDIA_INVALID', 500, 'Danh sách ảnh của kênh bị hỏng, cần kiểm tra dữ liệu');
    }
    return {
      fileId,
      generation: typeof generation === 'string' ? generation : null,
      altText: typeof altText === 'string' ? altText : null,
      mime,
      sizeBytes,
      durationMs: typeof durationMs === 'number' ? durationMs : null,
      width: typeof width === 'number' ? width : null,
      height: typeof height === 'number' ? height : null,
    };
  });
}

// A post file is a video, a document (#1119) or an image, by its type (the server read it from the bytes).
export const mediaKind = (mime: string): MediaKind => mediaKindOf(mime);

// The images a variant shows.
export const mediaFor = (post: PostContent, v: { media?: unknown; content_frozen?: boolean }) => effectiveMedia(post.media, mediaOf(v.media), v.content_frozen ?? false);

// The images of a post, in order, with what the hash and the channel rules need from each file.
export async function loadPostMedia(trx: Trx, orgId: string, postId: string): Promise<PostMedia[]> {
  const rows = await trx
    .selectFrom('crove_social.post_media as m')
    .innerJoin('crove_kernel.file as f', (j) => j.onRef('f.org_id', '=', 'm.org_id').onRef('f.id', '=', 'm.file_id'))
    .select(['m.file_id', 'm.alt_text', 'f.generation', 'f.content_type', 'f.size_bytes', 'f.duration_ms', 'f.image_width', 'f.image_height'])
    .where('m.org_id', '=', orgId)
    .where('m.post_id', '=', postId)
    .orderBy('m.position')
    .execute();
  return rows.map((r) => ({ fileId: r.file_id, generation: r.generation, altText: r.alt_text, mime: r.content_type, sizeBytes: Number(r.size_bytes), durationMs: r.duration_ms === null ? null : Number(r.duration_ms), width: r.image_width ?? null, height: r.image_height ?? null }));
}
export const settingsOf = (v: { settings: unknown }): Record<string, unknown> =>
  v.settings !== null && typeof v.settings === 'object' && !Array.isArray(v.settings) ? (v.settings as Record<string, unknown>) : {};

export function providerOf(v: { provider: string }) {
  if (!isProvider(v.provider)) throw new DomainError('CHANNEL_PROVIDER_UNSUPPORTED', 422, `Kênh ${v.provider} chưa được hỗ trợ`);
  return v.provider;
}

// The hash a reviewer's decision binds to: the variant's effective content, settings and target.
export function hashOf(
  post: PostContent,
  v: Pick<VariantRow, 'channel_connection_id' | 'provider' | 'body' | 'title' | 'link_url' | 'settings'> & { media?: unknown; content_frozen?: boolean },
): string {
  const content = effectiveContent(post, overrides(v), v.content_frozen ?? false, settingsOf(v));
  const media = mediaFor(post, v).map((m) => ({ fileId: m.fileId, generation: m.generation, altText: m.altText }));
  return contentHash([
    { channelConnectionId: v.channel_connection_id, provider: providerOf(v), body: content.body, title: content.title, linkUrl: content.linkUrl, media, settings: settingsOf(v) },
  ]);
}

export function issuesOf(post: PostContent, v: VariantRow): Issue[] {
  const content = effectiveContent(post, overrides(v), v.content_frozen, settingsOf(v));
  const media = mediaFor(post, v).map((m) => ({ kind: mediaKind(m.mime), mime: m.mime, sizeBytes: m.sizeBytes, durationSeconds: m.durationMs == null ? null : m.durationMs / 1000, width: m.width ?? null, height: m.height ?? null }));
  return validateVariant({ provider: providerOf(v), body: content.body, title: content.title, linkUrl: content.linkUrl, media, settings: settingsOf(v) });
}

// A planned takedown (#861) must come at least REMOVE_AT_MIN_GAP_MS and at most the channel's window after the time the
// variant goes out: refused where that time becomes known, like a time in the past.
export function refuseRemoveAtMisfit(v: Pick<VariantRow, 'id' | 'provider' | 'settings'>, publishAt: Date): void {
  const fit = removeAtFit(v.provider, settingsOf(v), publishAt);
  if (fit?.problem === 'too_soon') {
    throw new DomainError('REMOVE_AT_BEFORE_PUBLISH', 422, `Giờ gỡ bài phải sau giờ đăng ít nhất ${REMOVE_AT_MIN_GAP_MS / 60_000} phút`, { variantId: v.id });
  }
  if (fit?.problem === 'too_late') {
    throw new DomainError('REMOVE_AT_TOO_LATE', 422, `Giờ gỡ bài phải trong vòng ${fit.hours} giờ sau giờ đăng`, { variantId: v.id, limit: fit.hours });
  }
}

export function step(v: { id: string; status: SocialVariantStatus }, event: VariantEvent): SocialVariantStatus {
  const t = transitionVariant(v.status, event);
  if (!t.ok) {
    throw new DomainError('VARIANT_STATE', 409, `Không thể ${eventLabel(event)} ở trạng thái hiện tại của kênh`, { variantId: v.id, status: v.status, event: event.type });
  }
  return t.status;
}

export function eventLabel(event: VariantEvent): string {
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

export async function lockPost(trx: Trx, orgId: string, postId: string): Promise<PostRow> {
  const post = await trx.selectFrom('crove_social.post').select(POST_COLUMNS).where('org_id', '=', orgId).where('id', '=', postId).forUpdate().executeTakeFirst();
  if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
  // Media rows change only under this post lock, so reading them after it is consistent.
  return { ...post, media: await loadPostMedia(trx, orgId, postId) };
}

// An archived post (#1299) is out of every list until it is restored: nothing edits it, adds a channel, sends it to
// review, approves, schedules or retries it, and no repeat is set on it, so it never goes out from where nobody sees it.
export function refuseArchived(post: Pick<PostRow, 'archived_at'>): void {
  if (post.archived_at !== null) throw new DomainError('POST_ARCHIVED', 409, 'Bài này đã được lưu trữ; hãy khôi phục bài trước khi sửa, gửi duyệt hay lên lịch');
}

export interface QueueState {
  id: string;
  spec: QueueSpec;
  paused: boolean;
}

// A connection's queue row, locked, with its active slots. Commands that place or move queued variants take it before
// any post or variant, so they never wait on each other in a cycle.
export async function lockQueue(trx: Trx, orgId: string, connectionId: string): Promise<QueueState | null> {
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

export async function lockVariants(trx: Trx, orgId: string, postId: string): Promise<VariantRow[]> {
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
export function pick(variants: VariantRow[], ids: readonly string[] | undefined): VariantRow[] {
  if (!ids) return variants;
  const byId = new Map(variants.map((v) => [v.id, v]));
  const chosen = [...new Set(ids)].map((id) => byId.get(id));
  if (chosen.some((v) => v === undefined)) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Có kênh không thuộc bài đăng này');
  return chosen as VariantRow[];
}

export async function variantPost(trx: Trx, orgId: string, variantIds: readonly string[]): Promise<string> {
  const rows = await trx.selectFrom('crove_social.post_variant').select(['post_id']).where('org_id', '=', orgId).where('id', 'in', [...variantIds]).execute();
  const posts = new Set(rows.map((r) => r.post_id));
  if (rows.length !== new Set(variantIds).size) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
  if (posts.size !== 1) throw new DomainError('VARIANTS_OF_SEVERAL_POSTS', 422, 'Chỉ chọn các kênh của cùng một bài đăng');
  return [...posts][0] as string;
}

// Statuses whose queue slot is free again (the post_variant_slot_uq index skips them); every other status holds it.
export const SLOT_FREED: readonly SocialVariantStatus[] = ['cancelled', 'published', 'failed', 'removed'];
// Queued variants a queue edit may move: they have not been handed to the publisher.
export const MOVABLE: readonly SocialVariantStatus[] = ['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'paused'];

// The slots of a connection's queue that variants hold (all but one, when given), as epoch milliseconds.
export async function takenSlots(trx: Trx, orgId: string, connectionId: string, exceptId?: string): Promise<Set<number>> {
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

export async function setVariant(ctx: CommandContext, id: string, values: Record<string, unknown>): Promise<void> {
  await ctx.trx
    .updateTable('crove_social.post_variant')
    .set({ ...values, updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .execute()
    .catch((error: unknown) => {
      if ((error as { constraint?: string }).constraint === 'post_variant_slot_uq') {
        throw new DomainError('SLOT_TAKEN', 409, 'Khung giờ này của kênh đã có bài khác, hãy thử lại');
      }
      throw error;
    });
}

// What a variant moving to draft by an edit keeps: a failed one gives up its old slot and time (another post may
// hold that slot by now); the others keep their place in the queue while they are reviewed again.
export function editValues(v: VariantRow): Record<string, unknown> {
  // An edit is a new round of review: a variant a raised policy took out of the schedule no longer goes back on its own.
  const reason = v.error_code === POLICY_RAISED ? CLEAR_ERROR : {};
  return v.status === 'failed' ? { status: step(v, { type: 'edit' }), queue_slot_at: null, scheduled_at: null } : { status: step(v, { type: 'edit' }), ...reason };
}

export const CLEAR_ERROR = { error_kind: null, error_code: null, error_http_status: null, error_message: null, error_action: null, error_retry_at: null };
// Back in review because its channel's policy now asks for more approvals (#408). The reason shows on the variant, and
// one that was scheduled (or paused on its channel) is marked to go back to its kept time once the approvals are given.
export const POLICY_RAISED = 'POLICY_RAISED';

export function regateValues(v: VariantRow): Record<string, unknown> {
  return { ...CLEAR_ERROR, status: step(v, { type: 'regate' }), error_code: POLICY_RAISED, error_action: v.status === 'approved' ? null : 'reschedule' };
}

// What the approval that completes the count sets: approved, or scheduled again for a variant a raised policy took out
// of the schedule, when its kept time (or queue slot) is still ahead; past it, a person schedules it again. Never
// scheduled on an archived post (#1299): it stays approved, for a person to schedule once it is restored.
export function approvedValues(v: VariantRow, now: Date, post: Pick<PostRow, 'archived_at'>): Record<string, unknown> {
  const status = step(v, { type: 'approve' });
  if (v.error_code !== POLICY_RAISED) return { status };
  const at = v.scheduled_at ?? v.queue_slot_at;
  const back = post.archived_at === null && v.error_action === 'reschedule' && at !== null && at.getTime() > now.getTime();
  return { ...CLEAR_ERROR, status: back ? step({ id: v.id, status }, { type: 'schedule' }) : status };
}

// A variant becoming history keeps the content it had: copied into its own columns, which base edits no longer reach.
// Its own text, without the signature: its settings keep that, and effectiveContent appends it as before.
export function freezeValues(post: PostRow, v: VariantRow): Record<string, unknown> {
  const kept = inheritedContent(base(post), overrides(v), v.content_frozen);
  return { body: kept.body, title: kept.title, link_url: kept.linkUrl, media: JSON.stringify(mediaFor(base(post), v)), content_frozen: true };
}

export async function refreshPostStatus(ctx: CommandContext, postId: string): Promise<void> {
  const rows = await ctx.trx.selectFrom('crove_social.post_variant').select('status').where('org_id', '=', ctx.orgId).where('post_id', '=', postId).execute();
  await ctx.trx
    .updateTable('crove_social.post')
    .set({ status: postStatus(rows.map((r) => r.status)), updated_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', postId)
    .execute();
}

export async function latestDecision(trx: Trx, orgId: string, variantId: string) {
  return trx
    .selectFrom('crove_social.post_approval')
    .select(['decision', 'revision', 'content_hash'])
    .where('org_id', '=', orgId)
    .where('variant_id', '=', variantId)
    // Newest by id (written under the post lock), not by created_at (its transaction's start).
    .orderBy('id', 'desc')
    .executeTakeFirst();
}
