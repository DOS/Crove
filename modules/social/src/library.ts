// The media library (Social plan S9, issue #395): the org's post images, uploaded with purpose=social (#372), to reuse
// across posts, find by name and see where each is used. A library item is a crove_kernel.file row with source
// 'social'; an upload of the same bytes is the same file, so an image is in the library once.
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEDIA_TYPES: readonly string[] = [...SOCIAL_IMAGE_TYPES, ...SOCIAL_VIDEO_TYPES];
export const LIBRARY_PAGE = 60;

export interface LibraryItem {
  fileId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  // A video's duration; null for images.
  durationMs: number | null;
  createdAt: string;
  // Posts that show the image: in their own images or in a channel's own list.
  usedIn: number;
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

// Newest first, 60 a page; before is the last item of the previous page.
export const mediaList = defineQuery({
  name: 'social.media.list',
  input: z.object({
    search: z.string().trim().max(200).optional(),
    before: z.strictObject({ createdAt: z.iso.datetime({ offset: true }), fileId: zId }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  access: ALL,
  handler: async (ctx, input): Promise<{ items: LibraryItem[]; more: boolean }> => {
    const limit = input.limit ?? LIBRARY_PAGE;
    let q = ctx.trx
      .selectFrom('crove_kernel.file as f')
      .select(['f.id', 'f.filename', 'f.content_type', 'f.size_bytes', 'f.duration_ms', 'f.created_at', sql<string>`(SELECT count(*) FROM ${postsUsing} u)`.as('used_in')])
      .where('f.org_id', '=', ctx.orgId)
      .where('f.source', '=', 'social')
      .where('f.content_type', 'in', [...MEDIA_TYPES]);
    if (input.search) q = q.where(sql<boolean>`f.filename ILIKE ${likeTerm(input.search)}`);
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
        createdAt: r.created_at.toISOString(),
        usedIn: Number(r.used_in),
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

export const libraryQueries = [mediaList, mediaUsage];
