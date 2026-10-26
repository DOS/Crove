// The org's logo watermark for post images (#834), as Publer and Later keep one: a logo from the Social library, a
// corner, a size and an opacity. The composer draws it on a copy of an image in the browser and uploads the copy as a
// new file, so the original stays untouched and nothing is drawn on the server. Owners and admins edit; everyone reads.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { SOCIAL_WATERMARK_CORNERS, type MemberRole, type SocialWatermarkCorner } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
// A logo keeps its transparency as PNG or WebP; a JPEG is allowed too, drawn as the rectangle it is.
export const WATERMARK_TYPES: readonly string[] = ['image/png', 'image/webp', 'image/jpeg'];

export const zWatermarkSave = z.strictObject({
  fileId: zId,
  corner: z.enum(SOCIAL_WATERMARK_CORNERS),
  // The logo's width as a share of the image's.
  scalePercent: z.number().int().min(5).max(50),
  opacityPercent: z.number().int().min(10).max(100),
});

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

async function lockWatermark(ctx: CommandContext) {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.watermark:${ctx.orgId}`}))`.execute(ctx.trx);
  return ctx.trx.selectFrom('crove_social.watermark').select('id').where('org_id', '=', ctx.orgId).orderBy('created_at').orderBy('id').execute();
}

export const watermarkSave = defineCommand({
  name: 'social.watermark.save',
  input: zWatermarkSave,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    // An image of the org's Social library, as a post's images are.
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select('content_type')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .where('source', '=', 'social')
      .executeTakeFirst();
    if (!file || !WATERMARK_TYPES.includes(file.content_type)) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này trong thư viện');
    const values = { file_id: input.fileId, corner: input.corner, scale_percent: input.scalePercent, opacity_percent: input.opacityPercent, updated_by: userId, updated_at: ctx.now };
    const existing = await lockWatermark(ctx);
    const first = existing[0];
    if (first) {
      await ctx.trx.updateTable('crove_social.watermark').set(values).where('org_id', '=', ctx.orgId).where('id', '=', first.id).execute();
    } else {
      await ctx.trx
        .insertInto('crove_social.watermark')
        .values({ org_id: ctx.orgId, ...values, created_at: ctx.now })
        .execute();
    }
    ctx.audit({ file_id: input.fileId });
    return { saved: true };
  },
});

export const watermarkRemove = defineCommand({
  name: 'social.watermark.remove',
  input: z.strictObject({}),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx) => {
    requireUser(ctx);
    const rows = await lockWatermark(ctx);
    if (rows.length > 0)
      await ctx.trx
        .deleteFrom('crove_social.watermark')
        .where('org_id', '=', ctx.orgId)
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
    ctx.audit({});
    return { removed: rows.length > 0 };
  },
});

export interface Watermark {
  fileId: string;
  mime: string;
  corner: SocialWatermarkCorner;
  scalePercent: number;
  opacityPercent: number;
  updatedAt: string;
}

// The org's watermark, or null when none is saved.
export const watermarkGet = defineQuery({
  name: 'social.watermark.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<Watermark | null> => {
    const row = await ctx.trx
      .selectFrom('crove_social.watermark as w')
      .innerJoin('crove_kernel.file as f', (j) => j.onRef('f.org_id', '=', 'w.org_id').onRef('f.id', '=', 'w.file_id'))
      .select(['w.file_id', 'f.content_type', 'w.corner', 'w.scale_percent', 'w.opacity_percent', 'w.updated_at'])
      .where('w.org_id', '=', ctx.orgId)
      .orderBy('w.created_at')
      .orderBy('w.id')
      .executeTakeFirst();
    if (!row) return null;
    return { fileId: row.file_id, mime: row.content_type, corner: row.corner, scalePercent: row.scale_percent, opacityPercent: row.opacity_percent, updatedAt: row.updated_at.toISOString() };
  },
});

export const watermarkCommands = [watermarkSave, watermarkRemove];
export const watermarkQueries = [watermarkGet];
