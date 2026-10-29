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
import { socialCommands, socialQueries } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social attention in the inbox on PostgreSQL (#771)', () => {
  const dbName = `crove_test_social_attention_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Attention = { channels: { connectionId: string; status: string }[]; posts: { postId: string; excerpt: string; channels: { variantId: string; status: string; errorCode: string | null }[] }[]; total: number };
  const attention = (o: Org, user: string) => rt.query<Attention>('social.attention.inbox', {}, { actor: asUser(user), orgId: o.orgId });
  const setVariant = (postId: string, status: string, code: string | null = null) => admin((c) => c.query('UPDATE crove_social.post_variant SET status = $2, error_code = $3 WHERE post_id = $1', [postId, status, code]));

  it('lists expired channels and posts that did not go out for owners and admins, nothing for others', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    expect(await attention(o, o.owner)).toEqual({ channels: [], posts: [], total: 0 });
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Không đăng được', channels: [{ connectionId: conn }] });
    await setVariant(postId, 'failed', 'TOKEN_EXPIRED');
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = $1", [conn]));
    const seen = await attention(o, o.owner);
    expect(seen.total).toBe(2);
    expect(seen.channels).toEqual([expect.objectContaining({ connectionId: conn, status: 'expired' })]);
    expect(seen.posts).toEqual([expect.objectContaining({ postId, excerpt: 'Không đăng được', channels: [expect.objectContaining({ status: 'failed', errorCode: 'TOKEN_EXPIRED' })] })]);
    expect((await attention(o, o.admin)).total).toBe(2);
    expect(await attention(o, o.member)).toEqual({ channels: [], posts: [], total: 0 });
    expect(await attention(o, o.viewer)).toEqual({ channels: [], posts: [], total: 0 });
  });

  it('counts a paused post only while its channel is not active, and an unclear one always', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const paused = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Tạm dừng', channels: [{ connectionId: conn }] })).postId;
    await setVariant(paused, 'paused');
    expect((await attention(o, o.owner)).posts).toEqual([]);
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'error' WHERE id = $1", [conn]));
    expect((await attention(o, o.owner)).posts.map((p) => p.postId)).toEqual([paused]);
    const unclear = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Chưa rõ', channels: [{ connectionId: await connection(o.orgId, o.owner) }] })).postId;
    await setVariant(unclear, 'needs_attention', 'OUTCOME_UNKNOWN');
    expect((await attention(o, o.owner)).posts.map((p) => p.postId).sort()).toEqual([paused, unclear].sort());
    // Another org sees none of it.
    const other = await org();
    expect((await attention(other, other.owner)).total).toBe(0);
  });
});
