// The size of a Social image uploaded before sizes were read at upload (#668), recorded once by the worker's backfill
// from the file's header. file_guard lets image_width and image_height go from null to a value once, in a system
// context; every other change of a file row stays refused.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { defineCommand } from '@crove/kernel-runtime';

export const recordImageSize = defineCommand({
  name: 'kernel.file.image_size.record',
  input: z.object({ fileId: zId, width: z.number().int().min(1).max(100_000), height: z.number().int().min(1).max(100_000) }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    // Only a Social image still without a size: a size already read (at upload or by an earlier pass) stays as it is.
    const { rows } = await sql<{ id: string }>`
      UPDATE crove_kernel.file SET image_width = ${input.width}, image_height = ${input.height}
      WHERE org_id = ${ctx.orgId} AND id = ${input.fileId} AND source = 'social'
        AND content_type IN ('image/jpeg', 'image/png', 'image/webp') AND image_width IS NULL AND image_height IS NULL
      RETURNING id`.execute(ctx.trx);
    return { recorded: rows.length > 0 };
  },
});

export const imageSizeCommands = [recordImageSize];
