// The public booking page (#1318) on PostgreSQL 17: the page reads free slots only, a request records a pending
// booking, and the worker's crm.booking.confirm holds the host's time, links a party and confirms it, or refuses it.
// 200 confirmations of one slot at once end with exactly one booking. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { isVietnamHoliday, zonedDate, zonedInstant, type BookingItem, type EventType, type PersonalDataErasure, type PersonalDataResult } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { bookingManageAsk, bookingManageView, bookingRequest, bookingStatus, bookingView } from '../src/booking-page.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'test.crm.booking' };

// A day at least three days ahead that is not a Vietnamese public holiday, in Vietnam time.
function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();
const dayRange = (date: string) => ({ from: at(date, 0), to: at(date, 1440) });

suite('the public booking page on PostgreSQL (#1318)', () => {
  const dbName = `crove_test_crm_bookings_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let app: Runtime;
  let worker: Runtime;
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

  const register = (db: Db) =>
    new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });

  // An org whose member hosts a 30-minute call, bookable all day every day in Vietnam time.
  async function org(over: Partial<{ dailyLimit: number | null; minNoticeMin: number }> = {}) {
    const db = createDb(appPool);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@book.test`, name: null });
    const host = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `host-${randomUUID().slice(0, 8)}@book.test`, name: null });
    const { orgId } = await createOrg(app, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, host]));
    const slug = (await admin((c) => c.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))).rows[0]?.slug as string;
    await app.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) }, { actor: asUser(host), orgId });
    const type = await app.execute<EventType>(
      'crm.event_type.create',
      {
        slug: 'tu-van',
        title: 'Tư vấn thuế',
        description: null,
        durationMin: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        minNoticeMin: over.minNoticeMin ?? 0,
        horizonDays: 60,
        dailyLimit: over.dailyLimit ?? null,
        locationKind: 'video',
        locationValue: 'https://meet.example.test/x',
        hostUserId: host,
      },
      { actor: asUser(host), orgId },
    );
    const confirm = (bookingId: string) => worker.execute<{ status: string; refusal?: string }>('crm.booking.confirm', { bookingId }, { actor: SYSTEM, orgId });
    // The bookings the definer recorded, oldest first.
    const bookings = async () =>
      (await admin((c) => c.query<{ id: string; status: string; refusal: string | null; party_id: string | null; calendar_event_id: string | null }>('SELECT id, status, refusal, party_id, calendar_event_id FROM crove_crm.booking WHERE org_id = $1 ORDER BY created_at, id', [orgId]))).rows;
    return { orgId, slug, owner, host, type, confirm, bookings };
  }

  const visitor = (startsAt: string, over: Record<string, unknown> = {}) => ({ startsAt, name: 'Nguyễn Văn Khách', email: 'Khach@Example.test', phone: '0901234567', note: 'Hỏi về thuế', timeZone: VN, ...over });

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
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 10 });
    app = register(createDb(appPool));
    worker = register(createDb(workerPool));
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows free slots only: nothing of the host calendar, nothing for an unknown or archived type', async () => {
    const o = await org();
    const day = bookableDay();
    const page = await bookingView(app, o.slug, 'tu-van', dayRange(day));
    expect(page).toMatchObject({ eventType: { slug: 'tu-van', title: 'Tư vấn thuế', durationMin: 30, locationKind: 'video' } });
    expect(page?.slots).toHaveLength(48);
    await app.execute('kernel.calendar.event.add', { startsAt: at(day, 600), endsAt: at(day, 660), timeZone: VN, title: 'Họp bí mật', kind: 'manual' }, { actor: asUser(o.host), orgId: o.orgId });
    const after = await bookingView(app, o.slug, 'tu-van', dayRange(day));
    expect(after?.slots.map((s) => s.start)).not.toContain(at(day, 600));
    expect(after?.slots).toHaveLength(46);
    // No title, no location, no host: the page carries the type's public fields and free slots only.
    expect(JSON.stringify(after)).not.toMatch(/bí mật|meet\.example|host/i);

    expect(await bookingView(app, o.slug, 'khong-co', dayRange(day))).toBeNull();
    expect(await bookingView(app, 'khong-co-to-chuc', 'tu-van', dayRange(day))).toBeNull();
    await app.execute('crm.event_type.set_active', { eventTypeId: o.type.id, active: false }, { actor: asUser(o.host), orgId: o.orgId });
    expect(await bookingView(app, o.slug, 'tu-van', dayRange(day))).toBeNull();
    await expect(bookingView(app, o.slug, 'tu-van', { from: at(day, 0), to: new Date(Date.parse(at(day, 0)) + 40 * DAY).toISOString() })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('books a free slot: pending, then confirmed by the worker, with the event held, the party linked and an activity', async () => {
    const o = await org();
    const day = bookableDay();
    const request = await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 540)));
    if (!request) throw new Error('no request');
    expect(await bookingStatus(app, o.slug, 'tu-van', request)).toMatchObject({ status: 'pending', refusal: null, startsAt: at(day, 540), endsAt: at(day, 570) });
    const [pending] = await o.bookings();
    expect(await o.confirm(pending?.id as string)).toMatchObject({ status: 'confirmed' });
    // A replayed job changes nothing.
    expect(await o.confirm(pending?.id as string)).toMatchObject({ status: 'confirmed' });
    expect(await bookingStatus(app, o.slug, 'tu-van', request)).toMatchObject({ status: 'confirmed' });

    const [booking] = await o.bookings();
    const event = (await admin((c) => c.query('SELECT user_id, kind, title, starts_at FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2', [o.orgId, booking?.calendar_event_id]))).rows[0];
    expect(event).toMatchObject({ user_id: o.host, kind: 'booking', title: 'Tư vấn thuế: Nguyễn Văn Khách' });
    const party = (await admin((c) => c.query('SELECT name, email, phone, kind, source_trust FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, booking?.party_id]))).rows[0];
    expect(party).toMatchObject({ name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: '0901234567', kind: 'person', source_trust: 'external' });
    // A confirmation writes the party's creation and the booking at the same instant: the creation sorts first.
    const activity = (await admin((c) => c.query<{ kind: string; summary: string }>("SELECT kind, summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 ORDER BY occurred_at, kind <> 'party.created', id", [o.orgId, booking?.party_id]))).rows;
    expect(activity.map((a) => a.kind)).toEqual(['party.created', 'crm.booking.confirmed']);
    expect(activity[1]?.summary).toContain('Tư vấn thuế lúc 09:00');
    // The slot is gone from the page.
    expect((await bookingView(app, o.slug, 'tu-van', dayRange(day)))?.slots.map((s) => s.start)).not.toContain(at(day, 540));

    // The same visitor again, another slot: the same party.
    const again = await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 720), { email: 'KHACH@example.test' }));
    if (!again) throw new Error('no request');
    const second = (await o.bookings())[1];
    expect(await o.confirm(second?.id as string)).toMatchObject({ status: 'confirmed' });
    expect((await o.bookings())[1]?.party_id).toBe(booking?.party_id);

    // The visitor asks to be erased: both bookings lose the name, email, phone and note, and the finder sees none.
    const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
    const erased = await app.execute<PersonalDataErasure>('kernel.personal_data.erase', { value: 'khach@example.test' }, { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    expect(erased.erased).toEqual(
      expect.arrayContaining(['visitor_name', 'email', 'phone', 'note'].map((c) => expect.objectContaining({ column: `crove_crm.booking.${c}`, rows: 2 }))),
    );
    const left = (await admin((c) => c.query('SELECT visitor_name, email, phone, note FROM crove_crm.booking WHERE org_id = $1', [o.orgId]))).rows;
    expect(left).toEqual([0, 1].map(() => ({ visitor_name: null, email: null, phone: null, note: null })));
    const found = await app.query<PersonalDataResult>('kernel.personal_data.find', { value: '0901234567' }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(found.matches.filter((m) => m.column.startsWith('crove_crm.booking'))).toEqual([]);
  });

  it('refuses a taken time, a full day and an archived type, and turns away bad requests at once', async () => {
    const o = await org({ dailyLimit: 1 });
    const day = bookableDay();
    const first = await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 540)));
    const same = await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 540), { email: 'other@example.test' }));
    const later = await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 900), { email: 'third@example.test' }));
    const [a, b, c] = await o.bookings();
    expect(await o.confirm(a?.id as string)).toMatchObject({ status: 'confirmed' });
    expect(await o.confirm(b?.id as string)).toMatchObject({ status: 'refused', refusal: 'taken' });
    // The day's one booking is made: the next one on that day is no longer offered.
    expect(await o.confirm(c?.id as string)).toMatchObject({ status: 'refused', refusal: 'unavailable' });
    expect(await bookingStatus(app, o.slug, 'tu-van', same)).toMatchObject({ status: 'refused', refusal: 'taken' });
    expect(await bookingStatus(app, o.slug, 'tu-van', later)).toMatchObject({ status: 'refused', refusal: 'unavailable' });
    expect(await bookingStatus(app, o.slug, 'tu-van', first)).toMatchObject({ status: 'confirmed' });

    // Another day, then the type is archived before the worker gets to it.
    const other = bookableDay(5);
    await bookingRequest(app, o.slug, 'tu-van', visitor(at(other, 540)));
    await app.execute('crm.event_type.set_active', { eventTypeId: o.type.id, active: false }, { actor: asUser(o.host), orgId: o.orgId });
    expect(await o.confirm((await o.bookings())[3]?.id as string)).toMatchObject({ status: 'refused', refusal: 'unavailable' });

    const p = await org({ minNoticeMin: 24 * 60 });
    await expect(bookingRequest(app, p.slug, 'tu-van', visitor(new Date(Date.now() + 3_600_000).toISOString()))).rejects.toMatchObject({ code: 'BOOKING_TIME_UNAVAILABLE' });
    for (const bad of [{ email: 'not-an-email' }, { name: '' }, { timeZone: 'Nowhere/City' }, { note: 'x'.repeat(1001) }]) {
      await expect(bookingRequest(app, p.slug, 'tu-van', visitor(at(bookableDay(), 600), bad)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(await bookingRequest(app, p.slug, 'khong-co', visitor(at(bookableDay(), 600)))).toBeNull();
    expect(await bookingStatus(app, p.slug, 'tu-van', { token: 'A'.repeat(43) })).toBeNull();
    expect(await bookingStatus(app, p.slug, 'tu-van', { token: 'short' })).toBeNull();
    // A token of one page reads nothing on another.
    expect(await bookingStatus(app, p.slug, 'tu-van', first)).toBeNull();
    expect(await p.bookings()).toEqual([]);
  });

  it('mails the visitor and the host, and a manage link moves or cancels the booking once (#1319)', async () => {
    const o = await org();
    const day = bookableDay();
    await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 540)));
    const id = (await o.bookings())[0]?.id as string;
    await o.confirm(id);
    const [booking] = await o.bookings();
    // The visitor's and the host's mail of one step share a transaction, so the same created_at, and ids made in the
    // same millisecond (uuid_v7) in random order: within a step, the visitor's is listed first.
    const mails = async () =>
      (
        await admin((c) =>
          c.query<{ source: string; to_address: string; template_key: string; status: string; subject: string; payload: Record<string, unknown> }>(
            "SELECT source, to_address, template_key, status, subject, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2 ORDER BY created_at, payload->>'recipient' = 'host', id",
            [o.orgId, id],
          ),
        )
      ).rows;
    const confirmed = await mails();
    expect(confirmed.map((m) => [m.source, m.template_key, m.status, m.payload.recipient])).toEqual([
      ['crm.booking.confirmed', 'crm.booking', 'queued', 'visitor'],
      ['crm.booking.confirmed', 'crm.booking', 'queued', 'host'],
    ]);
    expect(confirmed[0]?.to_address).toBe('khach@example.test');
    expect(confirmed[1]?.to_address).toMatch(/^host-.*@book\.test$/);
    // No mail's merge data or subject holds a token or a detail of the visitor: the template reads them at send time.
    expect(JSON.stringify(confirmed)).not.toMatch(/[0-9a-f]{32}\.[0-9]+\.[0-9a-f]{32}|Nguyễn|0901234567|Hỏi về/);
    const data = await worker.execute<{ token: string | null; visitor: unknown }>('crm.booking.mail_data', { bookingId: id, revision: 0 }, { actor: SYSTEM, orgId: o.orgId });
    expect(data.visitor).toEqual({ name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: '0901234567', note: 'Hỏi về thuế' });
    const scheduled = await admin((c) => c.query("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'crm.booking.scheduled'", [o.orgId]));
    expect(scheduled.rows.map((r) => r.payload)).toEqual([{ booking_id: id, starts_at: at(day, 540) }]);

    // The link a mail of this revision carries.
    const link = async (revision: number) =>
      (await worker.execute<{ token: string | null }>('crm.booking.mail_data', { bookingId: id, revision }, { actor: SYSTEM, orgId: o.orgId })).token as string;
    const first = await link(0);
    expect(first).toMatch(/^[0-9a-f]{32}\.0\.[0-9a-f]{32}$/);
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: first })).toMatchObject({ status: 'confirmed', usable: true, startsAt: at(day, 540), outcome: null });
    // A forged MAC, another revision or another page's slugs read nothing.
    const forged = `${first.slice(0, -1)}${first.endsWith('0') ? '1' : '0'}`;
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: forged })).toBeNull();
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: first.replace('.0.', '.1.') })).toBeNull();
    const p = await org();
    expect(await bookingManageView(app, p.slug, 'tu-van', { manage: first })).toBeNull();

    // A move to a taken time is refused and the link keeps working.
    await app.execute('kernel.calendar.event.add', { startsAt: at(day, 600), endsAt: at(day, 660), timeZone: VN, title: 'Bận', kind: 'manual' }, { actor: asUser(o.host), orgId: o.orgId });
    const taken = await bookingManageAsk(app, o.slug, 'tu-van', { manage: first, action: 'move', startsAt: at(day, 600) });
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: first })).toMatchObject({ requestId: taken?.requestId, outcome: null });
    const manage = (requestId: string) => worker.execute<{ outcome: string }>('crm.booking.manage', { bookingId: id, requestId }, { actor: SYSTEM, orgId: o.orgId });
    expect(await manage(taken?.requestId as string)).toEqual({ bookingId: id, outcome: 'taken' });
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: first })).toMatchObject({ usable: true, outcome: 'taken', startsAt: at(day, 540) });

    // A move to a free time holds it, frees the old one, and ends the link.
    const moved = await bookingManageAsk(app, o.slug, 'tu-van', { manage: first, action: 'move', startsAt: at(day, 720) });
    expect(await manage(moved?.requestId as string)).toEqual({ bookingId: id, outcome: 'moved' });
    // The same ask again changes nothing.
    expect(await manage(moved?.requestId as string)).toEqual({ bookingId: id, outcome: 'none' });
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: first })).toMatchObject({ usable: false, outcome: 'moved', startsAt: at(day, 720), endsAt: at(day, 750) });
    expect(await bookingManageAsk(app, o.slug, 'tu-van', { manage: first, action: 'cancel' })).toBeNull();
    const event = (await admin((c) => c.query('SELECT starts_at, status FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2', [o.orgId, booking?.calendar_event_id]))).rows[0];
    expect(event).toMatchObject({ status: 'active' });
    expect(new Date(event?.starts_at).toISOString()).toBe(at(day, 720));
    const slots = async () => (await bookingView(app, o.slug, 'tu-van', dayRange(day)))?.slots.map((x) => x.start) ?? [];
    expect(await slots()).toContain(at(day, 540));
    expect(await slots()).not.toContain(at(day, 720));
    expect((await mails()).filter((m) => m.source === 'crm.booking.moved').map((m) => m.payload.recipient)).toEqual(['visitor', 'host']);

    // Reminders: only for the time the booking still starts at, and once per lead.
    const remind = (startsAt: string, lead: '24h' | '1h') => worker.execute<{ sent: boolean }>('crm.booking.remind', { bookingId: id, startsAt, lead }, { actor: SYSTEM, orgId: o.orgId });
    expect(await remind(at(day, 540), '24h')).toEqual({ sent: false });
    expect(await remind(at(day, 720), '24h')).toEqual({ sent: true });
    expect(await remind(at(day, 720), '24h')).toEqual({ sent: false });
    expect(await remind(at(day, 720), '1h')).toEqual({ sent: true });

    // A cancel with the new link frees the slot, ends the link, and no reminder goes out after it.
    // A mail of the first revision sent only now carries no link; one of the new revision does.
    expect(await link(0)).toBeNull();
    const second = await link(1);
    expect(second).toMatch(/\.1\./);
    const cancel = await bookingManageAsk(app, o.slug, 'tu-van', { manage: second, action: 'cancel' });
    expect(await manage(cancel?.requestId as string)).toEqual({ bookingId: id, outcome: 'cancelled' });
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: second })).toMatchObject({ status: 'cancelled', usable: false, outcome: 'cancelled' });
    expect(await bookingManageAsk(app, o.slug, 'tu-van', { manage: second, action: 'cancel' })).toBeNull();
    expect((await admin((c) => c.query('SELECT status FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2', [o.orgId, booking?.calendar_event_id]))).rows[0]).toMatchObject({ status: 'cancelled' });
    expect(await slots()).toContain(at(day, 720));
    expect(await link(2)).toBeNull();
    const before = (await mails()).length;
    await admin((c) => c.query("DELETE FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'crm.booking.remind_1h'", [o.orgId]));
    expect(await remind(at(day, 720), '1h')).toEqual({ sent: false });
    expect((await mails()).length).toBe(before - 1);
    expect((await mails()).filter((m) => m.source === 'crm.booking.cancelled').map((m) => m.payload.recipient)).toEqual(['visitor', 'host']);
    // Same instant for the party's creation and the confirmation: the creation sorts first.
    const activity = (await admin((c) => c.query<{ kind: string }>('SELECT kind FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 ORDER BY occurred_at, kind <> \'party.created\', id', [o.orgId, booking?.party_id]))).rows;
    expect(activity.map((a) => a.kind)).toEqual(['party.created', 'crm.booking.confirmed', 'crm.booking.moved', 'crm.booking.cancelled']);
    // Bad asks are turned away before anything is recorded.
    await expect(bookingManageAsk(app, o.slug, 'tu-van', { manage: second, action: 'drop' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bookingManageAsk(app, o.slug, 'tu-van', { manage: second, action: 'move' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('takes no cancel or move once the booking has started (#1319)', async () => {
    const o = await org();
    const day = bookableDay();
    await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 540)));
    const id = (await o.bookings())[0]?.id as string;
    await o.confirm(id);
    const { token } = await worker.execute<{ token: string }>('crm.booking.mail_data', { bookingId: id, revision: 0 }, { actor: SYSTEM, orgId: o.orgId });
    // An ask recorded before the start, which the worker reaches after it.
    const late = await bookingManageAsk(app, o.slug, 'tu-van', { manage: token, action: 'cancel' });
    await admin((c) =>
      c.query("UPDATE crove_crm.booking SET starts_at = now() - interval '10 minutes', ends_at = now() + interval '20 minutes' WHERE org_id = $1 AND id = $2", [o.orgId, id]),
    );
    expect(await worker.execute('crm.booking.manage', { bookingId: id, requestId: late?.requestId }, { actor: SYSTEM, orgId: o.orgId })).toEqual({ bookingId: id, outcome: 'unavailable' });
    expect(await bookingManageView(app, o.slug, 'tu-van', { manage: token })).toMatchObject({ status: 'confirmed', usable: false, outcome: 'unavailable' });
    expect(await bookingManageAsk(app, o.slug, 'tu-van', { manage: token, action: 'cancel' })).toBeNull();
  });

  it('lists bookings for their host and for owners, and the host cancels or moves one (#1320)', async () => {
    const o = await org();
    const day = bookableDay();
    await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 540)));
    await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 600), { email: 'hai@example.test', name: 'Trần Thị Hai' }));
    for (const b of await o.bookings()) await o.confirm(b.id);
    const [first, second] = await o.bookings();
    const list = (actor: string, scope: 'mine' | 'org', period: 'upcoming' | 'past' = 'upcoming') =>
      app.query<BookingItem[]>('crm.booking.list', { scope, period }, { actor: asUser(actor), orgId: o.orgId });

    const mine = await list(o.host, 'mine');
    expect(mine.map((b) => [b.startsAt, b.status, b.visitor.name])).toEqual([
      [at(day, 540), 'confirmed', 'Nguyễn Văn Khách'],
      [at(day, 600), 'confirmed', 'Trần Thị Hai'],
    ]);
    expect(mine[0]).toMatchObject({ eventType: { slug: 'tu-van', title: 'Tư vấn thuế' }, hostUserId: o.host, partyId: first?.party_id });
    // The owner hosts nothing but sees the org's; the host may not ask for the org's.
    expect(await list(o.owner, 'mine')).toEqual([]);
    expect(await list(o.owner, 'org')).toHaveLength(2);
    await expect(list(o.host, 'org')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await list(o.host, 'mine', 'past')).toEqual([]);

    // Another member may not touch the host's bookings; the owner may.
    const other = await upsertIdentity(createDb(appPool), { issuer: 'test', subject: randomUUID(), email: `other-${randomUUID().slice(0, 8)}@book.test`, name: null });
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, other]));
    await expect(app.execute('crm.booking.cancel', { bookingId: first?.id }, { actor: asUser(other), orgId: o.orgId })).rejects.toMatchObject({ code: 'BOOKING_HOST_FORBIDDEN' });

    // The host moves the first to a free time; a taken one is refused and nothing changes.
    await expect(app.execute('crm.booking.move', { bookingId: first?.id, startsAt: at(day, 600) }, { actor: asUser(o.host), orgId: o.orgId })).rejects.toMatchObject({ code: 'BOOKING_TIME_TAKEN' });
    expect(await app.execute('crm.booking.move', { bookingId: first?.id, startsAt: at(day, 720) }, { actor: asUser(o.host), orgId: o.orgId })).toEqual({ bookingId: first?.id, startsAt: at(day, 720) });
    // The owner cancels the second: its slot is free again.
    await app.execute('crm.booking.cancel', { bookingId: second?.id }, { actor: asUser(o.owner), orgId: o.orgId });
    await expect(app.execute('crm.booking.cancel', { bookingId: second?.id }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'BOOKING_NOT_CHANGEABLE' });
    const slots = (await bookingView(app, o.slug, 'tu-van', dayRange(day)))?.slots.map((x) => x.start) ?? [];
    expect(slots).toContain(at(day, 540));
    expect(slots).toContain(at(day, 600));
    expect(slots).not.toContain(at(day, 720));
    expect((await list(o.host, 'mine')).map((b) => [b.startsAt, b.status])).toEqual([
      [at(day, 600), 'cancelled'],
      [at(day, 720), 'confirmed'],
    ]);

    // The visitor is mailed and the host is not (they acted); the party's timeline says the host did it.
    const mails = await admin((c) =>
      c.query<{ source: string; recipient: string }>("SELECT source, payload->>'recipient' AS recipient FROM crove_kernel.mail_message WHERE org_id = $1 AND source IN ('crm.booking.moved', 'crm.booking.cancelled') ORDER BY created_at, id", [o.orgId]),
    );
    expect(mails.rows).toEqual([
      { source: 'crm.booking.moved', recipient: 'visitor' },
      { source: 'crm.booking.cancelled', recipient: 'visitor' },
    ]);
    const activity = await admin((c) => c.query<{ summary: string }>("SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND kind IN ('crm.booking.moved', 'crm.booking.cancelled') ORDER BY occurred_at, id", [o.orgId]));
    expect(activity.rows.map((a) => a.summary.split(' ').slice(0, 5).join(' '))).toEqual(['Người chủ trì đổi lịch', 'Người chủ trì hủy lịch']);
  });

  it('caps requests per event type at 30 an hour', async () => {
    const o = await org();
    const day = bookableDay();
    for (let i = 0; i < 30; i++) await bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 30 * i), { email: `v${i}@example.test` }));
    await expect(bookingRequest(app, o.slug, 'tu-van', visitor(at(day, 1000)))).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('confirms exactly one of 200 bookings of one slot made at once', { timeout: 120_000 }, async () => {
    const o = await org();
    const startsAt = at(bookableDay(), 600);
    // 200 visitors asked for the same slot (recorded directly: the request definer caps requests per type per hour).
    await admin((c) =>
      c.query(
        `INSERT INTO crove_crm.booking (org_id, event_type_id, starts_at, ends_at, visitor_name, email, time_zone)
         SELECT $1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes', 'Khách ' || i, 'k' || i || '@example.test', $4
         FROM generate_series(1, 200) i`,
        [o.orgId, o.type.id, startsAt, VN],
      ),
    );
    const ids = (await o.bookings()).map((b) => b.id);
    expect(ids).toHaveLength(200);
    const outcomes = await Promise.all(ids.map((id) => o.confirm(id)));
    expect(outcomes.filter((x) => x.status === 'confirmed')).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === 'refused' && x.refusal === 'taken')).toHaveLength(199);
    const events = await admin((c) => c.query("SELECT count(*)::int AS n FROM crove_kernel.calendar_event WHERE org_id = $1 AND kind = 'booking' AND status = 'active'", [o.orgId]));
    expect(events.rows[0]?.n).toBe(1);
  });
});
