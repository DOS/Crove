// Reminders of posts waiting for review on PostgreSQL 17 (#703): a review that has waited 24 hours, then a time less
// than 24 hours away, each reminds the reviewers once per round, never one who already approved the current content;
// a channel can turn them off; a reminder shows only while the post still waits; a new round starts the clock again.
// The worker's sweep and dispatch are run here by hand. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, sweepReminders, type NotificationItem, type PostView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social review reminders on PostgreSQL (#703)', () => {
  const dbName = `crove_test_social_remind_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string; viewer: string; dispatched: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), other: await person('other'), viewer: await person('viewer') };
    const role = { admin: 'admin', member: 'member', other: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles, dispatched: new Set() };
  }

  async function connection(orgId: string, owner: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, 'Kênh thử', owner],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const seen = (p: PostView) => p.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
  type List = { items: NotificationItem[]; unread: number; muted: string[] };
  const list = (o: Org, user: string) => rt.query<List>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId });

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
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

  // Moves a post's review clock back, as if it had gone into review `hours` ago (the trigger is skipped for this).
  const backdate = (postId: string, hours: number) =>
    admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE crove_social.post_variant SET review_since = now() - make_interval(hours => $2::int) WHERE post_id = $1", [postId, hours]);
    });
  const sweep = () => sweepReminders({ runtime: worker, workerDb: createDb(workerPool) });
  const reminders = async (o: Org, user: string) => (await list(o, user)).items.filter((i) => i.kind === 'review_reminder').map((i) => i.detail.stage);
  const clock = (postId: string) =>
    admin(async (c) => (await c.query<{ since: boolean; waiting: boolean; due: boolean }>('SELECT review_since IS NOT NULL AS since, reminded_waiting_at IS NOT NULL AS waiting, reminded_due_at IS NOT NULL AS due FROM crove_social.post_variant WHERE post_id = $1', [postId])).rows);

  it('reminds the reviewers once when a review has waited a day, and starts again with a new round', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài chờ duyệt', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    expect(await clock(postId)).toEqual([{ since: true, waiting: false, due: false }]);
    await deliver(o);
    // Not yet a day.
    await backdate(postId, 23);
    await sweep();
    await deliver(o);
    expect(await reminders(o, o.owner)).toEqual([]);

    await backdate(postId, 25);
    await sweep();
    await deliver(o);
    expect(await reminders(o, o.owner)).toEqual(['waiting']);
    expect(await reminders(o, o.admin)).toEqual(['waiting']);
    expect(await reminders(o, o.member)).toEqual([]);
    expect(await reminders(o, o.viewer)).toEqual([]);
    // Once per round.
    await sweep();
    await deliver(o);
    expect(await reminders(o, o.owner)).toEqual(['waiting']);
    expect(await clock(postId)).toEqual([{ since: true, waiting: true, due: false }]);

    // A request for changes ends the round, and the reminder goes from the list; sent back, the clock starts again.
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'changes_requested', variants: seen(await get(o, o.owner, postId)) });
    expect(await clock(postId)).toEqual([{ since: false, waiting: false, due: false }]);
    expect(await reminders(o, o.admin)).toEqual([]);
    expect((await list(o, o.admin)).unread).toBe(1);
    await exec(o, o.member, 'social.post.submit', { postId });
    expect(await clock(postId)).toEqual([{ since: true, waiting: false, due: false }]);
    // The last round's reminder does not come back with the new round.
    expect(await reminders(o, o.admin)).toEqual([]);
    await backdate(postId, 25);
    await sweep();
    await deliver(o);
    expect(await reminders(o, o.admin)).toEqual(['waiting']);
  });

  it('reminds before the time only those who have not approved yet, and a channel can turn reminders off', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    const at = new Date(Date.now() + 10 * 3_600_000).toISOString();
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài sắp đăng', scheduledAt: at, channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    await deliver(o);
    // Asked 30 hours ago, the time now 10 hours away: one reminder, about the time (the wait is marked with it).
    await backdate(postId, 30);
    await exec(o, o.owner, 'social.channel.set_reminders', { connectionId: conn, reviewReminders: false });
    await sweep();
    await deliver(o);
    expect(await reminders(o, o.admin)).toEqual([]);
    expect(await rt.query('social.channel.policies', {}, { actor: asUser(o.member), orgId: o.orgId })).toEqual([expect.objectContaining({ connectionId: conn, approvalsRequired: 2, reviewReminders: false })]);
    await expect(exec(o, o.member, 'social.channel.set_reminders', { connectionId: conn, reviewReminders: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await exec(o, o.admin, 'social.channel.set_reminders', { connectionId: conn, reviewReminders: true });
    await sweep();
    await deliver(o);
    expect(await reminders(o, o.admin)).toEqual(['due']);
    expect(await reminders(o, o.owner)).toEqual([]);
    expect(await clock(postId)).toEqual([{ since: true, waiting: true, due: true }]);
    await sweep();
    await deliver(o);
    expect(await reminders(o, o.admin)).toEqual(['due']);

    // Approved: nothing waits, and the reminder leaves the list.
    await exec(o, o.admin, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.admin, postId)) });
    expect(await reminders(o, o.admin)).toEqual([]);
  });

  it('keeps the review clock out of reach of a member', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài thử', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    // A write that leaves the status alone keeps the clock as the database set it.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET review_since = now() - interval '5 days', updated_at = now() WHERE post_id = $1", [postId]));
    const { rows } = await admin((c) => c.query<{ fresh: boolean }>("SELECT review_since > now() - interval '1 hour' AS fresh FROM crove_social.post_variant WHERE post_id = $1", [postId]));
    expect(rows).toEqual([{ fresh: true }]);
    await expect(worker.execute('social.review.remind', { postId }, { actor: system, orgId: o.orgId })).resolves.toEqual({ stage: null });
    await expect(exec(o, o.owner, 'social.review.remind', { postId })).rejects.toThrow();
  });
});
