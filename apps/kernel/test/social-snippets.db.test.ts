// Saved Social snippets on PostgreSQL 17 (issue #584): who may create, change and delete them, names unique per org,
// the platform filter, and isolation between orgs. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type Snippet } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social snippets on PostgreSQL (#584)', () => {
  const dbName = `crove_test_social_snippets_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const exec = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });

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
  const list = (o: { orgId: string }, user: string, provider?: string) => rt.query<Snippet[]>('social.snippet.list', provider ? { provider } : {}, { actor: asUser(user), orgId: o.orgId });

  it('lets members save snippets, change and delete their own, and owners and admins any', async () => {
    const o = await org();
    const { snippetId: tags } = await exec<{ snippetId: string }>(o, o.member, 'social.snippet.create', { name: 'Hashtag cửa hàng', body: '#crove #khaitruong' });
    const { snippetId: sign } = await exec<{ snippetId: string }>(o, o.owner, 'social.snippet.create', { name: 'Chữ ký Zalo', body: 'Nhắn Zalo 0900 000 000', provider: 'zalo_oa', isTemplate: false });
    await expect(exec(o, o.viewer, 'social.snippet.create', { name: 'x', body: 'x' })).rejects.toMatchObject({ status: 403 });
    // Names are unique per org, whatever the case.
    await expect(exec(o, o.owner, 'social.snippet.create', { name: 'hashtag CỬA HÀNG', body: '#x' })).rejects.toMatchObject({ code: 'SNIPPET_NAME_TAKEN' });
    await expect(exec(o, o.member, 'social.snippet.create', { name: 'Lạ', body: '#x', provider: 'myspace' })).rejects.toThrow();

    const all = await list(o, o.member);
    expect(all.map((s) => [s.name, s.mine])).toEqual([
      ['Chữ ký Zalo', false],
      ['Hashtag cửa hàng', true],
    ]);
    expect((await list(o, o.owner)).every((s) => s.mine)).toBe(true);
    expect((await list(o, o.viewer)).some((s) => s.mine)).toBe(false);
    // A platform's list: its own and those for every platform.
    expect((await list(o, o.member, 'facebook_page')).map((s) => s.name)).toEqual(['Hashtag cửa hàng']);
    expect((await list(o, o.member, 'zalo_oa')).map((s) => s.name)).toEqual(['Chữ ký Zalo', 'Hashtag cửa hàng']);

    // A member changes their own, not someone else's; an admin or owner changes any.
    await exec(o, o.member, 'social.snippet.update', { snippetId: tags, name: 'Hashtag cửa hàng', body: '#crove', provider: null, isTemplate: false });
    await expect(exec(o, o.member, 'social.snippet.update', { snippetId: sign, name: 'Chữ ký', body: 'x', provider: null, isTemplate: false })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.member, 'social.snippet.delete', { snippetId: sign })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.owner, 'social.snippet.update', { snippetId: tags, name: 'Mẫu khai trương', body: 'Khai trương!\n#crove', provider: null, isTemplate: true });
    expect((await list(o, o.member)).find((s) => s.id === tags)).toMatchObject({ name: 'Mẫu khai trương', isTemplate: true, createdBy: o.member });
    await exec(o, o.owner, 'social.snippet.delete', { snippetId: tags });
    await exec(o, o.owner, 'social.snippet.delete', { snippetId: sign });
    expect(await list(o, o.member)).toEqual([]);
  });

  it('keeps snippets to their org', async () => {
    const o = await org();
    const stranger = await org();
    const { snippetId } = await exec<{ snippetId: string }>(o, o.member, 'social.snippet.create', { name: 'Riêng', body: '#noibo' });
    expect(await list(stranger, stranger.owner)).toEqual([]);
    await expect(exec(stranger, stranger.owner, 'social.snippet.update', { snippetId, name: 'x', body: 'x', provider: null, isTemplate: false })).rejects.toMatchObject({ code: 'SNIPPET_NOT_FOUND' });
    await expect(exec(stranger, stranger.owner, 'social.snippet.delete', { snippetId })).rejects.toMatchObject({ code: 'SNIPPET_NOT_FOUND' });
    // The same name is free in another org.
    await exec(stranger, stranger.owner, 'social.snippet.create', { name: 'Riêng', body: '#khac' });
    const columns = await admin(async (c) =>
      (
        await c.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'snippet' AND privilege_type = 'UPDATE' ORDER BY 1",
        )
      ).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(['body', 'is_template', 'name', 'provider', 'updated_at']);
  });
});