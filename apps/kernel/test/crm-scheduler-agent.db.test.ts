// The crm.scheduler agent (#1434) on PostgreSQL 17: a booking the visitor cancels gives the agent a task, its run
// comments the next free slots of the type and hands the task to a human; a host's cancel gives no task. The task, its
// comment and the escalation carry the type and times only, never the visitor, since every member reads tasks; and the
// agent can book, move or cancel nothing. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, runAgentWake, upsertIdentity } from '@crove/kernel';
import { isVietnamHoliday, zonedDate, zonedInstant, type EventTypeInput } from '@crove/kernel-contract';
import { Runtime, type AgentProgram } from '@crove/kernel-runtime';
import { crmAgentPrograms, crmCommands, crmQueries, proposalText, type NextSlots } from '@crove/mod-crm';
import { bookingManageAsk, bookingRequest } from '../src/booking-page.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const SYSTEM = { type: 'system' as const, component: 'test.crm.scheduler' };

function bookableDay(offset: number): string {
  let date = zonedDate(VN, Date.now() + offset * DAY);
  while (isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();

suite('the crm.scheduler agent on PostgreSQL (#1434)', () => {
  const dbName = `crove_test_crm_scheduler_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let db: Db;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const draft = (hostUserId: string): EventTypeInput => ({
    slug: 'tu-van',
    title: 'Tư vấn thuế',
    description: null,
    durationMin: 60,
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
  });

  // An org whose owner hosts a type with the template installed, and a member who reads tasks.
  async function org() {
    const person = (who: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${who}-${randomUUID().slice(0, 8)}@scheduler.test`, name: null });
    const owner = await person('owner');
    const member = await person('member');
    const { orgId } = await createOrg(app, asUser(owner), `Văn phòng ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    const slug = (await admin((c) => c.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))).rows[0]?.slug as string;
    // Working hours 9:00 to 12:00 every day, so the next free slots are predictable.
    await app.execute('kernel.calendar.hours.save', { timeZone: VN, windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: 540, end: 720 })) }, { actor: asUser(owner), orgId });
    await app.execute('crm.event_type.create', draft(owner), { actor: asUser(owner), orgId });
    const { agentId } = await app.execute<{ agentId: string }>('kernel.agent.template.install', { templateKey: 'crm.scheduler' }, { actor: asMfa(owner), orgId });
    const book = async (startsAt: string) => {
      const request = await bookingRequest(app, slug, 'tu-van', { startsAt, name: 'Chị Lan Bí Mật', email: `lan-${randomUUID().slice(0, 6)}@khach.test`, phone: '0901234567', timeZone: VN });
      if (!request) throw new Error('no request');
      const { rows } = await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_crm.booking WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [orgId]));
      const bookingId = rows[0]?.id as string;
      expect(await worker.execute('crm.booking.confirm', { bookingId }, { actor: SYSTEM, orgId })).toMatchObject({ status: 'confirmed' });
      return bookingId;
    };
    // The visitor cancels through the manage link of their mail, as the page and the worker do.
    const visitorCancels = async (bookingId: string) => {
      const { token } = await worker.execute<{ token: string }>('crm.booking.mail_data', { bookingId, revision: 0 }, { actor: SYSTEM, orgId });
      const ask = await bookingManageAsk(app, slug, 'tu-van', { manage: token, action: 'cancel' });
      expect(await worker.execute('crm.booking.manage', { bookingId, requestId: ask?.requestId }, { actor: SYSTEM, orgId })).toMatchObject({ outcome: 'cancelled' });
    };
    const dispatchCancels = async () => {
      const events = await admin(async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'crm.booking.cancelled' ORDER BY id`, [orgId])).rows);
      let tasks = 0;
      for (const e of events) tasks += (await worker.execute<{ tasks: number }>('kernel.agent.dispatch_event', { eventId: e.id }, { actor: SYSTEM, orgId })).tasks;
      return { events: events.length, tasks };
    };
    return { orgId, slug, owner, member, agentId, book, visitorCancels, dispatchCancels };
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
    const runtimeFor = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      const d = createDb(pool);
      return { db: d, runtime: new Runtime(d, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] }) };
    };
    const api = runtimeFor('crove_app', 'test-app-pw');
    app = api.runtime;
    db = api.db;
    worker = runtimeFor('crove_worker', 'test-worker-pw').runtime;
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("proposes the next free slots when the visitor cancels, hands the task to a human, and names no visitor", async () => {
    const o = await org();
    const day = bookableDay(2);
    const kept = await o.book(at(day, 540));
    const cancelled = await o.book(at(day, 600));
    await o.visitorCancels(cancelled);
    // A redelivered event adds nothing.
    const first = await o.dispatchCancels();
    expect(first).toEqual({ events: 1, tasks: 1 });
    expect((await o.dispatchCancels()).tasks).toBe(0);
    const tasks = await admin(async (c) => (await c.query(`SELECT title, kind, source, source_ref, tainted FROM crove_kernel.task WHERE org_id = $1`, [o.orgId])).rows);
    expect(tasks).toEqual([{ title: 'Khách hủy lịch hẹn: Tư vấn thuế', kind: 'general', source: 'event', source_ref: { type: 'crm.booking', id: cancelled }, tainted: true }]);

    // What the page offers now: the freed 10:00 among the next slots; 9:00 stays taken.
    const next = await app.query<NextSlots>('crm.booking.next_slots', { bookingId: cancelled }, { actor: asUser(o.member), orgId: o.orgId });
    expect(next).toMatchObject({ bookingId: cancelled, status: 'cancelled', eventType: { title: 'Tư vấn thuế', active: true }, timeZone: VN });
    expect(next.slots).toHaveLength(3);
    expect(next.slots.map((s) => s.start)).not.toContain(at(day, 540));
    expect(next.slots.every((s) => Date.parse(s.end) - Date.parse(s.start) === 3_600_000)).toBe(true);
    expect(JSON.stringify(next)).not.toMatch(/Lan|khach\.test|0901234567/);

    expect(await runAgentWake({ runtime: worker, programs: crmAgentPrograms }, o.orgId, o.agentId)).toMatchObject({ outcome: 'succeeded' });
    const after = await admin(async (c) => ({
      comments: (await c.query<{ body: string; author_type: string }>(`SELECT body, author_type FROM crove_kernel.task_comment WHERE org_id = $1`, [o.orgId])).rows,
      escalations: (await c.query(`SELECT title, created_by_type FROM crove_kernel.task WHERE org_id = $1 AND kind = 'escalation'`, [o.orgId])).rows,
      bookings: (await c.query<{ id: string; status: string }>(`SELECT id, status FROM crove_crm.booking WHERE org_id = $1 ORDER BY starts_at`, [o.orgId])).rows,
    }));
    expect(after.comments).toEqual([{ body: proposalText(next), author_type: 'agent' }]);
    expect(after.comments[0]?.body).toContain('Khách đã hủy lịch hẹn "Tư vấn thuế" lúc 10:00 ');
    expect(after.escalations).toEqual([{ title: 'Mời khách đặt lại: Tư vấn thuế', created_by_type: 'agent' }]);
    // The agent changed no booking.
    expect(after.bookings).toEqual([
      { id: kept, status: 'confirmed' },
      { id: cancelled, status: 'cancelled' },
    ]);
    // A member reads every task and comment, and finds no visitor in them.
    const asMember = { actor: asUser(o.member), orgId: o.orgId };
    const { tasks: listed } = await app.query<{ tasks: { id: string }[] }>('kernel.task.list', {}, asMember);
    const read = JSON.stringify([listed, ...(await Promise.all(listed.map((t) => app.query('kernel.task.get', { id: t.id }, asMember))))]);
    for (const secret of ['Lan', 'Bí Mật', 'khach.test', '0901234567']) expect(read).not.toContain(secret);
  });

  it("gives no task for a host's cancel", async () => {
    const o = await org();
    const booking = await o.book(at(bookableDay(3), 540));
    await app.execute('crm.booking.cancel', { bookingId: booking }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await o.dispatchCancels()).toEqual({ events: 1, tasks: 0 });
    const payload = await admin(async (c) => (await c.query(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'crm.booking.cancelled'`, [o.orgId])).rows[0]?.payload);
    expect(payload).toEqual({ booking_id: booking, by: 'host' });
  });

  it('lets the agent book, move or cancel nothing', async () => {
    const o = await org();
    const day = bookableDay(4);
    const standing = await o.book(at(day, 540));
    const cancelled = await o.book(at(day, 600));
    await o.visitorCancels(cancelled);
    await o.dispatchCancels();
    const refused: string[] = [];
    const tries: AgentProgram = async (agent) => {
      for (const [name, input] of [
        ['crm.booking.cancel', { bookingId: standing }],
        ['crm.booking.move', { bookingId: standing, startsAt: at(day, 660) }],
        ['crm.event_type.set_active', { eventTypeId: randomUUID(), active: false }],
      ] as const) {
        try {
          await agent.execute(name, input);
        } catch (error) {
          refused.push(`${name}: ${(error as { status?: number }).status}`);
        }
      }
    };
    expect(await runAgentWake({ runtime: worker, programs: { 'crm.scheduler': tries } }, o.orgId, o.agentId)).toMatchObject({ outcome: 'succeeded' });
    expect(refused).toEqual(['crm.booking.cancel: 403', 'crm.booking.move: 403', 'crm.event_type.set_active: 403']);
    const status = await admin(async (c) => (await c.query<{ status: string }>(`SELECT status FROM crove_crm.booking WHERE org_id = $1 AND id = $2`, [o.orgId, standing])).rows[0]?.status);
    expect(status).toBe('confirmed');
  });
});
