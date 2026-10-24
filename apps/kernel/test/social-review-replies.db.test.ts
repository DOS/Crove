// The team's reply to a client's answer on a review link (#1301), with the plan link follow-ups of #930, on
// PostgreSQL 17: members and above reply, edit and clear (viewers do not, a member limited to some channels only on
// their posts); the client sees the reply on the single-post page and the plan page signed by neither a member's name
// nor id; the answer counts and the client's verdict stay as they were; crove_tenant writes only the reply columns, and
// only in its own member's name; a plan's body comes once per post; no tenant path adds a post to a frozen plan; and
// the live link caps hold against links made at the same time. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CompiledQuery, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView, type ReviewFeedbackView, type ReviewLinkView, type ReviewReplyView } from '@crove/mod-social';
import { reviewView } from '../src/review-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;

// SQL run as crove_tenant in a member's context, as a command's own statements run, so the grants and the guard are
// what refuses it, not the commands' rules. A refusal comes back as its SQLSTATE (the savepoint keeps the transaction
// usable for the command's audit row).
const rawSql = defineCommand({
  name: 'test.review_reply.raw',
  input: z.object({ text: z.string(), params: z.array(z.unknown()) }),
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input): Promise<{ ok: true; rows: number } | { ok: false; code: string; message: string }> => {
    await sql`SAVEPOINT raw_probe`.execute(ctx.trx);
    try {
      const result = await ctx.trx.executeQuery(CompiledQuery.raw(input.text, input.params));
      return { ok: true, rows: Number(result.numAffectedRows ?? result.rows.length) };
    } catch (error) {
      await sql`ROLLBACK TO SAVEPOINT raw_probe`.execute(ctx.trx);
      const e = error as { code?: string; message?: string };
      return { ok: false, code: e.code ?? 'unknown', message: e.message ?? '' };
    }
  },
});

suite('social review replies on PostgreSQL (#1301, #930)', () => {
  const dbName = `crove_test_social_review_replies_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@reply.test`, name: `Người ${name}` });

  type Org = { orgId: string; name: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const name = `Org ${randomUUID().slice(0, 6)}`;
    const { orgId } = await createOrg(rt, asUser(owner), name);
    const roles = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, name, owner, ...roles };
  }

  async function connection(o: Org, name = 'Kênh thử') {
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
  const raw = (o: Org, user: string, text: string, params: unknown[] = []) =>
    exec<{ ok: true; rows: number } | { ok: false; code: string; message: string }>(o, user, 'test.review_reply.raw', { text, params });
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const links = (o: Org, user: string, postId: string) => rt.query<{ links: ReviewLinkView[]; feedback: ReviewFeedbackView[] }>('social.review_link.list', { postId }, { actor: asUser(user), orgId: o.orgId });
  const reply = (o: Org, user: string, feedbackId: string, body: string | null) =>
    exec<{ feedbackId: string; postId: string; reply: ReviewReplyView | null }>(o, user, 'social.review.reply', { feedbackId, body });
  const draft = async (o: Org, conn: string, body: string, extra: Record<string, unknown> = {}) =>
    (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: conn }], scheduledAt: new Date(Date.now() + DAY).toISOString(), ...extra })).postId;

  type Reply = { body: string; at: string } | null;
  type Answer = { name: string; verdict: string; body: string | null; reply: Reply };
  type Page = {
    kind?: 'plan';
    org: string;
    feedback?: Answer[];
    posts?: { id: string; gone: boolean; body?: string | null; answers?: number; channels?: { channel: string; body: string | null }[]; feedback?: Answer[] }[];
  } | null;
  // The public side runs as the API login role, with no org context, as the HTTP edge does.
  const view = async (token: string) => (await pool.query<{ page: Page }>('SELECT crove_social.review_link_view($1) AS page', [token])).rows[0]?.page ?? null;
  const clientAnswer = (token: string, verdict: 'approved' | 'changes_requested' | 'comment', body: string | null) =>
    pool.query('SELECT crove_social.review_feedback_add($1, $2, $3, $4)', [token, 'Chị Lan (khách)', verdict, body]);
  const planAnswer = (token: string, postId: string, verdict: 'approved' | 'changes_requested' | 'comment', body: string | null) =>
    pool.query('SELECT crove_social.review_plan_feedback_add($1, $2::uuid, $3, $4, $5)', [token, postId, 'Chị Lan (khách)', verdict, body]);
  const rowsOf = (o: Org) => admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_social.review_feedback WHERE org_id = $1', [o.orgId])).rows[0]?.n);

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
    const registry = { commands: [...kernelCommands, ...socialCommands, rawSql], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 6 });
    db = createDb(pool);
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

  it('lets members reply, edit and clear; the client sees it signed by the org, and the answer counts and verdict stay', async () => {
    const o = await org();
    const conn = await connection(o);
    await exec(o, o.owner, 'social.channel.set_client_approval', { connectionId: conn, clientApproval: true });
    const postId = await draft(o, conn, 'Bài khai trương');
    await exec(o, o.member, 'social.post.submit', { postId });
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.review_link.create', { postId });
    await clientAnswer(token, 'changes_requested', 'Đổi ảnh bìa giúp chị');
    const before = { rows: await rowsOf(o), answers: (await links(o, o.member, postId)).links[0]?.answers, verdict: (await get(o, postId)).variants[0]?.review.clientVerdict };
    const feedbackId = (await links(o, o.member, postId)).feedback[0]?.id as string;
    expect((await links(o, o.member, postId)).feedback[0]?.reply).toBeNull();

    // A viewer reads but does not reply.
    await expect(reply(o, o.viewer, feedbackId, 'Dạ')).rejects.toMatchObject({ status: 403 });
    const first = await reply(o, o.member, feedbackId, 'Dạ, nhóm sẽ đổi ảnh bìa trong hôm nay ạ');
    expect(first).toMatchObject({ feedbackId, postId, reply: { body: 'Dạ, nhóm sẽ đổi ảnh bìa trong hôm nay ạ', by: o.member } });
    expect((await links(o, o.viewer, postId)).feedback[0]?.reply).toMatchObject({ body: 'Dạ, nhóm sẽ đổi ảnh bìa trong hôm nay ạ', by: o.member });

    // The client's next visit shows it under their answer, with no member's name, id or address anywhere on the page.
    const page = await view(token);
    expect(page?.feedback?.[0]).toMatchObject({ verdict: 'changes_requested', body: 'Đổi ảnh bìa giúp chị', reply: { body: 'Dạ, nhóm sẽ đổi ảnh bìa trong hôm nay ạ', at: expect.any(String) } });
    expect(Object.keys(page?.feedback?.[0]?.reply ?? {}).sort()).toEqual(['at', 'body']);
    const text = JSON.stringify(page);
    for (const id of [o.member, o.owner]) expect(text).not.toContain(id);
    expect(text).not.toContain('@reply.test');
    expect(text).not.toContain('Người member');
    expect(page?.org).toBe(o.name);
    // The HTTP edge's reader gives the same page.
    expect(((await reviewView(rt, { token })) as { feedback: Answer[] }).feedback[0]?.reply?.body).toBe('Dạ, nhóm sẽ đổi ảnh bìa trong hôm nay ạ');

    // An admin edits it: the newest author and text; a text that only differs by hidden characters is the same text.
    expect((await reply(o, o.admin, feedbackId, 'Nhóm đã đổi ảnh bìa,\r\nchị xem lại giúp em ạ​')).reply).toMatchObject({ body: 'Nhóm đã đổi ảnh bìa,\nchị xem lại giúp em ạ', by: o.admin });
    expect((await view(token))?.feedback?.[0]?.reply?.body).toBe('Nhóm đã đổi ảnh bìa,\nchị xem lại giúp em ạ');
    // Too long is refused; the client's comment has the same cap.
    expect(await refusal(reply(o, o.member, feedbackId, 'a'.repeat(2001)))).toBe('VALIDATION');
    expect((await reply(o, o.member, feedbackId, 'a'.repeat(2000))).reply?.body).toHaveLength(2000);

    // Nothing of the client's answer moved: the same rows, the same count on the link, the same standing answer.
    const after = { rows: await rowsOf(o), answers: (await links(o, o.member, postId)).links[0]?.answers, verdict: (await get(o, postId)).variants[0]?.review.clientVerdict };
    expect(after).toEqual(before);
    expect(before.verdict).toBe('changes_requested');
    expect((await get(o, postId)).variants[0]?.status).toBe('in_review');

    // Empty text or null clears it, on the page too.
    expect((await reply(o, o.member, feedbackId, '  \n ')).reply).toBeNull();
    expect((await view(token))?.feedback?.[0]?.reply).toBeNull();
    await reply(o, o.member, feedbackId, 'Lần nữa');
    expect((await reply(o, o.owner, feedbackId, null)).reply).toBeNull();
    const stored = await admin(async (c) => (await c.query('SELECT reply_body, replied_by, replied_at FROM crove_social.review_feedback WHERE id = $1', [feedbackId])).rows[0]);
    expect(stored).toEqual({ reply_body: null, replied_by: null, replied_at: null });

    // Every reply, edit and clear is audited, with the answer, the post and the link.
    const audited = await admin(
      async (c) =>
        (await c.query<{ target_id: string; detail: { post_id: string; cleared: boolean } }>("SELECT target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.review.reply' AND outcome = 'ok' ORDER BY occurred_at, id", [o.orgId])).rows,
    );
    expect(audited.map((a) => [a.target_id, a.detail.post_id, a.detail.cleared])).toEqual([
      [feedbackId, postId, false],
      [feedbackId, postId, false],
      [feedbackId, postId, false],
      [feedbackId, postId, true],
      [feedbackId, postId, false],
      [feedbackId, postId, true],
    ]);

    // Another org's member finds nothing.
    const other = await org();
    expect(await refusal(reply(other, other.owner, feedbackId, 'Xin chào'))).toBe('REVIEW_FEEDBACK_NOT_FOUND');
  });

  it('shows the reply on the plan page and sends each post body once (#930)', async () => {
    const o = await org();
    const a = await connection(o, 'Fanpage');
    const b = await connection(o, 'Zalo OA');
    const { postId: shared } = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
      body: 'Ưu đãi tháng 11',
      scheduledAt: new Date(Date.now() + DAY).toISOString(),
      channels: [{ connectionId: a }, { connectionId: b, body: 'Ưu đãi riêng Zalo' }],
    });
    const second = await draft(o, a, 'Bài thứ hai');
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.review_link.create_plan', { postIds: [shared, second] });
    await planAnswer(token, shared, 'comment', 'Giá đã gồm VAT chưa em?');
    await planAnswer(token, second, 'approved', null);
    const feedbackId = (await links(o, o.member, shared)).feedback[0]?.id as string;
    const before = await view(token);
    await reply(o, o.member, feedbackId, 'Dạ giá đã gồm VAT ạ');

    const page = await view(token);
    const item = page?.posts?.find((p) => p.id === shared);
    expect(item).toMatchObject({ body: 'Ưu đãi tháng 11', answers: 1, feedback: [{ body: 'Giá đã gồm VAT chưa em?', reply: { body: 'Dạ giá đã gồm VAT ạ' } }] });
    // The channel that shows the post's body says null; the one with its own text keeps it.
    expect(item?.channels?.map((c) => [c.channel, c.body])).toEqual([
      ['Fanpage', null],
      ['Zalo OA', 'Ưu đãi riêng Zalo'],
    ]);
    expect(page?.posts?.find((p) => p.id === second)?.feedback?.[0]?.reply).toBeNull();
    expect(JSON.stringify(page)).not.toContain(o.member);
    // Only the reply changed: the counts and the rest of the page are what they were.
    const withoutReplies = (p: Page) => JSON.parse(JSON.stringify(p), (key, value: unknown) => (key === 'reply' ? undefined : value)) as unknown;
    expect(withoutReplies(page)).toEqual(withoutReplies(before));
  });

  it('lets a member limited to some channels reply only on posts of theirs (#1081)', async () => {
    const o = await org();
    const mine = await connection(o, 'Kênh của tôi');
    const theirs = await connection(o, 'Kênh khác');
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [mine] });
    const answered = async (conn: string) => {
      const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài cho khách', channels: [{ connectionId: conn }] });
      const { token } = await exec<{ token: string }>(o, o.owner, 'social.review_link.create', { postId });
      await clientAnswer(token, 'comment', 'Ổn');
      return (await links(o, o.owner, postId)).feedback[0]?.id as string;
    };
    const onMine = await answered(mine);
    const onTheirs = await answered(theirs);
    expect(await refusal(reply(o, o.member, onTheirs, 'Dạ'))).toBe('CHANNEL_NOT_ALLOWED');
    expect((await reply(o, o.member, onMine, 'Dạ')).reply?.body).toBe('Dạ');
    // Owners and admins are never limited.
    expect((await reply(o, o.admin, onTheirs, 'Dạ')).reply?.by).toBe(o.admin);
  });

  it('lets crove_tenant write only the reply, in its own member name, and the guard holds for every role', async () => {
    const o = await org();
    const conn = await connection(o);
    const postId = await draft(o, conn, 'Bài');
    const { token, linkId } = await exec<{ token: string; linkId: string }>(o, o.owner, 'social.review_link.create', { postId });
    await clientAnswer(token, 'changes_requested', 'Sửa giúp');
    const id = (await links(o, o.owner, postId)).feedback[0]?.id as string;
    const denied = expect.objectContaining({ ok: false, code: '42501' });

    // The client's own fields: no column privilege.
    for (const set of ["verdict = 'approved'", "body = 'Đã sửa'", "reviewer_name = 'Ai đó'", 'changed = true', 'created_at = now()', 'post_id = post_id']) {
      expect(await raw(o, o.owner, `UPDATE crove_social.review_feedback SET ${set} WHERE id = $1`, [id])).toEqual(denied);
    }
    // No new answers and no deletions from a member's context either.
    expect(await raw(o, o.owner, "INSERT INTO crove_social.review_feedback (org_id, link_id, post_id, reviewer_name, verdict) VALUES ($1, $2, $3, 'Giả', 'approved')", [o.orgId, linkId, postId])).toEqual(denied);
    expect(await raw(o, o.owner, 'DELETE FROM crove_social.review_feedback WHERE id = $1', [id])).toEqual(denied);
    // The reply columns: only in the context's own member name, all three or none.
    expect(await raw(o, o.member, 'UPDATE crove_social.review_feedback SET reply_body = $2, replied_by = $3, replied_at = now() WHERE id = $1', [id, 'Giả danh', o.owner])).toEqual(
      expect.objectContaining({ ok: false, code: '42501', message: 'REVIEW_REPLY_AUTHOR' }),
    );
    expect(await raw(o, o.member, 'UPDATE crove_social.review_feedback SET reply_body = $2 WHERE id = $1', [id, 'Thiếu người viết'])).toEqual(expect.objectContaining({ ok: false, message: 'REVIEW_REPLY_AUTHOR' }));
    expect(await raw(o, o.member, 'UPDATE crove_social.review_feedback SET reply_body = $2, replied_by = $3 WHERE id = $1', [id, 'Thiếu giờ', o.member])).toEqual(expect.objectContaining({ ok: false, code: '23514' }));
    expect(await raw(o, o.member, 'UPDATE crove_social.review_feedback SET reply_body = $2, replied_by = $3, replied_at = now() WHERE id = $1', [id, 'x'.repeat(2001), o.member])).toEqual(
      expect.objectContaining({ ok: false, code: '23514' }),
    );
    expect(await raw(o, o.member, 'UPDATE crove_social.review_feedback SET reply_body = $2, replied_by = $3, replied_at = now() WHERE id = $1', [id, 'Dạ', o.member])).toEqual({ ok: true, rows: 1 });
    // Another org's answer is out of reach (RLS): nothing updated.
    const other = await org();
    expect(await raw(other, other.member, 'UPDATE crove_social.review_feedback SET reply_body = NULL, replied_by = NULL, replied_at = NULL WHERE id = $1', [id])).toEqual({ ok: true, rows: 0 });

    // The guard holds for the database owner too: the client's answer is what the client said.
    await expect(admin((c) => c.query("UPDATE crove_social.review_feedback SET verdict = 'approved' WHERE id = $1", [id]))).rejects.toMatchObject({ code: '42501', message: 'REVIEW_FEEDBACK_CLIENT_FIELDS' });
    const row = await admin(async (c) => (await c.query('SELECT verdict, body, reply_body FROM crove_social.review_feedback WHERE id = $1', [id])).rows[0]);
    expect(row).toEqual({ verdict: 'changes_requested', body: 'Sửa giúp', reply_body: 'Dạ' });

    const privileges = await admin(async (c) => {
      const { rows } = await c.query<{ col: string; can: boolean }>(
        "SELECT a.attname AS col, has_column_privilege('crove_tenant', 'crove_social.review_feedback', a.attname, 'UPDATE') AS can FROM pg_attribute a WHERE a.attrelid = 'crove_social.review_feedback'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
      );
      return rows.filter((r) => r.can).map((r) => r.col);
    });
    expect(privileges).toEqual(['reply_body', 'replied_by', 'replied_at']);
  });

  it('adds no post to a plan from a tenant path but the definer, once, for the link maker (#930)', async () => {
    const o = await org();
    const conn = await connection(o);
    const first = await draft(o, conn, 'Bài một');
    const late = await draft(o, conn, 'Bài thêm sau');
    const { linkId } = await exec<{ linkId: string }>(o, o.admin, 'social.review_link.create_plan', { postIds: [first] });
    const denied = expect.objectContaining({ ok: false, code: '42501' });
    // No INSERT for crove_tenant, whoever the member.
    expect(await raw(o, o.owner, 'INSERT INTO crove_social.review_link_post (org_id, link_id, post_id, position) VALUES ($1, $2, $3, 1)', [o.orgId, linkId, late])).toEqual(denied);
    // The definer refuses a plan that has its posts, and anyone but an owner or admin who made the link.
    expect(await raw(o, o.admin, 'SELECT crove_social.review_plan_posts_add($1::uuid, $2::uuid[])', [linkId, [late]])).toEqual(expect.objectContaining({ ok: false, code: '55000', message: 'REVIEW_PLAN_FROZEN' }));
    expect(await raw(o, o.member, 'SELECT crove_social.review_plan_posts_add($1::uuid, $2::uuid[])', [linkId, [late]])).toEqual(expect.objectContaining({ ok: false, code: '42501', message: 'REVIEW_PLAN_FORBIDDEN' }));

    // A plan link with no posts yet (as the create command makes it): only its maker fills it, once, with live posts of
    // the org, at most 50 and each once.
    const empty = randomUUID();
    expect(
      await raw(o, o.admin, "INSERT INTO crove_social.review_link (org_id, id, kind, token_sha256, created_by, expires_at) VALUES ($1, $2, 'plan', $3, $4, now() + interval '1 day')", [
        o.orgId,
        empty,
        randomBytes(32).toString('hex'),
        o.admin,
      ]),
    ).toEqual({ ok: true, rows: 1 });
    const add = (user: string, posts: string[]) => raw(o, user, 'SELECT crove_social.review_plan_posts_add($1::uuid, $2::uuid[])', [empty, posts]);
    expect(await add(o.owner, [late])).toEqual(expect.objectContaining({ ok: false, message: 'REVIEW_PLAN_FORBIDDEN' }));
    expect(await add(o.admin, [late, late])).toEqual(expect.objectContaining({ ok: false, code: '22023' }));
    expect(await add(o.admin, [])).toEqual(expect.objectContaining({ ok: false, code: '22023' }));
    const stranger = await org();
    expect(await add(o.admin, [await draft(stranger, await connection(stranger), 'Bài của tổ chức khác')])).toEqual(expect.objectContaining({ ok: false, code: '22023' }));
    const cancelled = await draft(o, conn, 'Bài bị hủy');
    await exec(o, o.member, 'social.variant.cancel', { variantIds: (await get(o, cancelled)).variants.map((v) => v.id) });
    expect(await add(o.admin, [cancelled])).toEqual(expect.objectContaining({ ok: false, code: '22023' }));
    expect(await add(o.admin, [late, first])).toEqual({ ok: true, rows: 1 });
    expect(await add(o.admin, [cancelled])).toEqual(expect.objectContaining({ ok: false, code: '55000' }));
    const rows = await admin(async (c) => (await c.query('SELECT post_id, position, content_key FROM crove_social.review_link_post WHERE link_id = $1 ORDER BY position', [empty])).rows);
    expect(rows.map((r: { post_id: string; position: number }) => [r.post_id, r.position])).toEqual([
      [late, 0],
      [first, 1],
    ]);
    expect(rows.every((r: { content_key: string }) => /^[0-9a-f]{64}$/.test(r.content_key))).toBe(true);
    // Another org's context never reaches the link.
    expect(await raw(stranger, stranger.owner, 'SELECT crove_social.review_plan_posts_add($1::uuid, $2::uuid[])', [empty, [late]])).toEqual(expect.objectContaining({ ok: false, code: '22023' }));

    const matrix = await admin(async (c) => {
      const fns = ['crove_social.review_plan_posts_add(uuid,uuid[])', 'crove_social.review_feedback_reply_guard()'];
      const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'public'];
      const { rows: can } = await c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [fns, roles],
      );
      return Object.fromEntries(fns.map((f) => [f, roles.filter((r) => can.some((row) => row.fn === f && row.role === r && row.can))]));
    });
    // crove_tenant's grant, which its member roles inherit (outside a member context the definer refuses), and nobody calls the guard.
    expect(matrix).toEqual({ 'crove_social.review_plan_posts_add(uuid,uuid[])': ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'], 'crove_social.review_feedback_reply_guard()': [] });
    await expect(pool.query('SELECT crove_social.review_plan_posts_add($1::uuid, $2::uuid[])', [empty, [late]])).rejects.toMatchObject({ code: '42501', message: 'NO_CONTEXT' });
  });

  it('holds the live link caps against links made at the same time (#930)', async () => {
    const o = await org();
    const conn = await connection(o);
    const postId = await draft(o, conn, 'Bài nhiều liên kết');
    // 49 live plan links and 9 live links of the post: one more each is allowed, and only one.
    await admin(async (c) => {
      for (let i = 0; i < 49; i++) {
        await c.query("INSERT INTO crove_social.review_link (org_id, kind, token_sha256, created_by, expires_at) VALUES ($1, 'plan', $2, $3, now() + interval '1 day')", [o.orgId, randomBytes(32).toString('hex'), o.owner]);
      }
      for (let i = 0; i < 9; i++) {
        await c.query("INSERT INTO crove_social.review_link (org_id, post_id, token_sha256, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')", [o.orgId, postId, randomBytes(32).toString('hex'), o.owner]);
      }
    });
    const plans = await Promise.all([0, 1, 2].map(() => refusal(exec(o, o.owner, 'social.review_link.create_plan', { postIds: [postId] }))));
    expect(plans.sort()).toEqual(['REVIEW_PLAN_LIMIT', 'REVIEW_PLAN_LIMIT', 'resolved']);
    const singles = await Promise.all([0, 1, 2].map(() => refusal(exec(o, o.admin, 'social.review_link.create', { postId }))));
    expect(singles.sort()).toEqual(['REVIEW_LINK_LIMIT', 'REVIEW_LINK_LIMIT', 'resolved']);
  });
});
