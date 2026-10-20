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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social channel sets on PostgreSQL (#774)', () => {
  const dbName = `crove_test_social_sets_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Set = { id: string; name: string; connectionIds: string[] };
  const sets = (o: Org, user: string) => rt.query<Set[]>('social.channel_set.list', {}, { actor: asUser(user), orgId: o.orgId });
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { code?: string }).code ?? String(e));

  it('lets owners and admins save and remove sets that everyone reads', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const b = await connection(o.orgId, o.owner);
    const { setId } = await exec<{ setId: string }>(o, o.admin, 'social.channel_set.save', { name: 'Thương hiệu  A', connectionIds: [a, b, a] });
    expect(await sets(o, o.viewer)).toEqual([expect.objectContaining({ id: setId, name: 'Thương hiệu A', connectionIds: [a, b] })]);
    expect(await code(exec(o, o.member, 'social.channel_set.save', { name: 'B', connectionIds: [a] }))).toBe('FORBIDDEN');
    // Names are unique whatever their case; renaming a set to its own name is fine.
    expect(await code(exec(o, o.owner, 'social.channel_set.save', { name: 'thương hiệu a', connectionIds: [a] }))).toBe('CHANNEL_SET_NAME_TAKEN');
    await exec(o, o.owner, 'social.channel_set.save', { setId, name: 'Thương hiệu A', connectionIds: [b] });
    expect((await sets(o, o.member))[0]?.connectionIds).toEqual([b]);
    // A channel of another org, or a made-up one, is refused.
    const other = await org();
    const foreign = await connection(other.orgId, other.owner);
    expect(await code(exec(o, o.owner, 'social.channel_set.save', { name: 'Lạ', connectionIds: [foreign] }))).toBe('CHANNEL_NOT_FOUND');
    expect(await sets(other, other.owner)).toEqual([]);
    expect(await exec(o, o.owner, 'social.channel_set.remove', { setId })).toMatchObject({ removed: true });
    expect(await sets(o, o.owner)).toEqual([]);
  });

  it('leaves out a channel disconnected after the set was saved', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const b = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel_set.save', { name: 'Cả hai', connectionIds: [a, b] });
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE id = $1", [b]));
    expect((await sets(o, o.owner))[0]?.connectionIds).toEqual([a]);
  });
});
