// Saved snippets (issue #584): named text an org reuses in posts, such as hashtags, a signature, or a whole post to
// start from (a template). Members create them and change or delete their own; owners and admins any. The composer
// inserts one at the cursor; nothing about a snippet reaches a post until a person puts it in the text.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { isProvider } from './domain/channels.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const SNIPPET_LIMIT = 500;

export interface Snippet {
  id: string;
  name: string;
  body: string;
  provider: string | null;
  isTemplate: boolean;
  createdBy: string;
  updatedAt: string;
  // The viewer may change or delete it.
  mine: boolean;
}

// NFC, so a name typed with combining marks matches the same name typed precomposed.
const zName = z
  .string()
  .trim()
  .transform((s) => s.normalize('NFC'))
  // The length the table checks is the normalized one: NFC can lengthen a few characters.
  .pipe(z.string().min(1).max(100));
const zBody = z.string().trim().min(1).max(10_000);
const zProvider = z
  .string()
  .refine((p) => isProvider(p), 'unknown provider')
  .nullable();

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// One snippet write at a time per org, so the name and count checks below hold until the commit.
const lockOrg = (ctx: CommandContext) => sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.snippet:${ctx.orgId}`}))`.execute(ctx.trx);

// Compared as the unique index does (lower() in the database), whatever the client's casing rules.
async function nameFree(ctx: CommandContext, name: string, except?: string) {
  let q = ctx.trx.selectFrom('crove_social.snippet').select('id').where('org_id', '=', ctx.orgId).where(sql<boolean>`lower(name) = lower(${name})`);
  if (except) q = q.where('id', '<>', except);
  if (await q.executeTakeFirst()) throw new DomainError('SNIPPET_NAME_TAKEN', 409, 'Đã có đoạn mẫu cùng tên', { name });
}

// The snippet, locked, if the actor may change it: its creator, or an owner or admin.
async function own(ctx: CommandContext, id: string) {
  const userId = requireUser(ctx);
  const s = await ctx.trx.selectFrom('crove_social.snippet').select(['id', 'created_by']).where('org_id', '=', ctx.orgId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!s) throw new DomainError('SNIPPET_NOT_FOUND', 404, 'Không tìm thấy đoạn mẫu này');
  if (s.created_by !== userId && ctx.role !== 'owner' && ctx.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ người tạo, chủ sở hữu hoặc quản trị viên mới sửa được đoạn mẫu này');
  return s;
}

export const snippetCreate = defineCommand({
  name: 'social.snippet.create',
  input: z.strictObject({ name: zName, body: zBody, provider: zProvider.optional(), isTemplate: z.boolean().optional() }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    await lockOrg(ctx);
    const count = await ctx.trx.selectFrom('crove_social.snippet').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (Number(count.n) >= SNIPPET_LIMIT) throw new DomainError('SNIPPET_LIMIT', 409, `Mỗi tổ chức lưu tối đa ${SNIPPET_LIMIT} đoạn mẫu`);
    await nameFree(ctx, input.name);
    const row = await ctx.trx
      .insertInto('crove_social.snippet')
      .values({ org_id: ctx.orgId, name: input.name, body: input.body, provider: input.provider ?? null, is_template: input.isTemplate ?? false, created_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { snippetId: row.id };
  },
});

export const snippetUpdate = defineCommand({
  name: 'social.snippet.update',
  input: z.strictObject({ snippetId: zId, name: zName, body: zBody, provider: zProvider, isTemplate: z.boolean() }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const s = await own(ctx, input.snippetId);
    await lockOrg(ctx);
    await nameFree(ctx, input.name, s.id);
    await ctx.trx
      .updateTable('crove_social.snippet')
      .set({ name: input.name, body: input.body, provider: input.provider, is_template: input.isTemplate, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', s.id)
      .execute();
    return { snippetId: s.id };
  },
});

export const snippetDelete = defineCommand({
  name: 'social.snippet.delete',
  input: z.strictObject({ snippetId: zId }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const s = await own(ctx, input.snippetId);
    await ctx.trx.deleteFrom('crove_social.snippet').where('org_id', '=', ctx.orgId).where('id', '=', s.id).execute();
    return { snippetId: s.id };
  },
});

// The org's snippets by name; provider: those for that platform and those for any.
export const snippetList = defineQuery({
  name: 'social.snippet.list',
  input: z.object({ provider: z.string().max(32).optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<Snippet[]> => {
    let q = ctx.trx
      .selectFrom('crove_social.snippet')
      .select(['id', 'name', 'body', 'provider', 'is_template', 'created_by', 'updated_at'])
      .where('org_id', '=', ctx.orgId);
    if (input.provider) q = q.where((eb) => eb.or([eb('provider', 'is', null), eb('provider', '=', input.provider as string)]));
    const rows = await q.orderBy('name').limit(SNIPPET_LIMIT).execute();
    const viewer = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const admin = ctx.role === 'owner' || ctx.role === 'admin';
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      body: r.body,
      provider: r.provider,
      isTemplate: r.is_template,
      createdBy: r.created_by,
      updatedAt: r.updated_at.toISOString(),
      mine: ctx.role !== 'viewer' && (admin || r.created_by === viewer),
    }));
  },
});

export const snippetCommands = [snippetCreate, snippetUpdate, snippetDelete];
export const snippetQueries = [snippetList];
