// Labels for posts (issue #639): an org's own tags, such as a campaign, a client or a topic, each with a colour from
// the app's palette. Members create labels and put them on posts; owners and admins rename, recolour and delete them.
// A post's labels sort and filter the lists, the calendar and the metrics; they are not part of its content, so
// setting them never changes a revision, a content hash or an approval.
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_LABEL_COLORS, zId } from '@crove/kernel-contract';
import type { MemberRole, SocialLabelColor } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import type { Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const LABEL_LIMIT = 100;
export const MAX_LABELS_PER_POST = 10;

export interface Label {
  id: string;
  name: string;
  color: SocialLabelColor;
  createdBy: string;
  // How many posts carry it.
  postCount: number;
}

// NFC, so a name typed with combining marks matches the same name typed precomposed.
const zName = z
  .string()
  .trim()
  .transform((s) => s.normalize('NFC'))
  // The length the table checks is the normalized one: NFC can lengthen a few characters.
  .pipe(z.string().min(1).max(50));
const zColor = z.enum(SOCIAL_LABEL_COLORS);

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// One label write at a time per org, so the name and count checks below hold until the commit.
const lockOrg = (ctx: CommandContext) => sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.label:${ctx.orgId}`}))`.execute(ctx.trx);

// Compared as the unique index does (lower() in the database), whatever the client's casing rules.
async function nameFree(ctx: CommandContext, name: string, except?: string) {
  let q = ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where(sql<boolean>`lower(name) = lower(${name})`);
  if (except) q = q.where('id', '<>', except);
  if (await q.executeTakeFirst()) throw new DomainError('LABEL_NAME_TAKEN', 409, 'Đã có nhãn cùng tên', { name });
}

async function lockLabel(ctx: CommandContext, id: string) {
  const label = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!label) throw new DomainError('LABEL_NOT_FOUND', 404, 'Không tìm thấy nhãn này');
  return label;
}

export const labelCreate = defineCommand({
  name: 'social.label.create',
  input: z.strictObject({ name: zName, color: zColor.optional() }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    await lockOrg(ctx);
    const count = await ctx.trx.selectFrom('crove_social.label').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (Number(count.n) >= LABEL_LIMIT) throw new DomainError('LABEL_LIMIT', 409, `Mỗi tổ chức có tối đa ${LABEL_LIMIT} nhãn`);
    await nameFree(ctx, input.name);
    const row = await ctx.trx
      .insertInto('crove_social.label')
      .values({ org_id: ctx.orgId, name: input.name, color: input.color ?? 'gray', created_by: userId, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { labelId: row.id };
  },
});

export const labelUpdate = defineCommand({
  name: 'social.label.update',
  input: z.strictObject({ labelId: zId, name: zName, color: zColor }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const label = await lockLabel(ctx, input.labelId);
    await lockOrg(ctx);
    await nameFree(ctx, input.name, label.id);
    await ctx.trx.updateTable('crove_social.label').set({ name: input.name, color: input.color }).where('org_id', '=', ctx.orgId).where('id', '=', label.id).execute();
    return { labelId: label.id };
  },
});

// Takes the label off every post too (the foreign key cascades).
export const labelDelete = defineCommand({
  name: 'social.label.delete',
  input: z.strictObject({ labelId: zId }),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const label = await lockLabel(ctx, input.labelId);
    await ctx.trx.deleteFrom('crove_social.label').where('org_id', '=', ctx.orgId).where('id', '=', label.id).execute();
    return { labelId: label.id };
  },
});

// The post's labels become exactly labelIds (none clears them). Each must be a label of this org.
export const postSetLabels = defineCommand({
  name: 'social.post.set_labels',
  input: z.strictObject({
    postId: zId,
    labelIds: z
      .array(zId)
      .max(MAX_LABELS_PER_POST)
      .refine((ids) => new Set(ids).size === ids.length, 'labels repeat'),
  }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    // One change of a post's labels at a time; its content and revision are left alone.
    const post = await ctx.trx.selectFrom('crove_social.post').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.postId).forUpdate().executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
    if (input.labelIds.length > 0) {
      // Held until the commit, so a label deleted meanwhile waits instead of failing the insert below.
      const found = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', input.labelIds).forKeyShare().execute();
      if (found.length !== input.labelIds.length) throw new DomainError('LABEL_NOT_FOUND', 404, 'Có nhãn không tồn tại hoặc đã bị xóa');
    }
    const current = await ctx.trx.selectFrom('crove_social.post_label').select('label_id').where('org_id', '=', ctx.orgId).where('post_id', '=', post.id).execute();
    const have = new Set(current.map((r) => r.label_id));
    const want = new Set(input.labelIds);
    const gone = [...have].filter((id) => !want.has(id));
    const added = input.labelIds.filter((id) => !have.has(id));
    if (gone.length > 0) await ctx.trx.deleteFrom('crove_social.post_label').where('org_id', '=', ctx.orgId).where('post_id', '=', post.id).where('label_id', 'in', gone).execute();
    if (added.length > 0) {
      await ctx.trx
        .insertInto('crove_social.post_label')
        .values(added.map((labelId) => ({ org_id: ctx.orgId, post_id: post.id, label_id: labelId, created_at: ctx.now })))
        .execute();
    }
    return { postId: post.id, labelIds: input.labelIds };
  },
});

// The org's labels by name, with how many posts carry each.
export const labelList = defineQuery({
  name: 'social.label.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<Label[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_social.label as l')
      .leftJoin('crove_social.post_label as pl', (j) => j.onRef('pl.org_id', '=', 'l.org_id').onRef('pl.label_id', '=', 'l.id'))
      .select(['l.id', 'l.name', 'l.color', 'l.created_by', (eb) => eb.fn.count<string>('pl.id').as('posts')])
      .where('l.org_id', '=', ctx.orgId)
      .groupBy(['l.org_id', 'l.id'])
      .orderBy(sql`lower(l.name)`)
      .orderBy('l.id')
      .limit(LABEL_LIMIT)
      .execute();
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, createdBy: r.created_by, postCount: Number(r.posts) }));
  },
});

// The labels of each post, by label name: label ids for the post views, names for the metrics export.
export async function labelsOfPosts(trx: Trx, orgId: string, postIds: readonly string[]): Promise<Map<string, { id: string; name: string }[]>> {
  const out = new Map<string, { id: string; name: string }[]>();
  if (postIds.length === 0) return out;
  const rows = await trx
    .selectFrom('crove_social.post_label as pl')
    .innerJoin('crove_social.label as l', (j) => j.onRef('l.org_id', '=', 'pl.org_id').onRef('l.id', '=', 'pl.label_id'))
    .select(['pl.post_id', 'l.id', 'l.name'])
    .where('pl.org_id', '=', orgId)
    .where('pl.post_id', 'in', [...postIds])
    .orderBy(sql`lower(l.name)`)
    .orderBy('l.id')
    .execute();
  for (const r of rows) {
    const list = out.get(r.post_id) ?? [];
    list.push({ id: r.id, name: r.name });
    out.set(r.post_id, list);
  }
  return out;
}

export const labelCommands = [labelCreate, labelUpdate, labelDelete, postSetLabels];
export const labelQueries = [labelList];
