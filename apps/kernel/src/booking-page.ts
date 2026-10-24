// The public side of the booking page (#1318, plan docs/plan/calendar.md §3.3): a visitor reads an event type's free
// slots, asks for one, and follows the request until the worker confirms or refuses it (crm.booking.confirm). The API's
// login runs the crm migration's definers on the control plane: the page gets free slots only, never the host's
// calendar; a request records a pending booking; the request token, returned once and stored as its SHA-256, is the
// only way to read that booking's status back.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DEFAULT_WORKING_HOURS,
  freeSlots,
  isTimeZone,
  zBookingRequest,
  zBookingStatus,
  zonedDate,
  type BookingPage,
  type BookingStatus,
  type WorkingHours,
} from '@crove/kernel-contract';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

export const BOOKING_VIEWS_PER_MINUTE = 60;
export const BOOKING_REQUESTS_PER_MINUTE = 5;
// The polls of one visitor's page while the worker decides: about one a second.
export const BOOKING_POLLS_PER_MINUTE = 90;
// What one page read covers at most.
export const BOOKING_RANGE_MAX_DAYS = 31;

const DAY_MS = 86_400_000;
const zSlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60);
const zToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const zRange = z
  .strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((r) => Date.parse(r.to) > Date.parse(r.from) && Date.parse(r.to) - Date.parse(r.from) <= BOOKING_RANGE_MAX_DAYS * DAY_MS);
// No NUL: PostgreSQL text cannot hold it.
const noNul = (s: string) => !s.includes('\u0000');
const zRequest = zBookingRequest.refine((r) => noNul(r.name) && noNul(r.note ?? '') && noNul(r.phone ?? '') && isTimeZone(r.timeZone), 'invalid text');

interface PageRow {
  orgName: string;
  eventType: {
    slug: string;
    title: string;
    description: string | null;
    durationMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
    minNoticeMin: number;
    horizonDays: number;
    dailyLimit: number | null;
    locationKind: BookingPage['eventType']['locationKind'];
  };
  hours: { weekday: number; start: number; end: number; timeZone: string }[];
  busy: [string, string][];
  booked: string[];
}

const invalid = () => new DomainError('VALIDATION', 422, 'Dữ liệu không hợp lệ');

function slugs(org: string, type: string): { org: string; type: string } {
  const o = zSlug.safeParse(org);
  const t = zSlug.safeParse(type);
  if (!o.success || !t.success) throw new DomainError('BOOKING_PAGE_NOT_FOUND', 404, 'Không tìm thấy trang đặt lịch này');
  return { org: o.data, type: t.data };
}

/** The event type's page with its free slots between from and to, or null when no active type has these slugs. */
export async function bookingView(runtime: Runtime, org: string, type: string, range: unknown, now = Date.now()): Promise<BookingPage | null> {
  const s = slugs(org, type);
  const parsed = zRange.safeParse(range);
  if (!parsed.success) throw invalid();
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  const row = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ page: PageRow | null }>`SELECT crove_crm.booking_page(${s.org}, ${s.type}, ${from}, ${to}) AS page`.execute(db);
    return rows[0]?.page ?? null;
  });
  if (!row) return null;
  const first = row.hours[0];
  const hours: WorkingHours = first ? { timeZone: first.timeZone, windows: row.hours.map((h) => ({ weekday: h.weekday, start: h.start, end: h.end })) } : DEFAULT_WORKING_HOURS;
  const bookedPerDay = new Map<string, number>();
  for (const at of row.booked) {
    const day = zonedDate(hours.timeZone, Date.parse(at));
    bookedPerDay.set(day, (bookedPerDay.get(day) ?? 0) + 1);
  }
  const t = row.eventType;
  const slots = freeSlots({
    hours,
    busy: row.busy.map(([start, end]) => ({ start: Date.parse(start), end: Date.parse(end) })),
    skipVietnamHolidays: true,
    rules: {
      durationMin: t.durationMin,
      bufferBeforeMin: t.bufferBeforeMin,
      bufferAfterMin: t.bufferAfterMin,
      minNoticeMin: t.minNoticeMin,
      horizonDays: t.horizonDays,
      dailyLimit: t.dailyLimit,
    },
    from: from.getTime(),
    to: to.getTime(),
    now,
    bookedPerDay,
  });
  return {
    orgName: row.orgName,
    eventType: { slug: t.slug, title: t.title, description: t.description, durationMin: t.durationMin, locationKind: t.locationKind },
    slots: slots.map((x) => ({ start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString() })),
  };
}

const sha256 = (token: string) => createHash('sha256').update(token).digest();

/**
 * Records a visitor's request for a slot and returns the token that reads its status back, or null when no active type
 * has these slugs. The worker decides it; a time outside the notice or the horizon is refused here at once.
 */
export async function bookingRequest(runtime: Runtime, org: string, type: string, body: unknown): Promise<{ token: string } | null> {
  const s = slugs(org, type);
  const parsed = zRequest.safeParse(body);
  if (!parsed.success) throw invalid();
  const r = parsed.data;
  const token = randomBytes(32).toString('base64url');
  const id = await runtime.orgless(async (db) => {
    try {
      const { rows } = await sql<{ id: string | null }>`
        SELECT crove_crm.booking_request(${s.org}, ${s.type}, ${new Date(r.startsAt)}, ${r.name}, ${r.email}, ${r.phone ?? null}, ${r.note ?? null}, ${r.timeZone}, ${sha256(token)}) AS id`.execute(db);
      return rows[0]?.id ?? null;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === '22023') throw invalid();
      if (code === '55000') throw new DomainError('BOOKING_TIME_UNAVAILABLE', 409, 'Khung giờ này không còn nhận đặt lịch');
      if (code === '54000') throw new DomainError('RATE_LIMITED', 429, 'Loại lịch hẹn này đang nhận quá nhiều yêu cầu, hãy thử lại sau');
      throw error;
    }
  });
  return id ? { token } : null;
}

/** The status of the booking a request token names, or null when it names none of this page's. */
export async function bookingStatus(runtime: Runtime, org: string, type: string, body: unknown): Promise<BookingStatus | null> {
  const s = slugs(org, type);
  const parsed = z.strictObject({ token: zToken }).safeParse(body);
  if (!parsed.success) return null;
  const row = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ status: unknown }>`SELECT crove_crm.booking_status(${s.org}, ${s.type}, ${sha256(parsed.data.token)}) AS status`.execute(db);
    return rows[0]?.status ?? null;
  });
  if (!row) return null;
  const status = zBookingStatus.parse({
    ...(row as Record<string, unknown>),
    startsAt: new Date(String((row as { startsAt: string }).startsAt)).toISOString(),
    endsAt: new Date(String((row as { endsAt: string }).endsAt)).toISOString(),
  });
  return status;
}
