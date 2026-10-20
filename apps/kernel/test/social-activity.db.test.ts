// Internal comments and the activity of a Social post on PostgreSQL 17 (issue #582): who may comment and edit, the
// edit window, and the timeline from comments, decisions and audited commands. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ActivityItem, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social post comments and activity on PostgreSQL (#582)', () => {
  const dbName = `crove_test_social_activity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const activity = async (o: { orgId: string }, user: string, postId: string) =>
    (await rt.query<{ items: ActivityItem[]; more: boolean }>('social.post.activity', { postId }, { actor: asUser(user), orgId: o.orgId })).items;

  it('lets members comment on a post or one of its channels, and shows them with the decisions and what happened', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Khai trương cửa hàng', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    const post = await get(o, o.member, postId);
    const variantId = post.variants[0]?.id as string;
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'changes_requested', comment: 'Thêm giá khai trương', variants: seen(post) });

    const { commentId } = await exec<{ commentId: string }>(o, o.member, 'social.post_comment.add', { postId, body: 'Đã hỏi giá bên bán hàng' });
    await exec(o, o.owner, 'social.post_comment.add', { postId, variantId, body: 'Kênh này cần ảnh dọc' });
    // Viewers read, they do not write; a channel of another post is refused.
    await expect(exec(o, o.viewer, 'social.post_comment.add', { postId, body: 'x' })).rejects.toMatchObject({ status: 403 });
    const other = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài khác', channels: [{ connectionId: conn }] });
    await expect(exec(o, o.member, 'social.post_comment.add', { postId: other.postId, variantId, body: 'x' })).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });

    const items = await activity(o, o.viewer, postId);
    expect(items.map((i) => i.kind)).toEqual(['comment', 'comment', 'decision', 'submitted', 'created']);
    expect(items[0]).toMatchObject({ body: 'Kênh này cần ảnh dọc', variantId, userId: o.owner, editable: false });
    expect(items[1]).toMatchObject({ id: commentId, body: 'Đã hỏi giá bên bán hàng', variantId: null, userId: o.member, editable: false });
    expect(items[2]).toMatchObject({ decision: 'changes_requested', body: 'Thêm giá khai trương', userId: o.owner, variantId });
    expect(items[4]).toMatchObject({ userId: o.member });
    expect(items.every((i) => i.name?.endsWith('@social.test'))).toBe(true);
    // The author sees their own comment as editable.
    expect((await activity(o, o.member, postId)).find((i) => i.id === commentId)?.editable).toBe(true);

    // Edits of the content show up as they happen.
    const fresh = await get(o, o.member, postId);
    await exec(o, o.member, 'social.post.update', { postId, revision: fresh.revision, body: 'Khai trương cửa hàng, giảm 20%' });
    expect((await activity(o, o.member, postId))[0]).toMatchObject({ kind: 'edited', userId: o.member, variantId: null });
  });

  it('lets only the author edit a comment, and only in its first 15 minutes', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài', channels: [{ connectionId: conn }] });
    const { commentId } = await exec<{ commentId: string }>(o, o.member, 'social.post_comment.add', { postId, body: 'Bản đầu' });
    await expect(exec(o, o.owner, 'social.post_comment.edit', { commentId, body: 'Chủ sửa' })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.member, 'social.post_comment.edit', { commentId, body: 'Bản sửa' });
    const edited = (await activity(o, o.member, postId)).find((i) => i.id === commentId);
    expect(edited).toMatchObject({ body: 'Bản sửa' });
    expect(edited?.editedAt).not.toBeNull();

    await admin((c) => c.query("UPDATE crove_social.post_comment SET created_at = now() - interval '16 minutes' WHERE id = $1", [commentId]));
    await expect(exec(o, o.member, 'social.post_comment.edit', { commentId, body: 'Muộn' })).rejects.toMatchObject({ code: 'COMMENT_EDIT_CLOSED' });
    expect((await activity(o, o.member, postId)).find((i) => i.id === commentId)).toMatchObject({ body: 'Bản sửa', editable: false });
  });

  it('keeps comments to their org, and lets no tenant transaction delete or rewrite one', async () => {
    const o = await org();
    const stranger = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài', channels: [{ connectionId: conn }] });
    const { commentId } = await exec<{ commentId: string }>(o, o.member, 'social.post_comment.add', { postId, body: 'Nội bộ' });
    await expect(activity(stranger, stranger.owner, postId)).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    await expect(exec(stranger, stranger.owner, 'social.post_comment.add', { postId, body: 'x' })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    await expect(exec(stranger, stranger.owner, 'social.post_comment.edit', { commentId, body: 'x' })).rejects.toMatchObject({ code: 'COMMENT_NOT_FOUND' });
    const grants = await admin(async (c) =>
      (
        await c.query<{ privilege_type: string }>(
          "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'post_comment' ORDER BY 1",
        )
      ).rows.map((r) => r.privilege_type),
    );
    expect(grants).toEqual(['INSERT', 'SELECT']);
    const columns = await admin(async (c) =>
      (
        await c.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'post_comment' AND privilege_type = 'UPDATE' ORDER BY 1",
        )
      ).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(['body', 'edited_at']);
  });
});