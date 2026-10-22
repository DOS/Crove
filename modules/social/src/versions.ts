// The version history of a post (#1021): every save that changes a post's content appends the content it left, in the
// save's own transaction, under the post's row lock; the newest MAX_VERSIONS_PER_POST stay. social.post.versions lists
// them for the post page, and social.post.restore_version (posts.ts) saves one again as a new edit.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { MAX_VERSIONS_PER_POST, contentKey, sameSnapshot, snapshotContentKey, variantContent, versionMedia, versionNumbers, versionVariants, type VersionContent, type VersionSnapshot } from './domain/versions.ts';
import type { Trx } from './variants.ts';
import { channelScope, postsInScope, variantsInScope } from './channel-access.ts';
import { tickedOf, type TickedCheck } from './review-checklist.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The newest approvals of a post the versions are matched with (#1105).
const APPROVALS_SHOWN = 200;

export interface SavedState {
  snapshot: VersionSnapshot;
  revision: number;
  updatedAt: Date;
}

// A post's content as its rows hold it now: the base text, link and images, and each channel's own columns.
export async function readSnapshot(trx: Trx, orgId: string, postId: string): Promise<SavedState> {
  const post = await trx.selectFrom('crove_social.post').select(['body', 'title', 'link_url', 'revision', 'updated_at']).where('org_id', '=', orgId).where('id', '=', postId).executeTakeFirst();
  if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
  const media = await trx.selectFrom('crove_social.post_media').select(['file_id', 'alt_text']).where('org_id', '=', orgId).where('post_id', '=', postId).orderBy('position').execute();
  const variants = await trx
    .selectFrom('crove_social.post_variant')
    .select(['id', 'channel_connection_id', 'provider', 'body', 'title', 'link_url', 'settings', 'media', 'content_frozen'])
    .where('org_id', '=', orgId)
    .where('post_id', '=', postId)
    .orderBy('position')
    .orderBy('id')
    .execute();
  return {
    revision: post.revision,
    updatedAt: post.updated_at,
    snapshot: {
      body: post.body,
      title: post.title,
      linkUrl: post.link_url,
      media: media.map((m) => ({ fileId: m.file_id, altText: m.alt_text })),
      variants: variants.map((v) => ({
        variantId: v.id,
        connectionId: v.channel_connection_id,
        provider: v.provider,
        body: v.body,
        title: v.title,
        linkUrl: v.link_url,
        settings: v.settings !== null && typeof v.settings === 'object' && !Array.isArray(v.settings) ? (v.settings as Record<string, unknown>) : {},
        media: Array.isArray(v.media) ? versionMedia(v.media) : null,
        contentFrozen: v.content_frozen,
      })),
    },
  };
}

const versionRow = (orgId: string, postId: string, state: SavedState, number: number, createdBy: string | null, createdAt: Date) => ({
  org_id: orgId,
  post_id: postId,
  number,
  revision: state.revision,
  body: state.snapshot.body,
  title: state.snapshot.title,
  link_url: state.snapshot.linkUrl,
  media: JSON.stringify(state.snapshot.media),
  variants: JSON.stringify(state.snapshot.variants),
  created_by: createdBy,
  created_at: createdAt,
});

// Appends the post's content as the save left it, when it differs from the content before the save. A post with no
// version yet first keeps the content before (number 1, no author, dated when the post last changed). The caller holds
// the post's row lock, so numbers never race; versions past the newest MAX_VERSIONS_PER_POST are deleted here.
export async function recordVersion(ctx: CommandContext, postId: string, before: SavedState): Promise<number | null> {
  const after = await readSnapshot(ctx.trx, ctx.orgId, postId);
  if (sameSnapshot(before.snapshot, after.snapshot)) return null;
  const latest = await ctx.trx
    .selectFrom('crove_social.post_version')
    .select((eb) => eb.fn.max('number').as('n'))
    .where('org_id', '=', ctx.orgId)
    .where('post_id', '=', postId)
    .executeTakeFirst();
  const { baseline, next, pruneUpTo } = versionNumbers(latest?.n ?? null);
  const author = ctx.actor.type === 'user' ? ctx.actor.userId : null;
  const rows = [...(baseline === null ? [] : [versionRow(ctx.orgId, postId, before, baseline, null, before.updatedAt)]), versionRow(ctx.orgId, postId, after, next, author, ctx.now)];
  await ctx.trx.insertInto('crove_social.post_version').values(rows).execute();
  if (pruneUpTo > 0) {
    await ctx.trx.deleteFrom('crove_social.post_version').where('org_id', '=', ctx.orgId).where('post_id', '=', postId).where('number', '<=', pruneUpTo).execute();
  }
  return next;
}

// Runs a save of a post whose row lock the caller holds, and appends a version when the save changed its content.
export async function withVersion<T>(ctx: CommandContext, postId: string, save: () => Promise<T>): Promise<T> {
  const before = await readSnapshot(ctx.trx, ctx.orgId, postId);
  const result = await save();
  await recordVersion(ctx, postId, before);
  return result;
}

export interface VersionContentView extends Omit<VersionContent, 'media'> {
  // mime: null for a file the org no longer has.
  media: Array<{ fileId: string; altText: string | null; mime: string | null }>;
}

// An approval given to a version's content of a channel, with the review checklist items its reviewer ticked (#1105).
export interface VersionApproval {
  decidedBy: string;
  decidedByName: string | null;
  at: string;
  checklist: TickedCheck[] | null;
}

export interface VersionView {
  id: string;
  number: number;
  revision: number;
  createdAt: string;
  // null for the content a post had before its first saved version.
  createdBy: string | null;
  createdByName: string | null;
  // Per channel of the version, what it showed: its effective text, link, images and settings; and the approvals given
  // to that content, oldest first.
  variants: Array<{ variantId: string; content: VersionContentView; approvals: VersionApproval[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A post's versions, newest first (at most MAX_VERSIONS_PER_POST, all a post keeps). Whoever may read the post may
// read them; it changes nothing.
export const postVersions = defineQuery({
  name: 'social.post.versions',
  input: z.strictObject({ postId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<{ postId: string; versions: VersionView[] }> => {
    const post = await ctx.trx.selectFrom('crove_social.post').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.postId).executeTakeFirst();
    if (!post) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
    // A member limited to some channels (#1081) reads the versions of a post they may see, with those channels only.
    const scope = await channelScope(ctx);
    if ((await postsInScope(ctx, scope, [post.id])).length === 0) throw new DomainError('POST_NOT_FOUND', 404, 'Không tìm thấy bài đăng này');
    const rows = await ctx.trx
      .selectFrom('crove_social.post_version')
      .select(['id', 'number', 'revision', 'body', 'title', 'link_url', 'media', 'variants', 'created_by', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', post.id)
      .orderBy('number', 'desc')
      .limit(MAX_VERSIONS_PER_POST)
      .execute();
    const saved = rows.map((r) => ({ row: r, variants: versionVariants(r.variants) }));
    const shown = scope === null ? null : await variantsInScope(ctx, scope, [...new Set(saved.flatMap((s) => s.variants.map((v) => v.variantId)))]);
    const versions = saved.map(({ row: r, variants }) => {
      const snapshot = { body: r.body, title: r.title, linkUrl: r.link_url, media: versionMedia(r.media) };
      return { row: r, variants: variants.filter((v) => shown === null || shown.has(v.variantId)).map((v) => ({ variantId: v.variantId, content: variantContent(snapshot, v) })) };
    });
    // The type of each file a version names, to show a removed video as a video.
    const fileIds = [...new Set(versions.flatMap((v) => v.variants.flatMap((x) => x.content.media.map((m) => m.fileId))).filter((id) => UUID.test(id)))];
    const mimes = new Map(
      fileIds.length === 0 ? [] : (await ctx.trx.selectFrom('crove_kernel.file').select(['id', 'content_type']).where('org_id', '=', ctx.orgId).where('id', 'in', fileIds).execute()).map((f) => [f.id, f.content_type]),
    );
    // The approvals of the channels shown (#1105), matched with a version by the content they were given to: the
    // snapshot an approval keeps, compared with the version's content of that channel.
    const approvalRows = await ctx.trx
      .selectFrom('crove_social.post_approval')
      .select(['id', 'variant_id', 'decided_by', 'created_at', 'snapshot', 'checklist'])
      .where('org_id', '=', ctx.orgId)
      .where('post_id', '=', post.id)
      .where('decision', '=', 'approved')
      .orderBy('id', 'desc')
      .limit(APPROVALS_SHOWN)
      .execute();
    const approvalsOf = new Map<string, Array<{ key: string; decidedBy: string; at: string; checklist: TickedCheck[] | null }>>();
    for (const a of [...approvalRows].reverse()) {
      if (shown !== null && !shown.has(a.variant_id)) continue;
      const list = approvalsOf.get(a.variant_id) ?? [];
      list.push({ key: snapshotContentKey(a.snapshot), decidedBy: a.decided_by, at: a.created_at.toISOString(), checklist: tickedOf(a.checklist) });
      approvalsOf.set(a.variant_id, list);
    }
    // Names while they are members (crove_kernel.member_profiles answers only members of the org).
    const people = [...new Set([...rows.map((r) => r.created_by), ...approvalRows.map((a) => a.decided_by)].filter((id): id is string => id !== null))];
    const names = new Map<string, string>();
    if (people.length > 0) {
      const { rows: profiles } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${people}::uuid[])`.execute(ctx.trx);
      for (const p of profiles) names.set(p.user_id, p.display_name ?? p.email);
    }
    return {
      postId: post.id,
      versions: versions.map(({ row, variants }) => ({
        id: row.id,
        number: row.number,
        revision: row.revision,
        createdAt: row.created_at.toISOString(),
        createdBy: row.created_by,
        createdByName: row.created_by === null ? null : (names.get(row.created_by) ?? null),
        variants: variants.map((v) => {
          const key = contentKey(v.content);
          const approvals = (approvalsOf.get(v.variantId) ?? [])
            .filter((a) => a.key === key)
            .map((a) => ({ decidedBy: a.decidedBy, decidedByName: names.get(a.decidedBy) ?? null, at: a.at, checklist: a.checklist }));
          return { variantId: v.variantId, content: { ...v.content, media: v.content.media.map((m) => ({ ...m, mime: mimes.get(m.fileId) ?? null })) }, approvals };
        }),
      })),
    };
  },
});

export const versionQueries = [postVersions];
