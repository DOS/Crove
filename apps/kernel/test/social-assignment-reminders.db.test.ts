// Due date reminders of an assigned post on PostgreSQL 17 (#1359): one when the due date is a day away and one when it
// has passed, to the assignee, once each; a new due date or a new assignee (single or bulk) arms them again; none for
// a post published, cancelled or archived, an assignee who turned the kind off, left the org, has a disabled account
// or may not see the post (#1081); the reminder and the assignment are also mailed and pushed, the push with no post
// text. The worker's sweep and dispatch are run here by hand. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, sweepAssignmentReminders, type NotificationItem, type PushTargets } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const H = 3_600_000;

suite('social due date reminders on PostgreSQL (#1359)', () => {
  const dbName = `crove_test_social_due_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const one = async <T extends pg.QueryResultRow>(text: string, values: unknown[]) => admin(async (c) => (await c.query<T>(text, values)).rows);

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  type Org = { orgId: string; owner: string; member: string; other: string; conn: string; dispatched: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const other = await person('other');
    for (const id of [member, other]) await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, id]));
    return { orgId, owner, member, other, conn: await connection(orgId, owner), dispatched: new Set() };
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
  type List = { items: NotificationItem[]; unread: number; muted: string[] };
  const list = (o: Org, user: string) => rt.query<List>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId });
  const dueIn = (hours: number) => new Date(Date.now() + hours * H).toISOString();
  async function post(o: Org, body = 'Bài khai trương bí mật', conn = o.conn): Promise<string> {
    return (await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body, channels: [{ connectionId: conn }] })).postId;
  }
  const assign = (o: Org, postId: string, assigneeUserId: string | null, dueAt: string | null) => exec(o, o.owner, 'social.post.assign', { postId, assigneeUserId, dueAt });

  // What the worker does for each new event of the org: the dispatch, in the org's system context. Returns the ids of
  // the notifications it names for push.
  async function deliver(o: Org): Promise<string[]> {
    const events = await one<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 ORDER BY created_at, id', [o.orgId]);
    const push: string[] = [];
    for (const e of events) {
      if (o.dispatched.has(e.id)) continue;
      o.dispatched.add(e.id);
      push.push(...(await worker.execute<{ push: string[] }>('social.notification.dispatch', { eventId: e.id }, { actor: system, orgId: o.orgId })).push);
    }
    return push;
  }
  const sweep = () => sweepAssignmentReminders({ runtime: worker, workerDb: createDb(workerPool) });
  // One pass of the worker: the sweep, then the dispatch of what it emitted.
  const pass = async (o: Org) => {
    const sent = await sweep();
    await deliver(o);
    return sent;
  };
  const reminders = async (o: Org, user: string) => (await list(o, user)).items.filter((i) => i.kind === 'assignment_due').map((i) => ({ postId: i.postId, stage: i.detail.stage }));
  const events = (o: Org) => one<{ payload: { post_id: string; stage: string; assignee_user_id: string } }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.due_reminder' ORDER BY created_at, id", [o.orgId]);
  const marks = (postId: string) => one<{ soon: boolean; overdue: boolean }>('SELECT due_soon_reminded_at IS NOT NULL AS soon, overdue_reminded_at IS NOT NULL AS overdue FROM crove_social.post WHERE id = $1', [postId]);
  type Mail = { to: string; subject: string; payload: Record<string, unknown> };
  const mails = (o: Org, kind: string) =>
    one<Mail>(
      `SELECT m.to_address AS to, m.subject, m.payload FROM crove_kernel.mail_message m JOIN crove_social.notification n ON n.org_id = m.org_id AND n.id = m.source_id
       WHERE m.org_id = $1 AND m.source = 'social.notification.dispatch' AND n.kind = $2 ORDER BY m.created_at`,
      [o.orgId, kind],
    );

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

  it('reminds the assignee once a day before the due date and once when it is overdue, and again for a new due date', async () => {
    const o = await org();
    const postId = await post(o);
    // Two days away: nothing yet.
    await assign(o, postId, o.member, dueIn(48));
    await deliver(o);
    await pass(o);
    expect(await reminders(o, o.member)).toEqual([]);

    // Moved to ten hours away: one reminder, only for the assignee.
    await assign(o, postId, o.member, dueIn(10));
    expect(await pass(o)).toBeGreaterThanOrEqual(1);
    expect(await reminders(o, o.member)).toEqual([{ postId, stage: 'soon' }]);
    expect(await reminders(o, o.owner)).toEqual([]);
    expect(await reminders(o, o.other)).toEqual([]);
    expect(await marks(postId)).toEqual([{ soon: true, overdue: false }]);
    // Once.
    await pass(o);
    await pass(o);
    expect((await events(o)).filter((e) => e.payload.post_id === postId)).toHaveLength(1);

    // Past the due date (set here as an earlier one): the overdue reminder replaces the first, once.
    await assign(o, postId, o.member, dueIn(-1));
    expect(await marks(postId)).toEqual([{ soon: false, overdue: false }]);
    await pass(o);
    await pass(o);
    expect(await reminders(o, o.member)).toEqual([{ postId, stage: 'overdue' }]);
    expect((await events(o)).map((e) => e.payload.stage)).toEqual(['soon', 'overdue']);
    expect(await marks(postId)).toEqual([{ soon: true, overdue: true }]);

    // Moved again: armed again, and the overdue item leaves the list (it was about the old date).
    await assign(o, postId, o.member, dueIn(5));
    expect(await reminders(o, o.member)).toEqual([]);
    await pass(o);
    expect(await reminders(o, o.member)).toEqual([{ postId, stage: 'soon' }]);
    // The same due date and assignee again changes nothing.
    await assign(o, postId, o.member, (await one<{ due: Date }>('SELECT due_at AS due FROM crove_social.post WHERE id = $1', [postId]))[0]?.due.toISOString() ?? null);
    expect(await marks(postId)).toEqual([{ soon: true, overdue: false }]);
    await pass(o);
    expect((await events(o)).map((e) => e.payload.stage)).toEqual(['soon', 'overdue', 'soon']);
    // Without a due date, or without an assignee, nothing is reminded.
    await assign(o, postId, o.member, null);
    await assign(o, postId, null, dueIn(-1));
    await pass(o);
    expect(await events(o)).toHaveLength(3);
  });

  it('reminds the new assignee after a reassignment, single or bulk', async () => {
    const o = await org();
    const first = await post(o, 'Bài một');
    const second = await post(o, 'Bài hai');
    await assign(o, first, o.member, dueIn(-2));
    await pass(o);
    expect(await reminders(o, o.member)).toEqual([{ postId: first, stage: 'overdue' }]);

    await assign(o, first, o.other, dueIn(-2));
    expect(await reminders(o, o.member)).toEqual([]);
    await pass(o);
    expect(await reminders(o, o.other)).toEqual([{ postId: first, stage: 'overdue' }]);

    // In bulk: both posts to the member, the due date kept, then a new due date for both.
    await exec(o, o.owner, 'social.post.bulk_assign', { postIds: [first, second], assigneeUserId: o.member });
    expect(await reminders(o, o.other)).toEqual([]);
    await pass(o);
    // The second has no due date yet.
    expect(await reminders(o, o.member)).toEqual([{ postId: first, stage: 'overdue' }]);
    await exec(o, o.owner, 'social.post.bulk_assign', { postIds: [first, second], assigneeUserId: o.member, dueAt: dueIn(12) });
    await pass(o);
    expect((await reminders(o, o.member)).sort((a, b) => (a.postId ?? '').localeCompare(b.postId ?? ''))).toEqual(
      [first, second].sort().map((postId) => ({ postId, stage: 'soon' })),
    );
  });

  it('reminds of nothing published, cancelled or archived', async () => {
    const o = await org();
    const published = await post(o, 'Đã đăng');
    const cancelled = await post(o, 'Đã hủy');
    const archived = await post(o, 'Đã lưu trữ');
    const partly = await post(o, 'Đăng một phần');
    for (const p of [published, cancelled, archived, partly]) await assign(o, p, o.member, dueIn(3));
    await admin((c) => c.query("UPDATE crove_social.post SET status = CASE id WHEN $1 THEN 'published' WHEN $2 THEN 'cancelled' ELSE 'partially_published' END WHERE id = ANY($3::uuid[])", [published, cancelled, [published, cancelled, partly]]));
    await exec(o, o.owner, 'social.post.archive', { postId: archived });
    expect(await pass(o)).toBe(0);
    expect(await reminders(o, o.member)).toEqual([]);
    // The command checks again under the lock, whatever the worker asks.
    for (const p of [published, cancelled, archived, partly]) {
      await expect(worker.execute('social.post.remind_due', { postId: p }, { actor: system, orgId: o.orgId })).resolves.toEqual({ stage: null });
    }
    expect(await events(o)).toEqual([]);

    // A reminder sent before the post went out leaves the list once it is out.
    const later = await post(o, 'Sắp đăng');
    await assign(o, later, o.member, dueIn(3));
    await pass(o);
    expect(await reminders(o, o.member)).toEqual([{ postId: later, stage: 'soon' }]);
    await admin((c) => c.query("UPDATE crove_social.post SET status = 'published' WHERE id = $1", [later]));
    expect(await reminders(o, o.member)).toEqual([]);
  });

  it('reminds nobody who turned the kind off, left the org, has a disabled account or may not see the post', async () => {
    const o = await org();
    const muted = await post(o, 'Tắt nhắc');
    await exec(o, o.member, 'social.notification.mute', { kind: 'assignment_due', muted: true });
    await assign(o, muted, o.member, dueIn(2));
    await pass(o);
    expect(await reminders(o, o.member)).toEqual([]);
    expect(await mails(o, 'assignment_due')).toEqual([]);
    await exec(o, o.member, 'social.notification.mute', { kind: 'assignment_due', muted: false });

    // A disabled account: the scan leaves it out and nothing is marked, so it comes once the account is enabled.
    const disabled = await post(o, 'Tài khoản bị khóa');
    await assign(o, disabled, o.other, dueIn(2));
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [o.other]));
    await pass(o);
    await expect(worker.execute('social.post.remind_due', { postId: disabled }, { actor: system, orgId: o.orgId })).resolves.toEqual({ stage: null });
    expect(await marks(disabled)).toEqual([{ soon: false, overdue: false }]);
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [o.other]));
    await pass(o);
    expect(await reminders(o, o.other)).toEqual([{ postId: disabled, stage: 'soon' }]);

    // A member who left keeps the post until it is changed, but is reminded of nothing.
    const departed = await post(o, 'Người đã rời đi');
    await assign(o, departed, o.other, dueIn(-1));
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.other]));
    await pass(o);
    await expect(worker.execute('social.post.remind_due', { postId: departed }, { actor: system, orgId: o.orgId })).resolves.toEqual({ stage: null });
    expect((await events(o)).map((e) => e.payload.post_id)).toEqual([muted, disabled]);

    // A member limited to one channel (#1081) is reminded of a post on it, not of one on another channel only.
    const other = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [o.conn] });
    const hidden = await post(o, 'Kênh khác', other);
    const shown = await post(o, 'Kênh của mình');
    await assign(o, hidden, o.member, dueIn(-3));
    await assign(o, shown, o.member, dueIn(-3));
    await pass(o);
    expect((await reminders(o, o.member)).map((r) => r.postId)).toEqual([shown]);
    // Marked all the same, so the scan moves past it.
    expect(await marks(hidden)).toEqual([{ soon: true, overdue: true }]);
    expect((await events(o)).map((e) => e.payload.post_id)).not.toContain(hidden);
  });

  it('mails and pushes the reminder and the assignment, the push without the post text', async () => {
    const o = await org();
    const postId = await post(o, 'Khai trương cửa hàng bí mật');
    await assign(o, postId, o.member, dueIn(6));
    const assignedPush = await deliver(o);
    expect(assignedPush).toHaveLength(1);
    const memberEmail = (await one<{ email: string }>('SELECT email FROM crove_kernel.user_account WHERE id = $1', [o.member]))[0]?.email;
    expect(await mails(o, 'assigned')).toEqual([{ to: memberEmail, subject: 'Bạn được giao một bài: Khai trương cửa hàng bí mật', payload: expect.objectContaining({ kind: 'assigned', post: 'Khai trương cửa hàng bí mật' }) }]);

    await sweep();
    const reminderPush = await deliver(o);
    expect(reminderPush).toHaveLength(1);
    const [mail] = await mails(o, 'assignment_due');
    expect(mail).toMatchObject({ to: memberEmail, subject: 'Bài được giao cho bạn sắp đến hạn: Khai trương cửa hàng bí mật', payload: { kind: 'assignment_due', stage: 'soon' } });
    expect(mail?.payload.due).toMatch(/^\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/);

    // The push: a line for the kind and the post's path, never its text. With no device, nothing to send.
    expect(await worker.query('social.push.targets', { notificationId: reminderPush[0] }, { actor: system, orgId: o.orgId })).toBeNull();
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    await exec(o, o.member, 'social.push.subscribe', { endpoint: `https://push.example/${randomUUID()}`, p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') });
    const slug = (await one<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [o.orgId]))[0]?.slug;
    const target = await worker.query<PushTargets | null>('social.push.targets', { notificationId: reminderPush[0] }, { actor: system, orgId: o.orgId });
    expect(target).toMatchObject({ line: 'Một bài được giao cho bạn sắp đến hạn', path: `/o/${slug}/social/${postId}`, tag: `assignment_due:${postId}` });
    expect(JSON.stringify(target)).not.toContain('Khai trương');
    const assignedTarget = await worker.query<PushTargets | null>('social.push.targets', { notificationId: assignedPush[0] }, { actor: system, orgId: o.orgId });
    expect(assignedTarget).toMatchObject({ line: 'Bạn được giao một bài mới', path: `/o/${slug}/social/${postId}` });
  });

  it('keeps the scan to the worker and the reminder command to the system', async () => {
    const o = await org();
    const postId = await post(o);
    await assign(o, postId, o.member, dueIn(1));
    await expect(exec(o, o.owner, 'social.post.remind_due', { postId })).rejects.toThrow();
    const app = new pg.Client({ connectionString: (() => {
      const u = new URL(adminUrl);
      u.username = 'crove_app';
      u.password = 'test-app-pw';
      return u.toString();
    })() });
    await app.connect();
    try {
      await expect(app.query('SELECT * FROM crove_social.assignment_reminders_due(10)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
    expect((await one<{ post_id: string }>('SELECT post_id FROM crove_social.assignment_reminders_due(1000)', [])).map((r) => r.post_id)).toContain(postId);
  });
});
