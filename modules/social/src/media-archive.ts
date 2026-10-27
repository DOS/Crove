// Archived media library files (issue #1302): members take failed crops and rejected designs out of the library and its
// pickers, up to MEDIA_ARCHIVE_MAX at once, and bring them back. crove_kernel.file never changes, so the mark lives in
// crove_social.media_archive, one per file. An archived file stays stored: posts that already use it keep it, and the
// library lists it again on restore. Members and above, on files they may use (#1081: a member limited to some
// channels neither archives nor restores another channel's own media). What an archived file may no longer do is in
// library.ts (refuseUnusableMedia).
import { z } from 'zod';
import { SOCIAL_MEDIA_ARCHIVE_MAX, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { channelScope } from './channel-access.ts';
import { LIBRARY_MEDIA_TYPES, mediaHidden, mediaNotAllowed } from './library.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const MEDIA_ARCHIVE_MAX = SOCIAL_MEDIA_ARCHIVE_MAX;

const zFileIds = z
  .array(zId)
  .min(1)
  .max(MEDIA_ARCHIVE_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'each file once');

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The library files named (images, videos and documents of the org uploaded for Social), held until the commit; each
// must be one, and one the caller may use. Nothing is written when one is not.
async function lockLibraryFiles(ctx: CommandContext, fileIds: readonly string[]): Promise<void> {
  const scope = await channelScope(ctx);
  const rows = await ctx.trx
    .selectFrom('crove_kernel.file as f')
    .select(['f.id', mediaHidden(scope).as('hidden')])
    .where('f.org_id', '=', ctx.orgId)
    .where('f.id', 'in', [...fileIds])
    .where('f.source', '=', 'social')
    .where('f.content_type', 'in', [...LIBRARY_MEDIA_TYPES])
    .orderBy('f.id')
    .forKeyShare()
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const fileId of fileIds) {
    const file = byId.get(fileId);
    if (!file) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này trong thư viện', { fileId });
    if (file.hidden) throw mediaNotAllowed(fileId, 'channel');
  }
}

// Takes files out of the library and its pickers. A file already archived is left as it was (its first archive kept);
// archived lists the ones this command archived, in the order given.
export const mediaArchive = defineCommand({
  name: 'social.media.archive',
  input: z.strictObject({ fileIds: zFileIds }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  handler: async (ctx, input): Promise<{ archived: string[] }> => {
    const userId = requireUser(ctx);
    await lockLibraryFiles(ctx, input.fileIds);
    const done = await ctx.trx
      .insertInto('crove_social.media_archive')
      .values(input.fileIds.map((fileId) => ({ org_id: ctx.orgId, file_id: fileId, archived_by: userId, archived_at: ctx.now })))
      .onConflict((oc) => oc.columns(['org_id', 'file_id']).doNothing())
      .returning('file_id')
      .execute();
    const fresh = new Set(done.map((r) => r.file_id));
    const archived = input.fileIds.filter((id) => fresh.has(id));
    ctx.audit({ files: input.fileIds.length, archived: archived.length, file_ids: archived });
    return { archived };
  },
});

// Brings archived files back to the library and its pickers. A file not archived is left as it was; restored lists the
// ones this command brought back, in the order given.
export const mediaRestore = defineCommand({
  name: 'social.media.restore',
  input: z.strictObject({ fileIds: zFileIds }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  handler: async (ctx, input): Promise<{ restored: string[] }> => {
    requireUser(ctx);
    await lockLibraryFiles(ctx, input.fileIds);
    const done = await ctx.trx.deleteFrom('crove_social.media_archive').where('org_id', '=', ctx.orgId).where('file_id', 'in', [...input.fileIds]).returning('file_id').execute();
    const back = new Set(done.map((r) => r.file_id));
    const restored = input.fileIds.filter((id) => back.has(id));
    ctx.audit({ files: input.fileIds.length, restored: restored.length, file_ids: restored });
    return { restored };
  },
});

export const mediaArchiveCommands = [mediaArchive, mediaRestore];
