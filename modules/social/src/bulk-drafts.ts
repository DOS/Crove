// One draft per image or video from the library (#1080), as Publer's bulk media upload and Hootsuite's bulk composer
// turn a designer's batch of files into posts. All or none, in one transaction:
// - every file is checked against every chosen channel first (the size, length, shape and kind rules of
//   validateVariant, on the file alone); when one does not fit, the answer lists each file with its problems and
//   nothing is saved;
// - otherwise each file becomes one draft, in the order given, through social.post.create as a nested command, so each
//   draft has its own audit row, event and timeline entry as one made by hand;
// - with queue, each draft holds the next free slot of each channel's queue, in file order. A draft holding a slot is
//   still reviewed as usual; nothing goes out before an approval and a schedule.
// Lock order: the queue rows (sorted by connection) before any post, as social.variant.schedule takes them.
import { z } from 'zod';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES, zSocialDraftsFromMedia, type zSocialDraftsFromMediaResult } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { captionFromFilename, fileIssues } from './domain/bulk-drafts.ts';
import { nextFreeSlot } from './domain/queue.ts';
import { validateVariant, type MediaItem } from './domain/validate.ts';
import { lockQueue, mediaKind, providerOf, setVariant, takenSlots, type QueueState } from './variants.ts';
import { refuseChannels } from './channel-access.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MEDIA_TYPES: readonly string[] = [...SOCIAL_IMAGE_TYPES, ...SOCIAL_VIDEO_TYPES];

export type DraftsFromMediaResult = z.infer<typeof zSocialDraftsFromMediaResult>;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// A saved set's channels still connected, in the order saved.
async function setChannels(ctx: CommandContext, setId: string): Promise<string[]> {
  const set = await ctx.trx.selectFrom('crove_social.channel_set').select('connection_ids').where('org_id', '=', ctx.orgId).where('id', '=', setId).executeTakeFirst();
  if (!set) throw new DomainError('CHANNEL_SET_NOT_FOUND', 404, 'Không tìm thấy bộ kênh này');
  return set.connection_ids;
}

// The org's live connections among ids, in their order; every id must be one.
async function liveChannels(ctx: CommandContext, ids: readonly string[], fromSet: boolean): Promise<Array<{ id: string; provider: ReturnType<typeof providerOf> }>> {
  const rows = ids.length === 0 ? [] : await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['id', 'provider']).where('org_id', '=', ctx.orgId).where('id', 'in', [...ids]).where('status', '<>', 'revoked').execute();
  const byId = new Map(rows.map((r) => [r.id, r.provider]));
  // A set drops the channels disconnected since it was saved, as the composer shows it; channels named one by one
  // must all be live.
  const kept = fromSet ? ids.filter((id) => byId.has(id)) : ids;
  if (kept.length === 0 || kept.some((id) => !byId.has(id))) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
  return kept.map((id) => ({ id, provider: providerOf({ provider: byId.get(id) as string }) }));
}

interface LibraryFile {
  id: string;
  filename: string;
  item: MediaItem;
}

// The files named, in their order: each an image or a video of the org uploaded for Social.
async function libraryFiles(ctx: CommandContext, ids: readonly string[]): Promise<LibraryFile[]> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select(['id', 'filename', 'content_type', 'size_bytes', 'source', 'duration_ms', 'image_width', 'image_height'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...ids])
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const f = byId.get(id);
    // Only files uploaded for posts: an accounting document of the org is never published, whatever its type.
    if (!f || f.source !== 'social') throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này', { fileId: id });
    if (!MEDIA_TYPES.includes(f.content_type)) throw new DomainError('MEDIA_TYPE_UNSUPPORTED', 422, 'Bài đăng chỉ nhận ảnh JPG, PNG, WEBP và video MP4, MOV', { fileId: id });
    return {
      id: f.id,
      filename: f.filename,
      item: {
        kind: mediaKind(f.content_type),
        mime: f.content_type,
        sizeBytes: Number(f.size_bytes),
        durationSeconds: f.duration_ms === null ? null : Number(f.duration_ms) / 1000,
        width: f.image_width ?? null,
        height: f.image_height ?? null,
      },
    };
  });
}

export const postCreateFromMedia = defineCommand({
  name: 'social.post.create_from_media',
  input: zSocialDraftsFromMedia,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input): Promise<DraftsFromMediaResult> => {
    requireUser(ctx);
    const channels = await liveChannels(ctx, input.channelSetId ? await setChannels(ctx, input.channelSetId) : (input.connectionIds ?? []), input.channelSetId !== undefined);
    // A member limited to some channels (#1081) makes drafts for those only, a channel set's included; refused before
    // any queue is locked or post made.
    await refuseChannels(
      ctx,
      channels.map((c) => c.id),
    );
    // The queues first, before any post: social.variant.schedule and social.queue.set take them in the same order.
    const queues = new Map<string, QueueState>();
    if (input.queue) {
      for (const c of [...channels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const queue = await lockQueue(ctx.trx, ctx.orgId, c.id);
        if (!queue || queue.spec.slots.length === 0) throw new DomainError('QUEUE_EMPTY', 409, 'Kênh này chưa có khung giờ đăng trong hàng đợi', { connectionId: c.id });
        queues.set(c.id, queue);
      }
    }
    const files = await libraryFiles(ctx, input.fileIds);
    const caption = input.caption ?? { kind: 'none' as const };
    let snippet = '';
    if (caption.kind === 'snippet') {
      const row = await ctx.trx.selectFrom('crove_social.snippet').select('body').where('org_id', '=', ctx.orgId).where('id', '=', caption.snippetId).executeTakeFirst();
      if (!row) throw new DomainError('SNIPPET_NOT_FOUND', 404, 'Không tìm thấy đoạn mẫu này');
      snippet = row.body;
    }
    const bodies = files.map((f) => (caption.kind === 'filename' ? captionFromFilename(f.filename) : snippet));

    // Every file against every channel, before anything is written.
    const invalid = files
      .map((f, i) => ({
        fileId: f.id,
        issues: channels.flatMap((c) =>
          fileIssues(validateVariant({ provider: c.provider, body: bodies[i] as string, title: null, media: [f.item], settings: {} })).map((issue) => ({ connectionId: c.id, provider: c.provider, ...issue })),
        ),
      }))
      .filter((f) => f.issues.length > 0);
    if (invalid.length > 0) {
      ctx.audit({ files: files.length, channels: channels.length, invalid_files: invalid.map((f) => f.fileId) });
      return { status: 'invalid', files: invalid };
    }

    // The next free slots of each queue, file by file, all found before the first draft is made.
    const slots = new Map<string, number[]>();
    for (const [connectionId, queue] of queues) {
      const taken = await takenSlots(ctx.trx, ctx.orgId, connectionId);
      const list: number[] = [];
      for (let i = 0; i < files.length; i++) {
        const at = nextFreeSlot(queue.spec, ctx.now.getTime(), taken);
        if (at === null) throw new DomainError('QUEUE_FULL', 409, 'Hàng đợi của kênh này đã kín trong năm tới', { connectionId });
        taken.add(at);
        list.push(at);
      }
      slots.set(connectionId, list);
    }

    const posts: Extract<DraftsFromMediaResult, { status: 'created' }>['posts'] = [];
    for (const [i, f] of files.entries()) {
      const created = await ctx.run<{ postId: string; variants: Array<{ variantId: string; connectionId: string }> }>('social.post.create', {
        body: bodies[i],
        media: [{ fileId: f.id }],
        channels: channels.map((c) => ({ connectionId: c.id })),
      });
      const variants: Array<{ variantId: string; connectionId: string; queueSlotAt: string | null }> = [];
      for (const v of created.variants) {
        const at = slots.get(v.connectionId)?.[i];
        if (at !== undefined) await setVariant(ctx, v.variantId, { queue_slot_at: new Date(at) });
        variants.push({ variantId: v.variantId, connectionId: v.connectionId, queueSlotAt: at === undefined ? null : new Date(at).toISOString() });
      }
      posts.push({ fileId: f.id, postId: created.postId, variants });
    }
    ctx.audit({
      files: files.length,
      channels: channels.length,
      post_ids: posts.map((p) => p.postId),
      caption: caption.kind,
      queued: queues.size > 0,
      ...(input.channelSetId ? { channel_set_id: input.channelSetId } : {}),
    });
    return { status: 'created', posts };
  },
});

export const bulkDraftCommands = [postCreateFromMedia];
