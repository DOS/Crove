// Bookings of the public booking page (issue #1318, plan docs/plan/calendar.md §3.3). The page records a pending
// booking through crove_crm.booking_request (the API's login cannot enter an org's system context); the worker then
// runs crm.booking.confirm here as a system actor: it checks the time is still one of the type's free slots, holds an
// event on the host's calendar, links the booking to a party (matched by email, else created) with an activity on its
// timeline, and marks the booking confirmed, or refused when the time was taken or is no longer offered.
//
// Confirmations of one host run one at a time (an advisory lock), so the slot check sees every earlier booking; the
// exclusion constraint on crove_kernel.calendar_event stays the last line against any other writer.
import { z } from 'zod';
import { sql } from 'kysely';
import { freeSlots, zId, zonedDate, zoneOffsetMs, type Interval } from '@crove/kernel-contract';
import { busyOf, workingHoursOf } from '@crove/kernel';
import { defineCommand, type CommandContext } from '@crove/kernel-runtime';

const DAY_MS = 86_400_000;
// Who may still host a booking: anyone who can change their own calendar.
const HOST_ROLES = new Set(['owner', 'admin', 'member']);

type Outcome = { bookingId: string; status: 'confirmed' | 'refused' | 'pending' | 'cancelled'; refusal?: 'taken' | 'unavailable' };

const lockHost = (ctx: CommandContext, hostUserId: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_crm.booking:${ctx.orgId}:${hostUserId}`}, 0))`.execute(ctx.trx);

// "09:30 ngày 02/11/2026" on the host's wall clock, for the party's timeline.
function wallTime(timeZone: string, at: number): string {
  const date = zonedDate(timeZone, at);
  const minutes = Math.round(((at + zoneOffsetMs(timeZone, at)) % DAY_MS) / 60_000);
  const [y, m, d] = date.split('-');
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ngày ${d}/${m}/${y}`;
}

// The party with this email in the org, or a new person with the visitor's name, email and phone.
async function partyFor(ctx: CommandContext, name: string, email: string, phone: string | null): Promise<string> {
  const existing = await ctx.trx
    .selectFrom('crove_kernel.party')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (existing) return existing.id;
  const created = await ctx.trx
    .insertInto('crove_kernel.party')
    .values({ org_id: ctx.orgId, kind: 'person', name, email, phone, source_trust: 'external' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await ctx.activity('kernel.party', created.id, 'party.created', `Thêm khách hàng ${name} từ trang đặt lịch`);
  return created.id;
}

export const bookingConfirm = defineCommand({
  name: 'crm.booking.confirm',
  input: z.strictObject({ bookingId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input): Promise<Outcome> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select(['id', 'event_type_id', 'starts_at', 'ends_at', 'status', 'visitor_name', 'email', 'phone'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    // Already decided (a replayed job): nothing to do.
    if (!booking || booking.status !== 'pending') {
      return { bookingId: input.bookingId, status: booking?.status ?? 'refused', ...(booking ? {} : { refusal: 'unavailable' as const }) };
    }
    const type = await ctx.trx
      .selectFrom('crove_crm.event_type')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', booking.event_type_id)
      .executeTakeFirstOrThrow();
    await lockHost(ctx, type.host_user_id);

    const refuse = async (refusal: 'taken' | 'unavailable'): Promise<Outcome> => {
      await ctx.trx
        .updateTable('crove_crm.booking')
        .set({ status: 'refused', refusal, decided_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', booking.id)
        .execute();
      ctx.audit({ bookingId: booking.id, eventTypeId: type.id, status: 'refused', refusal });
      return { bookingId: booking.id, status: 'refused', refusal };
    };

    const host = await ctx.trx
      .selectFrom('crove_kernel.tenant_member')
      .select('role')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', type.host_user_id)
      .executeTakeFirst();
    if (!type.active || !host || !HOST_ROLES.has(host.role) || !booking.visitor_name || !booking.email) return refuse('unavailable');

    const start = new Date(booking.starts_at).getTime();
    const end = new Date(booking.ends_at).getTime();
    const from = new Date(start - DAY_MS);
    const to = new Date(end + DAY_MS);
    const { hours } = await workingHoursOf(ctx, type.host_user_id);
    const busy = await busyOf(ctx, type.host_user_id, from, to);
    const booked = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select('starts_at')
      .where('org_id', '=', ctx.orgId)
      .where('event_type_id', '=', type.id)
      .where('status', '=', 'confirmed')
      .where('starts_at', '>=', from)
      .where('starts_at', '<', to)
      .execute();
    const bookedPerDay = new Map<string, number>();
    for (const b of booked) {
      const day = zonedDate(hours.timeZone, new Date(b.starts_at).getTime());
      bookedPerDay.set(day, (bookedPerDay.get(day) ?? 0) + 1);
    }
    const slots = freeSlots({
      hours,
      busy,
      skipVietnamHolidays: true,
      rules: {
        durationMin: type.duration_min,
        bufferBeforeMin: type.buffer_before_min,
        bufferAfterMin: type.buffer_after_min,
        minNoticeMin: type.min_notice_min,
        horizonDays: type.horizon_days,
        dailyLimit: type.daily_limit,
      },
      from: from.getTime(),
      to: to.getTime(),
      now: ctx.now.getTime(),
      bookedPerDay,
    });
    if (!slots.some((s) => s.start === start && s.end === end)) {
      const overlaps = (b: Interval) => b.start < end + type.buffer_after_min * 60_000 && b.end > start - type.buffer_before_min * 60_000;
      return refuse(busy.some(overlaps) ? 'taken' : 'unavailable');
    }

    const event = await ctx.trx
      .insertInto('crove_kernel.calendar_event')
      .values({
        org_id: ctx.orgId,
        user_id: type.host_user_id,
        starts_at: booking.starts_at,
        ends_at: booking.ends_at,
        time_zone: hours.timeZone,
        title: `${type.title}: ${booking.visitor_name}`.slice(0, 200),
        kind: 'booking',
        created_by: type.host_user_id,
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const partyId = await partyFor(ctx, booking.visitor_name, booking.email, booking.phone);
    await ctx.activity('kernel.party', partyId, 'crm.booking.confirmed', `Đặt lịch hẹn ${type.title} lúc ${wallTime(hours.timeZone, start)}`);
    await ctx.trx
      .updateTable('crove_crm.booking')
      .set({ status: 'confirmed', calendar_event_id: event.id, party_id: partyId, decided_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', booking.id)
      .execute();
    ctx.audit({ bookingId: booking.id, eventTypeId: type.id, status: 'confirmed', calendarEventId: event.id, partyId });
    return { bookingId: booking.id, status: 'confirmed' };
  },
});

export const bookingCommands = [bookingConfirm];
