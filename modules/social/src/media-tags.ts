// Tags on media library files (issue #904): members tag the org's post images and videos by product, campaign or
// client brand, and the library filters by tag. crove_kernel.file never changes, so the tags live in
// crove_social.media_tag; they go with their file. A tag is normalized (trimmed, inner spaces collapsed, case kept),
// a file has each tag once whatever its case, and at most MAX_TAGS_PER_FILE.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { MAX_TAGS_PER_FILE, mediaTagProblem, normalizeMediaTag, normalizeMediaTags } from './domain/media-tags.ts';
import { LIBRARY_MEDIA_TYPES } from './library.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// Those who may upload to the library.
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// The tags the filter offers, most used first.
export const MEDIA_TAG_LIST_LIMIT = 200;

export interface MediaTagCount {
  tag: string;
  // How many library files carry it.
  files: number;
}

// One tag as typed, normalized; the length checked is the normalized one.
export const zMediaTag = z
  .string()
  .max(200)
  .transform(normalizeMediaTag)
  .superRefine((tag, ctx) => {
    const problem = mediaTagProblem(tag);
    if (problem) ctx.addIssue({ code: 'custom', message: `tag ${problem}` });
  });
// Several, each once (compared without case), the first spelling kept.
const zTags = z
  .array(zMediaTag)
  .min(1)
  .max(MAX_TAGS_PER_FILE)
  .transform((tags) => normalizeMediaTags(tags));

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// A file of the library (an image or a video uploaded for posts), held until the commit; one tag change per file at a
// time, so the count check below holds.
async function lockLibraryFile(ctx: CommandContext, fileId: string) {
  const file = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', fileId)
    .where('source', '=', 'social')
    .where('content_type', 'in', [...LIBRARY_MEDIA_TYPES])
    .forKeyShare()
    .executeTakeFirst();
  if (!file) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này trong thư viện');
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.media_tag:${ctx.orgId}:${file.id}`}))`.execute(ctx.trx);
  return file;
}

// A file's tags by name (case aside).
async function tagsOf(ctx: CommandContext, fileId: string): Promise<string[]> {
  const rows = await ctx.trx.selectFrom('crove_social.media_tag').select('tag').where('org_id', '=', ctx.orgId).where('file_id', '=', fileId).orderBy(sql`lower(tag)`).orderBy('tag').execute();
  return rows.map((r) => r.tag);
}

// Adds tags to a library file; a tag it already has (in any case) is left as it is.
export const mediaTag = defineCommand({
  name: 'social.media.tag',
  input: z.strictObject({ fileId: zId, tags: zTags }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input): Promise<{ fileId: string; tags: string[] }> => {
    const userId = requireUser(ctx);
    const file = await lockLibraryFile(ctx, input.fileId);
    // The tags the file does not have yet, each once, in the order given: compared as the unique index does (lower()
    // in the database), whatever the client's casing rules.
    const fresh = await sql<{ tag: string }>`
      SELECT d.tag FROM (
        SELECT DISTINCT ON (lower(t.tag)) t.tag, t.n FROM unnest(${input.tags}::text[]) WITH ORDINALITY AS t(tag, n)
        WHERE NOT EXISTS (
          SELECT 1 FROM crove_social.media_tag m WHERE m.org_id = ${ctx.orgId} AND m.file_id = ${file.id} AND lower(m.tag) = lower(t.tag)
        )
        ORDER BY lower(t.tag), t.n
      ) d
      ORDER BY d.n`.execute(ctx.trx);
    const added = fresh.rows.map((r) => r.tag);
    const count = await ctx.trx.selectFrom('crove_social.media_tag').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).where('file_id', '=', file.id).executeTakeFirstOrThrow();
    if (Number(count.n) + added.length > MAX_TAGS_PER_FILE) {
      throw new DomainError('MEDIA_TAG_LIMIT', 409, `Mỗi tệp gắn được tối đa ${MAX_TAGS_PER_FILE} thẻ`, { limit: MAX_TAGS_PER_FILE });
    }
    if (added.length > 0) {
      await ctx.trx
        .insertInto('crove_social.media_tag')
        .values(added.map((tag) => ({ org_id: ctx.orgId, file_id: file.id, tag, created_by: userId, created_at: ctx.now })))
        .execute();
    }
    ctx.audit({ file_id: file.id, added: added.length });
    return { fileId: file.id, tags: await tagsOf(ctx, file.id) };
  },
});

// Takes tags off a library file (compared without case); a tag it does not have is ignored.
export const mediaUntag = defineCommand({
  name: 'social.media.untag',
  input: z.strictObject({ fileId: zId, tags: zTags }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input): Promise<{ fileId: string; tags: string[] }> => {
    requireUser(ctx);
    const file = await lockLibraryFile(ctx, input.fileId);
    const done = await ctx.trx
      .deleteFrom('crove_social.media_tag')
      .where('org_id', '=', ctx.orgId)
      .where('file_id', '=', file.id)
      .where(sql<boolean>`lower(tag) IN (SELECT lower(t) FROM unnest(${input.tags}::text[]) AS t)`)
      .executeTakeFirst();
    ctx.audit({ file_id: file.id, removed: Number(done.numDeletedRows) });
    return { fileId: file.id, tags: await tagsOf(ctx, file.id) };
  },
});

// The org's tags with how many library files carry each, for the filter: most used first, then by name. Spellings
// that differ only in case are one tag, shown in its first spelling by name.
export const mediaTags = defineQuery({
  name: 'social.media.tags',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<MediaTagCount[]> => {
    const rows = await sql<{ tag: string; files: string }>`
      SELECT min(t.tag) AS tag, count(DISTINCT t.file_id) AS files
      FROM crove_social.media_tag t
      JOIN crove_kernel.file f ON f.org_id = t.org_id AND f.id = t.file_id
      WHERE t.org_id = ${ctx.orgId} AND f.source = 'social' AND f.content_type IN (${sql.join([...LIBRARY_MEDIA_TYPES])})
      GROUP BY lower(t.tag)
      ORDER BY count(DISTINCT t.file_id) DESC, lower(t.tag), min(t.tag)
      LIMIT ${MEDIA_TAG_LIST_LIMIT}`.execute(ctx.trx);
    return rows.rows.map((r) => ({ tag: r.tag, files: Number(r.files) }));
  },
});

export const mediaTagCommands = [mediaTag, mediaUntag];
export const mediaTagQueries = [mediaTags];
