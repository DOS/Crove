// The ideas board (#701): ideas for posts before they are posts, as Buffer, Publer and Planable keep them. An idea has
// a title, an optional note and link, images or videos of the media library and labels, and moves through stages:
// new, planned, drafted (a draft was made from it) and archived. Members add, change and move ideas; viewers read.
// "Turn into a draft" opens the composer with the idea's text, link and media; the post it saves names the idea
// (social.post.create with ideaId), which links them, copies the idea's labels onto the post and moves the idea to
// drafted (linkIdeaToPost, called inside that command).
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_IDEA_STAGES, SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES, zId } from '@crove/kernel-contract';
import type { MemberRole, SocialIdeaStage } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MEDIA_TYPES: readonly string[] = [...SOCIAL_IMAGE_TYPES, ...SOCIAL_VIDEO_TYPES];
export const MAX_IDEA_FILES = 10;
export const MAX_IDEA_LABELS = 10;
// The most ideas a read returns per stage.
export const IDEA_LIST_LIMIT = 200;

const zTitle = z
  .string()
  .trim()
  .transform((s) => s.normalize('NFC'))
  .pipe(z.string().min(1).max(200));
const zNote = z
  .string()
  .trim()
  .transform((s) => s.normalize('NFC'))
  .pipe(z.string().max(5000))
  .transform((s) => (s === '' ? null : s));
const zLink = z.url({ protocol: /^https?$/ }).max(2000);
const zFiles = z
  .array(zId)
  .max(MAX_IDEA_FILES)
  .refine((ids) => new Set(ids).size === ids.length, 'each file once');
const zLabels = z
  .array(zId)
  .max(MAX_IDEA_LABELS)
  .refine((ids) => new Set(ids).size === ids.length, 'each label once');
const zFields = { title: zTitle, note: zNote.nullable().optional(), linkUrl: zLink.nullable().optional(), fileIds: zFiles.optional(), labelIds: zLabels.optional() };

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The org's own media library files (uploaded for Social), each once.
async function checkFiles(ctx: CommandContext, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select(['id', 'content_type'])
    .where('org_id', '=', ctx.orgId)
    .where('source', '=', 'social')
    .where('id', 'in', [...ids])
    .execute();
  const found = new Map(rows.map((r) => [r.id, r.content_type]));
  for (const id of ids) {
    const type = found.get(id);
    if (!type || !MEDIA_TYPES.includes(type)) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh hoặc video này trong thư viện', { fileId: id });
  }
}

async function setLabels(ctx: CommandContext, ideaId: string, labelIds: readonly string[]): Promise<void> {
  if (labelIds.length > 0) {
    const rows = await ctx.trx
      .selectFrom('crove_social.label')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', [...labelIds])
      .execute();
    if (rows.length !== labelIds.length) throw new DomainError('LABEL_NOT_FOUND', 404, 'Không tìm thấy nhãn này');
  }
  await ctx.trx.deleteFrom('crove_social.idea_label').where('org_id', '=', ctx.orgId).where('idea_id', '=', ideaId).execute();
  if (labelIds.length > 0) {
    await ctx.trx
      .insertInto('crove_social.idea_label')
      .values(labelIds.map((labelId) => ({ org_id: ctx.orgId, idea_id: ideaId, label_id: labelId, created_at: ctx.now })))
      .execute();
  }
}

async function lockIdea(ctx: CommandContext, id: string) {
  const idea = await ctx.trx
    .selectFrom('crove_social.idea')
    .select(['id', 'stage', 'post_id', 'title'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!idea) throw new DomainError('IDEA_NOT_FOUND', 404, 'Không tìm thấy ý tưởng này');
  return idea;
}

export const ideaCreate = defineCommand({
  name: 'social.idea.create',
  input: z.strictObject({ ...zFields, stage: z.enum(['new', 'planned']).optional() }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    await checkFiles(ctx, input.fileIds ?? []);
    const row = await ctx.trx
      .insertInto('crove_social.idea')
      .values({
        org_id: ctx.orgId,
        title: input.title,
        note: input.note ?? null,
        link_url: input.linkUrl ?? null,
        file_ids: input.fileIds ?? [],
        stage: input.stage ?? 'new',
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await setLabels(ctx, row.id, input.labelIds ?? []);
    ctx.audit({ idea_id: row.id });
    return { ideaId: row.id };
  },
});

export const ideaUpdate = defineCommand({
  name: 'social.idea.update',
  input: z.strictObject({ ideaId: zId, ...zFields }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.idea', id: input.ideaId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const idea = await lockIdea(ctx, input.ideaId);
    await checkFiles(ctx, input.fileIds ?? []);
    await ctx.trx
      .updateTable('crove_social.idea')
      .set({
        title: input.title,
        // A field left out stays as it is.
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.linkUrl !== undefined ? { link_url: input.linkUrl } : {}),
        ...(input.fileIds ? { file_ids: input.fileIds } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', idea.id)
      .execute();
    if (input.labelIds) await setLabels(ctx, idea.id, input.labelIds);
    return { ideaId: idea.id };
  },
});

// Moves an idea to another stage: new and planned while it is being planned, archived when it is dropped (and back).
// Drafted is reached only by making a draft from it.
export const ideaMove = defineCommand({
  name: 'social.idea.move',
  input: z.strictObject({ ideaId: zId, stage: z.enum(['new', 'planned', 'archived']) }),
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'social.idea', id: input.ideaId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const idea = await lockIdea(ctx, input.ideaId);
    // An idea with its draft stays drafted unless it is archived; its draft still says where it came from.
    if (idea.post_id && input.stage !== 'archived') throw new DomainError('IDEA_DRAFTED', 409, 'Ý tưởng này đã có bài nháp', { postId: idea.post_id });
    await ctx.trx.updateTable('crove_social.idea').set({ stage: input.stage, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', idea.id).execute();
    return { ideaId: idea.id, stage: input.stage };
  },
});

// Called by social.post.create when the post is made from an idea: the idea must still be waiting for its draft.
export async function linkIdeaToPost(ctx: CommandContext, ideaId: string, postId: string): Promise<void> {
  const idea = await lockIdea(ctx, ideaId);
  if (idea.post_id) throw new DomainError('IDEA_DRAFTED', 409, 'Ý tưởng này đã có bài nháp', { postId: idea.post_id });
  if (idea.stage === 'archived') throw new DomainError('IDEA_ARCHIVED', 409, 'Ý tưởng này đã được lưu trữ');
  await ctx.trx.updateTable('crove_social.idea').set({ stage: 'drafted', post_id: postId, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', idea.id).execute();
  // The idea's labels go onto its draft.
  await sql`
    INSERT INTO crove_social.post_label (org_id, post_id, label_id, created_at)
    SELECT org_id, ${postId}::uuid, label_id, ${ctx.now}::timestamptz FROM crove_social.idea_label
    WHERE org_id = ${ctx.orgId} AND idea_id = ${idea.id}
    ON CONFLICT (org_id, post_id, label_id) DO NOTHING`.execute(ctx.trx);
}

export interface IdeaMedia {
  fileId: string;
  mime: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}
export interface Idea {
  id: string;
  title: string;
  note: string | null;
  linkUrl: string | null;
  // The files still in the library, in the idea's order.
  media: IdeaMedia[];
  labelIds: string[];
  stage: SocialIdeaStage;
  postId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

type IdeaRow = {
  id: string;
  title: string;
  note: string | null;
  link_url: string | null;
  file_ids: string[];
  stage: SocialIdeaStage;
  post_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  label_ids: string[] | null;
};

async function toIdeas(ctx: { trx: CommandContext['trx']; orgId: string }, rows: IdeaRow[]): Promise<Idea[]> {
  const fileIds = [...new Set(rows.flatMap((r) => r.file_ids))];
  const files = new Map<string, IdeaMedia>();
  if (fileIds.length > 0) {
    const found = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'content_type', 'size_bytes', 'duration_ms', 'image_width', 'image_height'])
      .where('org_id', '=', ctx.orgId)
      .where('source', '=', 'social')
      .where('id', 'in', fileIds)
      .execute();
    for (const f of found) {
      files.set(f.id, { fileId: f.id, mime: f.content_type, sizeBytes: Number(f.size_bytes), durationMs: f.duration_ms === null ? null : Number(f.duration_ms), width: f.image_width, height: f.image_height });
    }
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    note: r.note,
    linkUrl: r.link_url,
    media: r.file_ids.map((id) => files.get(id)).filter((m): m is IdeaMedia => m !== undefined),
    labelIds: r.label_ids ?? [],
    stage: r.stage,
    postId: r.post_id,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

const IDEA_SELECT = sql`
  SELECT i.id, i.title, i.note, i.link_url, i.file_ids, i.stage, i.post_id, i.created_by, i.created_at, i.updated_at,
         (SELECT array_agg(l.label_id ORDER BY l.created_at, l.label_id) FROM crove_social.idea_label l WHERE l.org_id = i.org_id AND l.idea_id = i.id) AS label_ids
  FROM crove_social.idea i`;

// The board: the newest ideas of each stage (archived ones only when asked), optionally those with a label.
export const ideaList = defineQuery({
  name: 'social.idea.list',
  input: z.object({ archived: z.boolean().optional(), labelId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<{ ideas: Idea[]; truncated: boolean }> => {
    const stages: readonly SocialIdeaStage[] = input.archived ? ['archived'] : SOCIAL_IDEA_STAGES.filter((s) => s !== 'archived');
    const { rows } = await sql<IdeaRow & { n: string }>`
      SELECT * FROM (
        SELECT x.*, row_number() OVER (PARTITION BY x.stage ORDER BY x.updated_at DESC, x.id DESC) AS n FROM (${IDEA_SELECT}
          WHERE i.org_id = ${ctx.orgId} AND i.stage = ANY(${stages}::text[])
            ${input.labelId ? sql`AND EXISTS (SELECT 1 FROM crove_social.idea_label f WHERE f.org_id = i.org_id AND f.idea_id = i.id AND f.label_id = ${input.labelId})` : sql``}
        ) x
      ) y WHERE y.n <= ${IDEA_LIST_LIMIT + 1}
      ORDER BY y.updated_at DESC, y.id DESC`.execute(ctx.trx);
    const truncated = rows.some((r) => Number(r.n) > IDEA_LIST_LIMIT);
    return { ideas: await toIdeas(ctx, rows.filter((r) => Number(r.n) <= IDEA_LIST_LIMIT)), truncated };
  },
});

export const ideaGet = defineQuery({
  name: 'social.idea.get',
  input: z.object({ ideaId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<Idea> => {
    const { rows } = await sql<IdeaRow>`${IDEA_SELECT} WHERE i.org_id = ${ctx.orgId} AND i.id = ${input.ideaId}`.execute(ctx.trx);
    const [idea] = await toIdeas(ctx, rows);
    if (!idea) throw new DomainError('IDEA_NOT_FOUND', 404, 'Không tìm thấy ý tưởng này');
    return idea;
  },
});

// The idea a post was made from, for the post's page.
export async function ideaOfPost(trx: CommandContext['trx'], orgId: string, postId: string): Promise<{ id: string; title: string } | null> {
  const row = await trx.selectFrom('crove_social.idea').select(['id', 'title']).where('org_id', '=', orgId).where('post_id', '=', postId).executeTakeFirst();
  return row ?? null;
}

export const ideaCommands = [ideaCreate, ideaUpdate, ideaMove];
export const ideaQueries = [ideaList, ideaGet];
