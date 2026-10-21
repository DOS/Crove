// AI calls for the usage report (#852): each draft, rewrite, alt text or hashtag suggestion the writer was asked
// for leaves one audit row (social.ai.use, with its kind), which crove_kernel.usage_weekly counts. The API records it
// after the model answered or failed; nothing else reads it.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { defineCommand } from '@crove/kernel-runtime';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const AI_USE_KINDS = ['draft', 'rewrite', 'alt_text', 'hashtags'] as const;

export const aiUse = defineCommand({
  name: 'social.ai.use',
  input: z.strictObject({ kind: z.enum(AI_USE_KINDS) }),
  risk: 'R1',
  access: WRITERS,
  handler: async (ctx, input) => {
    ctx.audit({ kind: input.kind });
    return { recorded: true };
  },
});

export const aiUsageCommands = [aiUse];
