// A channel's queue running low on PostgreSQL 17 (#1079): with the warning on, the worker's sweep tells the team once
// when a posting day ahead has no post, not again until the queue is filled and runs low again; a muted member and a
// viewer hear nothing; paused queues and held orgs are skipped; another org's queue is untouched; only owners and
// admins set the warning. The worker's sweep and dispatch are run here by hand. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, sweepQueueLow, type NotificationItem, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const HCM = 'Asia/Ho_Chi_Minh';
const suite = ADMIN ? describe : describe.skip;

suite('social queue running low on PostgreSQL (#1079)', () => {
  const dbName = `crove_test_social_queue_low_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  // The worker's runtime (the crove_worker login): only it enters an org's system context.
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string; muted: string; viewer: string; dispatched: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), muted: await person('muted'), viewer: await person('viewer') };
    const role = { admin: 'admin', member: 'member', muted: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles, dispatched: new Set() };
  }

  async function connection(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Trang thử',
        o.owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  type Queue = { queueId: string | null; lowDays: number | null; low: boolean };
  const queueOf = (o: Org, user: string, connectionId: string) => rt.query<Queue>('social.queue.get', { connectionId }, { actor: asUser(user), orgId: o.orgId });
  type List = { items: NotificationItem[]; unread: number };
  const lows = async (o: Org, user: string) => (await rt.query<List>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId })).items.filter((i) => i.kind === 'queue_low');
  const marker = (queueId: string) => admin(async (c) => (await c.query<{ at: Date | null }>('SELECT low_alerted_at AS at FROM crove_social.queue WHERE id = $1', [queueId])).rows[0]?.at ?? null);

  // A daily slot two hours from now (local time), so the next two days hold exactly two posting days.
  const SLOT_MINUTE = (() => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: HCM, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(Date.now());
    const minute = Number(p.find((x) => x.type === 'hour')?.value) * 60 + Number(p.find((x) => x.type === 'minute')?.value);
    return (minute + 120) % 1440;
  })();
  const DAILY = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute: SLOT_MINUTE }));
  const setQueue = (o: Org, user: string, connectionId: string, extra: Record<string, unknown> = {}) =>
    exec<{ queueId: string }>(o, user, 'social.queue.set', { connectionId, timeZone: HCM, slots: DAILY, ...extra });

  // An approved post put in the channel's queue; returns its variant.
  async function queued(o: Org, connectionId: string, body: string): Promise<string> {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    const r = await exec<{ scheduled: { variantId: string }[] }>(o, o.owner, 'social.variant.schedule', { postId, queue: true });
    return r.scheduled[0]?.variantId as string;
  }

  // What the worker does for each new event of the org: the dispatch, in the org's system context.
  async function deliver(o: Org): Promise<number> {
    const events = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 ORDER BY created_at, id', [o.orgId])).rows);
    let sent = 0;
    for (const e of events) {
      if (o.dispatched.has(e.id)) continue;
      o.dispatched.add(e.id);
      sent += (await worker.execute<{ sent: number }>('social.notification.dispatch', { eventId: e.id }, { actor: system, orgId: o.orgId })).sent;
    }
    return sent;
  }
  const sweep = () => sweepQueueLow({ runtime: worker, workerDb: createDb(workerPool) });
  const lowEvents = (o: Org) =>
    admin(async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.queue.low'", [o.orgId])).rows[0]?.n ?? 0);

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
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 3 });
    worker = new Runtime(createDb(workerPool)).register(registry);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('tells the team once per dip, again only after a refill and a new dip, and never a muted member or a viewer', async () => {
    const o = await org();
    const conn = await connection(o);
    await exec(o, o.muted, 'social.notification.mute', { kind: 'queue_low', muted: true });
    const { queueId } = await setQueue(o, o.admin, conn, { lowDays: 2 });
    const first = await queued(o, conn, 'Bài một');
    const second = await queued(o, conn, 'Bài hai');
    expect(await queueOf(o, o.viewer, conn)).toMatchObject({ queueId, lowDays: 2, low: false });
    await deliver(o);

    // Both posting days ahead have a post: nothing to tell.
    await sweep();
    expect(await marker(queueId)).toBeNull();
    expect(await lowEvents(o)).toBe(0);

    // A post taken out: a posting day is empty, and the team is told once.
    await exec(o, o.owner, 'social.variant.cancel', { variantIds: [second] });
    await sweep();
    await deliver(o);
    expect(await marker(queueId)).not.toBeNull();
    for (const user of [o.owner, o.admin, o.member]) {
      expect((await lows(o, user)).map((n) => ({ connectionId: n.connectionId, channel: n.channel, detail: n.detail }))).toEqual([
        { connectionId: conn, channel: 'Trang thử', detail: { days: '2', posting: '2', filled: '1' } },
      ]);
    }
    expect(await lows(o, o.muted)).toEqual([]);
    expect(await lows(o, o.viewer)).toEqual([]);
    expect(await queueOf(o, o.member, conn)).toMatchObject({ lowDays: 2, low: true });
    // The mail of the kind, to those who got the notice, with a link to a new post for the channel.
    const mails = await admin(
      async (c) =>
        (await c.query<{ subject: string; path: string }>("SELECT subject, payload->>'path' AS path FROM crove_kernel.mail_message WHERE org_id = $1 AND payload->>'kind' = 'queue_low'", [o.orgId])).rows,
    );
    expect(mails).toHaveLength(3);
    expect(mails.every((m) => m.subject === 'Hàng đợi của kênh Trang thử sắp hết bài' && m.path.endsWith(`/social/new?channel=${conn}`))).toBe(true);

    // The next sweeps find it still low: no second notice.
    await sweep();
    await sweep();
    await deliver(o);
    expect(await lowEvents(o)).toBe(1);
    expect(await lows(o, o.owner)).toHaveLength(1);

    // Filled again: the marker goes, and the notice with it.
    await queued(o, conn, 'Bài ba');
    await sweep();
    expect(await marker(queueId)).toBeNull();
    expect(await lows(o, o.owner)).toEqual([]);
    expect(await queueOf(o, o.member, conn)).toMatchObject({ low: false });
    await sweep();
    expect(await lowEvents(o)).toBe(1);

    // A new dip: told again.
    await exec(o, o.owner, 'social.variant.cancel', { variantIds: [first] });
    await sweep();
    await deliver(o);
    expect(await lowEvents(o)).toBe(2);
    expect(await lows(o, o.admin)).toHaveLength(1);
    expect(await lows(o, o.muted)).toEqual([]);
  });

  it('tells the team once when two checks run at the same time', async () => {
    const o = await org();
    const conn = await connection(o);
    const { queueId } = await setQueue(o, o.owner, conn, { lowDays: 3 });
    const both = await Promise.all([0, 1].map(() => worker.execute<{ state: string }>('social.queue.check_low', { queueId }, { actor: system, orgId: o.orgId })));
    expect(both.map((r) => r.state).sort()).toEqual(['alerted', 'low']);
    expect(await lowEvents(o)).toBe(1);
  });

  it('skips paused queues, held orgs and queues without the warning, and leaves another org alone', async () => {
    const o = await org();
    const paused = await connection(o);
    const off = await connection(o);
    const p = await setQueue(o, o.owner, paused, { lowDays: 3, paused: true });
    const f = await setQueue(o, o.owner, off);
    // Another org: its queue is full, so nothing of A's dip reaches it.
    const other = await org();
    const otherConn = await connection(other);
    const otherQueue = await setQueue(other, other.owner, otherConn, { lowDays: 1 });
    await queued(other, otherConn, 'Bài của tổ chức khác');
    await deliver(other);
    // A held org: told nothing while held, told once it is released.
    const held = await org();
    const heldConn = await connection(held);
    const heldQueue = await setQueue(held, held.owner, heldConn, { lowDays: 3 });
    await exec(held, held.owner, 'social.publishing.hold', { reason: 'Ngày quốc tang' });
    await deliver(held);

    await sweep();
    await Promise.all([deliver(o), deliver(other), deliver(held)]);
    expect(await marker(p.queueId)).toBeNull();
    expect(await marker(f.queueId)).toBeNull();
    expect(await marker(otherQueue.queueId)).toBeNull();
    expect(await marker(heldQueue.queueId)).toBeNull();
    for (const x of [o, other, held]) expect(await lowEvents(x)).toBe(0);
    // The check itself refuses a held org too, should the scan have read it before the hold.
    expect(await worker.execute('social.queue.check_low', { queueId: heldQueue.queueId }, { actor: system, orgId: held.orgId })).toMatchObject({ state: 'skipped' });
    // Nor can a check run for one org reach another org's queue.
    expect(await worker.execute('social.queue.check_low', { queueId: otherQueue.queueId }, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'skipped' });

    await exec(held, held.owner, 'social.publishing.release', {});
    // Unpaused, the empty queue is low too.
    await setQueue(o, o.owner, paused, { paused: false });
    await sweep();
    await Promise.all([deliver(o), deliver(held)]);
    expect(await lowEvents(held)).toBe(1);
    expect(await lows(held, held.member)).toHaveLength(1);
    expect(await lowEvents(o)).toBe(1);
    expect((await lows(o, o.owner)).map((n) => n.connectionId)).toEqual([paused]);
    expect(await marker(otherQueue.queueId)).toBeNull();
    expect(await lows(other, other.owner)).toEqual([]);
  });

  it('tells nobody when the org left active between the scan and the check (#1095)', async () => {
    const o = await org();
    const conn = await connection(o);
    const q = await setQueue(o, o.owner, conn, { lowDays: 3 });
    // Offboarding, as staff (the scan would no longer list it; the check must not rely on that).
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [o.orgId]);
      await c.query('COMMIT');
    });
    expect(await worker.execute('social.queue.check_low', { queueId: q.queueId }, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'skipped' });
    expect(await marker(q.queueId)).toBeNull();
    expect(await lowEvents(o)).toBe(0);
  });

  it('lets owners and admins set the warning, keeps it when left out, and a new value starts a new dip', async () => {
    const o = await org();
    const conn = await connection(o);
    const { queueId } = await setQueue(o, o.owner, conn);
    for (const user of [o.member, o.viewer]) {
      await expect(setQueue(o, user, conn, { lowDays: 3 })).rejects.toMatchObject({ status: 403 });
    }
    expect(await queueOf(o, o.viewer, conn)).toMatchObject({ lowDays: null, low: false });
    for (const lowDays of [0, 31, 2.5]) await expect(setQueue(o, o.admin, conn, { lowDays })).rejects.toBeDefined();

    await setQueue(o, o.admin, conn, { lowDays: 3 });
    await sweep();
    expect(await marker(queueId)).not.toBeNull();
    // Left out: kept, and the dip with it.
    await setQueue(o, o.admin, conn);
    expect(await queueOf(o, o.viewer, conn)).toMatchObject({ lowDays: 3, low: true });
    await setQueue(o, o.admin, conn, { lowDays: 3 });
    expect(await marker(queueId)).not.toBeNull();
    // A new value: measured afresh.
    await setQueue(o, o.admin, conn, { lowDays: 5 });
    expect(await marker(queueId)).toBeNull();
    await sweep();
    expect(await lowEvents(o)).toBe(2);
    // Off: the sweep no longer looks at it.
    await setQueue(o, o.owner, conn, { lowDays: null });
    expect(await queueOf(o, o.viewer, conn)).toMatchObject({ lowDays: null, low: false });
    await sweep();
    expect(await lowEvents(o)).toBe(2);
  });

  it('keeps the scan for the worker login, and the check for the system', async () => {
    const o = await org();
    const conn = await connection(o);
    const { queueId } = await setQueue(o, o.owner, conn, { lowDays: 2 });
    const { rows } = await admin((c) =>
      c.query<{ role: string; ok: boolean }>(
        "SELECT r AS role, has_function_privilege(r, 'crove_social.queue_low_due(uuid, uuid, int)', 'EXECUTE') AS ok FROM unnest(ARRAY['crove_worker', 'crove_app', 'crove_tenant', 'crove_definer_tenant']) r",
      ),
    );
    expect(Object.fromEntries(rows.map((r) => [r.role, r.ok]))).toEqual({ crove_worker: true, crove_app: false, crove_tenant: false, crove_definer_tenant: false });
    await expect(exec(o, o.owner, 'social.queue.check_low', { queueId })).rejects.toThrow();
    // A member cannot write the dip marker through the queue's own command either: the input has no such field.
    await expect(setQueue(o, o.owner, conn, { lowAlertedAt: null })).rejects.toBeDefined();
  });
});
