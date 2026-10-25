// The crm.scheduler agent template's program (#1434, plan docs/plan/calendar.md §1 "Later", ADR-0029 Phase 1). A
// booking the visitor cancelled through their manage link emits crm.booking.cancelled with an agent_task, so the kernel
// gives the agent a task for it (the template subscribes to the event). Each run checks out its open booking tasks,
// reads the next free slots the type's booking page offers now (crm.booking.next_slots), comments them and hands the
// task to the nearest human up the chart, who may invite the client again. It never books, mails or changes a booking.
// Phase 1 uses no language model; reading a client's email or chat for the times they ask for is a later phase.
//
// Kernel tasks are read by every member of the org, while bookings are shown to their hosts and to owners and admins
// (#1320). So a task's comment and an escalation's title and reason carry the type, times and counts only, never the
// visitor's name or contact; the task points at the booking (its source ref), which its host finds in Lịch hẹn.
import { z } from 'zod';
import { CALENDAR_RANGE_MAX_DAYS, freeSlots, teamSlots, zId, zonedDate, zonedInstant, zoneOffsetMs, type Interval, type WorkingHours } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { busyOf, workingHoursOf } from '@crove/kernel';
import { DomainError, defineQuery, type AgentProgram, type QueryContext } from '@crove/kernel-runtime';

export const SCHEDULER_TEMPLATE = 'crm.scheduler';
// Tasks one run handles at most; the rest wait for the next run.
const TASKS_PER_RUN = 20;
// Slots one comment proposes, and how far ahead it looks for them.
const SLOTS_PROPOSED = 3;
const LOOKAHEAD_DAYS = 14;
const DAY_MS = 86_400_000;
const STAFF: readonly MemberRole[] = ['owner', 'admin', 'member'];
const HOST_ROLES = new Set(['owner', 'admin', 'member']);

export interface NextSlots {
  bookingId: string;
  // The booking's status now: the agent proposes slots for a cancelled one only.
  status: string;
  eventType: { title: string; active: boolean };
  // The cancelled time.
  startsAt: string;
  // The lead host's zone, in which the comment shows times.
  timeZone: string;
  slots: { start: string; end: string }[];
}

// "09:30 Thứ Hai 02/11/2026" on the wall clock of the zone.
export function wallClock(timeZone: string, at: number): string {
  const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const date = zonedDate(timeZone, at);
  const minutes = Math.round((((at + zoneOffsetMs(timeZone, at)) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
  const [y, m, d] = date.split('-');
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] as string;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${weekday} ${d}/${m}/${y}`;
}

// The task comment: the cancelled time and the slots to offer. Deterministic, without the visitor.
export function proposalText(n: NextSlots): string {
  const lines = [`Khách đã hủy lịch hẹn "${n.eventType.title}" lúc ${wallClock(n.timeZone, Date.parse(n.startsAt))} (${n.timeZone}).`];
  if (!n.eventType.active) lines.push('Loại lịch hẹn này đã được lưu trữ nên không còn giờ trống để mời khách đặt lại.');
  else if (n.slots.length === 0) lines.push(`Trong ${LOOKAHEAD_DAYS} ngày tới loại lịch hẹn này không còn giờ trống; có thể mở thêm giờ làm việc trước khi mời khách đặt lại.`);
  else {
    lines.push(`Các giờ trống gần nhất trên trang đặt lịch:`);
    for (const s of n.slots) lines.push(`- ${wallClock(n.timeZone, Date.parse(s.start))}`);
  }
  lines.push('Người phụ trách xem thông tin khách trong mục Lịch hẹn và quyết định có mời khách đặt lại hay không.');
  return lines.join('\n');
}

export function escalationTitle(n: NextSlots): string {
  return `Mời khách đặt lại: ${n.eventType.title}`.slice(0, 300);
}

type Reader = Pick<QueryContext, 'trx' | 'orgId'>;
const eventTypeRow = (ctx: Reader, id: string) => ctx.trx.selectFrom('crove_crm.event_type').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', id).executeTakeFirst();
type EventTypeRow = NonNullable<Awaited<ReturnType<typeof eventTypeRow>>>;

// The free slots the type's booking page offers between from and to: each host's free slots (the type's daily limit
// counted per local day of that host), then the team's (one host for a round-robin type, every host for a collective
// one), as bookingView() computes them; with the lead host's zone. None for an archived type.
async function typeSlots(ctx: Reader, type: EventTypeRow, from: number, to: number, now: number): Promise<{ timeZone: string; slots: Interval[] }> {
  const ids = type.assignment === 'single' ? [type.host_user_id] : [type.host_user_id, ...type.co_host_user_ids];
  const members = await ctx.trx.selectFrom('crove_kernel.tenant_member').select(['user_id', 'role']).where('org_id', '=', ctx.orgId).where('user_id', 'in', ids).execute();
  const able = new Set(members.filter((m) => HOST_ROLES.has(m.role)).map((m) => m.user_id));
  const hosts = type.active ? ids.filter((id) => able.has(id)) : [];
  const booked = await ctx.trx
    .selectFrom('crove_crm.booking')
    .select('starts_at')
    .where('org_id', '=', ctx.orgId)
    .where('event_type_id', '=', type.id)
    .where('status', '=', 'confirmed')
    .where('starts_at', '>=', new Date(from - DAY_MS))
    .where('starts_at', '<', new Date(to + DAY_MS))
    .execute();
  // The lead host's zone names the times, whether or not the lead may still host.
  let lead: WorkingHours = (await workingHoursOf(ctx, type.host_user_id)).hours;
  const perHost: Interval[][] = [];
  for (const [i, userId] of hosts.entries()) {
    const { hours } = await workingHoursOf(ctx, userId);
    if (i === 0) lead = hours;
    const bookedPerDay = new Map<string, number>();
    for (const b of booked) {
      const day = zonedDate(hours.timeZone, new Date(b.starts_at).getTime());
      bookedPerDay.set(day, (bookedPerDay.get(day) ?? 0) + 1);
    }
    perHost.push(
      freeSlots({
        hours,
        busy: await busyOf(ctx, userId, new Date(from - DAY_MS), new Date(to + DAY_MS)),
        skipVietnamHolidays: true,
        rules: {
          durationMin: type.duration_min,
          bufferBeforeMin: type.buffer_before_min,
          bufferAfterMin: type.buffer_after_min,
          minNoticeMin: type.min_notice_min,
          horizonDays: type.horizon_days,
          dailyLimit: type.daily_limit,
        },
        from,
        to,
        now,
        bookedPerDay,
      }),
    );
  }
  return { timeZone: lead.timeZone, slots: teamSlots(type.assignment === 'collective' ? 'all' : 'any', perHost) };
}

const isoSlot = (s: Interval) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() });

// The slots to propose: the earliest of each day first, so a client gets a choice of days rather than three slots of
// one morning, then the earliest of the rest when there are fewer days; in time order.
export function spreadSlots(slots: readonly Interval[], timeZone: string, count = SLOTS_PROPOSED): Interval[] {
  const firsts: Interval[] = [];
  const days = new Set<string>();
  for (const s of slots) {
    const day = zonedDate(timeZone, s.start);
    if (days.has(day)) continue;
    days.add(day);
    firsts.push(s);
    if (firsts.length === count) break;
  }
  const chosen = new Set(firsts);
  const rest = slots.filter((s) => !chosen.has(s)).slice(0, count - firsts.length);
  return [...firsts, ...rest].sort((a, b) => a.start - b.start);
}

// The next free slots the type's booking page offers now, for a booking of that type. Members and the crm.scheduler
// agent read it; it changes nothing and tells nothing about the visitor.
export const bookingNextSlots = defineQuery({
  name: 'crm.booking.next_slots',
  input: z.strictObject({ bookingId: zId }),
  access: STAFF,
  agent: { roles: [SCHEDULER_TEMPLATE] },
  handler: async (ctx, input): Promise<NextSlots> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select(['id', 'status', 'starts_at', 'event_type_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      .executeTakeFirst();
    const type = booking ? await eventTypeRow(ctx, booking.event_type_id) : undefined;
    if (!booking || !type) throw new DomainError('BOOKING_NOT_FOUND', 404, 'Không tìm thấy lịch hẹn này');
    const now = Date.now();
    const to = now + Math.min(LOOKAHEAD_DAYS, type.horizon_days, CALENDAR_RANGE_MAX_DAYS) * DAY_MS;
    const { timeZone, slots } = await typeSlots(ctx, type, now, to, now);
    return {
      bookingId: booking.id,
      status: booking.status,
      eventType: { title: type.title, active: type.active },
      startsAt: new Date(booking.starts_at).toISOString(),
      timeZone,
      slots: spreadSlots(slots, timeZone).map(isoSlot),
    };
  },
});

export interface SuggestedSlots {
  eventType: { id: string; slug: string; title: string; durationMin: number; active: boolean };
  // The lead host's zone, today in it and the days ahead looked at: what a reader of a client's message is told.
  timeZone: string;
  today: string;
  days: number;
  // true when the slots lie inside the windows asked for; false when none did and these are the next free slots.
  inWindows: boolean;
  slots: { start: string; end: string }[];
}

export const zSuggestWindow = z
  .strictObject({ date: z.iso.date(), from: z.number().int().min(0).max(1439), to: z.number().int().min(1).max(1440) })
  .refine((w) => w.from < w.to, { message: 'from before to' });

// Free slots of an event type for a reply to a client (#1440): the earliest ones inside the windows asked for (days and
// times of day in the type's zone, read from the client's message), else the next free ones. Owners, admins and
// members read it; it changes nothing.
export const bookingSuggestSlots = defineQuery({
  name: 'crm.booking.suggest_slots',
  input: z.strictObject({ eventTypeId: zId, windows: z.array(zSuggestWindow).max(5) }),
  access: STAFF,
  handler: async (ctx, input): Promise<SuggestedSlots> => {
    const type = await eventTypeRow(ctx, input.eventTypeId);
    if (!type) throw new DomainError('EVENT_TYPE_NOT_FOUND', 404, 'Không tìm thấy loại lịch hẹn này');
    const now = Date.now();
    const days = Math.min(LOOKAHEAD_DAYS, type.horizon_days, CALENDAR_RANGE_MAX_DAYS);
    const { timeZone, slots } = await typeSlots(ctx, type, now, now + days * DAY_MS, now);
    const ranges = input.windows.map((w) => ({ start: zonedInstant(timeZone, w.date, w.from), end: zonedInstant(timeZone, w.date, w.to) }));
    const inside = slots.filter((s) => ranges.some((r) => s.start >= r.start && s.end <= r.end));
    const chosen = inside.length > 0 ? inside : slots;
    return {
      eventType: { id: type.id, slug: type.slug, title: type.title, durationMin: type.duration_min, active: type.active },
      timeZone,
      today: zonedDate(timeZone, now),
      days,
      inWindows: inside.length > 0,
      slots: spreadSlots(chosen, timeZone).map(isoSlot),
    };
  },
});

interface TaskSummary {
  id: string;
  kind: string;
  status: string;
  source: string;
  sourceRef: unknown;
}

const zBookingRef = z.object({ type: z.literal('crm.booking'), id: zId });

export const schedulerProposeSlots: AgentProgram = async (agent) => {
  const { tasks } = await agent.query<{ tasks: TaskSummary[] }>('kernel.task.list', { status: ['todo', 'in_progress'] });
  const mine = tasks.filter((t) => t.kind === 'general' && t.source === 'event' && zBookingRef.safeParse(t.sourceRef).success).slice(0, TASKS_PER_RUN);
  for (const task of mine) {
    const ref = zBookingRef.parse(task.sourceRef);
    let fence: string;
    try {
      ({ fence } = await agent.execute<{ fence: string }>('kernel.task.checkout', { id: task.id }));
    } catch (error) {
      // Held by someone else or no longer open: not this run's work.
      if (error instanceof DomainError && error.status === 409) continue;
      throw error;
    }
    let next: NextSlots;
    try {
      next = await agent.query<NextSlots>('crm.booking.next_slots', { bookingId: ref.id });
    } catch (error) {
      // The booking is gone (the org purge, an erasure): nothing to propose.
      if (error instanceof DomainError && error.status === 404) {
        await agent.execute('kernel.task.set_status', { id: task.id, fence, status: 'done' });
        continue;
      }
      throw error;
    }
    // Only a cancelled booking is worth an invitation; one that stands again needs nothing.
    if (next.status !== 'cancelled') {
      await agent.execute('kernel.task.set_status', { id: task.id, fence, status: 'done' });
      continue;
    }
    const text = proposalText(next);
    await agent.execute('kernel.task.comment', { id: task.id, fence, body: text });
    await agent.execute('kernel.task.escalate', { id: task.id, fence, title: escalationTitle(next), reason: text });
  }
};

export const crmAgentPrograms = { [SCHEDULER_TEMPLATE]: schedulerProposeSlots } as const;
export const crmAgentQueries = [bookingNextSlots, bookingSuggestSlots];
