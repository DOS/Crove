// A member's booking feed on PostgreSQL 17 (#1382): who makes, replaces and revokes one (each host their own), what its
// token opens (the member's confirmed bookings from 30 days back to 90 ahead, lead and co-host alike, with the event
// type, where, and the visitor's name only) and that nothing else of the org is reachable through it, through the
// definer and through GET /cal/<token>.ics. The public side runs as the API login role with no org context, as the
// HTTP edge does. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { isVietnamHoliday, zonedDate, zonedInstant, type EventTypeInput } from '@crove/kernel-contract';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { crmCommands, crmQueries, type BookingFeedView } from '@crove/mod-crm';
import { createAuthenticator } from '../src/auth.ts';
import { bookingFeed, type BookingFeed } from '../src/booking-feed.ts';
import { bookingRequest } from '../src/booking-page.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'test.crm.booking_feed' };

function bookableDay(offset: number): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();

suite('crm booking feed on PostgreSQL (#1382)', () => {
  const dbName = `crove_test_crm_feed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let app: Runtime;
  let worker: Runtime;
  let http: (limit?: RateLimiter) => ReturnType<typeof createHttpApp>;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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

  const draft = (slug: string, hostUserId: string, over: Partial<EventTypeInput> = {}): EventTypeInput => ({
    slug,
    title: 'Tư vấn thuế',
    description: null,
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    horizonDays: 120,
    dailyLimit: null,
    locationKind: 'video',
    locationValue: 'https://meet.example.test/abc',
    hostUserId,
    assignment: 'single',
    coHostUserIds: [],
    ...over,
  });

  // An org whose members a and b keep every hour of every day free, in Vietnam time, plus a viewer.
  async function org() {
    const db = createDb(appPool);
    const person = (who: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${who}-${randomUUID().slice(0, 8)}@feed.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(app, asUser(owner), `Văn phòng ${randomUUID().slice(0, 6)}`);
    const [a, b, viewer] = [await person('a'), await person('b'), await person('viewer')];
    await admin((cl) => cl.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, a, b, viewer]));
    const slug = (await admin((cl) => cl.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))).rows[0]?.slug as string;
    for (const user of [a, b]) {
      await app.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 0, end: 1440 })) }, { actor: asUser(user), orgId });
    }
    const exec = <T>(user: string, command: string, input: unknown = {}) => app.execute<T>(command, input, { actor: asUser(user), orgId });
    const get = (user: string) => app.query<BookingFeedView | null>('crm.booking_feed.get', {}, { actor: asUser(user), orgId });
    // Books a time on the type's page and confirms it, as the worker does; returns the booking's id.
    const book = async (type: string, startsAt: string, name = 'Chị Lan') => {
      const email = `khach-${randomUUID().slice(0, 6)}@example.test`;
      const token = await bookingRequest(app, slug, type, { startsAt, name, email, phone: '0901234567', note: 'Ghi chú riêng tư', timeZone: VN });
      if (!token) throw new Error('no request');
      const { rows } = await admin((cl) => cl.query<{ id: string }>('SELECT id FROM crove_crm.booking WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [orgId]));
      const bookingId = rows[0]?.id as string;
      const outcome = await worker.execute<{ status: string }>('crm.booking.confirm', { bookingId }, { actor: SYSTEM, orgId });
      expect(outcome).toMatchObject({ status: 'confirmed' });
      return bookingId;
    };
    return { orgId, slug, owner, a, b, viewer, exec, get, book };
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
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    app = register(createDb(appPool));
    worker = register(createDb(workerPool));
    const config = loadConfig({
      DATABASE_URL: login('crove_app', 'test-app-pw'),
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-booking-feed-0123',
      AUTH_ISSUER: 'crove-auth',
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      PUBLIC_URL: 'http://localhost:8080/',
    });
    http = (limit) =>
      createHttpApp({ config, runtime: app, store: {} as BlobStore, authenticate: createAuthenticator(config, createDb(appPool)), pool: appPool, aiEnabled: false, ...(limit ? { calendarFeedLimit: limit } : {}) });
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

  it("opens the member's own confirmed bookings of the window, lead and co-host, with the visitor's name only", async () => {
    const o = await org();
    await o.exec(o.owner, 'crm.event_type.create', draft('tu-van', o.a));
    await o.exec(o.owner, 'crm.event_type.create', draft('nhom', o.b, { title: 'Họp chung', assignment: 'collective', coHostUserIds: [o.a], locationKind: 'phone', locationValue: null }));
    await o.exec(o.owner, 'crm.event_type.create', draft('cua-b', o.b, { title: 'Riêng của B' }));
    const day = bookableDay(3);
    const later = bookableDay(80);
    const own = await o.book('tu-van', at(day, 540));
    const shared = await o.book('nhom', at(day, 600), 'Anh Minh');
    const far = await o.book('tu-van', at(later, 540));
    // b's own booking, and a cancelled one of a's: neither shows.
    await o.book('cua-b', at(day, 660));
    const cancelled = await o.book('tu-van', at(day, 720));
    await o.exec(o.a, 'crm.booking.cancel', { bookingId: cancelled });
    // A booking past the window (moved there directly: the type's horizon would refuse it). At 17:00, a time no other
    // booking here takes, since bookableDay(4) is the same date as bookableDay(3) when day 3 is a holiday.
    const tooFar = await o.book('tu-van', at(bookableDay(4), 1020));
    await admin((cl) => cl.query("UPDATE crove_kernel.calendar_event SET starts_at = starts_at + interval '120 days', ends_at = ends_at + interval '120 days' WHERE id = (SELECT calendar_event_id FROM crove_crm.booking WHERE id = $1)", [tooFar]));

    const { token } = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const feed = (await bookingFeed(app, token)) as BookingFeed;
    expect(feed.slug).toBe(o.slug);
    expect(feed.name).toMatch(/^Văn phòng /);
    expect(feed.events.map((e) => [e.id, e.title, e.visitorName, e.locationKind])).toEqual([
      [own, 'Tư vấn thuế', 'Chị Lan', 'video'],
      [shared, 'Họp chung', 'Anh Minh', 'phone'],
      [far, 'Tư vấn thuế', 'Chị Lan', 'video'],
    ]);
    expect(feed.events[0]).toEqual({ id: own, startsAt: expect.any(String), endsAt: expect.any(String), revision: 0, title: 'Tư vấn thuế', locationKind: 'video', location: 'https://meet.example.test/abc', visitorName: 'Chị Lan' });
    expect(Date.parse(feed.events[0]?.startsAt as string)).toBe(Date.parse(at(day, 540)));
    // No email, phone, note, or anyone's id.
    const text = JSON.stringify(feed);
    expect(text).not.toMatch(/@example\.test|0901234567|riêng tư/);
    for (const id of [o.a, o.b, o.owner, o.orgId]) expect(text).not.toContain(id);

    // b sees the shared booking as a co-host, and their own, never a's.
    const other = await o.exec<{ token: string }>(o.b, 'crm.booking_feed.create');
    expect(((await bookingFeed(app, other.token)) as BookingFeed).events.map((e) => e.title)).toEqual(['Họp chung', 'Riêng của B']);

    // A move shows the new time and a new revision; a cancel takes it out.
    await o.exec(o.a, 'crm.booking.move', { bookingId: own, startsAt: at(day, 900) });
    const moved = ((await bookingFeed(app, token)) as BookingFeed).events.find((e) => e.id === own);
    expect(moved).toMatchObject({ revision: 1 });
    expect(Date.parse(moved?.startsAt as string)).toBe(Date.parse(at(day, 900)));
    await o.exec(o.a, 'crm.booking.cancel', { bookingId: far });
    expect(((await bookingFeed(app, token)) as BookingFeed).events.map((e) => e.id)).toEqual([shared, own]);

    // Through the HTTP edge: an iCalendar file with an event per booking.
    const res = await http().request(`/cal/${token}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const ics = (await res.text()).replace(/\r\n /g, '');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain(`UID:feed-booking-${own}@crove\r\nSEQUENCE:1\r\n`);
    expect(ics).toContain('SUMMARY:Tư vấn thuế: Chị Lan\r\n');
    expect(ics).toContain(`URL:http://localhost:8080/o/${o.slug}/bookings\r\n`);
    expect((await http().request(`/cal/${token}`)).status).toBe(404);
    expect((await http().request(`/cal/${'x'.repeat(43)}.ics`)).status).toBe(404);
  });

  it('keeps one live feed per member: a new one revokes the old, and a revoked token opens nothing', async () => {
    const o = await org();
    expect(await o.get(o.a)).toBeNull();
    const first = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    const second = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    expect(await bookingFeed(app, first.token)).toBeNull();
    expect(await bookingFeed(app, second.token)).toMatchObject({ slug: o.slug, events: [] });
    // Another member's feed stays live beside it.
    const theirs = await o.exec<{ token: string }>(o.b, 'crm.booking_feed.create');
    const live = await admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_crm.booking_feed WHERE org_id = $1 AND revoked_at IS NULL', [o.orgId])).rows[0]?.n);
    expect(live).toBe(2);
    // Each member sees their own, never the token; the database keeps its hash only.
    const seen = await o.get(o.a);
    expect(seen).toEqual({ createdAt: expect.any(String) });
    expect(await o.get(o.owner)).toBeNull();
    const stored = await admin(async (c) => (await c.query<{ token_sha256: string }>('SELECT token_sha256 FROM crove_crm.booking_feed WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL', [o.orgId, o.a])).rows[0]?.token_sha256);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    const audit = await admin(async (c) => JSON.stringify((await c.query("SELECT * FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'crm.booking_feed.%'", [o.orgId])).rows));
    expect(audit).toContain('crm.booking_feed.create');
    for (const t of [first.token, second.token, theirs.token]) expect(audit).not.toContain(t);

    expect(await o.exec(o.a, 'crm.booking_feed.revoke')).toEqual({ revoked: true });
    expect(await o.exec(o.a, 'crm.booking_feed.revoke')).toEqual({ revoked: false });
    expect(await bookingFeed(app, second.token)).toBeNull();
    expect((await http().request(`/cal/${second.token}.ics`)).status).toBe(404);
    expect(await bookingFeed(app, theirs.token)).toMatchObject({ slug: o.slug });
  });

  it('lets hosts only make a feed, and stops it when the member hosts no more or the org closes', async () => {
    const o = await org();
    await expect(o.exec(o.viewer, 'crm.booking_feed.create')).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.viewer, 'crm.booking_feed.revoke')).rejects.toMatchObject({ status: 403 });
    const owner = await o.exec<{ token: string }>(o.owner, 'crm.booking_feed.create');
    const b = await o.exec<{ token: string }>(o.b, 'crm.booking_feed.create');
    const a = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    // b becomes a viewer, and a leaves: their addresses stop working.
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.b]));
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.a]));
    expect(await bookingFeed(app, b.token)).toBeNull();
    expect(await bookingFeed(app, a.token)).toBeNull();
    expect(await bookingFeed(app, owner.token)).toMatchObject({ slug: o.slug });
    // A closed org's feeds open nothing either.
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [o.orgId]));
    expect(await bookingFeed(app, owner.token)).toBeNull();
  });

  it('revokes the feed of a member who leaves or becomes a viewer, so coming back does not revive it', async () => {
    const o = await org();
    const a = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    const b = await o.exec<{ token: string }>(o.b, 'crm.booking_feed.create');
    const owner = await o.exec<{ token: string }>(o.owner, 'crm.booking_feed.create');
    // What the worker does with each member event: the relay queues it, the job runs the command as the system.
    const revokeFromEvents = async () => {
      const events = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type IN ('kernel.member.removed', 'kernel.member.role_changed') ORDER BY id", [o.orgId])).rows);
      let revoked = 0;
      for (const e of events) revoked += (await worker.execute<{ revoked: number }>('crm.booking_feed.revoke_for_member', { eventId: e.id }, { actor: SYSTEM, orgId: o.orgId })).revoked;
      return revoked;
    };
    await app.execute('kernel.member.remove', { userId: o.a }, { actor: asMfa(o.owner), orgId: o.orgId });
    await app.execute('kernel.member.change_role', { userId: o.b, role: 'viewer' }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect(await revokeFromEvents()).toBe(2);
    // Added back, and made a member again: the old addresses stay dead.
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, o.a]));
    await app.execute('kernel.member.change_role', { userId: o.b, role: 'member' }, { actor: asMfa(o.owner), orgId: o.orgId });
    // The promotion back revokes nothing more (they host again), and a replayed event changes nothing.
    expect(await revokeFromEvents()).toBe(0);
    expect(await bookingFeed(app, a.token)).toBeNull();
    expect(await bookingFeed(app, b.token)).toBeNull();
    expect((await http().request(`/cal/${b.token}.ics`)).status).toBe(404);
    expect(await bookingFeed(app, owner.token)).toMatchObject({ slug: o.slug });
    // A new address works again for a member who hosts.
    const again = await o.exec<{ token: string }>(o.b, 'crm.booking_feed.create');
    expect(await bookingFeed(app, again.token)).toMatchObject({ slug: o.slug });
    // An admin made admin again keeps theirs: only leaving or becoming a viewer revokes.
    const live = await admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_crm.booking_feed WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL', [o.orgId, o.owner])).rows[0]?.n);
    expect(live).toBe(1);
  });

  it('revokes from the event even when it is handled after the member came back, and spares newer feeds', async () => {
    const o = await org();
    const old = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    await app.execute('kernel.member.remove', { userId: o.a }, { actor: asMfa(o.owner), orgId: o.orgId });
    const removed = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.member.removed'", [o.orgId])).rows[0]?.id as string);
    // Back in the org, with a new address, before the worker reached the removal.
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, o.a]));
    const fresh = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    expect(await worker.execute('crm.booking_feed.revoke_for_member', { eventId: removed }, { actor: SYSTEM, orgId: o.orgId })).toEqual({ revoked: 0 });
    // The new address made the old one revoked already; one made before the event and still live is revoked by it.
    const live = await admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_crm.booking_feed WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL', [o.orgId, o.a])).rows[0]?.n);
    expect(live).toBe(1);
    expect(await bookingFeed(app, old.token)).toBeNull();
    expect(await bookingFeed(app, fresh.token)).toMatchObject({ slug: o.slug });
    // b is demoted and promoted back before the worker runs: the demotion still revokes the address made before it.
    const b = await o.exec<{ token: string }>(o.b, 'crm.booking_feed.create');
    await app.execute('kernel.member.change_role', { userId: o.b, role: 'viewer' }, { actor: asMfa(o.owner), orgId: o.orgId });
    await app.execute('kernel.member.change_role', { userId: o.b, role: 'member' }, { actor: asMfa(o.owner), orgId: o.orgId });
    const changes = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.member.role_changed' ORDER BY id", [o.orgId])).rows);
    const results = [];
    for (const e of changes) results.push(await worker.execute<{ revoked: number }>('crm.booking_feed.revoke_for_member', { eventId: e.id }, { actor: SYSTEM, orgId: o.orgId }));
    expect(results).toEqual([{ revoked: 1 }, { revoked: 0 }]);
    expect(await bookingFeed(app, b.token)).toBeNull();
  });

  it("stops the feed of a member whose account is disabled", async () => {
    const o = await org();
    const { token } = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    expect(await bookingFeed(app, token)).toMatchObject({ slug: o.slug });
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [o.a]));
    expect(await bookingFeed(app, token)).toBeNull();
    expect((await http().request(`/cal/${token}.ics`)).status).toBe(404);
  });

  it('answers 429 past the per-client budget', async () => {
    const o = await org();
    const { token } = await o.exec<{ token: string }>(o.a, 'crm.booking_feed.create');
    const edge = http(new RateLimiter({ perMinute: 1 }));
    expect((await edge.request(`/cal/${token}.ics`)).status).toBe(200);
    const limited = await edge.request(`/cal/${token}.ics`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('keeps the definer to the API role, and lets no tenant transaction rewrite a feed', async () => {
    const grants = await admin(async (c) =>
      (
        await c.query<{ grantee: string }>(
          "SELECT grantee FROM information_schema.role_routine_grants WHERE routine_schema = 'crove_crm' AND routine_name = 'booking_feed_events' AND grantee NOT IN ('postgres') ORDER BY 1",
        )
      ).rows.map((r) => r.grantee),
    );
    expect(grants).toEqual(['crove_app']);
    const columns = await admin(async (c) =>
      (
        await c.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'crove_tenant' AND table_schema = 'crove_crm' AND table_name = 'booking_feed' AND privilege_type = 'UPDATE' ORDER BY 1",
        )
      ).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(['revoked_at']);
    const w = await workerPool.connect();
    try {
      await expect(w.query("SELECT crove_crm.booking_feed_events('x')")).rejects.toMatchObject({ code: '42501' });
    } finally {
      w.release();
    }
  });
});
