// Labels and the assignee on many Social posts at once on PostgreSQL 17 (#1057): one transaction per command, the
// posts locked in id order, viewers refused, the assignee a member, each post left out with its reason, the assignee
// told of each post, and an entry on each post's timeline. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own database. The worker's dispatch is run here by hand for each new outbox event.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ActivityItem, type BulkEditResult, type NotificationItem, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social bulk labels and assignment on PostgreSQL (#1057)', () => {
  const dbName = `crove_test_social_bulk_edit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Org = { orgId: string; owner: string; member: string; other: string; viewer: string; conn: string; dispatched: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { member: await person('member'), other: await person('other'), viewer: await person('viewer') };
    const role = { member: 'member', other: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    const conn = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, conn, 'sandbox', `acct-${conn.slice(0, 8)}`, 'Kênh thử', owner],
      ),
    );
    return { orgId, owner, ...roles, conn, dispatched: new Set() };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const post = async (o: Org, user: string, body: string) => (await exec<{ postId: string }>(o, user, 'social.post.create', { body, channels: [{ connectionId: o.conn }] })).postId;
  const label = async (o: Org, name: string) => (await exec<{ labelId: string }>(o, o.member, 'social.label.create', { name })).labelId;
  // Out on every channel, as the publisher leaves it.
  const publish = (o: Org, postId: string) =>
    admin(async (c) => {
      await c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = now() WHERE org_id = $1 AND post_id = $2", [o.orgId, postId]);
      await c.query("UPDATE crove_social.post SET status = 'published' WHERE org_id = $1 AND id = $2", [o.orgId, postId]);
    });
  const labelsOf = async (o: Org, postId: string) => [...(await get(o, o.owner, postId)).labelIds].sort();
  const timeline = async (o: Org, postId: string, kind: string) =>
    (await rt.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.viewer), orgId: o.orgId })).items.filter((i) => i.kind === kind);
  const audits = (o: Org, command: string, outcome = 'ok') =>
    admin(async (c) => (await c.query<{ target_id: string | null; detail: Record<string, unknown> | null }>('SELECT target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = $3 ORDER BY occurred_at, id', [o.orgId, command, outcome])).rows);
  const sorted = (ids: readonly string[]) => [...ids].sort();

  // What the worker does for each new event of the org: the dispatch, in the org's system context.
  async function deliver(o: Org) {
    const events = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 ORDER BY created_at, id', [o.orgId])).rows);
    for (const e of events) {
      if (o.dispatched.has(e.id)) continue;
      o.dispatched.add(e.id);
      await worker.execute('social.notification.dispatch', { eventId: e.id }, { actor: system, orgId: o.orgId });
    }
  }
  const notifications = (o: Org, user: string) => rt.query<{ items: NotificationItem[] }>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId });

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

  it('adds and removes labels on many posts, naming each post left out, with an entry on each timeline', async () => {
    const o = await org();
    const [spring, sale] = [await label(o, 'Mùa xuân'), await label(o, 'Khuyến mãi')];
    const a = await post(o, o.member, 'Bài A');
    const b = await post(o, o.owner, 'Bài B');
    const c = await post(o, o.member, 'Bài C');
    const published = await post(o, o.member, 'Bài đã đăng');
    await exec(o, o.member, 'social.post.set_labels', { postId: b, labelIds: [sale] });
    await exec(o, o.member, 'social.post.set_labels', { postId: c, labelIds: [spring] });
    await publish(o, published);
    // Ten labels already: one more would be too many.
    const full = await post(o, o.member, 'Bài đủ nhãn');
    const ten: string[] = [];
    for (let i = 0; i < 10; i++) ten.push(await label(o, `Nhãn ${i}`));
    await exec(o, o.member, 'social.post.set_labels', { postId: full, labelIds: ten });
    const missing = randomUUID();
    const foreign = await org();
    const theirs = await post(foreign, foreign.member, 'Bài của tổ chức khác');
    const before = (await get(o, o.owner, a)).revision;
    const seen = (await audits(o, 'social.post.set_labels')).length;

    const result = await exec<BulkEditResult>(o, o.member, 'social.post.bulk_labels', { postIds: [a, b, c, published, full, missing, theirs], add: [spring], remove: [sale] });
    expect(sorted(result.done)).toEqual(sorted([a, b]));
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { postId: c, reason: 'unchanged' },
        { postId: published, reason: 'published' },
        { postId: full, reason: 'too_many_labels' },
        { postId: missing, reason: 'not_found' },
        { postId: theirs, reason: 'not_found' },
      ]),
    );
    expect(result.skipped).toHaveLength(5);
    // The posts are changed in id order, the order they were locked in.
    expect(result.done).toEqual(sorted(result.done));

    expect(await labelsOf(o, a)).toEqual([spring]);
    expect(await labelsOf(o, b)).toEqual([spring]);
    expect(await labelsOf(o, c)).toEqual([spring]);
    expect(await labelsOf(o, published)).toEqual([]);
    expect(await labelsOf(o, full)).toEqual(sorted(ten));
    expect((await get(foreign, foreign.owner, theirs)).labelIds).toEqual([]);
    // Labels are not content: no new revision.
    expect((await get(o, o.owner, a)).revision).toBe(before);

    // One audit row per post changed, each on its post, so each timeline shows its own change; the bulk row lists all.
    const rows = (await audits(o, 'social.post.set_labels')).slice(seen);
    expect(rows.map((r) => r.target_id).sort()).toEqual(sorted([a, b]));
    expect(await timeline(o, a, 'labeled')).toMatchObject([{ kind: 'labeled', userId: o.member }]);
    expect(await timeline(o, published, 'labeled')).toEqual([]);
    const [bulk] = await audits(o, 'social.post.bulk_labels');
    expect(bulk?.detail).toMatchObject({ add: [spring], remove: [sale], done: 2, post_ids: result.done });
  });

  it('refuses viewers, labels the org does not have, and more than 100 posts, changing nothing', async () => {
    const o = await org();
    const spring = await label(o, 'Mùa xuân');
    const a = await post(o, o.member, 'Bài A');
    await expect(exec(o, o.viewer, 'social.post.bulk_labels', { postIds: [a], add: [spring], remove: [] })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.viewer, 'social.post.bulk_assign', { postIds: [a], assigneeUserId: o.member })).rejects.toMatchObject({ status: 403 });
    // A label of another org is no label of this one.
    const foreign = await org();
    const theirs = await label(foreign, 'Nhãn lạ');
    await expect(exec(o, o.member, 'social.post.bulk_labels', { postIds: [a], add: [spring, theirs], remove: [] })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    expect(await labelsOf(o, a)).toEqual([]);
    const many = Array.from({ length: 101 }, () => randomUUID());
    await expect(exec(o, o.member, 'social.post.bulk_labels', { postIds: many, add: [spring], remove: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.member, 'social.post.bulk_labels', { postIds: [a], add: [], remove: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.member, 'social.post.bulk_labels', { postIds: [a], add: [spring], remove: [spring] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.member, 'social.post.bulk_labels', { postIds: [a, a], add: [spring], remove: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await audits(o, 'social.post.set_labels')).toEqual([]);
  });

  it('assigns many posts to a member as single assignments would, telling the assignee of each', async () => {
    const o = await org();
    const mine = await post(o, o.member, 'Bài của thành viên');
    const ownerPost = await post(o, o.owner, 'Bài của chủ');
    const published = await post(o, o.member, 'Bài đã đăng');
    await publish(o, published);
    const missing = randomUUID();
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();

    // A member assigns only the posts they wrote; the rest is left out with the reason.
    const first = await exec<BulkEditResult>(o, o.member, 'social.post.bulk_assign', { postIds: [mine, ownerPost, published, missing], assigneeUserId: o.other, dueAt: due });
    expect(first.done).toEqual([mine]);
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        { postId: ownerPost, reason: 'not_allowed' },
        { postId: published, reason: 'published' },
        { postId: missing, reason: 'not_found' },
      ]),
    );
    expect(await get(o, o.owner, mine)).toMatchObject({ assigneeUserId: o.other });
    expect(Date.parse((await get(o, o.owner, mine)).dueAt ?? '')).toBe(Date.parse(due));
    expect(await get(o, o.owner, ownerPost)).toMatchObject({ assigneeUserId: null, dueAt: null });
    expect(await get(o, o.owner, published)).toMatchObject({ assigneeUserId: null });
    // The refused post is audited as a refused single assignment would be, linked to the bulk command.
    const denied = await audits(o, 'social.post.assign', 'denied');
    expect(denied.map((r) => r.target_id)).toEqual([ownerPost]);
    expect(denied[0]?.detail).toMatchObject({ code: 'FORBIDDEN', parentCommand: 'social.post.bulk_assign' });

    // The owner assigns both, keeping each post's own due date: the member's post is already so.
    const second = await exec<BulkEditResult>(o, o.owner, 'social.post.bulk_assign', { postIds: [mine, ownerPost], assigneeUserId: o.other });
    expect(second).toEqual({ done: [ownerPost], skipped: [{ postId: mine, reason: 'unchanged' }] });
    expect(Date.parse((await get(o, o.owner, mine)).dueAt ?? '')).toBe(Date.parse(due));
    expect(await get(o, o.owner, ownerPost)).toMatchObject({ assigneeUserId: o.other, dueAt: null });

    // The assignee hears of each post, as for a single assignment; never the person who acted.
    await deliver(o);
    const told = (await notifications(o, o.other)).items.filter((i) => i.kind === 'assigned');
    expect(told.map((i) => i.postId).sort()).toEqual(sorted([mine, ownerPost]));
    expect((await notifications(o, o.member)).items.filter((i) => i.kind === 'assigned')).toEqual([]);
    const events = await admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.assigned' ORDER BY created_at, id", [o.orgId])).rows);
    expect(events.map((e) => e.payload)).toEqual([
      { post_id: mine, assignee_user_id: o.other, by: o.member },
      { post_id: ownerPost, assignee_user_id: o.other, by: o.owner },
    ]);

    // Each post's timeline shows who assigned it.
    expect(await timeline(o, mine, 'assigned')).toMatchObject([{ userId: o.member }]);
    expect(await timeline(o, ownerPost, 'assigned')).toMatchObject([{ userId: o.owner }]);

    // A null due date clears it; nobody unassigns.
    await exec(o, o.owner, 'social.post.bulk_assign', { postIds: [mine], assigneeUserId: o.other, dueAt: null });
    expect(await get(o, o.owner, mine)).toMatchObject({ assigneeUserId: o.other, dueAt: null });
    await exec(o, o.owner, 'social.post.bulk_assign', { postIds: [mine, ownerPost], assigneeUserId: null });
    expect(await get(o, o.owner, mine)).toMatchObject({ assigneeUserId: null });
    expect(await get(o, o.owner, ownerPost)).toMatchObject({ assigneeUserId: null });
  });

  it('refuses an assignee who is not a member of the org, assigning nothing', async () => {
    const o = await org();
    const a = await post(o, o.member, 'Bài A');
    const stranger = await person('stranger');
    await expect(exec(o, o.owner, 'social.post.bulk_assign', { postIds: [a], assigneeUserId: stranger })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_MEMBER' });
    // A member of another org is no member of this one.
    const foreign = await org();
    await expect(exec(o, o.owner, 'social.post.bulk_assign', { postIds: [a], assigneeUserId: foreign.member, dueAt: null })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_MEMBER' });
    // Nor is one who has left.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.other]));
    await expect(exec(o, o.owner, 'social.post.bulk_assign', { postIds: [a], assigneeUserId: o.other })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_MEMBER' });
    expect(await get(o, o.owner, a)).toMatchObject({ assigneeUserId: null });
    expect(await audits(o, 'social.post.assign')).toEqual([]);
  });

  it('locks every post it names in id order before changing any, in one transaction', async () => {
    const o = await org();
    const spring = await label(o, 'Mùa xuân');
    const ids = sorted([await post(o, o.member, 'Một'), await post(o, o.member, 'Hai'), await post(o, o.member, 'Ba')]);
    const [low, mid, high] = ids as [string, string, string];
    // Another transaction holds the highest post: the bulk edit takes the lower ones first, then waits.
    const holder = new pg.Client({ connectionString: adminUrl });
    const prober = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    await prober.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM crove_social.post WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, high]);
      const running = exec<BulkEditResult>(o, o.member, 'social.post.bulk_labels', { postIds: [high, low, mid], add: [spring], remove: [] });
      for (let waiting = 0; waiting < 1; ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { rows } = await prober.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        waiting = rows[0]?.n ?? 0;
      }
      // While it waits, the lower posts are already its own, and none has a label yet.
      for (const id of [low, mid]) {
        await expect(prober.query('SELECT id FROM crove_social.post WHERE org_id = $1 AND id = $2 FOR UPDATE NOWAIT', [o.orgId, id])).rejects.toMatchObject({ code: '55P03' });
      }
      const { rows: early } = await prober.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_social.post_label WHERE org_id = $1', [o.orgId]);
      expect(early[0]?.n).toBe(0);
      await holder.query('COMMIT');
      const result = await running;
      expect(result.done).toEqual(ids);
    } finally {
      await holder.end();
      await prober.end();
    }
    for (const id of ids) expect(await labelsOf(o, id)).toEqual([spring]);

    // A refusal of the whole command (a label deleted before it ran) leaves every post as it was.
    const gone = await label(o, 'Sắp xóa');
    await exec(o, o.owner, 'social.label.delete', { labelId: gone });
    await expect(exec(o, o.member, 'social.post.bulk_labels', { postIds: ids, add: [gone], remove: [spring] })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    for (const id of ids) expect(await labelsOf(o, id)).toEqual([spring]);
  });
});
