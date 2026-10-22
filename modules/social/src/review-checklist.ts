// The review checklist (#1105), as Planable and Sprout let a team say what a reviewer must check before approving
// (spelling, the brand name, the legal line, the link works). Owners and admins keep up to SOCIAL_REVIEW_CHECKS_MAX
// short items for the org: for every channel, or for one channel. A variant's checklist is the org-wide items and its
// channel's, in (position, id) order.
//
// Rules:
// - social.review_check.set (owners and admins, R2, audited) replaces the whole list under a per-org advisory lock, so
//   two saves at once never leave a mix of both and the cap counts org-wide and channel items together (a variant's
//   list never exceeds the cap that post_approval.checklist's CHECK allows). Every save makes new items: an approval
//   with ticks of the list before it is refused as changed.
// - social.variant.decide with 'approved' takes only the ids a reviewer ticked per variant. In its transaction it
//   reads the current list of each variant's channel (under the same lock, shared), refuses an id not on that list
//   (409 CHECKLIST_CHANGED) and an approval without every item ticked (422 CHECKLIST_INCOMPLETE), and stores the items
//   as [{ id, label }] copied from the database, never a label from the client. A request for changes or a rejection
//   needs no ticks and stores NULL; so does an approval on a channel without a checklist, as before #1105.
// - Approvals that complete on their own (a lowered approval count, the client's answer on a review link) add no
//   decision row and ask nothing: they complete on approvals already given, which ticked the list as it was then (or
//   none, when they came before it), as posts already approved stay approved. Client review links are not asked.
// - Every member reads the list (social.review_check.list); a member limited to some channels (#1081) sees the
//   org-wide items and those channels' items only.
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_REVIEW_CHECKS_MAX, SOCIAL_REVIEW_CHECK_LABEL_MAX, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { channelScope } from './channel-access.ts';
import type { Trx } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

export interface ReviewCheck {
  id: string;
  // null: every channel.
  connectionId: string | null;
  position: number;
  label: string;
}

// An item as an approval keeps it.
export interface TickedCheck {
  id: string;
  label: string;
}

// The label as the person typed it, in NFC with its white space collapsed; at most SOCIAL_REVIEW_CHECK_LABEL_MAX
// characters (code points, as the database counts them).
const zLabel = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/gu, ' ').trim())
  .pipe(z.string().min(1))
  .refine((s) => [...s].length <= SOCIAL_REVIEW_CHECK_LABEL_MAX, `at most ${SOCIAL_REVIEW_CHECK_LABEL_MAX} characters`);

export const zReviewChecklistSet = z.strictObject({
  items: z
    .array(z.strictObject({ connectionId: zId.nullable(), label: zLabel }))
    .max(SOCIAL_REVIEW_CHECKS_MAX)
    .refine((items) => new Set(items.map((i) => `${i.connectionId?.toLowerCase() ?? ''}\u0000${i.label}`)).size === items.length, 'each item once per channel'),
});

const lockKey = (orgId: string) => `crove_social.review_check:${orgId}`;
// One save at a time per org (exclusive); an approval reads the list under the shared lock, so a save waits for the
// approvals in progress and an approval never reads half a save.
const lockList = (ctx: Pick<CommandContext, 'trx' | 'orgId'>) => sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey(ctx.orgId)}, 0))`.execute(ctx.trx);
const lockListShared = (ctx: Pick<CommandContext, 'trx' | 'orgId'>) => sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(${lockKey(ctx.orgId)}, 0))`.execute(ctx.trx);

/** The org's items, in (position, id) order. */
export async function reviewChecksOf(trx: Trx, orgId: string): Promise<ReviewCheck[]> {
  const rows = await trx
    .selectFrom('crove_social.review_check')
    .select(['id', 'channel_connection_id', 'position', 'label'])
    .where('org_id', '=', orgId)
    .orderBy('position')
    .orderBy('id')
    .limit(SOCIAL_REVIEW_CHECKS_MAX)
    .execute();
  return rows.map((r) => ({ id: r.id, connectionId: r.channel_connection_id, position: r.position, label: r.label }));
}

/** A channel's checklist: the org-wide items and the channel's, in order. */
export const checklistFor = (checks: readonly ReviewCheck[], connectionId: string): ReviewCheck[] => checks.filter((c) => c.connectionId === null || c.connectionId === connectionId);

/**
 * The items an approval of a variant keeps: every item of its channel's checklist, which the reviewer must all have
 * ticked, copied from the list; null when the channel has none. Refuses a ticked id not on the list (the list changed
 * since the reviewer loaded it) and a list not wholly ticked.
 */
export function tickedChecklist(checks: readonly ReviewCheck[], variant: { id: string; channel_connection_id: string }, ticked: readonly string[] | undefined): TickedCheck[] | null {
  const list = checklistFor(checks, variant.channel_connection_id);
  const ids = new Set((ticked ?? []).map((id) => id.toLowerCase()));
  const known = new Set(list.map((c) => c.id));
  const unknown = [...ids].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new DomainError('CHECKLIST_CHANGED', 409, 'Danh sách kiểm tra đã đổi sau khi bạn mở bài; hãy xem lại danh sách rồi duyệt', { variantId: variant.id, unknown });
  }
  const missing = list.filter((c) => !ids.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    throw new DomainError('CHECKLIST_INCOMPLETE', 422, 'Hãy đánh dấu đủ mọi mục trong danh sách kiểm tra trước khi duyệt', { variantId: variant.id, missing });
  }
  return list.length === 0 ? null : list.map((c) => ({ id: c.id, label: c.label }));
}

/** The org's current list for an approval, read under the shared lock so no save is half seen. */
export async function checklistForApproval(ctx: Pick<CommandContext, 'trx' | 'orgId'>): Promise<ReviewCheck[]> {
  await lockListShared(ctx);
  return reviewChecksOf(ctx.trx, ctx.orgId);
}

/** An approval's ticked items as the row keeps them. Read defensively: an entry without an id and a label is dropped. */
export function tickedOf(raw: unknown): TickedCheck[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.flatMap((c: unknown) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return [];
    const { id, label } = c as Record<string, unknown>;
    return typeof id === 'string' && typeof label === 'string' ? [{ id, label }] : [];
  });
  return list.length === 0 ? null : list;
}

export const reviewChecklistSet = defineCommand({
  name: 'social.review_check.set',
  input: zReviewChecklistSet,
  risk: 'R2',
  access: ADMINS,
  handler: async (ctx, input): Promise<{ items: ReviewCheck[] }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const by = ctx.actor.userId;
    const items = input.items.map((i) => ({ connectionId: i.connectionId === null ? null : i.connectionId.toLowerCase(), label: i.label }));
    if (items.length > SOCIAL_REVIEW_CHECKS_MAX) throw new DomainError('VALIDATION', 422, `Danh sách kiểm tra có tối đa ${SOCIAL_REVIEW_CHECKS_MAX} mục`);
    const connectionIds = [...new Set(items.flatMap((i) => (i.connectionId === null ? [] : [i.connectionId])))].sort();
    if (connectionIds.length > 0) {
      // The org's channels, of any status: a disconnected channel may keep its items until it is removed.
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', connectionIds).execute();
      if (found.length !== connectionIds.length) {
        const known = new Set(found.map((c) => c.id));
        throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không thuộc tổ chức này', { connectionIds: connectionIds.filter((id) => !known.has(id)) });
      }
    }
    await lockList(ctx);
    const before = await ctx.trx.selectFrom('crove_social.review_check').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    await ctx.trx.deleteFrom('crove_social.review_check').where('org_id', '=', ctx.orgId).execute();
    // The position is the item's place in the whole list, so a channel's checklist keeps the order the list gives.
    const rows =
      items.length === 0
        ? []
        : await ctx.trx
            .insertInto('crove_social.review_check')
            .values(items.map((i, position) => ({ org_id: ctx.orgId, channel_connection_id: i.connectionId, position, label: i.label, created_by: by, created_at: ctx.now })))
            .returning(['id', 'channel_connection_id', 'position', 'label'])
            .execute();
    const saved = rows.map((r) => ({ id: r.id, connectionId: r.channel_connection_id, position: r.position, label: r.label })).sort((a, b) => a.position - b.position);
    ctx.audit({ removed: Number(before.n), items: saved.map((s) => ({ id: s.id, connection_id: s.connectionId, label: s.label })) });
    return { items: saved };
  },
});

export const reviewChecklistList = defineQuery({
  name: 'social.review_check.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ items: ReviewCheck[] }> => {
    const scope = await channelScope(ctx);
    const items = await reviewChecksOf(ctx.trx, ctx.orgId);
    return { items: scope === null ? items : items.filter((c) => c.connectionId === null || scope.has(c.connectionId)) };
  },
});

export const reviewChecklistCommands = [reviewChecklistSet];
export const reviewChecklistQueries = [reviewChecklistList];
