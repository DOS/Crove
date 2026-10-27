// Channel sets for the composer (#774, research §2: Postiz's "sets and signatures"; signatures are snippets, #584): a
// saved group of channels, picked in one click and still editable after. Owners and admins save and remove them;
// everyone reads. A channel disconnected later drops out of its sets when they are read.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const CHANNEL_SET_MAX = 20;
// The most sets an org keeps.
export const CHANNEL_SETS_MAX = 50;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

export const channelSetSave = defineCommand({
  name: 'social.channel_set.save',
  input: z.strictObject({
    // Absent: a new set.
    setId: zId.optional(),
    name: z.string().trim().min(1).max(80),
    connectionIds: z.array(zId).min(1).max(CHANNEL_SET_MAX),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const ids = [...new Set(input.connectionIds)];
    const live = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', ids)
      .where('status', '<>', 'revoked')
      .execute();
    if (live.length !== ids.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
    const name = input.name.replace(/\s+/g, ' ');
    // One save at a time per org, so the name check and the count below hold against saves at the same moment.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.channel_set:${ctx.orgId}`}))`.execute(ctx.trx);
    const clash = await ctx.trx
      .selectFrom('crove_social.channel_set')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      // lower() on both sides, so the check agrees with the unique index whatever the collation.
      .where((w) => w(w.fn('lower', ['name']), '=', w.fn('lower', [w.val(name)])))
      .executeTakeFirst();
    if (clash && clash.id !== input.setId) throw new DomainError('CHANNEL_SET_NAME_TAKEN', 409, 'Đã có bộ kênh tên này');
    const values = { name, connection_ids: ids, updated_by: userId, updated_at: ctx.now };
    if (input.setId) {
      const done = await ctx.trx.updateTable('crove_social.channel_set').set(values).where('org_id', '=', ctx.orgId).where('id', '=', input.setId).executeTakeFirst();
      if (Number(done.numUpdatedRows) === 0) throw new DomainError('CHANNEL_SET_NOT_FOUND', 404, 'Không tìm thấy bộ kênh này');
      ctx.audit({ set_id: input.setId, channels: ids.length });
      return { setId: input.setId };
    }
    const count = await ctx.trx.selectFrom('crove_social.channel_set').select((e) => e.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (Number(count?.n ?? 0) >= CHANNEL_SETS_MAX) throw new DomainError('CHANNEL_SETS_FULL', 409, `Mỗi tổ chức lưu tối đa ${CHANNEL_SETS_MAX} bộ kênh`);
    const row = await ctx.trx
      .insertInto('crove_social.channel_set')
      .values({ org_id: ctx.orgId, ...values, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ set_id: row.id, channels: ids.length });
    return { setId: row.id };
  },
});

export const channelSetRemove = defineCommand({
  name: 'social.channel_set.remove',
  input: z.strictObject({ setId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const done = await ctx.trx.deleteFrom('crove_social.channel_set').where('org_id', '=', ctx.orgId).where('id', '=', input.setId).executeTakeFirst();
    ctx.audit({ set_id: input.setId });
    return { setId: input.setId, removed: Number(done.numDeletedRows) > 0 };
  },
});

export interface ChannelSet {
  id: string;
  name: string;
  // Its channels still connected, in the order saved.
  connectionIds: string[];
  updatedAt: string;
}

// The org's sets by name, each with the channels still connected.
export const channelSetList = defineQuery({
  name: 'social.channel_set.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<ChannelSet[]> => {
    const rows = await ctx.trx.selectFrom('crove_social.channel_set').select(['id', 'name', 'connection_ids', 'updated_at']).where('org_id', '=', ctx.orgId).orderBy('name').limit(CHANNEL_SETS_MAX).execute();
    const all = [...new Set(rows.flatMap((r) => r.connection_ids))];
    const live = new Set(
      all.length === 0
        ? []
        : (await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', all).where('status', '<>', 'revoked').execute()).map((c) => c.id),
    );
    return rows.map((r) => ({ id: r.id, name: r.name, connectionIds: r.connection_ids.filter((id) => live.has(id)), updatedAt: r.updated_at.toISOString() }));
  },
});

export const channelSetCommands = [channelSetSave, channelSetRemove];
export const channelSetQueries = [channelSetList];
