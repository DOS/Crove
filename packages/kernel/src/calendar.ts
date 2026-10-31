// The calendar core (issue #1313, plan docs/plan/calendar.md): each member's weekly working hours
// (crove_kernel.availability_rule) and the events on their calendar (crove_kernel.calendar_event). A member reads and
// changes only their own calendar here; the crm booking command (#1318) writes bookings on a host's calendar as the
// system, and reads the host's hours and busy time through workingHoursOf() and busyOf().
//
// Holidays and the slot rules are pure functions in @crove/kernel-contract (calendar.ts).
import {
  CALENDAR_RANGE_MAX_DAYS,
  DEFAULT_WORKING_HOURS,
  freeSlots,
  zCalendarEventAdd,
  zCalendarEventCancel,
  zCalendarRange,
  zCalendarSlotsQuery,
  zWorkingHours,
  type CalendarEventView,
  type Interval,
  type MyCalendar,
  type WorkingHours,
} from '@crove/kernel-contract';
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { calendarConnectionCommands, calendarConnectionQueries } from './calendar-connections.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// A viewer reads their calendar but changes nothing, as everywhere else.
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// Events are at most this long (the table's calendar_event_length), so a range query looks this far back.
const EVENT_MAX_MS = 31 * 86_400_000;
// The most events one calendar read returns.
const MAX_EVENTS = 1000;

type Reader = Pick<QueryContext, 'trx' | 'orgId'>;

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

/** A member's working hours, and whether they saved their own (otherwise the default: weekdays 8:00 to 17:00). */
export async function workingHoursOf(ctx: Reader, userId: string): Promise<{ hours: WorkingHours; saved: boolean }> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.availability_rule')
    .select(['weekday', 'start_minute', 'end_minute', 'time_zone'])
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .orderBy('weekday')
    .orderBy('start_minute')
    .execute();
  const first = rows[0];
  if (!first) return { hours: DEFAULT_WORKING_HOURS, saved: false };
  return {
    hours: { timeZone: first.time_zone, windows: rows.map((r) => ({ weekday: r.weekday, start: r.start_minute, end: r.end_minute })) },
    saved: true,
  };
}

/**
 * A member's busy time that overlaps [from, to): every active event, whatever its kind, but `exceptEventId` (a booking
 * being moved does not stand in its own way).
 */
export async function busyOf(ctx: Reader, userId: string, from: Date, to: Date, exceptEventId?: string): Promise<Interval[]> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.calendar_event')
    .select(['starts_at', 'ends_at'])
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .$if(exceptEventId !== undefined, (q) => q.where('id', '<>', exceptEventId as string))
    .where('starts_at', '<', to)
    .where('starts_at', '>', new Date(from.getTime() - EVENT_MAX_MS))
    .where('ends_at', '>', from)
    .execute();
  return rows.map((r) => ({ start: new Date(r.starts_at).getTime(), end: new Date(r.ends_at).getTime() }));
}

async function eventsOf(ctx: Reader, userId: string, from: Date, to: Date): Promise<CalendarEventView[]> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.calendar_event')
    .select(['id', 'starts_at', 'ends_at', 'time_zone', 'title', 'kind'])
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .where('starts_at', '<', to)
    .where('starts_at', '>', new Date(from.getTime() - EVENT_MAX_MS))
    .where('ends_at', '>', from)
    .orderBy('starts_at')
    .orderBy('id')
    .limit(MAX_EVENTS)
    .execute();
  return rows.map(view);
}

function view(r: { id: string; starts_at: Date | string; ends_at: Date | string; time_zone: string; title: string | null; kind: CalendarEventView['kind'] }): CalendarEventView {
  return {
    id: r.id,
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: new Date(r.ends_at).toISOString(),
    timeZone: r.time_zone,
    title: r.title,
    kind: r.kind,
  };
}

export const calendarGet = defineQuery({
  name: 'kernel.calendar.get',
  input: zCalendarRange,
  access: ALL,
  handler: async (ctx, input): Promise<MyCalendar> => {
    const userId = userOf(ctx.actor);
    const { hours, saved } = await workingHoursOf(ctx, userId);
    return { hours, saved, events: await eventsOf(ctx, userId, new Date(input.from), new Date(input.to)) };
  },
});

export const calendarSlots = defineQuery({
  name: 'kernel.calendar.slots',
  input: zCalendarSlotsQuery,
  access: ALL,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const from = new Date(input.from);
    const to = new Date(input.to);
    const { hours } = await workingHoursOf(ctx, userId);
    const busy = await busyOf(ctx, userId, from, to);
    const slots = freeSlots({
      hours,
      busy,
      skipVietnamHolidays: true,
      rules: { durationMin: input.durationMin, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: CALENDAR_RANGE_MAX_DAYS, dailyLimit: null },
      from: from.getTime(),
      to: to.getTime(),
      now: Date.now(),
    });
    return slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }));
  },
});

export const calendarHoursSave = defineCommand({
  name: 'kernel.calendar.hours.save',
  input: zWorkingHours,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    if (input.windows.length === 0) throw new DomainError('WORKING_HOURS_EMPTY', 422, 'Hãy chọn ít nhất một khung giờ làm việc');
    // The whole set at once, one save of a member at a time: without the lock, two first saves would both delete
    // nothing and both insert their windows.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_kernel.availability_rule:${ctx.orgId}:${userId}`}, 0))`.execute(ctx.trx);
    const before = await workingHoursOf(ctx, userId);
    await ctx.trx.deleteFrom('crove_kernel.availability_rule').where('org_id', '=', ctx.orgId).where('user_id', '=', userId).execute();
    const windows = [...input.windows].sort((a, b) => a.weekday - b.weekday || a.start - b.start);
    await ctx.trx
      .insertInto('crove_kernel.availability_rule')
      .values(windows.map((w) => ({ org_id: ctx.orgId, user_id: userId, weekday: w.weekday, start_minute: w.start, end_minute: w.end, time_zone: input.timeZone, created_by: userId, created_at: ctx.now })))
      .execute();
    ctx.audit({ previous: before.saved ? before.hours : null, hours: { timeZone: input.timeZone, windows } });
    return { hours: { timeZone: input.timeZone, windows }, saved: true };
  },
});

export const calendarEventAdd = defineCommand({
  name: 'kernel.calendar.event.add',
  input: zCalendarEventAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<CalendarEventView> => {
    const userId = userOf(ctx.actor);
    const title = input.title?.trim() || null;
    const row = await ctx.trx
      .insertInto('crove_kernel.calendar_event')
      .values({ org_id: ctx.orgId, user_id: userId, starts_at: input.startsAt, ends_at: input.endsAt, time_zone: input.timeZone, title, kind: input.kind, created_by: userId, created_at: ctx.now })
      .returning(['id', 'starts_at', 'ends_at', 'time_zone', 'title', 'kind'])
      .executeTakeFirstOrThrow();
    ctx.audit({ eventId: row.id, kind: input.kind, startsAt: input.startsAt, endsAt: input.endsAt });
    return view(row);
  },
});

export const calendarEventCancel = defineCommand({
  name: 'kernel.calendar.event.cancel',
  input: zCalendarEventCancel,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const event = await ctx.trx
      .selectFrom('crove_kernel.calendar_event')
      .select(['kind', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.eventId)
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!event) throw new DomainError('CALENDAR_EVENT_NOT_FOUND', 404, 'Không tìm thấy sự kiện này trên lịch của bạn');
    // A booking is cancelled through the booking (crm, #1319), which tells the visitor.
    if (event.kind === 'booking') throw new DomainError('CALENDAR_EVENT_IS_BOOKING', 409, 'Đây là lịch hẹn của khách; hãy hủy từ mục Lịch hẹn');
    // A block of a connected calendar is the provider's: it goes when the member disconnects that calendar.
    if (event.kind !== 'manual' && event.kind !== 'time_off') throw new DomainError('CALENDAR_EVENT_IS_EXTERNAL', 409, 'Đây là giờ bận từ lịch bên ngoài; hãy ngắt kết nối lịch đó nếu không muốn dùng');
    if (event.status === 'active') {
      await ctx.trx
        .updateTable('crove_kernel.calendar_event')
        .set({ status: 'cancelled', cancelled_by: userId, cancelled_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.eventId)
        .execute();
    }
    ctx.audit({ eventId: input.eventId, already: event.status === 'cancelled' });
    return { eventId: input.eventId, cancelled: true as const };
  },
});

export const calendarCommands = [calendarHoursSave, calendarEventAdd, calendarEventCancel, ...calendarConnectionCommands];
export const calendarQueries = [calendarGet, calendarSlots, ...calendarConnectionQueries];
