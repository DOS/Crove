// Bookings of the public booking page (issue #1318, plan docs/plan/calendar.md §3.3). The page records a pending
// booking through crove_crm.booking_request (the API's login cannot enter an org's system context); the worker then
// runs crm.booking.confirm here as a system actor: it checks the time is still one of the type's free slots, holds an
// event on the host's calendar, links the booking to a party (matched by email, else created) with an activity on its
// timeline, and marks the booking confirmed, or refused when the time was taken or is no longer offered.
//
// Mails and links (#1319, step C4): a confirmation queues a mail to the visitor and one to the host (template
// crm.booking, with an .ics event) and emits crm.booking.scheduled, from which the worker queues the reminders (24 hours
// and 1 hour before; crm.booking.remind sends one only while the booking still starts then). The visitor's mails carry
// a manage link (crove_crm.booking_manage_token, minted at send time through crm.booking.mail_data): the page records
// an ask with crove_crm.booking_manage_request, and crm.booking.manage carries it out here. A cancel or a move raises
// the booking's revision, which ends every link minted before it.
//
// Confirmations and moves of one host run one at a time (an advisory lock), so the slot check sees every earlier
// booking; the exclusion constraint on crove_kernel.calendar_event stays the last line against any other writer.
import { z } from 'zod';
import { sql } from 'kysely';
import { freeSlots, zBookingCancel, zBookingListQuery, zBookingMove, zId, zonedDate, zoneOffsetMs, type BookingItem, type Interval, type WorkingHours } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { busyOf, createMailMessage, workingHoursOf } from '@crove/kernel';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const DAY_MS = 86_400_000;
// Who may still host a booking: anyone who can change their own calendar.
const HOST_ROLES = new Set(['owner', 'admin', 'member']);
export const BOOKING_MAIL_TEMPLATE = 'crm.booking';

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

// The party with this email in the org, or a new person with the visitor's name, email and phone. Confirmations for
// different hosts run in parallel, so the same visitor booking two of them at once takes this lock first.
async function partyFor(ctx: CommandContext, name: string, email: string, phone: string | null): Promise<string> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_crm.party:${ctx.orgId}:${email.toLowerCase()}`}, 0))`.execute(ctx.trx);
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

type EventType = Awaited<ReturnType<typeof eventTypeOf>>;
const eventTypeOf = (ctx: CommandContext, id: string) =>
  ctx.trx.selectFrom('crove_crm.event_type').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', id).executeTakeFirstOrThrow();

// Whether the host may still be booked: the type is active and the host still a member who keeps a calendar.
async function hostable(ctx: CommandContext, type: EventType): Promise<boolean> {
  const host = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select('role')
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', type.host_user_id)
    .executeTakeFirst();
  return type.active && !!host && HOST_ROLES.has(host.role);
}

// Whether [start, end) is one of the type's free slots now: 'free', or why not. A booking being moved passes its own
// calendar event and its own row, so it does not stand in its own way.
async function slotCheck(
  ctx: CommandContext,
  type: EventType,
  hours: WorkingHours,
  start: number,
  end: number,
  own?: { eventId: string; bookingId: string },
): Promise<'free' | 'taken' | 'unavailable'> {
  const from = new Date(start - DAY_MS);
  const to = new Date(end + DAY_MS);
  const busy = await busyOf(ctx, type.host_user_id, from, to, own?.eventId);
  const booked = await ctx.trx
    .selectFrom('crove_crm.booking')
    .select('starts_at')
    .where('org_id', '=', ctx.orgId)
    .where('event_type_id', '=', type.id)
    .where('status', '=', 'confirmed')
    .where('starts_at', '>=', from)
    .where('starts_at', '<', to)
    .$if(own !== undefined, (q) => q.where('id', '<>', own?.bookingId as string))
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
  if (slots.some((s) => s.start === start && s.end === end)) return 'free';
  const overlaps = (b: Interval) => b.start < end + type.buffer_after_min * 60_000 && b.end > start - type.buffer_before_min * 60_000;
  return busy.some(overlaps) ? 'taken' : 'unavailable';
}

export type BookingMailKind = 'confirmed' | 'moved' | 'cancelled' | 'reminder';
interface BookingForMail {
  id: string;
  revision: number;
  starts_at: Date | string;
  ends_at: Date | string;
  time_zone: string;
  visitor_name: string | null;
  email: string | null;
}

// Subjects name the event type only: the stored subject and merge data stay free of the visitor's details, which the
// template reads when it sends the mail (crm.booking.mail_data), so an erasure of the visitor reaches queued mail too.
const SUBJECTS: Record<BookingMailKind, { visitor: (title: string) => string; host: (title: string) => string }> = {
  confirmed: { visitor: (t) => `Đã xác nhận lịch hẹn: ${t}`, host: (t) => `Lịch hẹn mới: ${t}` },
  moved: { visitor: (t) => `Lịch hẹn đã đổi giờ: ${t}`, host: (t) => `Lịch hẹn đã đổi giờ: ${t}` },
  cancelled: { visitor: (t) => `Lịch hẹn đã hủy: ${t}`, host: (t) => `Lịch hẹn đã hủy: ${t}` },
  reminder: { visitor: (t) => `Nhắc lịch hẹn: ${t}`, host: (t) => `Nhắc lịch hẹn: ${t}` },
};

// Queues the booking's mails of one kind (template crm.booking): to the visitor, and to the host. The merge data holds
// no secret and no detail of the visitor; the template reads those, and mints the visitor's manage link, at send time.
async function queueBookingMails(
  ctx: CommandContext,
  kind: BookingMailKind,
  booking: BookingForMail,
  type: EventType,
  hostZone: string,
  toHost = true,
): Promise<void> {
  if (!booking.email || !booking.visitor_name) return;
  const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
  // The host's address while they are a member (the worker's member_emails: no name, no other account column). Only
  // the worker mails the host: a change the host made in the app mails the visitor alone.
  const host = toHost
    ? (await sql<{ email: string | null }>`SELECT email FROM crove_kernel.member_emails(${[type.host_user_id]}::uuid[])`.execute(ctx.trx)).rows[0]
    : undefined;
  const common = {
    kind,
    bookingId: booking.id,
    revision: booking.revision,
    org: tenant.slug,
    orgName: tenant.name,
    type: type.slug,
    title: type.title,
    startsAt: new Date(booking.starts_at).toISOString(),
    endsAt: new Date(booking.ends_at).toISOString(),
    locationKind: type.location_kind,
    location: type.location_value,
  };
  const source = `crm.booking.${kind}`;
  const subject = SUBJECTS[kind];
  const visitor = await createMailMessage(ctx, {
    stream: 'transactional',
    source,
    sourceId: booking.id,
    templateKey: BOOKING_MAIL_TEMPLATE,
    to: booking.email,
    subject: subject.visitor(type.title).slice(0, 300),
    payload: { ...common, recipient: 'visitor', timeZone: booking.time_zone },
    status: 'queued',
  });
  const sent: Record<string, string> = { visitor: visitor.status };
  if (host?.email) {
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source,
      sourceId: booking.id,
      templateKey: BOOKING_MAIL_TEMPLATE,
      to: host.email,
      subject: subject.host(type.title).slice(0, 300),
      payload: { ...common, recipient: 'host', timeZone: hostZone },
      status: 'queued',
    });
    sent.host = mail.status;
  }
  ctx.audit({ bookingId: booking.id, mails: kind, ...sent });
}

const scheduled = (ctx: CommandContext, bookingId: string, startsAt: Date | string) =>
  ctx.emit('crm.booking.scheduled', { booking_id: bookingId, starts_at: new Date(startsAt).toISOString() });

export const bookingConfirm = defineCommand({
  name: 'crm.booking.confirm',
  input: z.strictObject({ bookingId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input): Promise<Outcome> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select(['id', 'event_type_id', 'starts_at', 'ends_at', 'status', 'visitor_name', 'email', 'phone', 'time_zone', 'revision'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    // Already decided (a replayed job): nothing to do.
    if (!booking || booking.status !== 'pending') {
      return { bookingId: input.bookingId, status: booking?.status ?? 'refused', ...(booking ? {} : { refusal: 'unavailable' as const }) };
    }
    const type = await eventTypeOf(ctx, booking.event_type_id);
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

    if (!(await hostable(ctx, type)) || !booking.visitor_name || !booking.email) return refuse('unavailable');
    const start = new Date(booking.starts_at).getTime();
    const end = new Date(booking.ends_at).getTime();
    const { hours } = await workingHoursOf(ctx, type.host_user_id);
    const check = await slotCheck(ctx, type, hours, start, end);
    if (check !== 'free') return refuse(check);

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
    await queueBookingMails(ctx, 'confirmed', booking, type, hours.timeZone);
    await scheduled(ctx, booking.id, booking.starts_at);
    return { bookingId: booking.id, status: 'confirmed' };
  },
});

export interface BookingMailData {
  // The manage token for the booking's current revision; null once it is cancelled.
  token: string | null;
  // The visitor's details as the booking holds them now (null fields once erased).
  visitor: { name: string | null; email: string | null; phone: string | null; note: string | null } | null;
}

// What a booking mail being sent now needs beyond its merge data (the worker's mail template asks for it): the
// visitor's manage token and the visitor's details, read at send time.
export const bookingMailData = defineCommand({
  name: 'crm.booking.mail_data',
  input: z.strictObject({ bookingId: zId, revision: z.number().int().min(0) }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input): Promise<BookingMailData> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .select(['revision', 'visitor_name', 'email', 'phone', 'note'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      // Held until the token is read, so a move cannot commit between the revision check and the token.
      .forShare()
      .executeTakeFirst();
    const { rows } = await sql<{ token: string | null }>`SELECT crove_crm.booking_manage_token(${input.bookingId}::uuid) AS token`.execute(ctx.trx);
    return {
      // A mail of an earlier revision (sent after a move) carries no link: links of earlier revisions are dead.
      token: booking?.revision === input.revision ? (rows[0]?.token ?? null) : null,
      visitor: booking ? { name: booking.visitor_name, email: booking.email, phone: booking.phone, note: booking.note } : null,
    };
  },
});

export type ManageOutcome = 'cancelled' | 'moved' | 'taken' | 'unavailable' | 'none';

const lockBooking = (ctx: CommandContext, bookingId: string) =>
  ctx.trx.selectFrom('crove_crm.booking').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', bookingId).forUpdate().executeTakeFirst();
type HeldBooking = NonNullable<Awaited<ReturnType<typeof lockBooking>>> & { calendar_event_id: string };
// Who cancels or moves a booking: the visitor from a manage link, or the host (or an owner or admin) in the app.
type ChangedBy = 'visitor' | 'host';
const BY_TEXT: Record<ChangedBy, string> = { visitor: 'Khách', host: 'Người chủ trì' };

// Whether a booking may still be cancelled or moved: confirmed, holding its event, and not started.
const changeable = (ctx: CommandContext, b: NonNullable<Awaited<ReturnType<typeof lockBooking>>>): b is HeldBooking =>
  b.status === 'confirmed' && b.calendar_event_id !== null && new Date(b.starts_at).getTime() > ctx.now.getTime();

// Cancels a held booking: its calendar event is cancelled (the slot is free again), the revision rises (earlier links
// stop working), the party's timeline says so, and the visitor is mailed (the host too when the visitor cancelled).
async function cancelHeld(ctx: CommandContext, booking: HeldBooking, type: EventType, hours: WorkingHours, by: ChangedBy): Promise<void> {
  await ctx.trx
    .updateTable('crove_kernel.calendar_event')
    .set({ status: 'cancelled', cancelled_at: ctx.now })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', booking.calendar_event_id)
    .where('status', '=', 'active')
    .execute();
  await ctx.trx
    .updateTable('crove_crm.booking')
    .set({ status: 'cancelled', cancelled_at: ctx.now, revision: booking.revision + 1 })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', booking.id)
    .execute();
  if (booking.party_id) {
    await ctx.activity('kernel.party', booking.party_id, 'crm.booking.cancelled', `${BY_TEXT[by]} hủy lịch hẹn ${type.title} lúc ${wallTime(hours.timeZone, new Date(booking.starts_at).getTime())}`);
  }
  await queueBookingMails(ctx, 'cancelled', { ...booking, revision: booking.revision + 1 }, type, hours.timeZone, by === 'visitor');
}

// Moves a held booking to [start, start + duration) when that is still a free slot of the type (the booking's own event
// and row set aside): the event and the booking move, the revision rises, the reminders follow, and the visitor is
// mailed (the host too when the visitor moved it). Otherwise nothing changes and the answer says why.
async function moveHeld(
  ctx: CommandContext,
  booking: HeldBooking,
  type: EventType,
  hours: WorkingHours,
  start: number,
  by: ChangedBy,
): Promise<'moved' | 'taken' | 'unavailable'> {
  const end = start + type.duration_min * 60_000;
  if (!(await hostable(ctx, type))) return 'unavailable';
  const check = await slotCheck(ctx, type, hours, start, end, { eventId: booking.calendar_event_id, bookingId: booking.id });
  if (check !== 'free') return check;
  const startsAt = new Date(start);
  const endsAt = new Date(end);
  await ctx.trx
    .updateTable('crove_kernel.calendar_event')
    .set({ starts_at: startsAt, ends_at: endsAt, time_zone: hours.timeZone })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', booking.calendar_event_id)
    .execute();
  await ctx.trx
    .updateTable('crove_crm.booking')
    .set({ starts_at: startsAt, ends_at: endsAt, revision: booking.revision + 1 })
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', booking.id)
    .execute();
  if (booking.party_id) {
    await ctx.activity('kernel.party', booking.party_id, 'crm.booking.moved', `${BY_TEXT[by]} đổi lịch hẹn ${type.title} sang ${wallTime(hours.timeZone, start)}`);
  }
  await queueBookingMails(ctx, 'moved', { ...booking, starts_at: startsAt, ends_at: endsAt, revision: booking.revision + 1 }, type, hours.timeZone, by === 'visitor');
  await scheduled(ctx, booking.id, startsAt);
  return 'moved';
}

// Carries out a visitor's ask from a manage link (recorded by crove_crm.booking_manage_request): the ask `requestId`
// names, while it is still the booking's last and unanswered. A cancel frees the slot; a move holds the new time if it
// is still a free slot of the type, else the answer says why and the link keeps working.
export const bookingManage = defineCommand({
  name: 'crm.booking.manage',
  input: z.strictObject({ bookingId: zId, requestId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input): Promise<{ bookingId: string; outcome: ManageOutcome }> => {
    const booking = await lockBooking(ctx, input.bookingId);
    if (!booking || booking.manage_request_id !== input.requestId || booking.manage_outcome !== null || !booking.manage_action) {
      return { bookingId: input.bookingId, outcome: 'none' };
    }
    const type = await eventTypeOf(ctx, booking.event_type_id);
    await lockHost(ctx, type.host_user_id);
    const answer = async (outcome: Exclude<ManageOutcome, 'none'>) => {
      await ctx.trx.updateTable('crove_crm.booking').set({ manage_outcome: outcome }).where('org_id', '=', ctx.orgId).where('id', '=', booking.id).execute();
      ctx.audit({ bookingId: booking.id, action: booking.manage_action, outcome });
      return { bookingId: booking.id, outcome };
    };
    // Cancelled meanwhile (by the host, or an earlier ask), or reached after the booking started: too late.
    if (!changeable(ctx, booking)) return answer('unavailable');
    const { hours } = await workingHoursOf(ctx, type.host_user_id);
    if (booking.manage_action === 'cancel') {
      await cancelHeld(ctx, booking, type, hours, 'visitor');
      return answer('cancelled');
    }
    return answer(await moveHeld(ctx, booking, type, hours, new Date(booking.manage_starts_at as Date).getTime(), 'visitor'));
  },
});

// The host's side (#1320): the member who hosts the booking's type, or an owner or admin, cancels or moves it in the
// app. The visitor is mailed with a new link; a manage link from before stops working.
const STAFF: readonly MemberRole[] = ['owner', 'admin', 'member'];

async function hostBooking(ctx: CommandContext, bookingId: string): Promise<{ booking: HeldBooking; type: EventType; hours: WorkingHours }> {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  const booking = await lockBooking(ctx, bookingId);
  if (!booking) throw new DomainError('BOOKING_NOT_FOUND', 404, 'Không tìm thấy lịch hẹn này');
  const type = await eventTypeOf(ctx, booking.event_type_id);
  if (ctx.role !== 'owner' && ctx.role !== 'admin' && type.host_user_id !== ctx.actor.userId) {
    throw new DomainError('BOOKING_HOST_FORBIDDEN', 403, 'Bạn chỉ đổi được lịch hẹn do chính mình chủ trì');
  }
  if (!changeable(ctx, booking)) throw new DomainError('BOOKING_NOT_CHANGEABLE', 409, 'Lịch hẹn này đã hủy hoặc đã bắt đầu');
  await lockHost(ctx, type.host_user_id);
  const { hours } = await workingHoursOf(ctx, type.host_user_id);
  return { booking, type, hours };
}

export const bookingCancel = defineCommand({
  name: 'crm.booking.cancel',
  input: zBookingCancel,
  risk: 'R1',
  access: STAFF,
  handler: async (ctx, input): Promise<{ bookingId: string; status: 'cancelled' }> => {
    const { booking, type, hours } = await hostBooking(ctx, input.bookingId);
    await cancelHeld(ctx, booking, type, hours, 'host');
    ctx.audit({ bookingId: booking.id, eventTypeId: type.id, status: 'cancelled' });
    return { bookingId: booking.id, status: 'cancelled' };
  },
});

export const bookingMove = defineCommand({
  name: 'crm.booking.move',
  input: zBookingMove,
  risk: 'R1',
  access: STAFF,
  handler: async (ctx, input): Promise<{ bookingId: string; startsAt: string }> => {
    const { booking, type, hours } = await hostBooking(ctx, input.bookingId);
    const outcome = await moveHeld(ctx, booking, type, hours, Date.parse(input.startsAt), 'host');
    if (outcome === 'taken') throw new DomainError('BOOKING_TIME_TAKEN', 409, 'Giờ này đã có lịch khác');
    if (outcome === 'unavailable') throw new DomainError('BOOKING_TIME_UNAVAILABLE', 409, 'Khung giờ này không còn nhận đặt lịch');
    ctx.audit({ bookingId: booking.id, eventTypeId: type.id, moved: true });
    return { bookingId: booking.id, startsAt: new Date(input.startsAt).toISOString() };
  },
});

// One reminder before a booking (a job the worker queued from crm.booking.scheduled): mailed to the visitor only while
// the booking is confirmed and still starts at the time the job was queued for, and once per lead and time.
export const bookingRemind = defineCommand({
  name: 'crm.booking.remind',
  input: z.strictObject({ bookingId: zId, startsAt: z.iso.datetime(), lead: z.enum(['24h', '1h']) }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input): Promise<{ sent: boolean }> => {
    const booking = await ctx.trx
      .selectFrom('crove_crm.booking')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking || booking.status !== 'confirmed' || new Date(booking.starts_at).getTime() !== Date.parse(input.startsAt)) return { sent: false };
    if (new Date(booking.starts_at).getTime() <= ctx.now.getTime()) return { sent: false };
    const source = `crm.booking.remind_${input.lead}`;
    const earlier = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('source', '=', source)
      .where('source_id', '=', booking.id)
      .where(sql<boolean>`payload ->> 'startsAt' = ${new Date(booking.starts_at).toISOString()}`)
      .executeTakeFirst();
    if (earlier) return { sent: false };
    const type = await eventTypeOf(ctx, booking.event_type_id);
    if (!booking.email || !booking.visitor_name) return { sent: false };
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source,
      sourceId: booking.id,
      templateKey: BOOKING_MAIL_TEMPLATE,
      to: booking.email,
      subject: SUBJECTS.reminder.visitor(type.title).slice(0, 300),
      payload: {
        kind: 'reminder',
        recipient: 'visitor',
        bookingId: booking.id,
        revision: booking.revision,
        org: tenant.slug,
        orgName: tenant.name,
        type: type.slug,
        title: type.title,
        startsAt: new Date(booking.starts_at).toISOString(),
        endsAt: new Date(booking.ends_at).toISOString(),
        timeZone: booking.time_zone,
        locationKind: type.location_kind,
        location: type.location_value,
      },
      status: 'queued',
    });
    ctx.audit({ bookingId: booking.id, reminder: input.lead, mail: mail.status });
    return { sent: mail.status === 'queued' };
  },
});

// The bookings of the screen (#1320): confirmed and cancelled ones (requests the worker refused are not bookings), of the
// types the member hosts, or of the whole org for owners and admins. At most 200 a page.
export const bookingList = defineQuery({
  name: 'crm.booking.list',
  input: zBookingListQuery,
  access: STAFF,
  handler: async (ctx, input): Promise<BookingItem[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const userId = ctx.actor.userId;
    if (input.scope === 'org' && ctx.role !== 'owner' && ctx.role !== 'admin') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới xem được lịch hẹn của cả tổ chức');
    }
    const upcoming = input.period === 'upcoming';
    const rows = await ctx.trx
      .selectFrom('crove_crm.booking as b')
      .innerJoin('crove_crm.event_type as e', (j) => j.onRef('e.org_id', '=', 'b.org_id').onRef('e.id', '=', 'b.event_type_id'))
      .select([
        'b.id',
        'b.status',
        'b.starts_at',
        'b.ends_at',
        'b.time_zone',
        'b.visitor_name',
        'b.email',
        'b.phone',
        'b.note',
        'b.party_id',
        'e.id as type_id',
        'e.slug',
        'e.title',
        'e.active',
        'e.host_user_id',
      ])
      .where('b.org_id', '=', ctx.orgId)
      .where('b.status', 'in', ['confirmed', 'cancelled'])
      .$if(input.scope === 'mine', (q) => q.where('e.host_user_id', '=', userId))
      .where('b.ends_at', upcoming ? '>' : '<=', new Date())
      .orderBy('b.starts_at', upcoming ? 'asc' : 'desc')
      .orderBy('b.id')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      eventType: { id: r.type_id, slug: r.slug, title: r.title, active: r.active },
      hostUserId: r.host_user_id,
      status: r.status,
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
      timeZone: r.time_zone,
      visitor: { name: r.visitor_name, email: r.email, phone: r.phone, note: r.note },
      partyId: r.party_id,
    }));
  },
});

export const bookingQueries = [bookingList];

export const bookingCommands = [bookingConfirm, bookingMailData, bookingManage, bookingRemind, bookingCancel, bookingMove];
