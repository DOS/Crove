// Team event types (#1373, plan docs/plan/calendar.md step C8) on PostgreSQL 17: a round-robin type offers a time when
// one host is free and books the free host with the fewest upcoming bookings; a collective type offers a time only
// when every host is free and holds every host's calendar, so a cancel or a move acts on all of them. Concurrent
// confirmations of one slot end with one booking, across overlapping teams too. Only owners and admins set up a
// team. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { isVietnamHoliday, zonedDate, zonedInstant, type BookingItem, type EventType, type EventTypeInput } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { bookingRequest, bookingView } from '../src/booking-page.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'test.crm.team' };

function bookableDay(offset = 3): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();
const dayRange = (date: string) => ({ from: at(date, 0), to: at(date, 1440) });

suite('team event types on PostgreSQL (#1373)', () => {
  const dbName = `crove_test_crm_team_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const draft = (hostUserId: string, over: Partial<EventTypeInput> = {}): EventTypeInput => ({
    slug: 'nhom',
    title: 'Họp nhóm',
    description: null,
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    horizonDays: 60,
    dailyLimit: null,
    locationKind: 'video',
    locationValue: null,
    hostUserId,
    assignment: 'single',
    coHostUserIds: [],
    ...over,
  });

  // An org with three members (a, b, c) who keep every hour of every day free, in Vietnam time.
  async function org() {
    const db = createDb(appPool);
    const person = (who: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${who}-${randomUUID().slice(0, 8)}@team.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(app, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const [a, b, c, viewer] = [await person('a'), await person('b'), await person('c'), await person('viewer')];
    await admin((cl) =>
      cl.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [
        orgId,
        a,
        b,
        c,
        viewer,
      ]),
    );
    const slug = (await admin((cl) => cl.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))).rows[0]?.slug as string;
    for (const user of [a, b, c]) {
      await app.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) }, { actor: asUser(user), orgId });
    }
    const exec = <T>(user: string, command: string, input: unknown) => app.execute<T>(command, input, { actor: asUser(user), orgId });
    const busy = (user: string, date: string, minute: number) =>
      exec(user, 'kernel.calendar.event.add', { startsAt: at(date, minute), endsAt: at(date, minute + 30), timeZone: VN, title: 'Bận', kind: 'manual' });
    const confirm = (bookingId: string) => worker.execute<{ status: string; refusal?: string }>('crm.booking.confirm', { bookingId }, { actor: SYSTEM, orgId });
    // Asks for a time on the type's page and returns the pending booking's id.
    const request = async (type: string, startsAt: string, email = `khach-${randomUUID().slice(0, 6)}@example.test`) => {
      const token = await bookingRequest(app, slug, type, { startsAt, name: 'Khách', email, timeZone: VN });
      if (!token) throw new Error('no request');
      const { rows } = await admin((cl) => cl.query<{ id: string }>('SELECT id FROM crove_crm.booking WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [orgId]));
      return rows[0]?.id as string;
    };
    // The calendars a booking holds: who, which events, and their status.
    const held = async (bookingId: string) =>
      (
        await admin((cl) =>
          cl.query<{ user_id: string; status: string; starts_at: Date }>(
            `SELECT ev.user_id, ev.status, ev.starts_at FROM crove_crm.booking b
             JOIN crove_kernel.calendar_event ev ON ev.org_id = b.org_id AND ev.id = ANY (ARRAY[b.calendar_event_id] || b.hold_event_ids)
             WHERE b.org_id = $1 AND b.id = $2 ORDER BY array_position(ARRAY[b.calendar_event_id] || b.hold_event_ids, ev.id)`,
            [orgId, bookingId],
          ),
        )
      ).rows;
    const slots = async (type: string, date: string) => (await bookingView(app, slug, type, dayRange(date)))?.slots.map((s) => s.start) ?? [];
    return { orgId, slug, owner, a, b, c, viewer, exec, busy, confirm, request, held, slots };
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

  it('lets only owners and admins set up a team, with co-hosts who may host, none of them the lead', async () => {
    const o = await org();
    const team = draft(o.a, { assignment: 'round_robin', coHostUserIds: [o.b] });
    // A member leads it but may not book the others' time.
    await expect(o.exec(o.a, 'crm.event_type.create', team)).rejects.toMatchObject({ code: 'EVENT_TYPE_TEAM_FORBIDDEN' });
    for (const bad of [
      { assignment: 'round_robin' as const, coHostUserIds: [] },
      { assignment: 'single' as const, coHostUserIds: [o.b] },
      { assignment: 'collective' as const, coHostUserIds: [o.a] },
      { assignment: 'collective' as const, coHostUserIds: [o.b, o.b] },
    ]) {
      await expect(o.exec(o.owner, 'crm.event_type.create', draft(o.a, bad)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'EVENT_TYPE_TEAM_INVALID' });
    }
    await expect(o.exec(o.owner, 'crm.event_type.create', draft(o.a, { assignment: 'collective', coHostUserIds: [o.viewer] }))).rejects.toMatchObject({
      code: 'EVENT_TYPE_HOST_INVALID',
    });
    const created = await o.exec<EventType>(o.owner, 'crm.event_type.create', team);
    expect(created).toMatchObject({ assignment: 'round_robin', coHostUserIds: [o.b], hostUserId: o.a });

    // The lead edits everything else, but not the team.
    const { id: eventTypeId, active: _a, createdAt: _c, updatedAt: _u, ...fields } = created;
    const renamed = await o.exec<EventType>(o.a, 'crm.event_type.update', { ...fields, eventTypeId, title: 'Họp nhóm mới' });
    expect(renamed).toMatchObject({ title: 'Họp nhóm mới', coHostUserIds: [o.b] });
    await expect(o.exec(o.a, 'crm.event_type.update', { ...fields, eventTypeId, coHostUserIds: [o.b, o.c] })).rejects.toMatchObject({ code: 'EVENT_TYPE_TEAM_FORBIDDEN' });
    await expect(o.exec(o.a, 'crm.event_type.update', { ...fields, eventTypeId, assignment: 'collective' })).rejects.toMatchObject({ code: 'EVENT_TYPE_TEAM_FORBIDDEN' });
    const widened = await o.exec<EventType>(o.owner, 'crm.event_type.update', { ...fields, eventTypeId, assignment: 'collective', coHostUserIds: [o.b, o.c] });
    expect(widened).toMatchObject({ assignment: 'collective', coHostUserIds: [o.b, o.c] });
    // The database holds the same rules against any other writer.
    await expect(
      admin((cl) => cl.query('UPDATE crove_crm.event_type SET co_host_user_ids = ARRAY[host_user_id] WHERE org_id = $1 AND id = $2', [o.orgId, eventTypeId])),
    ).rejects.toMatchObject({ constraint: 'event_type_co_hosts' });
  });

  it('round-robin: offers a time one host has free and books the free host with the fewest upcoming bookings', async () => {
    const o = await org();
    await o.exec(o.owner, 'crm.event_type.create', draft(o.a, { assignment: 'round_robin', coHostUserIds: [o.b] }));
    const day = bookableDay();
    await o.busy(o.a, day, 600);
    // a is busy at 10:00, b is not: the time is still offered.
    expect(await o.slots('nhom', day)).toContain(at(day, 600));
    await o.busy(o.b, day, 660);
    await o.busy(o.a, day, 660);
    expect(await o.slots('nhom', day)).not.toContain(at(day, 660));

    const first = await o.request('nhom', at(day, 600));
    expect(await o.confirm(first)).toMatchObject({ status: 'confirmed' });
    expect((await o.held(first)).map((h) => h.user_id)).toEqual([o.b]);
    // Both free at 12:00: a has no upcoming booking of the type, b has one.
    const second = await o.request('nhom', at(day, 720));
    expect(await o.confirm(second)).toMatchObject({ status: 'confirmed' });
    expect((await o.held(second)).map((h) => h.user_id)).toEqual([o.a]);
    // One each: the tie goes to the lower member id.
    const third = await o.request('nhom', at(day, 780));
    expect(await o.confirm(third)).toMatchObject({ status: 'confirmed' });
    expect((await o.held(third)).map((h) => h.user_id)).toEqual([[o.a, o.b].sort()[0]]);

    // b sees the booking on their calendar under "mine", and may cancel it; c, outside the team, may not.
    const mine = await app.query<BookingItem[]>('crm.booking.list', { scope: 'mine', period: 'upcoming' }, { actor: asUser(o.b), orgId: o.orgId });
    expect(mine.find((x) => x.id === first)).toMatchObject({ hostUserId: o.b, hostUserIds: [o.b] });
    await expect(o.exec(o.c, 'crm.booking.cancel', { bookingId: first })).rejects.toMatchObject({ code: 'BOOKING_HOST_FORBIDDEN' });
    await o.exec(o.b, 'crm.booking.cancel', { bookingId: first });
    expect((await o.held(first)).map((h) => h.status)).toEqual(['cancelled']);

    // A host who leaves the org is skipped: their free time is no longer offered.
    await admin((cl) => cl.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.b]));
    const other = bookableDay(4);
    await o.busy(o.a, other, 600);
    expect(await o.slots('nhom', other)).not.toContain(at(other, 600));
  });

  it('collective: offers a time only when every host is free, and holds, moves and cancels every host together', async () => {
    const o = await org();
    await o.exec(o.owner, 'crm.event_type.create', draft(o.a, { assignment: 'collective', coHostUserIds: [o.b, o.c] }));
    const day = bookableDay();
    await o.busy(o.c, day, 600);
    expect(await o.slots('nhom', day)).not.toContain(at(day, 600));
    expect(await o.slots('nhom', day)).toContain(at(day, 630));

    // A request for a time one host has taken is refused.
    const taken = await o.request('nhom', at(day, 600));
    expect(await o.confirm(taken)).toMatchObject({ status: 'refused', refusal: 'taken' });

    const id = await o.request('nhom', at(day, 540));
    expect(await o.confirm(id)).toMatchObject({ status: 'confirmed' });
    expect(await o.held(id)).toEqual([o.a, o.b, o.c].map((user_id) => ({ user_id, status: 'active', starts_at: new Date(at(day, 540)) })));
    // Every host mailed, with the visitor.
    const mails = await admin((cl) => cl.query<{ recipient: string }>("SELECT payload ->> 'recipient' AS recipient FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2", [o.orgId, id]));
    expect(mails.rows.map((m) => m.recipient).sort()).toEqual(['host', 'host', 'host', 'visitor']);
    const listed = await app.query<BookingItem[]>('crm.booking.list', { scope: 'mine', period: 'upcoming' }, { actor: asUser(o.c), orgId: o.orgId });
    expect(listed.find((x) => x.id === id)).toMatchObject({ hostUserId: o.a, hostUserIds: [o.a, o.b, o.c] });

    // A move needs every host free at the new time; then all of them move.
    await o.busy(o.b, day, 840);
    await expect(o.exec(o.owner, 'crm.booking.move', { bookingId: id, startsAt: at(day, 840) })).rejects.toMatchObject({ code: 'BOOKING_TIME_TAKEN' });
    await o.exec(o.c, 'crm.booking.move', { bookingId: id, startsAt: at(day, 900) });
    expect((await o.held(id)).map((h) => [h.status, h.starts_at.toISOString()])).toEqual([0, 1, 2].map(() => ['active', at(day, 900)]));
    expect(await o.slots('nhom', day)).toContain(at(day, 540));

    await o.exec(o.b, 'crm.booking.cancel', { bookingId: id });
    expect((await o.held(id)).map((h) => h.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(await o.slots('nhom', day)).toContain(at(day, 900));
  });

  it('confirms one booking of a slot when many arrive at once, across a team and a single type sharing a host', async () => {
    const o = await org();
    await o.exec(o.owner, 'crm.event_type.create', draft(o.a, { assignment: 'collective', coHostUserIds: [o.b] }));
    await o.exec(o.owner, 'crm.event_type.create', draft(o.b, { slug: 'rieng', title: 'Riêng b' }));
    await o.exec(o.owner, 'crm.event_type.create', draft(o.c, { slug: 'luan-phien', assignment: 'round_robin', coHostUserIds: [o.b] }));
    const day = bookableDay();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await o.request('nhom', at(day, 600)));
    for (let i = 0; i < 20; i++) ids.push(await o.request('rieng', at(day, 600)));
    const outcomes = await Promise.all(ids.map((id) => o.confirm(id)));
    // b is in both types: one booking holds b at 10:00, whichever came first.
    expect(outcomes.filter((x) => x.status === 'confirmed')).toHaveLength(1);
    // The round-robin type still has c free at that time, and books c.
    const rr = await o.request('luan-phien', at(day, 600));
    expect(await o.confirm(rr)).toMatchObject({ status: 'confirmed' });
    expect((await o.held(rr)).map((h) => h.user_id)).toEqual([o.c]);
  });
});
