// The calendar core (#1313) on PostgreSQL 17: a member's working hours and events, who reads and changes them, free
// slots that a busy event or a public holiday takes away, and the database's own rules (no two active bookings of a
// member overlap, events bounded and ordered). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { isVietnamHoliday, vietnamHolidays, weekdayOf, zonedDate, zonedInstant, type CalendarEventView, type MyCalendar } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;

// The next working day (Vietnam time, Monday to Friday, not a public holiday) at least two days from now.
function nextWorkday(): string {
  let date = zonedDate(VN, Date.now() + 2 * DAY);
  while (weekdayOf(date) > 5 || isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}

// The next public holiday on a weekday at least two days from now.
function nextWeekdayHoliday(): string {
  const soon = zonedDate(VN, Date.now() + 2 * DAY);
  const year = Number(soon.slice(0, 4));
  const found = [...vietnamHolidays(year), ...vietnamHolidays(year + 1)].map((h) => h.date).find((d) => d >= soon && weekdayOf(d) <= 5);
  if (!found) throw new Error('no weekday holiday ahead');
  return found;
}

const dayRange = (date: string) => ({ from: new Date(zonedInstant(VN, date, 0)).toISOString(), to: new Date(zonedInstant(VN, date, 1440)).toISOString() });
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();

suite('calendar core on PostgreSQL (#1313)', () => {
  const dbName = `crove_test_calendar_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@cal.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, name: string, input: unknown) => rt.query<T>(name, input, { actor: asUser(user), orgId });
    return { orgId, owner, member, viewer, exec, query };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('starts every member on the default hours, saves their own, and keeps each calendar to its member', async () => {
    const o = await org();
    const range = dayRange(nextWorkday());
    const fresh = await o.query<MyCalendar>(o.member, 'kernel.calendar.get', range);
    expect(fresh).toMatchObject({ saved: false, hours: { timeZone: VN, windows: expect.arrayContaining([{ weekday: 1, start: 480, end: 1020 }]) }, events: [] });

    const hours = { timeZone: 'Europe/Berlin', windows: [{ weekday: 3, start: 600, end: 720 }, { weekday: 1, start: 540, end: 600 }] };
    expect(await o.exec(o.member, 'kernel.calendar.hours.save', hours)).toEqual({
      saved: true,
      hours: { timeZone: 'Europe/Berlin', windows: [{ weekday: 1, start: 540, end: 600 }, { weekday: 3, start: 600, end: 720 }] },
    });
    expect((await o.query<MyCalendar>(o.member, 'kernel.calendar.get', range)).hours.timeZone).toBe('Europe/Berlin');
    // Saving again replaces the set.
    await o.exec(o.member, 'kernel.calendar.hours.save', { timeZone: VN, windows: [{ weekday: 2, start: 480, end: 600 }] });
    expect((await o.query<MyCalendar>(o.member, 'kernel.calendar.get', range)).hours).toEqual({ timeZone: VN, windows: [{ weekday: 2, start: 480, end: 600 }] });
    // The owner's calendar is untouched.
    expect((await o.query<MyCalendar>(o.owner, 'kernel.calendar.get', range)).saved).toBe(false);

    await expect(o.exec(o.member, 'kernel.calendar.hours.save', { timeZone: VN, windows: [] })).rejects.toMatchObject({ code: 'WORKING_HOURS_EMPTY' });
    await expect(o.exec(o.member, 'kernel.calendar.hours.save', { timeZone: 'Nowhere/City', windows: [{ weekday: 1, start: 0, end: 60 }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A viewer reads their calendar and changes nothing.
    expect((await o.query<MyCalendar>(o.viewer, 'kernel.calendar.get', range)).saved).toBe(false);
    await expect(o.exec(o.viewer, 'kernel.calendar.hours.save', hours)).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.viewer, 'kernel.calendar.event.add', { startsAt: range.from, endsAt: range.to, timeZone: VN, kind: 'time_off' })).rejects.toMatchObject({ status: 403 });

    const audit = await admin((c) => c.query<{ command: string }>("SELECT command FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.calendar.%' AND outcome = 'ok' ORDER BY occurred_at, id", [o.orgId]));
    expect(audit.rows.map((r) => r.command)).toEqual(['kernel.calendar.hours.save', 'kernel.calendar.hours.save']);
  });

  it('keeps one whole set of hours when two first saves of a member race', async () => {
    const o = await org();
    const mon = { timeZone: VN, windows: [{ weekday: 1, start: 480, end: 600 }] };
    const tue = { timeZone: VN, windows: [{ weekday: 2, start: 540, end: 720 }, { weekday: 3, start: 540, end: 720 }] };
    await Promise.all([o.exec(o.member, 'kernel.calendar.hours.save', mon), o.exec(o.member, 'kernel.calendar.hours.save', tue)]);
    const { hours } = await o.query<MyCalendar>(o.member, 'kernel.calendar.get', dayRange(nextWorkday()));
    expect([mon, tue]).toContainEqual(hours);
  });

  it('takes a busy event out of the free slots and gives it back when cancelled', async () => {
    const o = await org();
    const day = nextWorkday();
    await o.exec(o.member, 'kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 540, end: 660 })) });
    const slots = () => o.query<{ start: string; end: string }[]>(o.member, 'kernel.calendar.slots', { ...dayRange(day), durationMin: 30 });
    expect((await slots()).map((s) => s.start)).toEqual([at(day, 540), at(day, 570), at(day, 600), at(day, 630)]);

    const event = await o.exec<CalendarEventView>(o.member, 'kernel.calendar.event.add', { startsAt: at(day, 560), endsAt: at(day, 600), timeZone: VN, title: '  Họp nội bộ  ', kind: 'manual' });
    expect(event).toMatchObject({ title: 'Họp nội bộ', kind: 'manual', timeZone: VN });
    expect((await slots()).map((s) => s.start)).toEqual([at(day, 600), at(day, 630)]);
    // Another meeting may overlap it: people double-book their own meetings.
    await o.exec(o.member, 'kernel.calendar.event.add', { startsAt: at(day, 570), endsAt: at(day, 630), timeZone: VN, kind: 'manual' });
    expect((await o.query<MyCalendar>(o.member, 'kernel.calendar.get', dayRange(day))).events).toHaveLength(2);
    // The owner sees nothing of it, and cannot cancel it.
    expect((await o.query<MyCalendar>(o.owner, 'kernel.calendar.get', dayRange(day))).events).toEqual([]);
    await expect(o.exec(o.owner, 'kernel.calendar.event.cancel', { eventId: event.id })).rejects.toMatchObject({ code: 'CALENDAR_EVENT_NOT_FOUND' });

    expect(await o.exec(o.member, 'kernel.calendar.event.cancel', { eventId: event.id })).toEqual({ eventId: event.id, cancelled: true });
    expect(await o.exec(o.member, 'kernel.calendar.event.cancel', { eventId: event.id })).toEqual({ eventId: event.id, cancelled: true });
    expect((await o.query<MyCalendar>(o.member, 'kernel.calendar.get', dayRange(day))).events).toHaveLength(1);
    expect((await slots()).map((s) => s.start)).toEqual([at(day, 540), at(day, 630)]);

    // A day off takes the whole day.
    await o.exec(o.member, 'kernel.calendar.event.add', { startsAt: dayRange(day).from, endsAt: dayRange(day).to, timeZone: VN, kind: 'time_off' });
    expect(await slots()).toEqual([]);
  });

  it('offers no slot on a public holiday', async () => {
    const o = await org();
    const holiday = nextWeekdayHoliday();
    expect(await o.query(o.member, 'kernel.calendar.slots', { ...dayRange(holiday), durationMin: 30 })).toEqual([]);
  });

  it('refuses two active bookings of one member that overlap, and lets a cancelled one go', async () => {
    const o = await org();
    const day = nextWorkday();
    const book = (user: string, from: number, to: number) =>
      admin((c) =>
        c.query("INSERT INTO crove_kernel.calendar_event (org_id, user_id, starts_at, ends_at, time_zone, kind, created_by) VALUES ($1, $2, $3, $4, $5, 'booking', $2) RETURNING id", [
          o.orgId,
          user,
          at(day, from),
          at(day, to),
          VN,
        ]),
      );
    const first = (await book(o.member, 600, 630)).rows[0] as { id: string };
    await expect(book(o.member, 615, 645)).rejects.toThrow(/calendar_event_no_double_booking/);
    // Back to back is fine; another member, and a manual event at the same time, too.
    await book(o.member, 630, 660);
    await book(o.owner, 600, 630);
    await o.exec(o.member, 'kernel.calendar.event.add', { startsAt: at(day, 600), endsAt: at(day, 630), timeZone: VN, kind: 'manual' });
    // A member does not cancel a booking from the calendar.
    await expect(o.exec(o.member, 'kernel.calendar.event.cancel', { eventId: first.id })).rejects.toMatchObject({ code: 'CALENDAR_EVENT_IS_BOOKING' });
    await admin((c) => c.query("UPDATE crove_kernel.calendar_event SET status = 'cancelled', cancelled_at = now(), cancelled_by = user_id WHERE org_id = $1 AND id = $2", [o.orgId, first.id]));
    await book(o.member, 615, 630);
  });

  it('keeps events ordered, at most 31 days long, and a cancellation stamped', async () => {
    const o = await org();
    const insert = (starts: string, ends: string, extra = '') =>
      admin((c) => c.query(`INSERT INTO crove_kernel.calendar_event (org_id, user_id, starts_at, ends_at, time_zone, created_by${extra ? ', status' : ''}) VALUES ($1, $2, $3, $4, $5, $2${extra ? `, '${extra}'` : ''})`, [o.orgId, o.member, starts, ends, VN]));
    await expect(insert('2030-01-01T10:00:00Z', '2030-01-01T10:00:00Z')).rejects.toThrow(/calendar_event_order/);
    await expect(insert('2030-01-01T00:00:00Z', '2030-02-02T00:00:00Z')).rejects.toThrow(/calendar_event_length/);
    await expect(insert('2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', 'cancelled')).rejects.toThrow(/calendar_event_cancelled/);
    await expect(o.exec(o.member, 'kernel.calendar.event.add', { startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-02-02T00:00:00Z', timeZone: VN, kind: 'time_off' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
