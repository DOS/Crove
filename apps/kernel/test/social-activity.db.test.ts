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
    // The edit command's text columns, and the resolve command's two (#1168); nothing else.
    expect(columns).toEqual(['body', 'edited_at', 'resolved_at', 'resolved_by']);
    const asTenant = (statement: string, params: unknown[]) =>
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE crove_tenant');
          await c.query(statement, params);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    await expect(asTenant('UPDATE crove_social.post_comment SET author_user_id = $1 WHERE id = $2', [o.owner, commentId])).rejects.toThrow(/permission denied/);
    await expect(asTenant('UPDATE crove_social.post_comment SET created_at = now() WHERE id = $1', [commentId])).rejects.toThrow(/permission denied/);
    await expect(asTenant('DELETE FROM crove_social.post_comment WHERE id = $1', [commentId])).rejects.toThrow(/permission denied/);
    // Resolved at and by go together, whoever writes them.
    await expect(admin((c) => c.query('UPDATE crove_social.post_comment SET resolved_at = now() WHERE id = $1', [commentId]))).rejects.toThrow(/post_comment_resolved_check/);
    await expect(admin((c) => c.query('UPDATE crove_social.post_comment SET resolved_by = $1 WHERE id = $2', [o.owner, commentId]))).rejects.toThrow(/post_comment_resolved_check/);
  });

  it('lets the comment author, the post author or assignee, and owners and admins resolve and reopen a comment (#1168)', async () => {
    const o = await org();
    const [adminUser, assignee, bystander] = [await person('admin'), await person('assignee'), await person('bystander')];
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')", [o.orgId, adminUser, assignee, bystander]),
    );
    const conn = await connection(o.orgId, o.owner);
    // The member writes the post; the owner, the assignee and another member comment on it.
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Khuyến mãi cuối tuần', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.assign', { postId, assigneeUserId: assignee, dueAt: null });
    const byOwner = (await exec<{ commentId: string }>(o, o.owner, 'social.post_comment.add', { postId, body: 'Thêm giá cũ để so sánh' })).commentId;
    const byAssignee = (await exec<{ commentId: string }>(o, assignee, 'social.post_comment.add', { postId, body: 'Ảnh hơi tối' })).commentId;
    const byBystander = (await exec<{ commentId: string }>(o, bystander, 'social.post_comment.add', { postId, body: 'Ghi rõ ngày kết thúc' })).commentId;
    expect((await get(o, o.viewer, postId)).openComments).toBe(3);

    // A viewer, and a member who wrote neither the post nor the comment and is not assigned, may not.
    await expect(exec(o, o.viewer, 'social.post_comment.resolve', { commentId: byOwner })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, bystander, 'social.post_comment.resolve', { commentId: byOwner })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // The post's author resolves the owner's note; the text and the edit stamp stay as they were.
    const textOf = () => admin(async (c) => (await c.query('SELECT body, edited_at FROM crove_social.post_comment WHERE id = $1', [byOwner])).rows[0]);
    const before = await textOf();
    const done = await exec<{ resolvedAt: string; resolvedBy: string }>(o, o.member, 'social.post_comment.resolve', { commentId: byOwner });
    expect(done).toMatchObject({ commentId: byOwner, postId, resolvedBy: o.member });
    expect(await textOf()).toEqual(before);
    // Resolving again changes nothing: not the time, not who.
    expect(await exec(o, o.owner, 'social.post_comment.resolve', { commentId: byOwner })).toEqual(done);
    // The comment's own author, the assignee and an admin may too.
    await exec(o, bystander, 'social.post_comment.resolve', { commentId: byBystander });
    await exec(o, assignee, 'social.post_comment.resolve', { commentId: byAssignee });
    await exec(o, adminUser, 'social.post_comment.reopen', { commentId: byAssignee });
    expect((await get(o, o.viewer, postId)).openComments).toBe(1);
    const listed = await rt.query<PostView[]>('social.post.list', {}, { actor: asUser(o.viewer), orgId: o.orgId });
    expect(listed.find((p) => p.id === postId)?.openComments).toBe(1);

    // The timeline: who resolved and when, and who may act on each comment.
    const shown = (await activity(o, o.member, postId)).filter((i) => i.kind === 'comment');
    expect(shown.find((i) => i.id === byOwner)).toMatchObject({ resolvedAt: done.resolvedAt, resolvedBy: o.member, resolvable: true });
    expect(shown.find((i) => i.id === byOwner)?.resolvedByName).toMatch(/@social\.test$/);
    expect(shown.find((i) => i.id === byAssignee)).toMatchObject({ resolvedAt: null, resolvedBy: null, resolvedByName: null });
    const forBystander = new Map((await activity(o, bystander, postId)).filter((i) => i.kind === 'comment').map((i) => [i.id, i.resolvable]));
    expect(forBystander.get(byOwner)).toBe(false);
    expect(forBystander.get(byBystander)).toBe(true);
    expect((await activity(o, o.viewer, postId)).every((i) => !i.resolvable)).toBe(true);
    // Reopening an open one changes nothing; every call is audited on the comment.
    expect(await exec(o, o.member, 'social.post_comment.reopen', { commentId: byAssignee })).toMatchObject({ resolvedAt: null, resolvedBy: null });
    const audited = await admin(async (c) =>
      (
        await c.query<{ target_type: string; target_id: string }>(
          "SELECT target_type, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('social.post_comment.resolve', 'social.post_comment.reopen') AND outcome = 'ok'",
          [o.orgId],
        )
      ).rows,
    );
    expect(audited).toHaveLength(6);
    expect(audited.every((a) => a.target_type === 'social.post_comment')).toBe(true);

    // The pre-review lists the open notes first, and submitting still works.
    const review = await rt.query<{ findings: string[] }>('social.post.pre_review', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(review.findings[0]).toBe('1 bình luận nội bộ chưa xử lý.');
    await exec(o, o.member, 'social.post.submit', { postId });

    // Editing stays the author's, within 15 minutes, resolved or not.
    await exec(o, o.owner, 'social.post_comment.edit', { commentId: byOwner, body: 'Thêm giá cũ, gạch ngang' });
    await expect(exec(o, o.member, 'social.post_comment.edit', { commentId: byOwner, body: 'x' })).rejects.toMatchObject({ status: 403 });
    await admin((c) => c.query("UPDATE crove_social.post_comment SET created_at = now() - interval '16 minutes' WHERE id = $1", [byOwner]));
    await expect(exec(o, o.owner, 'social.post_comment.edit', { commentId: byOwner, body: 'Muộn' })).rejects.toMatchObject({ code: 'COMMENT_EDIT_CLOSED' });
    // A comment of another org is not found.
    const stranger = await org();
    await expect(exec(stranger, stranger.owner, 'social.post_comment.resolve', { commentId: byOwner })).rejects.toMatchObject({ code: 'COMMENT_NOT_FOUND' });
  });
});