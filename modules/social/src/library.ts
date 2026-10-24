// The media library (Social plan S9, issue #395): the org's post images, uploaded with purpose=social (#372), to reuse
// across posts, find by name and see where each is used. A library item is a crove_kernel.file row with source
// 'social'; an upload of the same bytes is the same file, so an image is in the library once. Members tag files to
// find them again (#904, media-tags.ts).
//
// The files a member may use (#1081, #1196, #1258): a member limited to some channels may not use another channel's own
// media, a file that only variants on other channels list as their own media, in no post's shared media and in no own
// media of a channel of theirs. mediaHidden says it in SQL for every reader and command that picks library files: the
// photo draft picker (social.media.list { usable }), the AI draft's photos, the CSV import's file names and the import
// itself. The library's list stays org-wide otherwise (#1099).
//
// Archived files (#1302): members take failed crops and rejected designs out of the library with social.media.archive
// and bring them back with social.media.restore, up to 100 at once. The mark lives in crove_social.media_archive, since
// crove_kernel.file never changes. An archived file leaves the library's list (shown only when asked for) and every
// picker; posts that already use it keep it, since publishing and previews read the file itself. Every command that
// attaches files refuses an archived file, and a file the member may not use, with 403 MEDIA_NOT_ALLOWED
// (refuseUnusableMedia, #1273): the post and variant create and edit, add channels, duplicate, drafts from media, the
// CSV import and the AI draft's photos; a file a post or channel already holds stays attached.
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { normalizeMediaTag } from './domain/media-tags.ts';
import { isFileId } from './domain/plan-csv.ts';
import { channelScope, postInScope, type ChannelScope } from './channel-access.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// The file types of the library: a social upload of another type is not one of its items.
export const LIBRARY_MEDIA_TYPES: readonly string[] = [...SOCIAL_IMAGE_TYPES, ...SOCIAL_VIDEO_TYPES];
export const LIBRARY_PAGE = 60;

export interface LibraryItem {
  fileId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  // A video's duration; null for images.
  durationMs: number | null;
  // An image's size as shown (#636); null when unknown.
  width: number | null;
  height: number | null;
  createdAt: string;
  // Posts that show the image: in their own images or in a channel's own list.
  usedIn: number;
  // Its tags (#904), by name.
  tags: string[];
  // Who took it and where it came from, for a photo saved from a stock photo site (#1106); null for an upload.
  credit: MediaCredit | null;
  // When it was archived (#1302); null for a file in the library.
  archivedAt: string | null;
}

// A stock photo's credit as Pexels gave it (#1106): shown under the image with links back, and its description offered
// as alt text. The text came from outside the org, so it is shown as text only.
export interface MediaCredit {
  provider: 'pexels';
  photographer: string;
  photographerUrl: string;
  sourceUrl: string;
  altText: string | null;
}

export interface LibraryUse {
  postId: string;
  status: string;
  excerpt: string;
  updatedAt: string;
}

// Posts of the org that show a file, as a subquery over the file row f.
const postsUsing = sql`(
  SELECT m.post_id FROM crove_social.post_media m WHERE m.org_id = f.org_id AND m.file_id = f.id
  UNION
  SELECT v.post_id FROM crove_social.post_variant v WHERE v.org_id = f.org_id AND v.media @> jsonb_build_array(jsonb_build_object('fileId', f.id::text))
)`;

// SQL over a file row (alias f by default): the file is another channel's own media only, for a member limited to some
// channels; FALSE for everyone else.
export function mediaHidden(scope: ChannelScope, alias = 'f'): RawBuilder<boolean> {
  if (scope === null) return sql<boolean>`FALSE`;
  const org = sql.ref(`${alias}.org_id`);
  const id = sql.ref(`${alias}.id`);
  const ids = [...scope];
  const own = (mine: boolean) =>
    sql`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = ${org} AND v.media @> jsonb_build_array(jsonb_build_object('fileId', ${id}::text)) AND ${
      mine ? sql`v.channel_connection_id = ANY(${ids}::uuid[])` : sql`NOT (v.channel_connection_id = ANY(${ids}::uuid[]))`
    })`;
  return sql<boolean>`(${own(false)} AND NOT EXISTS (SELECT 1 FROM crove_social.post_media m WHERE m.org_id = ${org} AND m.file_id = ${id}) AND NOT ${own(true)})`;
}

// SQL over a file row (alias f by default): the file is archived (#1302).
export function mediaArchived(alias = 'f'): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM crove_social.media_archive x WHERE x.org_id = ${sql.ref(`${alias}.org_id`)} AND x.file_id = ${sql.ref(`${alias}.id`)})`;
}

// Why a file may not be attached: another channel's own media (#1081), or archived (#1302).
export function mediaNotAllowed(fileId: string, reason: 'channel' | 'archived'): DomainError {
  const message = reason === 'archived' ? 'Ảnh này đã được lưu trữ; hãy khôi phục trong thư viện rồi dùng lại' : 'Ảnh này chỉ thuộc riêng một kênh bạn không được dùng';
  return new DomainError('MEDIA_NOT_ALLOWED', 403, message, { fileId, reason });
}

// Refuses a file of these that the caller may not attach, with 403 MEDIA_NOT_ALLOWED naming it (#1273): another
// channel's own media for a member limited to some channels (#1081), or an archived file (#1302). kept: the files the
// post or channel being changed already holds, which stay attached whatever their state.
export async function refuseUnusableMedia(ctx: Pick<CommandContext, 'trx' | 'orgId' | 'actor' | 'role'>, fileIds: readonly string[], kept: ReadonlySet<string> = new Set()): Promise<void> {
  const ids = [...new Set(fileIds)].filter((id) => !kept.has(id));
  if (ids.length === 0) return;
  const scope = await channelScope(ctx);
  const found = await ctx.trx
    .selectFrom('crove_kernel.file as f')
    .select(['f.id', mediaHidden(scope).as('hidden')])
    .where('f.org_id', '=', ctx.orgId)
    .where('f.id', 'in', ids)
    .where(sql<boolean>`(${mediaHidden(scope)} OR ${mediaArchived()})`)
    .orderBy('f.id')
    .executeTakeFirst();
  if (found) throw mediaNotAllowed(found.id, found.hidden ? 'channel' : 'archived');
}

// LIKE wildcards in a search are matched as themselves.
export const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Newest first, 60 a page; before is the last item of the previous page. search matches the file name, tag one of
// its tags whatever the case (#904); both together narrow the list. usable leaves out the files the caller may not use
// (#1196), for the pickers that attach or send them. Archived files (#1302) are left out, or listed alone with
// archived (never with usable).
export const mediaList = defineQuery({
  name: 'social.media.list',
  input: z.object({
    search: z.string().trim().max(200).optional(),
    tag: z.string().max(200).transform(normalizeMediaTag).optional(),
    before: z.strictObject({ createdAt: z.iso.datetime({ offset: true }), fileId: zId }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    usable: z.boolean().optional(),
    archived: z.boolean().optional(),
  }),
  access: ALL,
  handler: async (ctx, input): Promise<{ items: LibraryItem[]; more: boolean }> => {
    const limit = input.limit ?? LIBRARY_PAGE;
    let q = ctx.trx
      .selectFrom('crove_kernel.file as f')
      .leftJoin('crove_social.media_attribution as a', (j) => j.onRef('a.org_id', '=', 'f.org_id').onRef('a.file_id', '=', 'f.id'))
      .leftJoin('crove_social.media_archive as x', (j) => j.onRef('x.org_id', '=', 'f.org_id').onRef('x.file_id', '=', 'f.id'))
      .select([
        'f.id',
        'f.filename',
        'f.content_type',
        'f.size_bytes',
        'f.duration_ms',
        'f.image_width',
        'f.image_height',
        'f.created_at',
        sql<string>`(SELECT count(*) FROM ${postsUsing} u)`.as('used_in'),
        sql<string[]>`ARRAY(SELECT t.tag FROM crove_social.media_tag t WHERE t.org_id = f.org_id AND t.file_id = f.id ORDER BY lower(t.tag), t.tag)`.as('tags'),
        'a.provider',
        'a.photographer',
        'a.photographer_url',
        'a.source_url',
        'a.alt_text',
        'x.archived_at',
      ])
      .where('f.org_id', '=', ctx.orgId)
      .where('f.source', '=', 'social')
      .where('f.content_type', 'in', [...LIBRARY_MEDIA_TYPES])
      .where('x.id', input.archived && !input.usable ? 'is not' : 'is', null);
    if (input.usable) q = q.where(sql<boolean>`NOT ${mediaHidden(await channelScope(ctx))}`);
    if (input.search) q = q.where(sql<boolean>`f.filename ILIKE ${likeTerm(input.search)}`);
    if (input.tag) {
      const tag = input.tag;
      q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM crove_social.media_tag t WHERE t.org_id = f.org_id AND t.file_id = f.id AND lower(t.tag) = lower(${tag}))`);
    }
    if (input.before) {
      const at = new Date(Date.parse(input.before.createdAt));
      q = q.where(sql<boolean>`(f.created_at, f.id) < (${at}, ${input.before.fileId}::uuid)`);
    }
    const rows = await q
      .orderBy('f.created_at', 'desc')
      .orderBy('f.id', 'desc')
      .limit(limit + 1)
      .execute();
    return {
      items: rows.slice(0, limit).map((r) => ({
        fileId: r.id,
        filename: r.filename,
        mime: r.content_type,
        sizeBytes: Number(r.size_bytes),
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
        width: r.image_width,
        height: r.image_height,
        createdAt: r.created_at.toISOString(),
        usedIn: Number(r.used_in),
        tags: r.tags,
        credit:
          r.provider === null || r.photographer === null || r.photographer_url === null || r.source_url === null
            ? null
            : { provider: r.provider, photographer: r.photographer, photographerUrl: r.photographer_url, sourceUrl: r.source_url, altText: r.alt_text },
        archivedAt: r.archived_at === null ? null : r.archived_at.toISOString(),
      })),
      more: rows.length > limit,
    };
  },
});

// The posts that show an image, newest first (50 at most).
export const mediaUsage = defineQuery({
  name: 'social.media.usage',
  input: z.object({ fileId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<LibraryUse[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_social.post as p')
      .select(['p.id', 'p.status', 'p.body', 'p.updated_at'])
      .where('p.org_id', '=', ctx.orgId)
      // A member limited to some channels (#1081) sees the posts they may see.
      .where(postInScope(await channelScope(ctx)))
      .where((eb) =>
        eb.or([
          eb.exists(eb.selectFrom('crove_social.post_media as m').select('m.id').whereRef('m.org_id', '=', 'p.org_id').whereRef('m.post_id', '=', 'p.id').where('m.file_id', '=', input.fileId)),
          eb.exists(
            eb
              .selectFrom('crove_social.post_variant as v')
              .select('v.id')
              .whereRef('v.org_id', '=', 'p.org_id')
              .whereRef('v.post_id', '=', 'p.id')
              .where(sql<boolean>`v.media @> jsonb_build_array(jsonb_build_object('fileId', ${input.fileId}::text))`),
          ),
        ]),
      )
      .orderBy('p.updated_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((r) => ({ postId: r.id, status: r.status, excerpt: r.body.replace(/\s+/g, ' ').trim().slice(0, 160), updatedAt: r.updated_at.toISOString() }));
  },
});

// One file of the library as stored, for an AI alt text suggestion (#1121): only the org's own Social uploads, so an
// accounting document is never sent to the model whatever its type. The caller checks the type and the size.
export const mediaStored = defineQuery({
  name: 'social.media.stored',
  input: z.strictObject({ fileId: zId }),
  access: MEMBERS,
  handler: async (ctx, input): Promise<{ storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: number }> => {
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['storage_key', 'generation', 'sha256', 'content_type', 'size_bytes'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .where('source', '=', 'social')
      .executeTakeFirst();
    if (!file) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này');
    return { storageKey: file.storage_key, generation: file.generation, sha256: file.sha256, contentType: file.content_type, sizeBytes: Number(file.size_bytes) };
  },
});

// The photos an AI draft is written from (#1191), as stored, in the order asked: only the org's own Social uploads, as
// for alt text. A member limited to some channels (#1081) may not use a channel's own media they cannot see: a file
// that only variants on other channels list as their own media, in no post's shared media and in no own media of a
// channel of theirs, is refused with 403 MEDIA_NOT_ALLOWED, and so is an archived file (#1302). The caller checks the
// types and the sizes.
export const mediaDraftImages = defineQuery({
  name: 'social.media.draft_images',
  input: z.strictObject({ fileIds: z.array(zId).min(1).max(4) }),
  access: MEMBERS,
  handler: async (ctx, input): Promise<{ fileId: string; storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: number }[]> => {
    const scope = await channelScope(ctx);
    const rows = await ctx.trx
      .selectFrom('crove_kernel.file as f')
      .select([
        'f.id',
        'f.storage_key',
        'f.generation',
        'f.sha256',
        'f.content_type',
        'f.size_bytes',
        mediaHidden(scope).as('hidden'),
        mediaArchived().as('archived'),
      ])
      .where('f.org_id', '=', ctx.orgId)
      .where('f.id', 'in', [...new Set(input.fileIds)])
      .where('f.source', '=', 'social')
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return input.fileIds.map((fileId) => {
      const file = byId.get(fileId);
      if (!file) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này', { fileId });
      if (file.hidden) throw mediaNotAllowed(fileId, 'channel');
      if (file.archived) throw mediaNotAllowed(fileId, 'archived');
      return { fileId, storageKey: file.storage_key, generation: file.generation, sha256: file.sha256, contentType: file.content_type, sizeBytes: Number(file.size_bytes) };
    });
  },
});

// A library file as the CSV import shows and attaches it.
export interface ResolvedMedia {
  fileId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}
export type MediaRefProblem = 'UNKNOWN_FILE' | 'AMBIGUOUS_FILE' | 'FILE_NOT_ALLOWED';

// The library files a CSV import's media cells name (#1258): a file id, or a file name whatever the case (NFC, so a
// name saved by a Mac matches one typed). A name finds the one file of the library by that name the caller may use;
// several such files are AMBIGUOUS_FILE (the export writes an id then), and a name or an id that only finds another
// channel's own media (#1081) or an archived file (#1302) is FILE_NOT_ALLOWED. The import command checks the files
// again.
export const mediaResolve = defineQuery({
  name: 'social.media.resolve',
  input: z.strictObject({ refs: z.array(z.string().trim().min(1).max(255)).min(1).max(200) }),
  access: MEMBERS,
  handler: async (ctx, input): Promise<{ ref: string; file: ResolvedMedia | null; problem: MediaRefProblem | null }[]> => {
    const scope = await channelScope(ctx);
    const keyOf = (ref: string) => (isFileId(ref) ? ref.toLowerCase() : ref.normalize('NFC').toLowerCase());
    const ids = [...new Set(input.refs.filter(isFileId).map((r) => r.toLowerCase()))];
    const names = [...new Set(input.refs.filter((r) => !isFileId(r)).map(keyOf))];
    const rows = await ctx.trx
      .selectFrom('crove_kernel.file as f')
      .select([
        'f.id',
        'f.filename',
        'f.content_type',
        'f.size_bytes',
        'f.duration_ms',
        'f.image_width',
        'f.image_height',
        sql<string>`lower(normalize(f.filename, NFC))`.as('name_key'),
        mediaHidden(scope).as('hidden'),
        mediaArchived().as('archived'),
      ])
      .where('f.org_id', '=', ctx.orgId)
      .where('f.source', '=', 'social')
      .where('f.content_type', 'in', [...LIBRARY_MEDIA_TYPES])
      .where((eb) =>
        eb.or([
          ...(ids.length > 0 ? [eb('f.id', 'in', ids)] : []),
          ...(names.length > 0 ? [sql<boolean>`lower(normalize(f.filename, NFC)) = ANY(${names}::text[])`] : []),
        ]),
      )
      .orderBy('f.created_at', 'desc')
      .execute();
    return input.refs.map((ref) => {
      const key = keyOf(ref);
      const found = rows.filter((r) => (isFileId(ref) ? r.id === key : r.name_key === key));
      const usable = found.filter((r) => !r.hidden && !r.archived);
      if (usable.length === 1) {
        const f = usable[0] as (typeof usable)[number];
        return {
          ref,
          file: { fileId: f.id, filename: f.filename, mime: f.content_type, sizeBytes: Number(f.size_bytes), durationMs: f.duration_ms === null ? null : Number(f.duration_ms), width: f.image_width, height: f.image_height },
          problem: null,
        };
      }
      return { ref, file: null, problem: usable.length > 1 ? 'AMBIGUOUS_FILE' : found.length > 0 ? 'FILE_NOT_ALLOWED' : 'UNKNOWN_FILE' };
    });
  },
});

export const libraryQueries = [mediaList, mediaUsage, mediaStored, mediaDraftImages, mediaResolve];
