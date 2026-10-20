// A saved brand voice for AI drafts (#741), as Buffer, Hootsuite and Publer keep one: how the org's posts should sound,
// or one channel's. AI drafting and rewriting (packages/agent social.ts) use the channel's voice, else the org's,
// unless the member types a tone for that request. Owners and admins edit; everyone reads. The voice reaches the model
// as data about style, fenced like the brief, never as instructions.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

const zWord = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((s) => s.replace(/\s+/g, ' '));
export const zBrandVoiceSave = z.strictObject({
  // Absent or null: the org's voice.
  connectionId: zId.nullable().optional(),
  description: z.string().trim().min(1).max(600),
  useWords: z.array(zWord).max(20),
  avoidWords: z.array(zWord).max(20),
  emoji: z.boolean(),
});

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

async function lockVoice(ctx: CommandContext, connectionId: string | null) {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.brand_voice:${ctx.orgId}:${connectionId ?? 'org'}`}))`.execute(ctx.trx);
  let q = ctx.trx.selectFrom('crove_social.brand_voice').select('id').where('org_id', '=', ctx.orgId);
  q = connectionId ? q.where('channel_connection_id', '=', connectionId) : q.where('channel_connection_id', 'is', null);
  return q.orderBy('created_at').orderBy('id').execute();
}

export const brandVoiceSave = defineCommand({
  name: 'social.brand_voice.save',
  input: zBrandVoiceSave,
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const connectionId = input.connectionId ?? null;
    if (connectionId) {
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', connectionId).where('status', '<>', 'revoked').executeTakeFirst();
      if (!found) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh này');
    }
    const values = {
      description: input.description,
      use_words: [...new Set(input.useWords)],
      avoid_words: [...new Set(input.avoidWords)],
      emoji: input.emoji,
      updated_by: userId,
      updated_at: ctx.now,
    };
    const existing = await lockVoice(ctx, connectionId);
    const first = existing[0];
    if (first) {
      await ctx.trx.updateTable('crove_social.brand_voice').set(values).where('org_id', '=', ctx.orgId).where('id', '=', first.id).execute();
    } else {
      await ctx.trx
        .insertInto('crove_social.brand_voice')
        .values({ org_id: ctx.orgId, channel_connection_id: connectionId, ...values, created_at: ctx.now })
        .execute();
    }
    ctx.audit({ connection_id: connectionId });
    return { connectionId };
  },
});

export const brandVoiceRemove = defineCommand({
  name: 'social.brand_voice.remove',
  input: z.strictObject({ connectionId: zId.nullable().optional() }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const connectionId = input.connectionId ?? null;
    const rows = await lockVoice(ctx, connectionId);
    if (rows.length > 0)
      await ctx.trx
        .deleteFrom('crove_social.brand_voice')
        .where('org_id', '=', ctx.orgId)
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
    ctx.audit({ connection_id: connectionId });
    return { connectionId, removed: rows.length > 0 };
  },
});

export interface BrandVoice {
  connectionId: string | null;
  description: string;
  useWords: string[];
  avoidWords: string[];
  emoji: boolean;
  updatedAt: string;
}

// The org's voice and each channel's, the org's first.
export const brandVoiceList = defineQuery({
  name: 'social.brand_voice.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<BrandVoice[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_social.brand_voice')
      .select(['channel_connection_id', 'description', 'use_words', 'avoid_words', 'emoji', 'updated_at', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const seen = new Set<string>();
    const out: BrandVoice[] = [];
    for (const r of rows) {
      const key = r.channel_connection_id ?? '';
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ connectionId: r.channel_connection_id, description: r.description, useWords: r.use_words, avoidWords: r.avoid_words, emoji: r.emoji, updatedAt: r.updated_at.toISOString() });
    }
    return out.sort((a, b) => (a.connectionId === null ? -1 : b.connectionId === null ? 1 : a.connectionId.localeCompare(b.connectionId)));
  },
});

// A voice as one line of notes for the model.
export function voiceNotes(v: Pick<BrandVoice, 'description' | 'useWords' | 'avoidWords' | 'emoji'>): string {
  const parts = [v.description.replace(/\s+/g, ' ').trim()];
  if (v.useWords.length > 0) parts.push(`Words to use: ${v.useWords.join(', ')}`);
  if (v.avoidWords.length > 0) parts.push(`Words to avoid: ${v.avoidWords.join(', ')}`);
  parts.push(v.emoji ? 'Emoji are fine.' : 'No emoji.');
  return parts.join('. ').slice(0, 1200);
}

export const brandVoiceCommands = [brandVoiceSave, brandVoiceRemove];
export const brandVoiceQueries = [brandVoiceList];
