// The cover check a channel's settings edit runs (social.post.create, social.variant.update), shared with
// social.post.bulk_replace, which leaves a post out instead of refusing the whole command.
import { zId } from '@crove/kernel-contract';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import { COVER_IMAGE_MAX_BYTES, COVER_IMAGE_TYPES, coverOf, isProvider } from './domain/channels.ts';

// What checkCover would refuse, without throwing: social.post.bulk_replace leaves such a post out before it edits
// anything (#1144), since a channel's settings edit checks its cover again.
export async function coverProblem(ctx: Pick<CommandContext, 'trx' | 'orgId'>, provider: string, settings: Record<string, unknown> | undefined): Promise<DomainError | null> {
  if (settings?.cover === undefined) return null;
  const cover = coverOf(settings);
  if (!cover) return new DomainError('COVER_INVALID', 422, 'Ảnh bìa phải là một thời điểm trong video hoặc một ảnh');
  if (!('fileId' in cover)) return null;
  // Stored in the lower case ids are kept in, so the hash and the worker's lookup see one spelling.
  (settings.cover as { fileId: string }).fileId = cover.fileId;
  const file = zId.safeParse(cover.fileId).success
    ? await ctx.trx.selectFrom('crove_kernel.file').select(['source', 'content_type', 'size_bytes']).where('org_id', '=', ctx.orgId).where('id', '=', cover.fileId).executeTakeFirst()
    : undefined;
  // Only images uploaded for posts, as for the post's media.
  if (!file || file.source !== 'social') return new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh bìa này');
  if (!COVER_IMAGE_TYPES.includes(file.content_type)) return new DomainError('COVER_TYPE_UNSUPPORTED', 422, 'Ảnh bìa phải là ảnh JPG hoặc PNG');
  const max = isProvider(provider) ? COVER_IMAGE_MAX_BYTES[provider] : undefined;
  if (max !== undefined && Number(file.size_bytes) > max) {
    return new DomainError('COVER_TOO_LARGE', 422, `Ảnh bìa cho kênh này tối đa ${Math.floor(max / 1_048_576)} MB`, { limit: max, actual: Number(file.size_bytes) });
  }
  return null;
}
