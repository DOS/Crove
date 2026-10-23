// The media library (Social plan S9, issue #395): the org's post images, uploaded with purpose=social (#372), to reuse
// across posts, find by name and see where each is used. A library item is a crove_kernel.file row with source
// 'social'; an upload of the same bytes is the same file, so an image is in the library once. Members tag files to
// find them again (#904, media-tags.ts).
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { normalizeMediaTag } from './domain/media-tags.ts';
import { channelScope, postInScope } from './channel-access.ts';

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

// LIKE wildcards in a search are matched as themselves.
export const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Newest first, 60 a page; before is the last item of the previous page. search matches the file name, tag one of
// its tags whatever the case (#904); both together narrow the list.
export const mediaList = defineQuery({
  name: 'social.media.list',
  input: z.object({
    search: z.string().trim().max(200).optional(),
    tag: z.string().max(200).transform(normalizeMediaTag).optional(),
    before: z.strictObject({ createdAt: z.iso.datetime({ offset: true }), fileId: zId }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  access: ALL,
  handler: async (ctx, input): Promise<{ items: LibraryItem[]; more: boolean }> => {
    const limit = input.limit ?? LIBRARY_PAGE;
    let q = ctx.trx
      .selectFrom('crove_kernel.file as f')
      .leftJoin('crove_social.media_attribution as a', (j) => j.onRef('a.org_id', '=', 'f.org_id').onRef('a.file_id', '=', 'f.id'))
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
      ])
      .where('f.org_id', '=', ctx.orgId)
      .where('f.source', '=', 'social')
      .where('f.content_type', 'in', [...LIBRARY_MEDIA_TYPES]);
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

export const libraryQueries = [mediaList, mediaUsage, mediaStored];
