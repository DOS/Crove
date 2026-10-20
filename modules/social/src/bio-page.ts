// An org's link-in-bio page (#707), as Later (Linkin.bio), Buffer (Start Page) and Metricool (SmartLinks) give one:
// the one link an Instagram or TikTok bio allows, at PUBLIC_URL/b/<slug>. A title, a short about, an avatar from the
// media library, up to 12 buttons and a grid of recent published image posts, each counted when clicked (bio_click,
// through the page's definer). Owners and admins edit it; everyone in the org sees it and its clicks. The public page
// is drawn by the kernel from the definers, with nothing of the org beyond what the page shows.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const MAX_BIO_BUTTONS = 12;
export const BIO_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
// Paths of the app and the API a slug may not look like (they share the origin, under /b/ but read by people).
const RESERVED = new Set(['admin', 'api', 'app', 'crove', 'help', 'login', 'new', 'settings', 'support']);

const zText = (max: number) =>
  z
    .string()
    .trim()
    .transform((s) => s.normalize('NFC'))
    .pipe(z.string().max(max));
export const zBioSave = z.strictObject({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(BIO_SLUG)
    .refine((s) => !RESERVED.has(s), 'reserved'),
  title: zText(100).pipe(z.string().min(1)),
  about: zText(300).nullable().optional(),
  avatarFileId: zId.nullable().optional(),
  buttons: z.array(z.strictObject({ label: zText(60).pipe(z.string().min(1)), url: z.url({ protocol: /^https?$/ }).max(2000) })).max(MAX_BIO_BUTTONS),
  showPosts: z.boolean(),
  published: z.boolean(),
});

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

export const bioSave = defineCommand({
  name: 'social.bio.save',
  input: zBioSave,
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    if (input.avatarFileId) {
      const file = await ctx.trx
        .selectFrom('crove_kernel.file')
        .select('content_type')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.avatarFileId)
        .where('source', '=', 'social')
        .executeTakeFirst();
      if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.content_type)) throw new DomainError('MEDIA_NOT_FOUND', 404, 'Không tìm thấy ảnh này trong thư viện');
    }
    const values = {
      slug: input.slug,
      title: input.title,
      about: input.about || null,
      avatar_file_id: input.avatarFileId ?? null,
      buttons: JSON.stringify(input.buttons),
      show_posts: input.showPosts,
      published: input.published,
      updated_at: ctx.now,
    };
    // One page per org: saves are taken one at a time, and a second save changes the page the first made.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.bio_page:${ctx.orgId}`}))`.execute(ctx.trx);
    const existing = await ctx.trx.selectFrom('crove_social.bio_page').select('id').where('org_id', '=', ctx.orgId).orderBy('created_at').orderBy('id').executeTakeFirst();
    const write = existing
      ? ctx.trx.updateTable('crove_social.bio_page').set(values).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).returning('id')
      : ctx.trx.insertInto('crove_social.bio_page').values({ org_id: ctx.orgId, ...values, created_by: userId, created_at: ctx.now }).returning('id');
    const row = await write
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        if ((error as { constraint?: string }).constraint === 'bio_page_slug_uq') throw new DomainError('BIO_SLUG_TAKEN', 409, 'Địa chỉ này đã có trang khác dùng', { slug: input.slug });
        throw error;
      });
    ctx.audit({ page_id: row.id, slug: input.slug, published: input.published });
    return { pageId: row.id, slug: input.slug };
  },
});

export interface BioPage {
  id: string;
  slug: string;
  title: string;
  about: string | null;
  avatarFileId: string | null;
  buttons: { label: string; url: string }[];
  showPosts: boolean;
  published: boolean;
  updatedAt: string;
  // Clicks of the last 30 days, by button:<index> or post:<id>.
  clicks: Record<string, number>;
}

export const bioGet = defineQuery({
  name: 'social.bio.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<BioPage | null> => {
    const page = await ctx.trx
      .selectFrom('crove_social.bio_page')
      .select(['id', 'slug', 'title', 'about', 'avatar_file_id', 'buttons', 'show_posts', 'published', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
    if (!page) return null;
    const { rows } = await sql<{ target: string; clicks: string }>`
      SELECT target, sum(clicks) AS clicks FROM crove_social.bio_click
      WHERE org_id = ${ctx.orgId} AND page_id = ${page.id} AND day > (pg_catalog.now() AT TIME ZONE 'UTC')::date - 30
      GROUP BY target`.execute(ctx.trx);
    const buttons = (Array.isArray(page.buttons) ? page.buttons : []) as { label?: unknown; url?: unknown }[];
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      about: page.about,
      avatarFileId: page.avatar_file_id,
      buttons: buttons.filter((b) => typeof b.label === 'string' && typeof b.url === 'string').map((b) => ({ label: b.label as string, url: b.url as string })),
      showPosts: page.show_posts,
      published: page.published,
      updatedAt: page.updated_at.toISOString(),
      clicks: Object.fromEntries(rows.map((r) => [r.target, Number(r.clicks)])),
    };
  },
});

export const bioCommands = [bioSave];
export const bioQueries = [bioGet];
