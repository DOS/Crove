// Saved views and whose-posts filters on PostgreSQL 17 (#1300): a private view is its owner's alone and a shared one
// every member's, in the commands and in the table's own policy below them; owners and admins change a shared view but
// never make it private; at most 20 per member, under a lock; a view goes with its member. The assignee and author
// filters take "me" or a member of the org, and a member limited to some channels (#1081) still lists only their
// channels' posts through them. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineQuery } from '@crove/kernel-runtime';
import { SAVED_VIEW_LIMIT, socialCommands, socialQueries, type SavedView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Every saved view the caller's context reads, with no filter of its own: what the table's policy lets through.
const rawViews = defineQuery({
  name: 'test.saved_view.raw',
  input: z.object({}),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx) => (await ctx.trx.selectFrom('crove_social.saved_view').select(['id', 'name']).orderBy('name').execute()).map((r) => r.name),
});

suite('social saved views on PostgreSQL (#1300)', () => {
  const dbName = `crove_test_social_views_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
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
  // A statement in a member's context as the API's login (crove_app), always rolled back: the policy, not a command.
  async function asApp<T>(orgId: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [user, orgId]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }
  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@views.test`, name: null });
  }
  type Org = { orgId: string; owner: string; admin: string; lan: string; minh: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, owner, admin: await person('admin'), lan: await person('lan'), minh: await person('minh'), viewer: await person('viewer') };
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [
        orgId,
        o.admin,
        o.lan,
        o.minh,
        o.viewer,
      ]),
    );
    return o;
  }
  async function connection(o: Org, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        name,
        o.owner,
      ]),
    );
    return id;
  }
  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const list = (o: Org, user: string) => rt.query<SavedView[]>('social.saved_view.list', {}, { actor: asUser(user), orgId: o.orgId });
  const raw = (o: Org, user: string) => rt.query<string[]>('test.saved_view.raw', {}, { actor: asUser(user), orgId: o.orgId });
  const save = (o: Org, user: string, input: Record<string, unknown>) => exec<{ viewId: string }>(o, user, 'social.saved_view.save', { filters: {}, shared: false, ...input });
  const posts = async (o: Org, user: string, input: Record<string, unknown>) =>
    (await rt.query<{ body: string }[]>('social.post.list', input, { actor: asUser(user), orgId: o.orgId })).map((p) => p.body).sort();

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
    appUrl = app.toString();
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries, rawViews] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows a private view to its owner alone and a shared one to every member, in the commands and in the policy', async () => {
    const o = await org();
    const mine = await save(o, o.lan, { name: 'Việc của tôi', filters: { tab: 'calendar', assignee: 'me', view: 'week' } });
    const team = await save(o, o.lan, { name: 'Nhóm Lan', filters: { tab: 'board', author: o.lan }, shared: true });
    expect(await list(o, o.lan)).toEqual([
      { id: team.viewId, name: 'Nhóm Lan', filters: { tab: 'board', author: o.lan }, shared: true, ownerId: o.lan, mine: true, canChange: true, updatedAt: expect.any(String) },
      { id: mine.viewId, name: 'Việc của tôi', filters: { tab: 'calendar', assignee: 'me', view: 'week' }, shared: false, ownerId: o.lan, mine: true, canChange: true, updatedAt: expect.any(String) },
    ]);
    // Another member, an admin and a viewer see the shared view only; the member may not change it, the admin may.
    expect((await list(o, o.minh)).map((v) => [v.name, v.canChange])).toEqual([['Nhóm Lan', false]]);
    expect((await list(o, o.admin)).map((v) => [v.name, v.canChange])).toEqual([['Nhóm Lan', true]]);
    expect((await list(o, o.viewer)).map((v) => v.name)).toEqual(['Nhóm Lan']);
    // Below the query's own filter: the table's policy shows the same rows.
    expect(await raw(o, o.lan)).toEqual(['Nhóm Lan', 'Việc của tôi']);
    expect(await raw(o, o.minh)).toEqual(['Nhóm Lan']);
    expect(await raw(o, o.owner)).toEqual(['Nhóm Lan']);
    // Another org sees nothing, its owner included.
    const other = await org();
    expect(await list(other, other.owner)).toEqual([]);
    expect(await raw(other, other.owner)).toEqual([]);

    // A private view: nobody else changes or deletes it, an owner of the org neither.
    await expect(save(o, o.owner, { viewId: mine.viewId, name: 'Đổi tên' })).rejects.toMatchObject({ code: 'SAVED_VIEW_NOT_FOUND' });
    await expect(exec(o, o.owner, 'social.saved_view.delete', { viewId: mine.viewId })).rejects.toMatchObject({ code: 'SAVED_VIEW_NOT_FOUND' });
    expect(await asApp(o.orgId, o.owner, async (c) => (await c.query("UPDATE crove_social.saved_view SET name = 'x' WHERE id = $1", [mine.viewId])).rowCount)).toBe(0);
    expect(await asApp(o.orgId, o.owner, async (c) => (await c.query('DELETE FROM crove_social.saved_view WHERE id = $1', [mine.viewId])).rowCount)).toBe(0);
    // A shared view: another member may not change or delete it, in the command or in the table.
    await expect(save(o, o.minh, { viewId: team.viewId, name: 'Của Minh', shared: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(exec(o, o.minh, 'social.saved_view.delete', { viewId: team.viewId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await asApp(o.orgId, o.minh, async (c) => (await c.query("UPDATE crove_social.saved_view SET name = 'x' WHERE id = $1", [team.viewId])).rowCount)).toBe(0);
    expect(await asApp(o.orgId, o.minh, async (c) => (await c.query('DELETE FROM crove_social.saved_view WHERE id = $1', [team.viewId])).rowCount)).toBe(0);
    // Nor write a view in someone else's name.
    await expect(
      asApp(o.orgId, o.minh, (c) => c.query("INSERT INTO crove_social.saved_view (org_id, user_id, name, filters) VALUES ($1, $2, 'Giả', '{}')", [o.orgId, o.lan])),
    ).rejects.toThrow(/row-level security/);
    // The admin renames it and keeps it shared, but may not make it private (it would hide it from them) in either place.
    await save(o, o.admin, { viewId: team.viewId, name: 'Nhóm Lan (tuần)', filters: { tab: 'calendar', author: o.lan, view: 'week' }, shared: true });
    await expect(save(o, o.admin, { viewId: team.viewId, name: 'Nhóm Lan', shared: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(asApp(o.orgId, o.admin, (c) => c.query('UPDATE crove_social.saved_view SET shared = false WHERE id = $1', [team.viewId]))).rejects.toThrow(/row-level security/);
    expect((await list(o, o.lan)).find((v) => v.id === team.viewId)).toMatchObject({ name: 'Nhóm Lan (tuần)', shared: true, ownerId: o.lan });
    // Its owner makes it private again; then only they see it.
    await save(o, o.lan, { viewId: team.viewId, name: 'Nhóm Lan (tuần)', filters: { tab: 'calendar' }, shared: false });
    expect(await list(o, o.minh)).toEqual([]);
    expect(await raw(o, o.admin)).toEqual([]);
    // A viewer saves views of their own but does not share them.
    await save(o, o.viewer, { name: 'Của tôi' });
    await expect(save(o, o.viewer, { name: 'Cho cả nhóm', shared: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The owner deletes their own; the admin a shared one.
    const again = await save(o, o.minh, { name: 'Của Minh', shared: true });
    expect(await exec(o, o.admin, 'social.saved_view.delete', { viewId: again.viewId })).toEqual({ viewId: again.viewId });
    expect(await exec(o, o.lan, 'social.saved_view.delete', { viewId: mine.viewId })).toEqual({ viewId: mine.viewId });
    expect((await list(o, o.lan)).map((v) => v.name)).toEqual(['Nhóm Lan (tuần)']);
  });

  it('keeps one name per member, at most 20 views per member under a lock, and drops a member’s views with them', async () => {
    const o = await org();
    await save(o, o.lan, { name: 'Tuần này' });
    await expect(save(o, o.lan, { name: '  Tuần này ' })).rejects.toMatchObject({ code: 'SAVED_VIEW_NAME_TAKEN' });
    // Another member may use the same name.
    await save(o, o.minh, { name: 'Tuần này', shared: true });
    for (let i = 2; i < SAVED_VIEW_LIMIT; i++) await save(o, o.lan, { name: `Chế độ ${i}` });
    // Two saves at once for the last place: one is kept, the other refused at the limit.
    const both = await Promise.allSettled([save(o, o.lan, { name: 'Cuối A' }), save(o, o.lan, { name: 'Cuối B' })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(both.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'SAVED_VIEW_LIMIT' } });
    const count = async (user: string) => (await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.saved_view WHERE org_id = $1 AND user_id = $2', [o.orgId, user]))).rows[0]?.n;
    expect(await count(o.lan)).toBe(String(SAVED_VIEW_LIMIT));
    // The limit counts the member's own views only: Minh's shared view did not take one of Lan's places, and Lan still
    // renames one at the limit.
    const first = (await list(o, o.lan)).find((v) => v.name === 'Tuần này' && v.mine);
    await save(o, o.lan, { viewId: first?.id, name: 'Tuần sau' });
    // A shape the contract does not know is refused before the table; the table's own check holds without it.
    await expect(save(o, o.minh, { name: 'Lạ', filters: { tab: 'metrics' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(save(o, o.minh, { name: 'Lạ', filters: { extra: 1 } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(admin((c) => c.query("INSERT INTO crove_social.saved_view (org_id, user_id, name, filters) VALUES ($1, $2, 'Mảng', '[]')", [o.orgId, o.minh]))).rejects.toThrow(/check constraint/);
    await expect(
      admin((c) => c.query('INSERT INTO crove_social.saved_view (org_id, user_id, name, filters) VALUES ($1, $2, $3, $4)', [o.orgId, o.minh, 'To', JSON.stringify({ q: 'x'.repeat(5000) })])),
    ).rejects.toThrow(/check constraint/);
    // A member who leaves takes their views along, shared ones too.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.minh]));
    expect(await count(o.minh)).toBe('0');
    expect((await list(o, o.lan)).every((v) => v.ownerId === o.lan)).toBe(true);
  });

  it('filters posts by any member as assignee or author, refuses a stranger, and keeps a limited member to their channels', async () => {
    const o = await org();
    const a = await connection(o, 'Kênh A');
    const b = await connection(o, 'Kênh B');
    const post = async (user: string, channels: string[], body: string) => (await exec<{ postId: string }>(o, user, 'social.post.create', { body, channels: channels.map((connectionId) => ({ connectionId })) })).postId;
    const lanOnA = await post(o.lan, [a], 'Lan viết trên A');
    await post(o.lan, [b], 'Lan viết trên B');
    const minhOnB = await post(o.minh, [b], 'Minh viết trên B');
    await post(o.owner, [a, b], 'Chủ viết trên A và B');
    await exec(o, o.owner, 'social.post.assign', { postId: lanOnA, assigneeUserId: o.minh, dueAt: null });
    await exec(o, o.owner, 'social.post.assign', { postId: minhOnB, assigneeUserId: o.minh, dueAt: null });

    // A manager checks one writer's queue and what is assigned to someone.
    expect(await posts(o, o.owner, { author: o.lan })).toEqual(['Lan viết trên A', 'Lan viết trên B']);
    expect(await posts(o, o.owner, { assignee: o.minh })).toEqual(['Lan viết trên A', 'Minh viết trên B']);
    expect(await posts(o, o.owner, { author: o.lan, assignee: o.minh })).toEqual(['Lan viết trên A']);
    expect(await posts(o, o.minh, { assignee: 'me' })).toEqual(['Lan viết trên A', 'Minh viết trên B']);
    expect(await posts(o, o.lan, { author: 'me', connectionId: b })).toEqual(['Lan viết trên B']);
    // A person outside the org, or a member of another org, is refused rather than listed as nothing.
    const other = await org();
    await expect(posts(o, o.owner, { author: other.lan })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    await expect(posts(o, o.owner, { assignee: randomUUID() })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    await expect(save(o, o.owner, { name: 'Người lạ', filters: { author: other.lan } })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });

    // A shared view applied by a member limited to channel A (#1081): the filters only narrow what they see.
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.minh, channelConnectionIds: [a] });
    const view = await save(o, o.owner, { name: 'Bài của Lan', filters: { tab: 'board', author: o.lan }, shared: true });
    const shared = (await list(o, o.minh)).find((v) => v.id === view.viewId);
    expect(shared?.filters).toEqual({ tab: 'board', author: o.lan });
    expect(await posts(o, o.minh, { author: shared?.filters.author })).toEqual(['Lan viết trên A']);
    expect(await posts(o, o.minh, { assignee: 'me' })).toEqual(['Lan viết trên A']);
    expect(await posts(o, o.minh, { author: o.lan, connectionId: b })).toEqual([]);
  });

  it('is purged with the org: the purge function lists the table among the Social rows it deletes', async () => {
    const { rows } = await admin((c) => c.query<{ src: string }>("SELECT prosrc AS src FROM pg_catalog.pg_proc WHERE oid = 'crove_kernel.org_purge(integer)'::regprocedure"));
    expect(rows[0]?.src).toContain("'crove_social.saved_view'");
  });
});
