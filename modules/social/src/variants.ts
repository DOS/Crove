// Rows of posts and variants as the commands read them, and the helpers every Social command shares: locking (post
// first, then its variants), effective content and its hash, state steps, and the post status refresh. Internal to the
// module; posts.ts and publishing.ts use it.
import type { Transaction } from 'kysely';
import type { Database, SocialVariantStatus } from '@crove/db';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import { contentHash, effectiveContent, effectiveMedia, type BaseContent, type PostMedia } from './domain/approval.ts';
import { isProvider } from './domain/channels.ts';
import { postStatus, transitionVariant, type VariantEvent } from './domain/state.ts';
import { validateVariant, type Issue } from './domain/validate.ts';

export type Trx = Transaction<Database>;

export interface PostRow {
  id: string;
  body: string;
  title: string | null;
  link_url: string | null;
  time_zone: string;
  scheduled_at: Date | null;
  revision: number;
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
  content_hash: string;
  content_frozen: boolean;
  status: SocialVariantStatus;
  scheduled_at: Date | null;
  queue_slot_at: Date | null;
  attempt: number;
  error_retry_at: Date | null;
  next_check_at: Date | null;
  external_post_id: string | null;
  updated_at: Date;
}

export const POST_COLUMNS = ['id', 'body', 'title', 'link_url', 'time_zone', 'scheduled_at', 'revision'] as const;
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
  'content_hash',
  'content_frozen',
  'status',
  'scheduled_at',
  'queue_slot_at',
  'attempt',
  'error_retry_at',
  'next_check_at',
  'external_post_id',
  'updated_at',
] as const;

// A post's base content: text and images, which every variant inherits unless it overrides them.
export type PostContent = BaseContent & { media: readonly PostMedia[] };
export const base = (post: Pick<PostRow, 'body' | 'title' | 'link_url' | 'media'>): PostContent => ({ body: post.body, title: post.title, linkUrl: post.link_url, media: post.media });
export const overrides = (v: Pick<VariantRow, 'body' | 'title' | 'link_url'>) => ({ body: v.body, title: v.title, linkUrl: v.link_url });

// A variant's own media column, as the commands wrote it; anything else reads as no list (inherit).
export function mediaOf(value: unknown): PostMedia[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((m: unknown) => {
    if (m === null || typeof m !== 'object') return [];
    const r = m as Record<string, unknown>;
    if (typeof r.fileId !== 'string' || typeof r.mime !== 'string' || typeof r.sizeBytes !== 'number') return [];
    return [{ fileId: r.fileId, generation: typeof r.generation === 'string' ? r.generation : null, altText: typeof r.altText === 'string' ? r.altText : null, mime: r.mime, sizeBytes: r.sizeBytes, durationMs: typeof r.durationMs === 'number' ? r.durationMs : null }];
  });
}

// A post file is a video or an image, by its type (the server read it from the bytes).
export const mediaKind = (mime: string): 'image' | 'video' => (mime.startsWith('video/') ? 'video' : 'image');

// The images a variant shows.
export const mediaFor = (post: PostContent, v: { media?: unknown; content_frozen?: boolean }) => effectiveMedia(post.media, mediaOf(v.media), v.content_frozen ?? false);

// The images of a post, in order, with what the hash and the channel rules need from each file.
export async function loadPostMedia(trx: Trx, orgId: string, postId: string): Promise<PostMedia[]> {
  const rows = await trx
    .selectFrom('crove_social.post_media as m')
    .innerJoin('crove_kernel.file as f', (j) => j.onRef('f.org_id', '=', 'm.org_id').onRef('f.id', '=', 'm.file_id'))
    .select(['m.file_id', 'm.alt_text', 'f.generation', 'f.content_type', 'f.size_bytes', 'f.duration_ms'])
    .where('m.org_id', '=', orgId)
    .where('m.post_id', '=', postId)
    .orderBy('m.position')
    .execute();
  return rows.map((r) => ({ fileId: r.file_id, generation: r.generation, altText: r.alt_text, mime: r.content_type, sizeBytes: Number(r.size_bytes), durationMs: r.duration_ms === null ? null : Number(r.duration_ms) }));
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
  const content = effectiveContent(post, overrides(v), v.content_frozen ?? false);
  const media = mediaFor(post, v).map((m) => ({ fileId: m.fileId, generation: m.generation, altText: m.altText }));
  return contentHash([
    { channelConnectionId: v.channel_connection_id, provider: providerOf(v), body: content.body, title: content.title, linkUrl: content.linkUrl, media, settings: settingsOf(v) },
  ]);
}

export function issuesOf(post: PostContent, v: VariantRow): Issue[] {
  const content = effectiveContent(post, overrides(v), v.content_frozen);
  const media = mediaFor(post, v).map((m) => ({ kind: mediaKind(m.mime), mime: m.mime, sizeBytes: m.sizeBytes, durationSeconds: m.durationMs == null ? null : m.durationMs / 1000 }));
  return validateVariant({ provider: providerOf(v), body: content.body, title: content.title, media });
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
export const SLOT_FREED: readonly SocialVariantStatus[] = ['cancelled', 'published', 'failed'];
// Queued variants a queue edit may move: they have not been handed to the publisher.
export const MOVABLE: readonly SocialVariantStatus[] = ['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'paused'];

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
  return v.status === 'failed' ? { status: step(v, { type: 'edit' }), queue_slot_at: null, scheduled_at: null } : { status: step(v, { type: 'edit' }) };
}

// A variant becoming history keeps the content it had: copied into its own columns, which base edits no longer reach.
export function freezeValues(post: PostRow, v: VariantRow): Record<string, unknown> {
  const kept = effectiveContent(base(post), overrides(v), v.content_frozen);
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
