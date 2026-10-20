// Four-eyes approval (#740) on PostgreSQL 17: owners turn it on per channel; then the author of a post may not approve
// it there (asking for changes and rejecting stay allowed), someone else must; off, nothing changes. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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

suite('social reviews in the inbox on PostgreSQL (#749)', () => {
  const dbName = `crove_test_social_inbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string; viewer: string; };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), other: await person('other'), viewer: await person('viewer') };
    const role = { admin: 'admin', member: 'member', other: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles };
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
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  type Inbox = { items: { postId: string; title: string | null; excerpt: string; channels: { variantId: string; provider: string; displayName: string }[]; at: string | null }[]; total: number };
  const inbox = (o: Org, user: string) => rt.query<Inbox>('social.review.inbox', {}, { actor: asUser(user), orgId: o.orgId });
  const ids = async (o: Org, user: string) => (await inbox(o, user)).items.map((i) => i.postId);

  it('lists posts in review for owners and admins, and nothing for members and viewers', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Khai trương  quán\nmới', channels: [{ connectionId: conn }] });
    // A draft is not waiting for anyone.
    expect(await ids(o, o.owner)).toEqual([]);
    await exec(o, o.member, 'social.post.submit', { postId });
    const listed = await inbox(o, o.owner);
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ postId, title: null, excerpt: 'Khai trương quán mới', at: null, channels: [{ provider: 'sandbox', displayName: 'Kênh thử' }] });
    expect(await ids(o, o.admin)).toEqual([postId]);
    expect(await inbox(o, o.member)).toEqual({ items: [], total: 0 });
    expect(await inbox(o, o.viewer)).toEqual({ items: [], total: 0 });
    // Decided: gone from the inbox.
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    expect(await ids(o, o.owner)).toEqual([]);
    expect(await ids(o, o.admin)).toEqual([]);
  });

  it('leaves out a post the viewer already approved, or wrote on a four-eyes channel', async () => {
    const o = await org();
    const two = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: two, approvalsRequired: 2 });
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Cần hai người duyệt', channels: [{ connectionId: two }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    // The owner gave their approval; the admin's is still needed.
    expect(await ids(o, o.owner)).toEqual([]);
    expect(await ids(o, o.admin)).toEqual([postId]);

    const guarded = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_four_eyes', { connectionId: guarded, fourEyes: true });
    const own = (await exec<{ postId: string }>(o, o.admin, 'social.post.create', { body: 'Bài của admin', channels: [{ connectionId: guarded }] })).postId;
    await exec(o, o.admin, 'social.post.submit', { postId: own });
    expect(await ids(o, o.admin)).toEqual([postId]);
    expect((await ids(o, o.owner)).sort()).toEqual([own]);
  });

  it('keeps one item per post with every channel waiting, and its earliest time', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const b = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Hai kênh', channels: [{ connectionId: a }, { connectionId: b }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    const at = new Date('2026-11-01T02:00:00Z');
    await admin((c) => c.query('UPDATE crove_social.post SET scheduled_at = $2 WHERE id = $1', [postId, at]));
    const listed = await inbox(o, o.owner);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.channels).toHaveLength(2);
    expect(listed.items[0]).toMatchObject({ title: null, excerpt: 'Hai kênh', at: at.toISOString() });
    // A channel with its own text shows that text, the one its reviewer approves.
    const own = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Chung', channels: [{ connectionId: a, body: 'Riêng của kênh' }] })).postId;
    await exec(o, o.member, 'social.post.submit', { postId: own });
    expect((await inbox(o, o.owner)).items.find((i) => i.postId === own)?.excerpt).toBe('Riêng của kênh');
  });
});
