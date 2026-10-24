// Saved views of the posts (#1300): a member names the filters of the Social home (the tab, a channel, a label, the
// text, the list's days, whose posts and the calendar's month or week) and opens them again in one click, as Loomly saves
// filters and ContentStudio keeps custom views. A view is private to its owner, or shared with every member of the org;
// the owner changes and deletes it, and owners and admins a shared one too (they may not make another's view private,
// which would hide it from them). At most SAVED_VIEW_LIMIT per member, counted under a lock. The table's restrictive
// policies hold the same rules in the database. A view only fills the filters: applying one lists through
// social.post.list, so a member limited to some channels (#1081) still sees only their channels' posts, and a view
// naming a member who left lists nothing but says so (MEMBER_NOT_FOUND).
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zSocialSavedViewSave, zSocialViewFilters } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { membersOutside } from './post-filter.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The views one member keeps per org.
export const SAVED_VIEW_LIMIT = 20;
// The most views one list answers: the viewer's own and the shared ones, newest change first beyond it.
export const SAVED_VIEW_LIST_MAX = 200;

export type SocialViewFilters = z.infer<typeof zSocialViewFilters>;
export interface SavedView {
  id: string;
  name: string;
  filters: SocialViewFilters;
  shared: boolean;
  ownerId: string;
  mine: boolean;
  canChange: boolean;
  updatedAt: string;
}

function requireUser(ctx: Pick<CommandContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// NFC, so a name typed with combining marks matches the same name typed precomposed; the table checks the length again.
const normalName = (name: string) => name.normalize('NFC').trim();

// A stored filter read back: the shape the contract allows, else the empty filter (a row written before a field was
// narrowed opens on the plain list rather than failing the whole answer).
function filtersOf(raw: unknown): SocialViewFilters {
  const parsed = zSocialViewFilters.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

// The filters as stored: only the fields set, so the link a view opens shows only those.
function compact(filters: SocialViewFilters): SocialViewFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)) as SocialViewFilters;
}

// The view, locked, when the viewer may change it: their own, or a shared one for an owner or admin. A view the viewer
// cannot see (another's private one) is not found. Read before it is locked: a lock asks for the update policy, which
// would hide a shared view from a member who may only read it, and they are told why instead.
async function changeable(ctx: CommandContext, me: string, viewId: string, verb: 'sửa' | 'xoá') {
  const of = () => ctx.trx.selectFrom('crove_social.saved_view').select(['id', 'user_id', 'shared']).where('org_id', '=', ctx.orgId).where('id', '=', viewId);
  const seen = await of().executeTakeFirst();
  if (!seen) throw new DomainError('SAVED_VIEW_NOT_FOUND', 404, 'Không tìm thấy chế độ xem này');
  if (seen.user_id !== me && !(seen.shared && (ctx.role === 'owner' || ctx.role === 'admin'))) {
    throw new DomainError('FORBIDDEN', 403, `Chỉ người tạo, chủ sở hữu hoặc quản trị viên mới ${verb} được chế độ xem này`);
  }
  const view = await of().forUpdate().executeTakeFirst();
  if (!view) throw new DomainError('SAVED_VIEW_NOT_FOUND', 404, 'Không tìm thấy chế độ xem này');
  return view;
}

export const savedViewSave = defineCommand({
  name: 'social.saved_view.save',
  input: zSocialSavedViewSave,
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input): Promise<{ viewId: string }> => {
    const me = requireUser(ctx);
    const name = normalName(input.name);
    if (name.length === 0 || name.length > 60) throw new DomainError('VALIDATION', 422, 'Tên chế độ xem dài từ 1 đến 60 ký tự');
    // Sharing shows the view to the whole org: not for viewers, who only read.
    if (input.shared && ctx.role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người chỉ xem không chia sẻ được chế độ xem');
    // Whose posts: a member of the org, as the list asks.
    if ((await membersOutside(ctx, input.filters)).length > 0) throw new DomainError('MEMBER_NOT_FOUND', 404, 'Không tìm thấy thành viên này trong tổ chức');
    // The contract bounds every field, so the object stays well under the table's 2 KB check.
    const filters = JSON.stringify(compact(input.filters));

    if (input.viewId === undefined) {
      // One save at a time per member, so the count below holds until the commit.
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_social.saved_view:${ctx.orgId}:${me}`}, 0))`.execute(ctx.trx);
      const count = await ctx.trx
        .selectFrom('crove_social.saved_view')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('org_id', '=', ctx.orgId)
        .where('user_id', '=', me)
        .executeTakeFirstOrThrow();
      if (Number(count.n) >= SAVED_VIEW_LIMIT) throw new DomainError('SAVED_VIEW_LIMIT', 409, `Mỗi người lưu tối đa ${SAVED_VIEW_LIMIT} chế độ xem`, { limit: String(SAVED_VIEW_LIMIT) });
      const taken = await ctx.trx.selectFrom('crove_social.saved_view').select('id').where('org_id', '=', ctx.orgId).where('user_id', '=', me).where('name', '=', name).executeTakeFirst();
      if (taken) throw new DomainError('SAVED_VIEW_NAME_TAKEN', 409, 'Bạn đã có chế độ xem cùng tên', { name });
      const row = await ctx.trx
        .insertInto('crove_social.saved_view')
        .values({ org_id: ctx.orgId, user_id: me, name, filters, shared: input.shared, created_at: ctx.now, updated_at: ctx.now })
        .returning('id')
        .executeTakeFirstOrThrow();
      ctx.audit({ view_id: row.id, shared: input.shared });
      return { viewId: row.id };
    }

    // A change: the view, if the viewer may change it; another's shared view stays shared.
    const view = await changeable(ctx, me, input.viewId, 'sửa');
    if (view.user_id !== me && !input.shared) throw new DomainError('FORBIDDEN', 403, 'Chỉ người tạo mới chuyển được chế độ xem này về riêng tư');
    // One name per owner, the view's owner whoever renames it.
    const taken = await ctx.trx
      .selectFrom('crove_social.saved_view')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', view.user_id)
      .where('name', '=', name)
      .where('id', '<>', view.id)
      .executeTakeFirst();
    if (taken) throw new DomainError('SAVED_VIEW_NAME_TAKEN', 409, 'Đã có chế độ xem cùng tên', { name });
    await ctx.trx
      .updateTable('crove_social.saved_view')
      .set({ name, filters, shared: input.shared, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', view.id)
      .execute();
    ctx.audit({ view_id: view.id, shared: input.shared });
    return { viewId: view.id };
  },
});

export const savedViewDelete = defineCommand({
  name: 'social.saved_view.delete',
  input: z.strictObject({ viewId: zId }),
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input): Promise<{ viewId: string }> => {
    const me = requireUser(ctx);
    const view = await changeable(ctx, me, input.viewId, 'xoá');
    await ctx.trx.deleteFrom('crove_social.saved_view').where('org_id', '=', ctx.orgId).where('id', '=', view.id).execute();
    ctx.audit({ view_id: view.id });
    return { viewId: view.id };
  },
});

// The viewer's views and the org's shared ones, the viewer's first, each by name. The policy shows nothing else.
export const savedViewList = defineQuery({
  name: 'social.saved_view.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<SavedView[]> => {
    if (ctx.actor.type !== 'user') return [];
    const me = ctx.actor.userId;
    const rows = await ctx.trx
      .selectFrom('crove_social.saved_view')
      .select(['id', 'user_id', 'name', 'filters', 'shared', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where((eb) => eb.or([eb('user_id', '=', me), eb('shared', '=', true)]))
      .orderBy(sql`user_id = ${me}`, 'desc')
      .orderBy('name')
      .orderBy('id')
      .limit(SAVED_VIEW_LIST_MAX)
      .execute();
    const admin = ctx.role === 'owner' || ctx.role === 'admin';
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      filters: filtersOf(r.filters),
      shared: r.shared,
      ownerId: r.user_id,
      mine: r.user_id === me,
      canChange: r.user_id === me || (r.shared && admin),
      updatedAt: r.updated_at.toISOString(),
    }));
  },
});

export const savedViewCommands = [savedViewSave, savedViewDelete];
export const savedViewQueries = [savedViewList];
