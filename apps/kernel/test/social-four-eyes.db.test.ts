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
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social four-eyes approval on PostgreSQL (#740)', () => {
  const dbName = `crove_test_social_foureyes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  const status = async (o: Org, postId: string) => (await get(o, o.owner, postId)).variants.map((v) => v.status);

  it('lets only owners turn it on, and then keeps the author from approving their own post there', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    expect(await refusal(exec(o, o.admin, 'social.channel.set_four_eyes', { connectionId: conn, fourEyes: true }))).toBe('FORBIDDEN');
    await exec(o, o.owner, 'social.channel.set_four_eyes', { connectionId: conn, fourEyes: true });
    expect((await rt.query<{ connectionId: string; fourEyes: boolean }[]>('social.channel.policies', {}, { actor: asUser(o.member), orgId: o.orgId })).find((p) => p.connectionId === conn)?.fourEyes).toBe(true);

    // The admin writes and submits; their approval is refused, the owner's goes through.
    const { postId } = await exec<{ postId: string }>(o, o.admin, 'social.post.create', { body: 'Bài của admin', channels: [{ connectionId: conn }] });
    await exec(o, o.admin, 'social.post.submit', { postId });
    const post = await get(o, o.admin, postId);
    expect(post.variants[0]?.review.fourEyes).toBe(true);
    expect(await refusal(exec(o, o.admin, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post) }))).toBe('SOCIAL_SELF_APPROVAL');
    expect(await status(o, postId)).toEqual(['in_review']);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    expect(await status(o, postId)).toEqual(['approved']);

    // The author may still send their own post back.
    const second = (await exec<{ postId: string }>(o, o.admin, 'social.post.create', { body: 'Bài thứ hai', channels: [{ connectionId: conn }] })).postId;
    await exec(o, o.admin, 'social.post.submit', { postId: second });
    await exec(o, o.admin, 'social.variant.decide', { postId: second, decision: 'changes_requested', comment: 'Tự sửa', variants: seen(await get(o, o.admin, second)) });
    expect(await status(o, second)).toEqual(['changes_requested']);
  });

  it('changes nothing while off, or on another channel', async () => {
    const o = await org();
    const off = await connection(o.orgId, o.owner);
    const on = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_four_eyes', { connectionId: on, fourEyes: true });
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài của chủ', channels: [{ connectionId: off }] });
    await exec(o, o.owner, 'social.post.submit', { postId });
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    expect(await status(o, postId)).toEqual(['approved']);
    // Turned off again: the owner approves their own post on that channel too.
    await exec(o, o.owner, 'social.channel.set_four_eyes', { connectionId: on, fourEyes: false });
    const next = (await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài kênh hai', channels: [{ connectionId: on }] })).postId;
    await exec(o, o.owner, 'social.post.submit', { postId: next });
    await exec(o, o.owner, 'social.variant.decide', { postId: next, decision: 'approved', variants: seen(await get(o, o.owner, next)) });
    expect(await status(o, next)).toEqual(['approved']);
  });
});