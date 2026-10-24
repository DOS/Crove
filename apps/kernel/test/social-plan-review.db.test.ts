// One client review link for a content plan (#902) on PostgreSQL 17: owners and admins make it from picked posts or a
// date range on chosen channels, frozen into a set of posts; the public page lists them in schedule order, an answer
// settles its post alone through the client approval step (#770), revocation, expiry and the member-revoke rule (#625)
// hold, another org's posts never join, and a post cancelled since shows as gone. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { reviewTokenHash, socialCommands, socialQueries, type PostView, type ReviewFeedbackView, type ReviewLinkView, type ReviewPlanLinkView } from '@crove/mod-social';
import { reviewAnswer } from '../src/review-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;

suite('social plan review links on PostgreSQL (#902)', () => {
  const dbName = `crove_test_social_plan_review_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const system = { type: 'system' as const, component: 'plan-review-test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@plan.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; member: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
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
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const draft = async (o: Org, conn: string, body: string, at?: Date) =>
    (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: conn }], ...(at ? { scheduledAt: at.toISOString() } : {}) })).postId;
  const plan = (o: Org, user: string, input: unknown) => exec<{ linkId: string; token: string; expiresAt: string; posts: number }>(o, user, 'social.review_link.create_plan', input);
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));

  type PlanPost = { id: string; gone: boolean; at?: string | null; changed?: boolean; body?: string | null; channels?: { channel: string; body: string | null; media: { id: string }[] }[]; answers?: number; feedback?: { name: string; verdict: string }[] };
  type Page = { kind?: 'plan'; org: string; posts?: PlanPost[]; channels?: unknown[] } | null;
  // The public side runs as the API login role, with no org context, as the HTTP edge does.
  const view = async (token: string) => (await pool.query<{ page: Page }>('SELECT crove_social.review_link_view($1) AS page', [token])).rows[0]?.page ?? null;
  const answer = async (token: string, postId: string, verdict: 'approved' | 'changes_requested' | 'comment', body: string | null = null) =>
    (await pool.query<{ done: { recorded: boolean } | null }>('SELECT crove_social.review_plan_feedback_add($1, $2::uuid, $3, $4, $5) AS done', [token, postId, 'Chị Lan (khách)', verdict, body])).rows[0]?.done ?? null;
  const plans = (o: Org) => rt.query<ReviewPlanLinkView[]>('social.review_link.list_plans', {}, { actor: asUser(o.member), orgId: o.orgId });
  const links = (o: Org, postId: string) => rt.query<{ links: ReviewLinkView[]; feedback: ReviewFeedbackView[] }>('social.review_link.list', { postId }, { actor: asUser(o.member), orgId: o.orgId });
  const settle = async (o: Org) => {
    const event = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.review.answered' ORDER BY created_at DESC, id DESC LIMIT 1", [o.orgId])).rows[0]?.id);
    return worker.execute<{ settled: string[]; verdict: string | null }>('social.review.client_settle', { eventId: event as string }, { actor: system, orgId: o.orgId });
  };
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
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db).register(registry);
    const w = new URL(adminUrl);
    w.username = 'crove_worker';
    w.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: w.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool)).register(registry);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('makes a plan from picked posts, in schedule order, keeping only the token hash', async () => {
    const o = await org();
    const conn = await connection(o);
    const now = Date.now();
    const late = await draft(o, conn, 'Bài cuối tháng', new Date(now + 20 * DAY));
    const untimed = await draft(o, conn, 'Bài chưa có giờ');
    const early = await draft(o, conn, 'Bài đầu tháng', new Date(now + 2 * DAY));
    await expect(plan(o, o.member, { postIds: [late, early] })).rejects.toMatchObject({ status: 403 });
    expect(await refusal(plan(o, o.owner, {}))).toBe('REVIEW_PLAN_INVALID');
    expect(await refusal(plan(o, o.owner, { postIds: [late], range: { from: new Date(now).toISOString(), to: new Date(now + DAY).toISOString() } }))).toBe('REVIEW_PLAN_INVALID');

    const made = await plan(o, o.admin, { postIds: [untimed, late, early], days: 14 });
    expect(made).toMatchObject({ posts: 3, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const stored = await admin(async (c) => (await c.query('SELECT kind, post_id, token_sha256, plan_from FROM crove_social.review_link WHERE id = $1', [made.linkId])).rows[0]);
    expect(stored).toEqual({ kind: 'plan', post_id: null, token_sha256: reviewTokenHash(made.token), plan_from: null });
    const leaks = await admin(async (c) =>
      Number(
        (
          await c.query<{ n: string }>(
            `SELECT (SELECT count(*) FROM crove_kernel.audit_event a WHERE a.detail::text LIKE '%' || $1 || '%')
                  + (SELECT count(*) FROM crove_kernel.outbox_event e WHERE e.payload::text LIKE '%' || $1 || '%') AS n`,
            [made.token],
          )
        ).rows[0]?.n,
      ),
    );
    expect(leaks).toBe(0);

    const page = await view(made.token);
    expect(page?.kind).toBe('plan');
    expect(page?.posts?.map((p) => p.id)).toEqual([early, late, untimed]);
    // The post's body comes once (#930): a channel that shows it says null.
    expect(page?.posts?.[0]).toMatchObject({ gone: false, changed: false, answers: 0, feedback: [], body: 'Bài đầu tháng', channels: [{ channel: 'Kênh thử', body: null, media: [] }] });
    // A post made after the link does not join it.
    await draft(o, conn, 'Bài thêm sau', new Date(now + 3 * DAY));
    expect((await view(made.token))?.posts).toHaveLength(3);
    expect(await plans(o)).toEqual([expect.objectContaining({ id: made.linkId, posts: 3, answered: 0, gone: 0, from: null, to: null, revokedAt: null })]);
    // The post's own review card lists the plan it is in.
    expect((await links(o, early)).links).toEqual([expect.objectContaining({ id: made.linkId, kind: 'plan', posts: 3, answers: 0, answersMax: 20, changed: false })]);
  });

  it('makes a plan from a date range on chosen channels, and refuses an empty or too long one', async () => {
    const o = await org();
    const a = await connection(o, 'Fanpage');
    const b = await connection(o, 'Zalo OA');
    const now = Date.now();
    const inA = await draft(o, a, 'Trong khoảng, kênh A', new Date(now + 5 * DAY));
    const inB = await draft(o, b, 'Trong khoảng, kênh B', new Date(now + 4 * DAY));
    await draft(o, a, 'Ngoài khoảng', new Date(now + 40 * DAY));
    await draft(o, a, 'Chưa có giờ');
    const from = new Date(now + DAY).toISOString();
    const to = new Date(now + 30 * DAY).toISOString();

    const all = await plan(o, o.owner, { range: { from, to } });
    expect(all.posts).toBe(2);
    expect((await view(all.token))?.posts?.map((p) => p.id)).toEqual([inB, inA]);
    const onA = await plan(o, o.owner, { range: { from, to, connectionIds: [a] } });
    expect((await view(onA.token))?.posts?.map((p) => p.id)).toEqual([inA]);
    const listed = await plans(o);
    expect(listed.find((l) => l.id === onA.linkId)).toMatchObject({ posts: 1, from: new Date(from).toISOString(), to: new Date(to).toISOString() });

    expect(await refusal(plan(o, o.owner, { range: { from: new Date(now + 60 * DAY).toISOString(), to: new Date(now + 70 * DAY).toISOString() } }))).toBe('REVIEW_PLAN_EMPTY');
    expect(await refusal(plan(o, o.owner, { range: { from, to: from } }))).toBe('REVIEW_PLAN_RANGE_INVALID');
    expect(await refusal(plan(o, o.owner, { range: { from, to: new Date(now + 200 * DAY).toISOString() } }))).toBe('REVIEW_PLAN_RANGE_INVALID');
  });

  it('settles only the post answered, through the client approval step, and caps the answers per post', async () => {
    const o = await org();
    const conn = await connection(o);
    await exec(o, o.owner, 'social.channel.set_client_approval', { connectionId: conn, clientApproval: true });
    const inReview = async (body: string) => {
      const postId = await draft(o, conn, body);
      await exec(o, o.member, 'social.post.submit', { postId });
      await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, postId)) });
      return postId;
    };
    const first = await inReview('Bài một');
    const second = await inReview('Bài hai');
    const third = await inReview('Bài ba');
    const { token, linkId } = await plan(o, o.owner, { postIds: [first, second, third] });
    const status = async (postId: string) => (await get(o, postId)).variants.map((v) => v.status);

    expect(await answer(token, first, 'approved')).toEqual({ recorded: true });
    expect(await settle(o)).toMatchObject({ verdict: 'approved', settled: [expect.any(String)] });
    expect(await status(first)).toEqual(['approved']);
    expect(await status(second)).toEqual(['in_review']);

    expect(await answer(token, second, 'changes_requested', 'Đổi ảnh bìa')).toEqual({ recorded: true });
    expect(await settle(o)).toMatchObject({ verdict: 'changes_requested' });
    expect(await status(second)).toEqual(['changes_requested']);
    expect(await status(third)).toEqual(['in_review']);
    // A comment settles nothing.
    expect(await answer(token, third, 'comment', 'Đẹp')).toEqual({ recorded: true });
    expect(await settle(o)).toMatchObject({ settled: [] });
    expect(await status(third)).toEqual(['in_review']);

    // Each answer is the post's, as a single-post link's would be: on the post's card and on the page.
    expect((await links(o, second)).feedback.map((f) => [f.linkId, f.verdict, f.body])).toEqual([[linkId, 'changes_requested', 'Đổi ảnh bìa']]);
    const page = await view(token);
    expect(page?.posts?.find((p) => p.id === second)).toMatchObject({ answers: 1, feedback: [{ name: 'Chị Lan (khách)', verdict: 'changes_requested' }] });
    expect((await plans(o))[0]).toMatchObject({ posts: 3, answered: 2 });

    // The plan's answers name a post: the single-post function refuses the token, and the HTTP edge maps the codes.
    await expect(pool.query("SELECT crove_social.review_feedback_add($1, 'Khách', 'approved', NULL)", [token])).rejects.toMatchObject({ code: '22023' });
    await expect(reviewAnswer(rt, { token, postId: randomUUID(), name: 'Khách', verdict: 'approved' })).rejects.toMatchObject({ code: 'REVIEW_ANSWER_INVALID' });
    expect(await reviewAnswer(rt, { token, postId: third, name: 'Khách', verdict: 'approved' })).toEqual({ recorded: true });

    // At most 20 answers per post.
    await pool.query("SELECT crove_social.review_plan_feedback_add($1, $2::uuid, 'Khách', 'comment', 'Thêm') FROM generate_series(1, 18)", [token, third]);
    await expect(answer(token, third, 'approved')).rejects.toMatchObject({ code: '54000' });
    expect(await answer(token, first, 'approved')).toEqual({ recorded: true });
  });

  it('stops at revocation or expiry, page, answers and files alike', async () => {
    const o = await org();
    const conn = await connection(o);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 7]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const fileId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, 'anh.jpg', 'image/jpeg', $6, 'social')`,
        [o.orgId, fileId, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, bytes.byteLength],
      ),
    );
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Ảnh khai trương', media: [{ fileId }], channels: [{ connectionId: conn }] });
    const file = async (t: string) => (await pool.query<{ file: unknown }>('SELECT crove_social.review_link_file($1, $2::uuid) AS file', [t, fileId])).rows[0]?.file ?? null;

    const revoked = await plan(o, o.owner, { postIds: [postId] });
    expect((await view(revoked.token))?.posts?.[0]?.channels?.[0]?.media).toEqual([{ id: fileId, type: 'image/jpeg' }]);
    expect(await file(revoked.token)).toMatchObject({ type: 'image/jpeg', filename: 'anh.jpg' });
    await expect(exec(o, o.member, 'social.review_link.revoke', { linkId: revoked.linkId })).rejects.toMatchObject({ status: 403 });
    expect(await exec(o, o.owner, 'social.review_link.revoke', { linkId: revoked.linkId })).toEqual({ linkId: revoked.linkId, postId: null });
    expect(await view(revoked.token)).toBeNull();
    expect(await answer(revoked.token, postId, 'approved')).toBeNull();
    expect(await file(revoked.token)).toBeNull();

    const expired = await plan(o, o.owner, { postIds: [postId], days: 1 });
    await admin((c) => c.query("UPDATE crove_social.review_link SET created_at = now() - interval '3 days', expires_at = now() - interval '1 minute' WHERE id = $1", [expired.linkId]));
    expect(await view(expired.token)).toBeNull();
    expect(await answer(expired.token, postId, 'approved')).toBeNull();
    expect(await file(expired.token)).toBeNull();
  });

  it('keeps another org\'s posts out, and the plan\'s rows to their org', async () => {
    const o = await org();
    const stranger = await org();
    const conn = await connection(o);
    const theirs = await draft(stranger, await connection(stranger), 'Bài của tổ chức khác');
    const mine = await draft(o, conn, 'Bài của mình');
    const outside = await draft(o, conn, 'Bài không trong kế hoạch');
    expect(await refusal(plan(o, o.owner, { postIds: [mine, theirs] }))).toBe('POST_NOT_FOUND');
    expect(await refusal(plan(o, o.owner, { range: { from: new Date().toISOString(), to: new Date(Date.now() + DAY).toISOString(), connectionIds: [await connection(stranger)] } }))).toBe('CHANNEL_NOT_FOUND');
    const { token, linkId } = await plan(o, o.owner, { postIds: [mine] });
    // A post outside the plan, of this org or another, takes no answer.
    await expect(answer(token, outside, 'approved')).rejects.toMatchObject({ code: '22023' });
    await expect(answer(token, theirs, 'approved')).rejects.toMatchObject({ code: '22023' });
    expect(await plans(stranger)).toEqual([]);
    await expect(exec(stranger, stranger.owner, 'social.review_link.revoke', { linkId })).rejects.toMatchObject({ code: 'REVIEW_LINK_NOT_FOUND' });
    // The database holds it too: a plan row naming another org's post, or feedback outside its link, is refused.
    await expect(admin((c) => c.query('INSERT INTO crove_social.review_link_post (org_id, link_id, post_id, position) VALUES ($1, $2, $3, 1)', [o.orgId, linkId, theirs]))).rejects.toMatchObject({ code: '23503' });
    await expect(
      admin((c) => c.query("INSERT INTO crove_social.review_feedback (org_id, link_id, post_id, reviewer_name, verdict) VALUES ($1, $2, $3, 'Khách', 'approved')", [o.orgId, linkId, outside])),
    ).rejects.toMatchObject({ code: '23503' });

    const grants = await admin(async (c) =>
      (
        await c.query<{ p: string }>(
          "SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'review_link_post' ORDER BY 1",
        )
      ).rows.map((r) => r.p),
    );
    // The tenant role reads a plan's posts; only review_plan_posts_add adds them, once (#930).
    expect(grants).toEqual(['SELECT']);
    const fns = ['crove_social.review_plan_feedback_add(text,uuid,text,text,text)', 'crove_social.review_plan_page(crove_social.review_link)', 'crove_social.review_feedback_in_link()'];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'public'];
    const matrix = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [fns, roles],
      );
      return Object.fromEntries(fns.map((f) => [f, roles.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))]));
    });
    expect(matrix).toEqual({
      'crove_social.review_plan_feedback_add(text,uuid,text,text,text)': ['crove_app'],
      'crove_social.review_plan_page(crove_social.review_link)': [],
      'crove_social.review_feedback_in_link()': [],
    });
  });

  it('shows a post cancelled since as no longer in the plan, and takes no answer on it', async () => {
    const o = await org();
    const conn = await connection(o);
    const kept = await draft(o, conn, 'Bài giữ lại', new Date(Date.now() + DAY));
    const dropped = await draft(o, conn, 'Bài bị hủy', new Date(Date.now() + 2 * DAY));
    const { token } = await plan(o, o.owner, { postIds: [kept, dropped] });
    await exec(o, o.member, 'social.variant.cancel', { variantIds: (await get(o, dropped)).variants.map((v) => v.id) });
    const page = await view(token);
    expect(page?.posts?.map((p) => [p.id, p.gone])).toEqual([
      [kept, false],
      [dropped, true],
    ]);
    // Nothing of a gone post shows.
    expect(page?.posts?.[1]).toEqual({ id: dropped, gone: true });
    await expect(answer(token, dropped, 'approved')).rejects.toMatchObject({ code: '55000' });
    await expect(reviewAnswer(rt, { token, postId: dropped, name: 'Khách', verdict: 'approved' })).rejects.toMatchObject({ code: 'REVIEW_POST_GONE' });
    expect((await plans(o))[0]).toMatchObject({ posts: 2, gone: 1 });
    // A cancelled post is not picked for a new plan.
    expect(await refusal(plan(o, o.owner, { postIds: [dropped] }))).toBe('REVIEW_PLAN_POST_CANCELLED');
  });

  it('revokes the plan links of an admin moved to member (#625)', async () => {
    const o = await org();
    const conn = await connection(o);
    const postId = await draft(o, conn, 'Bài cho khách');
    const mine = await plan(o, o.admin, { postIds: [postId] });
    const theirs = await plan(o, o.owner, { postIds: [postId] });
    await rt.execute('kernel.member.change_role', { userId: o.admin, role: 'member' }, { actor: asMfa(o.owner), orgId: o.orgId });
    const eventId = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.member.role_changed' ORDER BY created_at DESC, id DESC LIMIT 1", [o.orgId])).rows[0]?.id as string);
    expect(await worker.execute('social.links.revoke_for_member', { eventId }, { actor: system, orgId: o.orgId })).toMatchObject({ review: 1 });
    expect(await view(mine.token)).toBeNull();
    expect(await view(theirs.token)).not.toBeNull();
  });
});
