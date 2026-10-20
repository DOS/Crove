// A Social post's assignee and due date on PostgreSQL 17 (issue #640): who may set them, members only, the Mine list,
// and no new revision. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social post assignment on PostgreSQL (#640)', () => {
  const dbName = `crove_test_social_assign_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
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

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles: Record<'member' | 'viewer', string> = { member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(orgId: string, owner: string, provider = 'sandbox') {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, id, provider, `acct-${id.slice(0, 8)}`, 'Kênh thử', owner],
      ),
    );
    return id;
  }

  const exec = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: { orgId: string }, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });

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
    rt = new Runtime(db).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const list = (o: { orgId: string }, user: string, input: Record<string, unknown>) => rt.query<PostView[]>('social.post.list', input, { actor: asUser(user), orgId: o.orgId });

  it('lets owners, admins and the author assign a post to a member with a due date, without a new revision', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài khai trương', channels: [{ connectionId: conn }] });
    const before = await get(o, o.member, postId);
    const due = new Date(Date.now() + 86_400_000).toISOString();

    // The author assigns it to the owner.
    await exec(o, o.member, 'social.post.assign', { postId, assigneeUserId: o.owner, dueAt: due });
    const after = await get(o, o.member, postId);
    expect(after).toMatchObject({ assigneeUserId: o.owner, revision: before.revision });
    expect(Date.parse(after.dueAt ?? '')).toBe(Date.parse(due));
    expect(after.variants.map((v) => v.revision)).toEqual(before.variants.map((v) => v.revision));
    const events = await admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.assigned'", [o.orgId])).rows);
    expect(events.map((e) => e.payload)).toEqual([{ post_id: postId, assignee_user_id: o.owner, by: o.member }]);

    // The owner sees it under Mine; the member does not.
    expect((await list(o, o.owner, { assignee: 'me' })).map((p) => p.id)).toEqual([postId]);
    expect(await list(o, o.member, { assignee: 'me' })).toEqual([]);

    // A viewer, or a member who did not write it, cannot change it; nobody can assign it outside the org.
    await expect(exec(o, o.viewer, 'social.post.assign', { postId, assigneeUserId: null, dueAt: null })).rejects.toMatchObject({ status: 403 });
    const other = await person('other');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, other]));
    await expect(exec(o, other, 'social.post.assign', { postId, assigneeUserId: other, dueAt: null })).rejects.toMatchObject({ status: 403 });
    const stranger = await person('stranger');
    await expect(exec(o, o.owner, 'social.post.assign', { postId, assigneeUserId: stranger, dueAt: null })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_MEMBER' });

    // Cleared by the owner.
    await exec(o, o.owner, 'social.post.assign', { postId, assigneeUserId: null, dueAt: null });
    expect(await get(o, o.member, postId)).toMatchObject({ assigneeUserId: null, dueAt: null });
  });
});