// Event types (issue #1314, plan docs/plan/calendar.md §3.1, step C2): the kinds of meeting a client books with one
// member, the host, on the public booking page (C3, #1318). Owners and admins manage every event type of the org; a
// member manages the ones they host. Each slug names its page, so it is unique per org (event_type_slug_uq). Event
// types are archived, never deleted, so bookings keep their type.
//
// Team types (#1373, step C8): a type may name up to nine co-hosts beside its lead host, booked round-robin (one free
// host) or collectively (every host). A team books other members' time, so only owners and admins make a type a team
// type, change its co-hosts or change how it assigns; a member who leads one still edits everything else.
import { z } from 'zod';
import { zEventTypeInput, zEventTypeSetActive, zEventTypeUpdate, type EventType, type EventTypeAssignment, type EventTypeInput } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// Who may host a booking: anyone who can change their own calendar.
const HOSTS: readonly MemberRole[] = EDITORS;

type Reader = Pick<QueryContext, 'trx' | 'orgId'>;

const COLUMNS = [
  'id',
  'slug',
  'title',
  'description',
  'duration_min',
  'buffer_before_min',
  'buffer_after_min',
  'min_notice_min',
  'horizon_days',
  'daily_limit',
  'location_kind',
  'location_value',
  'host_user_id',
  'assignment',
  'co_host_user_ids',
  'active',
  'created_at',
  'updated_at',
] as const;

interface Row {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  horizon_days: number;
  daily_limit: number | null;
  location_kind: EventType['locationKind'];
  location_value: string | null;
  host_user_id: string;
  assignment: EventTypeAssignment;
  co_host_user_ids: string[];
  active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function view(r: Row): EventType {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    durationMin: r.duration_min,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    minNoticeMin: r.min_notice_min,
    horizonDays: r.horizon_days,
    dailyLimit: r.daily_limit,
    locationKind: r.location_kind,
    locationValue: r.location_value,
    hostUserId: r.host_user_id,
    assignment: r.assignment,
    coHostUserIds: r.co_host_user_ids,
    active: r.active,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const columnsOf = (input: EventTypeInput) => ({
  slug: input.slug,
  title: input.title,
  description: input.description?.trim() || null,
  duration_min: input.durationMin,
  buffer_before_min: input.bufferBeforeMin,
  buffer_after_min: input.bufferAfterMin,
  min_notice_min: input.minNoticeMin,
  horizon_days: input.horizonDays,
  daily_limit: input.dailyLimit,
  location_kind: input.locationKind,
  location_value: input.locationValue?.trim() || null,
  host_user_id: input.hostUserId,
  assignment: input.assignment,
  co_host_user_ids: input.coHostUserIds,
});

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const manager = (ctx: CommandContext) => ctx.role === 'owner' || ctx.role === 'admin';

// A member manages only event types they host.
function assertMayHost(ctx: CommandContext, userId: string, hostUserId: string): void {
  if (!manager(ctx) && hostUserId !== userId) {
    throw new DomainError('EVENT_TYPE_HOST_FORBIDDEN', 403, 'Bạn chỉ quản lý được loại lịch hẹn do chính mình chủ trì');
  }
}

async function assertHost(ctx: CommandContext, hostUserId: string): Promise<void> {
  const member = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select('role')
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', hostUserId)
    .executeTakeFirst();
  if (!member || !HOSTS.includes(member.role)) throw new DomainError('EVENT_TYPE_HOST_INVALID', 422, 'Người chủ trì phải là thành viên được sửa lịch của tổ chức');
}

// A single type has no co-host; a team type has at least one, each named once and none of them the lead host.
function assertTeamShape(input: EventTypeInput): void {
  const co = input.coHostUserIds;
  if (input.assignment === 'single' ? co.length > 0 : co.length === 0) {
    throw new DomainError('EVENT_TYPE_TEAM_INVALID', 422, 'Loại lịch hẹn theo nhóm cần ít nhất một người cùng chủ trì; loại một người thì không có');
  }
  if (new Set(co).size !== co.length || co.includes(input.hostUserId)) {
    throw new DomainError('EVENT_TYPE_TEAM_INVALID', 422, 'Mỗi người cùng chủ trì chỉ ghi một lần và không trùng người chủ trì chính');
  }
}

// Only owners and admins set up a team: it books other members' time.
function assertMayTeam(ctx: CommandContext): void {
  if (!manager(ctx)) throw new DomainError('EVENT_TYPE_TEAM_FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới lập lịch hẹn theo nhóm');
}

// Another event type took the slug after the check (the unique constraint).
function onWrite(slug: string) {
  return (error: unknown): never => {
    const pg = error as { code?: string; constraint?: string } | null | undefined;
    if (pg?.code === '23505' && pg.constraint === 'event_type_slug_uq') throw slugTaken(slug);
    throw error;
  };
}
const slugTaken = (slug: string) => new DomainError('EVENT_TYPE_SLUG_TAKEN', 409, `Đường dẫn "${slug}" đã dùng cho một loại lịch hẹn khác`);

async function slugFree(ctx: Reader, slug: string, except: string | null): Promise<boolean> {
  let q = ctx.trx.selectFrom('crove_crm.event_type').select('id').where('org_id', '=', ctx.orgId).where('slug', '=', slug);
  if (except) q = q.where('id', '<>', except);
  return (await q.executeTakeFirst()) === undefined;
}

async function load(ctx: Reader, eventTypeId: string, lock: boolean): Promise<Row> {
  let q = ctx.trx.selectFrom('crove_crm.event_type').select(COLUMNS).where('org_id', '=', ctx.orgId).where('id', '=', eventTypeId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw new DomainError('EVENT_TYPE_NOT_FOUND', 404, 'Không tìm thấy loại lịch hẹn này');
  return row;
}

export const eventTypeList = defineQuery({
  name: 'crm.event_type.list',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<EventType[]> => {
    const rows = await ctx.trx.selectFrom('crove_crm.event_type').select(COLUMNS).where('org_id', '=', ctx.orgId).orderBy('active', 'desc').orderBy('title').orderBy('id').limit(500).execute();
    return rows.map(view);
  },
});

export const eventTypeCreate = defineCommand({
  name: 'crm.event_type.create',
  input: zEventTypeInput,
  // It changes what the public booking page shows customers (visible outside Crove derives R2; #1579). No agent runs
  // it.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  handler: async (ctx, input): Promise<EventType> => {
    const userId = userOf(ctx.actor);
    assertMayHost(ctx, userId, input.hostUserId);
    assertTeamShape(input);
    if (input.assignment !== 'single') assertMayTeam(ctx);
    await assertHost(ctx, input.hostUserId);
    for (const coHost of input.coHostUserIds) await assertHost(ctx, coHost);
    if (!(await slugFree(ctx, input.slug, null))) throw slugTaken(input.slug);
    const row = await ctx.trx
      .insertInto('crove_crm.event_type')
      .values({ org_id: ctx.orgId, ...columnsOf(input), created_by: userId, created_at: ctx.now, updated_by: userId, updated_at: ctx.now })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow()
      .catch(onWrite(input.slug));
    ctx.audit({ eventTypeId: row.id, slug: row.slug, hostUserId: row.host_user_id, assignment: row.assignment, coHostUserIds: row.co_host_user_ids });
    return view(row);
  },
});

export const eventTypeUpdate = defineCommand({
  name: 'crm.event_type.update',
  input: zEventTypeUpdate,
  // It changes what the public booking page shows customers (visible outside Crove derives R2; #1579). No agent runs
  // it.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  handler: async (ctx, input): Promise<EventType> => {
    const userId = userOf(ctx.actor);
    const { eventTypeId, ...fields } = input;
    const before = await load(ctx, eventTypeId, true);
    // A member may neither change another host's type nor hand theirs to someone else.
    assertMayHost(ctx, userId, before.host_user_id);
    assertMayHost(ctx, userId, fields.hostUserId);
    assertTeamShape(fields);
    const teamChanged =
      fields.assignment !== before.assignment || fields.coHostUserIds.length !== before.co_host_user_ids.length || fields.coHostUserIds.some((id, i) => id !== before.co_host_user_ids[i]);
    if (teamChanged) assertMayTeam(ctx);
    if (fields.hostUserId !== before.host_user_id) await assertHost(ctx, fields.hostUserId);
    // A co-host added now must be able to host; one kept from before who no longer can is skipped when booking.
    for (const coHost of fields.coHostUserIds) if (!before.co_host_user_ids.includes(coHost)) await assertHost(ctx, coHost);
    if (!(await slugFree(ctx, fields.slug, eventTypeId))) throw slugTaken(fields.slug);
    const row = await ctx.trx
      .updateTable('crove_crm.event_type')
      .set({ ...columnsOf(fields), updated_by: userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', eventTypeId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow()
      .catch(onWrite(fields.slug));
    // Field names only: the description and location are free text that may hold personal data, and audit rows are
    // kept after a personal-data erasure.
    const previous = view(before);
    const next = view(row);
    const changed = (Object.keys(next) as (keyof EventType)[]).filter((k) => k !== 'updatedAt' && k !== 'coHostUserIds' && previous[k] !== next[k]);
    if (teamChanged) changed.push('coHostUserIds');
    ctx.audit({
      eventTypeId,
      slug: row.slug,
      hostUserId: row.host_user_id,
      previousHostUserId: before.host_user_id,
      ...(teamChanged ? { assignment: row.assignment, coHostUserIds: row.co_host_user_ids } : {}),
      changed,
    });
    return view(row);
  },
});

export const eventTypeSetActive = defineCommand({
  name: 'crm.event_type.set_active',
  input: zEventTypeSetActive,
  // It opens or closes a type on the public booking page (visible outside Crove derives R2; #1579). No agent runs it.
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  handler: async (ctx, input): Promise<EventType> => {
    const userId = userOf(ctx.actor);
    const before = await load(ctx, input.eventTypeId, true);
    assertMayHost(ctx, userId, before.host_user_id);
    // Turning a type back on needs a host who may still host.
    if (input.active && !before.active) await assertHost(ctx, before.host_user_id);
    const row = await ctx.trx
      .updateTable('crove_crm.event_type')
      .set({ active: input.active, updated_by: userId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.eventTypeId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    ctx.audit({ eventTypeId: input.eventTypeId, active: input.active, changed: before.active !== input.active });
    return view(row);
  },
});

export const eventTypeCommands = [eventTypeCreate, eventTypeUpdate, eventTypeSetActive];
export const eventTypeQueries = [eventTypeList];
