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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social client approval on PostgreSQL (#770)', () => {
  const dbName = `crove_test_social_client_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  // The worker settles the client's answers: the API cannot enter a system context.
  let workerPool: pg.Pool;
  let worker: Runtime;
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
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  const status = async (o: Org, postId: string) => (await get(o, o.owner, postId)).variants.map((v) => v.status);

  const system = { type: 'system' as const, component: 'client-approval-test' };
  // The client answers through the public definer, as the HTTP edge calls it with the link's token.
  const answer = async (o: Org, token: string, verdict: 'approved' | 'changes_requested' | 'comment') => {
    await pool.query('SELECT crove_social.review_feedback_add($1, $2, $3, $4)', [token, 'Chị Lan (khách)', verdict, verdict === 'comment' ? 'Đẹp' : null]);
    const event = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.review.answered' ORDER BY created_at DESC, id DESC LIMIT 1", [o.orgId])).rows[0]?.id);
    return worker.execute<{ settled: string[]; verdict: string | null }>('social.review.client_settle', { eventId: event as string }, { actor: system, orgId: o.orgId });
  };
  const linkFor = async (o: Org, postId: string) => (await exec<{ token: string }>(o, o.owner, 'social.review_link.create', { postId })).token;
  async function inReview(o: Org, conn: string, body = 'Bài cho khách duyệt') {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    return postId;
  }
  async function clientChannel(o: Org) {
    const conn = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_client_approval', { connectionId: conn, clientApproval: true });
    return conn;
  }

  it('keeps a team-approved post waiting for the client, and the client yes completes it', async () => {
    const o = await org();
    expect(await refusal(exec(o, o.admin, 'social.channel.set_client_approval', { connectionId: await connection(o.orgId, o.owner), clientApproval: true }))).toBe('FORBIDDEN');
    const conn = await clientChannel(o);
    const postId = await inReview(o, conn);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    expect(await status(o, postId)).toEqual(['in_review']);
    expect((await get(o, o.owner, postId)).variants[0]?.review).toMatchObject({ client: true, clientVerdict: null, approvedBy: [o.owner] });
    const token = await linkFor(o, postId);
    // A comment settles nothing.
    expect(await answer(o, token, 'comment')).toMatchObject({ settled: [] });
    expect(await answer(o, token, 'approved')).toMatchObject({ verdict: 'approved', settled: [expect.any(String)] });
    expect(await status(o, postId)).toEqual(['approved']);
  });

  it('completes at the team approval when the client said yes first, and the client no sends it back', async () => {
    const o = await org();
    const conn = await clientChannel(o);
    const first = await inReview(o, conn, 'Khách duyệt trước');
    await answer(o, await linkFor(o, first), 'approved');
    expect(await status(o, first)).toEqual(['in_review']);
    await exec(o, o.owner, 'social.variant.decide', { postId: first, decision: 'approved', variants: seen(await get(o, o.owner, first)) });
    expect(await status(o, first)).toEqual(['approved']);

    const second = await inReview(o, conn, 'Khách muốn sửa');
    await exec(o, o.owner, 'social.variant.decide', { postId: second, decision: 'approved', variants: seen(await get(o, o.owner, second)) });
    expect(await answer(o, await linkFor(o, second), 'changes_requested')).toMatchObject({ verdict: 'changes_requested' });
    expect(await status(o, second)).toEqual(['changes_requested']);
  });

  it('ignores a yes given for content that changed since, and changes nothing on channels without it', async () => {
    const o = await org();
    const conn = await clientChannel(o);
    const postId = await inReview(o, conn, 'Bản đầu');
    const token = await linkFor(o, postId);
    // The client said yes, then the post changed: that yes was for the old content.
    await answer(o, token, 'approved');
    const before = await get(o, o.member, postId);
    await exec(o, o.member, 'social.post.update', { postId, revision: before.revision, body: 'Bản đã sửa' });
    await exec(o, o.member, 'social.post.submit', { postId });
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, o.owner, postId)) });
    expect(await status(o, postId)).toEqual(['in_review']);

    const plain = await connection(o.orgId, o.owner);
    const other = await inReview(o, plain, 'Kênh thường');
    await exec(o, o.owner, 'social.variant.decide', { postId: other, decision: 'approved', variants: seen(await get(o, o.owner, other)) });
    expect(await status(o, other)).toEqual(['approved']);
    expect((await get(o, o.owner, other)).variants[0]?.review).toMatchObject({ client: false, clientVerdict: null });
    // Only the worker settles.
    const event = randomUUID();
    await expect(rt.execute('social.review.client_settle', { eventId: event }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });
});
