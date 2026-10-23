// The social.content_manager agent (#799) on PostgreSQL 17: a post sent for review gives the agent a task, its run
// comments the pre-review and hands the decision to a human, and it never approves. The task, its comment and the
// escalation say counts only, so a member limited to some channels (#1081) reads nothing of a post outside them in
// kernel.task.list or kernel.task.get (#1193); the post page's pre-review keeps the findings for those who may see the
// post. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, runAgentWake, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialAgentPrograms, socialCommands, socialQueries, type PreReview } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

suite('the social.content_manager agent on PostgreSQL (#799)', () => {
  const dbName = `crove_test_social_agent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let db: Db;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
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
    const runtimeFor = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      const d = createDb(pool);
      return { db: d, runtime: new Runtime(d).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] }) };
    };
    const api = runtimeFor('crove_app', 'test-app-pw');
    app = api.runtime;
    db = api.db;
    worker = runtimeFor('crove_worker', 'test-worker-pw').runtime;
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pre-reviews each post sent for review, comments what the checks found, hands it to a human, and never decides', async () => {
    const owner = await upsertIdentity(db, { issuer: 'agents', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 6)}@agents.test`, name: null });
    const { orgId } = await createOrg(app, asUser(owner), 'Tiệm bánh');
    const { agentId } = await app.execute<{ agentId: string }>('kernel.agent.template.install', { templateKey: 'social.content_manager' }, { actor: asMfa(owner), orgId });
    const connection = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        connection,
        'sandbox',
        `acct-${connection.slice(0, 8)}`,
        'Kênh thử',
        owner,
      ]),
    );
    await app.execute('social.brand_voice.save', { connectionId: null, description: 'Thân thiện', useWords: [], avoidWords: ['rẻ nhất'], emoji: true }, { actor: asUser(owner), orgId });
    const { postId } = await app.execute<{ postId: string }>('social.post.create', { body: 'Bánh mì rẻ nhất phố', channels: [{ connectionId: connection }] }, { actor: asUser(owner), orgId });
    await app.execute('social.post.submit', { postId }, { actor: asUser(owner), orgId });
    const submitted = await admin(async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.submitted'`, [orgId])).rows[0]?.id as string);
    // A redelivered event adds nothing.
    for (const eventId of [submitted, submitted]) await worker.execute('kernel.agent.dispatch_event', { eventId }, { actor: SYSTEM, orgId });
    const tasks = await admin(async (c) => (await c.query(`SELECT title, kind, source, source_ref, tainted FROM crove_kernel.task WHERE org_id = $1`, [orgId])).rows);
    expect(tasks).toEqual([{ title: 'Rà soát bài gửi duyệt: 1 kênh', kind: 'general', source: 'event', source_ref: { type: 'social.post', id: postId }, tainted: false }]);

    const review = await app.query<PreReview>('social.post.pre_review', { postId }, { actor: asUser(owner), orgId });
    expect(review).toMatchObject({ postId, waiting: 1 });
    expect(review.findings.join('\n')).toContain('rẻ nhất');

    const result = await runAgentWake({ runtime: worker, programs: socialAgentPrograms }, orgId, agentId);
    expect(result).toMatchObject({ outcome: 'succeeded' });
    const after = await admin(async (c) => ({
      comment: (await c.query<{ body: string; author_type: string }>(`SELECT body, author_type FROM crove_kernel.task_comment WHERE org_id = $1`, [orgId])).rows,
      escalations: (await c.query(`SELECT title, created_by_type FROM crove_kernel.task WHERE org_id = $1 AND kind = 'escalation'`, [orgId])).rows,
      variants: (await c.query<{ status: string }>(`SELECT status FROM crove_social.post_variant WHERE org_id = $1`, [orgId])).rows,
    }));
    expect(after.comment).toHaveLength(1);
    expect(after.comment[0]).toMatchObject({ author_type: 'agent' });
    // Counts only (#1193): the findings stay on the post page.
    const points = review.findings.length;
    expect(after.comment[0]?.body).toBe(
      `Rà soát trước: 1 kênh đang chờ duyệt.\nCác kiểm tra tự động thấy ${points} điểm cần xem; chi tiết ở mục Kiểm tra tự động, phần Duyệt bài của trang bài đăng. Người duyệt nên xem các điểm đó trước khi quyết định.`,
    );
    expect(after.comment[0]?.body).not.toMatch(/rẻ nhất|Bánh mì|Kênh thử/);
    expect(after.escalations).toEqual([{ title: `Duyệt bài: 1 kênh chờ duyệt, ${points} điểm cần xem`, created_by_type: 'agent' }]);
    // The agent decided nothing: the channel still waits for a person.
    expect(after.variants).toEqual([{ status: 'in_review' }]);
  });

  it("keeps the text and channel names of posts outside a limited member's channels out of the tasks they read (#1193)", async () => {
    const owner = await upsertIdentity(db, { issuer: 'agents', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 6)}@agents.test`, name: null });
    const member = await upsertIdentity(db, { issuer: 'agents', subject: randomUUID(), email: `member-${randomUUID().slice(0, 6)}@agents.test`, name: null });
    const { orgId } = await createOrg(app, asUser(owner), 'Agency');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    const { agentId } = await app.execute<{ agentId: string }>('kernel.agent.template.install', { templateKey: 'social.content_manager' }, { actor: asMfa(owner), orgId });
    const channel = async (name: string) => {
      const id = randomUUID();
      await admin((c) =>
        c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
      );
      return id;
    };
    const mine = await channel('Trang khách Lan');
    const theirs = await channel('Trang khách Hùng');
    await app.execute('social.channel_access.set', { userId: member, channelConnectionIds: [mine] }, { actor: asUser(owner), orgId });
    await app.execute('social.brand_voice.save', { connectionId: null, description: 'Thân thiện', useWords: [], avoidWords: ['giá sốc'], emoji: true }, { actor: asUser(owner), orgId });
    // A post on the other client's channel, sent by the owner, and one on the member's own channel, sent by the member.
    const hidden = (
      await app.execute<{ postId: string }>('social.post.create', { body: 'Ra mắt nệm Hùng Phát, giá sốc cuối tuần', channels: [{ connectionId: theirs }] }, { actor: asUser(owner), orgId })
    ).postId;
    await app.execute('social.post.submit', { postId: hidden }, { actor: asUser(owner), orgId });
    const own = (await app.execute<{ postId: string }>('social.post.create', { body: 'Bánh Lan giá sốc hôm nay', channels: [{ connectionId: mine }] }, { actor: asUser(member), orgId })).postId;
    await app.execute('social.post.submit', { postId: own }, { actor: asUser(member), orgId });
    const events = await admin(async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.submitted' ORDER BY id`, [orgId])).rows);
    expect(events).toHaveLength(2);
    for (const e of events) await worker.execute('kernel.agent.dispatch_event', { eventId: e.id }, { actor: SYSTEM, orgId });
    expect(await runAgentWake({ runtime: worker, programs: socialAgentPrograms }, orgId, agentId)).toMatchObject({ outcome: 'succeeded' });

    // What the member reads of every task: the agent's two and the two escalations, with their comments.
    const asMember = { actor: asUser(member), orgId };
    const { tasks } = await app.query<{ tasks: { id: string; title: string; kind: string; sourceRef: unknown }[] }>('kernel.task.list', {}, asMember);
    expect(tasks.map((t) => `${t.kind}: ${t.title}`).sort()).toEqual([
      'escalation: Duyệt bài: 1 kênh chờ duyệt, 1 điểm cần xem',
      'escalation: Duyệt bài: 1 kênh chờ duyệt, 1 điểm cần xem',
      'general: Rà soát bài gửi duyệt: 1 kênh',
      'general: Rà soát bài gửi duyệt: 1 kênh',
    ]);
    const read = JSON.stringify([tasks, ...(await Promise.all(tasks.map((t) => app.query('kernel.task.get', { id: t.id }, asMember))))]);
    for (const secret of ['Hùng', 'Ra mắt', 'nệm', 'giá sốc', 'Lan', 'Bánh']) expect(read).not.toContain(secret);
    expect(read).toContain('1 điểm cần xem');
    // Each task points at its post, whose page answers 404 to the member when it is outside their channels.
    expect(new Set(tasks.map((t) => (t.sourceRef as { id: string }).id))).toEqual(new Set([hidden, own]));
    await expect(app.query('social.post.pre_review', { postId: hidden }, asMember)).rejects.toMatchObject({ code: 'POST_NOT_FOUND', status: 404 });
    await expect(app.query('social.post.get', { postId: hidden }, asMember)).rejects.toMatchObject({ code: 'POST_NOT_FOUND', status: 404 });
    // The post page keeps the detail for those who may see the post.
    expect((await app.query<PreReview>('social.post.pre_review', { postId: own }, asMember)).findings).toEqual(['Trang khách Lan: có từ nên tránh theo giọng thương hiệu (giá sốc).']);
    expect((await app.query<PreReview>('social.post.pre_review', { postId: hidden }, { actor: asUser(owner), orgId })).findings).toEqual([
      'Trang khách Hùng: có từ nên tránh theo giọng thương hiệu (giá sốc).',
    ]);
  });

  it('makes no task from an event without an agent task, nor for a template of another module', async () => {
    const owner = await upsertIdentity(db, { issuer: 'agents', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 6)}@agents.test`, name: null });
    const { orgId } = await createOrg(app, asUser(owner), 'Khác');
    await app.execute('kernel.agent.template.install', { templateKey: 'social.content_manager' }, { actor: asMfa(owner), orgId });
    const event = async (payload: unknown) =>
      admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.outbox_event (org_id, type, payload) VALUES ($1, 'social.post.submitted', $2) RETURNING id`, [orgId, JSON.stringify(payload)])).rows[0]?.id as string);
    const bare = await event({ post_id: randomUUID() });
    const foreign = await event({ post_id: randomUUID(), agent_task: { title: 'x', ref: { type: 'finance.purchase', id: randomUUID() } } });
    for (const eventId of [bare, foreign]) expect(await worker.execute('kernel.agent.dispatch_event', { eventId }, { actor: SYSTEM, orgId })).toEqual({ tasks: 0 });
    // Taint is the default when the event does not say.
    const unsaid = await event({ post_id: randomUUID(), agent_task: { title: 'Rà soát bài: y', ref: { type: 'social.post', id: randomUUID() } } });
    expect(await worker.execute('kernel.agent.dispatch_event', { eventId: unsaid }, { actor: SYSTEM, orgId })).toEqual({ tasks: 1 });
    expect(await admin(async (c) => (await c.query(`SELECT tainted FROM crove_kernel.task WHERE org_id = $1`, [orgId])).rows)).toEqual([{ tainted: true }]);
  });
});
