// Stock photos from Pexels in the media library (#1106). The API fetches the chosen photo through the egress guard and
// stores its bytes like an upload; this command then records the file and its credit in one transaction: the file
// row through kernel.file.ingest (source 'social', so the library lists it and extraction never reads it), and the
// photographer, the photo's page and its description in crove_social.media_attribution. Files are deduplicated by
// content, so saving the same bytes again finds the same file and keeps its first credit.
import { z } from 'zod';
import { SOCIAL_PHOTO_TYPES } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { STOCK_ALT_MAX, STOCK_NAME_MAX, pexelsPageUrl, stockText } from './domain/stock-photos.ts';

// Those who may add to the library.
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export const zStockCredit = z.strictObject({
  provider: z.literal('pexels'),
  externalId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  photographer: z.string().min(1).max(STOCK_NAME_MAX),
  // Pexels pages only: the library links to them.
  photographerUrl: z.string().refine((v) => pexelsPageUrl(v) === v, 'a page on pexels.com'),
  sourceUrl: z.string().refine((v) => pexelsPageUrl(v) === v, 'a page on pexels.com'),
  altText: z.string().min(1).max(STOCK_ALT_MAX).nullable(),
});
export type StockCredit = z.infer<typeof zStockCredit>;

// The stored bytes, as the API wrote them (kernel.file.ingest checks the key and the generation again).
const zStoredPhoto = z.strictObject({
  filename: z.string().min(1).max(255),
  contentType: z.enum(SOCIAL_PHOTO_TYPES as [string, ...string[]]),
  sizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageKey: z.string().min(1),
  generation: z.string().min(1),
  imageWidth: z.number().int().min(1).max(100_000).optional(),
  imageHeight: z.number().int().min(1).max(100_000).optional(),
});

export const mediaSaveStock = defineCommand({
  name: 'social.media.save_stock',
  input: z.strictObject({ file: zStoredPhoto, credit: zStockCredit }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  handler: async (ctx, input): Promise<{ fileId: string; duplicate: boolean; credited: boolean }> => {
    // The member who saved it, from the sealed context; never from the input.
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới lưu được ảnh vào thư viện');
    const userId = ctx.actor.userId;
    const { fileId, duplicate } = await ctx.run<{ fileId: string; duplicate: boolean }>('kernel.file.ingest', { ...input.file, source: 'social' });
    // The text is cleaned again here, whoever called: one line of plain text each.
    const photographer = stockText(input.credit.photographer, STOCK_NAME_MAX) ?? 'Pexels';
    const altText = stockText(input.credit.altText, STOCK_ALT_MAX);
    const inserted = await ctx.trx
      .insertInto('crove_social.media_attribution')
      .values({
        org_id: ctx.orgId,
        file_id: fileId,
        provider: input.credit.provider,
        external_id: input.credit.externalId,
        photographer,
        photographer_url: input.credit.photographerUrl,
        source_url: input.credit.sourceUrl,
        alt_text: altText,
        created_by: userId,
        created_at: ctx.now,
      })
      // The first credit of a file stays: the same bytes saved again, from any photo, change nothing.
      .onConflict((oc) => oc.columns(['org_id', 'file_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    ctx.audit({ file_id: fileId, provider: input.credit.provider, external_id: input.credit.externalId, credited: inserted !== undefined });
    return { fileId, duplicate, credited: inserted !== undefined };
  },
});

export const stockPhotoCommands = [mediaSaveStock];
