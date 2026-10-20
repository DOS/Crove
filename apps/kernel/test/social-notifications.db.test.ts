// In-app notifications of Crove Social on PostgreSQL 17 (#637): who each event tells, never the person who acted, the
// kinds a member turns off, reading and marking only one's own, a client's answer through a review link, and pruning.
// The worker's dispatch is run here by hand for each new outbox event. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type NotificationItem, type PostView } from '@crove/mod-social';
import { reviewAnswer } from '../src/review-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social in-app notifications on PostgreSQL (#637)', () => {
  const dbName = `crove_test_social_notify_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const kinds = async (o: Org, user: string) => (await list(o, user)).items.map((i) => i.kind);

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
    rt = new Runtime(db).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
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

  it('tells reviewers of a submitted post, the author of a decision, and the thread of a comment, never the actor', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Khai trương cửa hàng', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await deliver(o);
    expect(await kinds(o, o.owner)).toEqual(['review_requested']);
    expect(await kinds(o, o.admin)).toEqual(['review_requested']);
    expect(await kinds(o, o.member)).toEqual([]);
    expect(await kinds(o, o.viewer)).toEqual([]);
    const ask = (await list(o, o.owner)).items[0];
    expect(ask).toMatchObject({ postId, postText: 'Khai trương cửa hàng', read: false });
    expect(ask?.actorName).toMatch(/^member-.*@social\.test$/);

    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'changes_requested', comment: 'Thêm giá', variants: seen(await get(o, o.owner, postId)) });
    await deliver(o);
    expect((await list(o, o.member)).items).toEqual([expect.objectContaining({ kind: 'decided', postId, detail: { decision: 'changes_requested' } })]);
    expect(await kinds(o, o.owner)).toEqual(['review_requested']);

    // A comment tells the author and those who commented before; a later one by the author tells the earlier commenter.
    await exec(o, o.other, 'social.post_comment.add', { postId, body: 'Ảnh hơi tối' });
    await deliver(o);
    expect(await kinds(o, o.member)).toEqual(['comment', 'decided']);
    expect(await kinds(o, o.owner)).toEqual(['review_requested']);
    await exec(o, o.member, 'social.post_comment.add', { postId, body: 'Đã đổi ảnh' });
    await deliver(o);
    expect(await kinds(o, o.other)).toEqual(['comment']);
    expect(await kinds(o, o.member)).toEqual(['comment', 'decided']);

    // A dispatch run twice for one event writes nothing the second time.
    const last = [...o.dispatched].at(-1) as string;
    await expect(worker.execute('social.notification.dispatch', { eventId: last }, { actor: system, orgId: o.orgId })).resolves.toEqual({ sent: 0, mailed: 0 });
  });

  it('says nothing to reviewers when the post is no longer waiting, and tells the deciders when a channel expires', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    // The owner approves their own post in one step: submitted, then decided; nobody else is asked.
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài của chủ', channels: [{ connectionId: conn }] });
    await exec(o, o.owner, 'social.post.submit', { postId });
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    await deliver(o);
    expect(await kinds(o, o.admin)).toEqual([]);

    await worker.execute('kernel.channel.mark_expired', { connectionId: conn, reason: 'token revoked' }, { actor: system, orgId: o.orgId });
    await deliver(o);
    for (const user of [o.owner, o.admin]) {
      expect((await list(o, user)).items).toEqual([expect.objectContaining({ kind: 'channel_expired', connectionId: conn, channel: 'Kênh thử', actorName: null, detail: { provider: 'sandbox' } })]);
    }
    expect(await kinds(o, o.member)).toEqual([]);
  });

  it('lets each member read, mark and turn off only their own', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const posts: string[] = [];
    for (const body of ['Một', 'Hai', 'Ba']) {
      const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: conn }] });
      await exec(o, o.member, 'social.post.submit', { postId });
      posts.push(postId);
    }
    await deliver(o);
    const mine = await list(o, o.owner);
    expect(mine.unread).toBe(3);
    // Another member's ids are not theirs to mark.
    await expect(exec(o, o.admin, 'social.notification.read', { ids: [mine.items[0]?.id] })).resolves.toEqual({ read: 0 });
    await expect(exec(o, o.owner, 'social.notification.read', { ids: [mine.items[0]?.id] })).resolves.toEqual({ read: 1 });
    expect((await list(o, o.owner)).unread).toBe(2);
    expect((await list(o, o.admin)).unread).toBe(3);
    await expect(exec(o, o.owner, 'social.notification.read', { all: true })).resolves.toEqual({ read: 2 });
    expect((await list(o, o.owner)).items.every((i) => i.read)).toBe(true);
    await expect(exec(o, o.owner, 'social.notification.read', { ids: [] })).rejects.toMatchObject({ status: 422 });

    // A tenant transaction of one member sees only that member's rows, and moves none to another person.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [o.admin, o.orgId]);
      const { rows } = await client.query<{ user_id: string }>('SELECT user_id FROM crove_social.notification');
      expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([o.admin]));
      await expect(client.query('UPDATE crove_social.notification SET user_id = $1', [o.owner])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await expect(
      admin((c) => c.query('INSERT INTO crove_social.notification (org_id, user_id, kind, event_id) VALUES ($1, $2, $3, $4)', [o.orgId, o.owner, 'pinned', randomUUID()])),
    ).rejects.toMatchObject({ code: '23514' });

    // Turned off: the next one of that kind is not written; turned on again, it is.
    await exec(o, o.admin, 'social.notification.mute', { kind: 'review_requested', muted: true });
    expect((await list(o, o.admin)).muted).toEqual(['review_requested']);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bốn', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await deliver(o);
    expect((await list(o, o.admin)).items).toHaveLength(3);
    expect((await list(o, o.owner)).items).toHaveLength(4);
    await exec(o, o.admin, 'social.notification.mute', { kind: 'review_requested', muted: false });
    expect((await list(o, o.admin)).muted).toEqual([]);

    // Someone no longer a member is not told.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.admin]));
    const five = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Năm', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId: five.postId });
    await deliver(o);
    const left = await admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_social.notification WHERE org_id = $1 AND user_id = $2', [o.orgId, o.admin])).rows[0]?.n);
    expect(left).toBe(3);
  });

  it('tells a member a post was assigned to them, but not one who assigns it to themselves (#640)', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Giao việc', channels: [{ connectionId: conn }] });
    await exec(o, o.owner, 'social.post.assign', { postId, assigneeUserId: o.other, dueAt: null });
    await deliver(o);
    expect((await list(o, o.other)).items).toEqual([expect.objectContaining({ kind: 'assigned', postId, postText: 'Giao việc' })]);
    expect((await list(o, o.other)).items[0]?.actorName).toMatch(/^owner-/);
    await exec(o, o.member, 'social.post.assign', { postId, assigneeUserId: o.member, dueAt: null });
    await exec(o, o.member, 'social.post.assign', { postId, assigneeUserId: null, dueAt: null });
    await deliver(o);
    expect(await kinds(o, o.member)).toEqual([]);
  });

  it('tells the author of a client answer through a review link, and keeps the org to the server', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Gửi khách duyệt', channels: [{ connectionId: conn }] });
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.review_link.create', { postId });
    await expect(reviewAnswer(rt, { token, name: 'Chị Lan', verdict: 'changes_requested', body: 'Đổi màu chữ' })).resolves.toEqual({ recorded: true });
    await deliver(o);
    expect((await list(o, o.member)).items).toEqual([expect.objectContaining({ kind: 'client_answer', postId, actorName: null, detail: { verdict: 'changes_requested', name: 'Chị Lan' } })]);
    expect(await kinds(o, o.owner)).toEqual([]);
  });

  it('prunes read ones after 30 days and any after 90, and keeps them to their org', async () => {
    const o = await org();
    const stranger = await org();
    const conn = await connection(o.orgId, o.owner);
    const ids: string[] = [];
    for (const body of ['Cũ đã đọc', 'Cũ chưa đọc', 'Mới đã đọc']) {
      const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: conn }] });
      await exec(o, o.member, 'social.post.submit', { postId });
      await deliver(o);
      ids.push(((await list(o, o.owner)).items[0] as NotificationItem).id);
    }
    await admin((c) => c.query("UPDATE crove_social.notification SET read_at = now() - interval '31 days' WHERE id = $1", [ids[0]]));
    await admin((c) => c.query("UPDATE crove_social.notification SET created_at = now() - interval '91 days' WHERE id = $1", [ids[1]]));
    await admin((c) => c.query("UPDATE crove_social.notification SET read_at = now() - interval '2 days' WHERE id = $1", [ids[2]]));
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài mới', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await deliver(o);
    const left = (await list(o, o.owner)).items.map((i) => i.postText);
    expect(left).toEqual(['Bài mới', 'Mới đã đọc']);

    expect((await list(stranger, stranger.owner)).items).toEqual([]);
    await expect(exec(stranger, stranger.owner, 'social.notification.read', { ids })).resolves.toEqual({ read: 0 });
    // An event of another org is not found from this one.
    const foreign = [...o.dispatched][0] as string;
    await expect(worker.execute('social.notification.dispatch', { eventId: foreign }, { actor: system, orgId: stranger.orgId })).resolves.toEqual({ sent: 0, mailed: 0 });
    // Only the system runs the dispatch.
    await expect(exec(o, o.owner, 'social.notification.dispatch', { eventId: foreign })).rejects.toMatchObject({ status: 403 });
  });
});
