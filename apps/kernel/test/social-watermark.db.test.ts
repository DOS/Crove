// The org's logo watermark (#834) on PostgreSQL 17: who saves, changes and removes it, which files may be the logo,
// and that one org never sees another's. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type Watermark } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social logo watermark on PostgreSQL (#834)', () => {
  const dbName = `crove_test_social_watermark_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer };
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
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function socialFile(orgId: string, owner: string, type = 'image/png', source = 'social') {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by) VALUES ($1, $2, $3, $4, $5, 'logo.png', $6, 1000, $7, $8)", [orgId, id, sha, `org/${orgId}/${sha}`, `content:${sha}`, type, source, owner]),
    );
    return id;
  }

  it('lets owners and admins save, change and remove the logo, and everyone read it', async () => {
    const o = await org();
    const exec = <T>(user: string, name: string, input: unknown) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId });
    const get = (user: string) => rt.query<Watermark | null>('social.watermark.get', {}, { actor: asUser(user), orgId: o.orgId });
    expect(await get(o.viewer)).toBeNull();
    const logo = await socialFile(o.orgId, o.owner);
    expect(await exec(o.owner, 'social.watermark.save', { fileId: logo, corner: 'bottom_right', scalePercent: 20, opacityPercent: 80 })).toEqual({ saved: true });
    expect(await get(o.viewer)).toMatchObject({ fileId: logo, mime: 'image/png', corner: 'bottom_right', scalePercent: 20, opacityPercent: 80 });
    // A second save changes the one watermark, it never adds another.
    const other = await socialFile(o.orgId, o.owner, 'image/webp');
    await exec(o.owner, 'social.watermark.save', { fileId: other, corner: 'top_left', scalePercent: 50, opacityPercent: 10 });
    expect(await get(o.member)).toMatchObject({ fileId: other, mime: 'image/webp', corner: 'top_left', scalePercent: 50, opacityPercent: 10 });
    expect(await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_social.watermark WHERE org_id = $1', [o.orgId])).rows[0].n)).toBe(1);

    await expect(exec(o.member, 'social.watermark.save', { fileId: logo, corner: 'bottom_right', scalePercent: 20, opacityPercent: 80 })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o.member, 'social.watermark.remove', {})).rejects.toMatchObject({ status: 403 });
    await expect(exec(o.owner, 'social.watermark.save', { fileId: logo, corner: 'middle', scalePercent: 20, opacityPercent: 80 })).rejects.toMatchObject({ status: 422 });
    await expect(exec(o.owner, 'social.watermark.save', { fileId: logo, corner: 'bottom_right', scalePercent: 60, opacityPercent: 80 })).rejects.toMatchObject({ status: 422 });
    await expect(exec(o.owner, 'social.watermark.save', { fileId: logo, corner: 'bottom_right', scalePercent: 20, opacityPercent: 5 })).rejects.toMatchObject({ status: 422 });

    expect(await exec(o.owner, 'social.watermark.remove', {})).toEqual({ removed: true });
    expect(await get(o.viewer)).toBeNull();
    expect(await exec(o.owner, 'social.watermark.remove', {})).toEqual({ removed: false });
  });

  it('takes only an image of the org own Social library as the logo, and keeps orgs apart', async () => {
    const o = await org();
    const p = await org();
    const save = (fileId: string) => rt.execute('social.watermark.save', { fileId, corner: 'bottom_right', scalePercent: 20, opacityPercent: 80 }, { actor: asUser(o.owner), orgId: o.orgId });
    await expect(save(await socialFile(o.orgId, o.owner, 'video/mp4'))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(save(await socialFile(o.orgId, o.owner, 'image/png', 'upload'))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(save(await socialFile(p.orgId, p.owner))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(save(randomUUID())).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await save(await socialFile(o.orgId, o.owner));
    expect(await rt.query('social.watermark.get', {}, { actor: asUser(p.viewer), orgId: p.orgId })).toBeNull();
  });
});
