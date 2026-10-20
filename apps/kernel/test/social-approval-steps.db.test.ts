// Multi-step approval of Crove Social posts on PostgreSQL 17 (Social plan S9, issue #394): a channel's review policy
// asks for several different people to approve a variant's current content; each approval binds what its reviewer
// saw, a request for changes or an edit starts the count again, and lowering the policy approves what already meets it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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

suite('social multi-step approval on PostgreSQL (S9)', () => {
  const dbName = `crove_test_social_steps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; admin: string; second: string; member: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@steps.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), second: await person('admin2'), member: await person('member') };
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, key === 'member' ? 'member' : 'admin']));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        o.owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const seen = (p: PostView) => p.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
  const decide = async (o: Org, user: string, postId: string, decision: string, comment?: string) =>
    exec<{ waiting: string[] }>(o, user, 'social.variant.decide', { postId, decision, variants: seen(await get(o, postId)), ...(comment ? { comment } : {}) });
  const schedule = (o: Org, postId: string) => exec(o, o.owner, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });

  async function inReview(o: Org, connectionId: string) {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: `Bài ${randomUUID().slice(0, 6)}`, channels: [{ connectionId }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    return postId;
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

  it('needs two different people on a channel that asks for two, and only then schedules', async () => {
    const o = await org();
    const conn = await connection(o);
    await expect(exec(o, o.member, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 })).rejects.toBeDefined();
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    expect(await rt.query('social.channel.policies', {}, { actor: asUser(o.member), orgId: o.orgId })).toMatchObject([{ connectionId: conn, approvalsRequired: 2 }]);
    const postId = await inReview(o, conn);

    const first = await decide(o, o.owner, postId, 'approved');
    let v = (await get(o, postId)).variants[0];
    expect([first.waiting, v?.status, v?.review]).toEqual([[v?.id], 'in_review', { required: 2, approvedBy: [o.owner], fourEyes: false, client: false, clientVerdict: null }]);
    await expect(decide(o, o.owner, postId, 'approved')).rejects.toMatchObject({ code: 'ALREADY_APPROVED' });
    await expect(schedule(o, postId)).rejects.toBeDefined();

    const second = await decide(o, o.admin, postId, 'approved');
    v = (await get(o, postId)).variants[0];
    expect([second.waiting, v?.status, v?.review.approvedBy]).toEqual([[], 'approved', [o.admin, o.owner]]);
    await schedule(o, postId);
    expect((await get(o, postId)).variants[0]?.status).toBe('scheduled');
  });

  it('starts the count again after a request for changes, and after an edit', async () => {
    const o = await org();
    const conn = await connection(o);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    const postId = await inReview(o, conn);
    await decide(o, o.owner, postId, 'approved');
    await decide(o, o.admin, postId, 'changes_requested', 'Thêm giờ mở cửa');
    // Sent back without an edit: the approval from before the request does not count.
    await exec(o, o.member, 'social.post.submit', { postId });
    expect((await get(o, postId)).variants[0]?.review.approvedBy).toEqual([]);
    await decide(o, o.owner, postId, 'approved');
    expect((await get(o, postId)).variants[0]?.status).toBe('in_review');

    // An edit changes the content: the earlier approval is of other content.
    const post = await get(o, postId);
    await exec(o, o.member, 'social.post.update', { postId, revision: post.revision, body: 'Khai trương, mở cửa 8 giờ' });
    await exec(o, o.member, 'social.post.submit', { postId });
    expect((await get(o, postId)).variants[0]?.review.approvedBy).toEqual([]);
    await decide(o, o.second, postId, 'approved');
    await decide(o, o.owner, postId, 'approved');
    expect((await get(o, postId)).variants[0]?.status).toBe('approved');
  });

  it('sends approved and scheduled variants back to review when the policy rises, keeping their place (#408)', async () => {
    const o = await org();
    const conn = await connection(o);
    const approvedPost = await inReview(o, conn);
    await decide(o, o.owner, approvedPost, 'approved');
    const scheduledPost = await inReview(o, conn);
    await decide(o, o.owner, scheduledPost, 'approved');
    await schedule(o, scheduledPost);
    const slotBefore = (await get(o, scheduledPost)).variants[0]?.effectiveAt;
    const reviewPost = await inReview(o, conn);

    const raised = await exec<{ approved: string[]; regated: string[] }>(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    const ids = async (postId: string) => (await get(o, postId)).variants.map((v) => v.id);
    expect(raised.approved).toEqual([]);
    expect([...raised.regated].sort()).toEqual([...(await ids(approvedPost)), ...(await ids(scheduledPost))].sort());
    for (const postId of [approvedPost, scheduledPost, reviewPost]) {
      expect((await get(o, postId)).variants[0]).toMatchObject({ status: 'in_review' });
    }
    // The reason shows on each, and the one that was scheduled is marked to go back to its time.
    expect((await get(o, scheduledPost)).variants[0]?.error).toMatchObject({ code: 'POLICY_RAISED', action: 'reschedule' });
    expect((await get(o, approvedPost)).variants[0]?.error).toMatchObject({ code: 'POLICY_RAISED', action: null });
    // The earlier approval still counts: one more person approves, and the scheduled one is back on its time.
    expect((await get(o, scheduledPost)).variants[0]).toMatchObject({ review: { required: 2, approvedBy: [o.owner], fourEyes: false }, effectiveAt: slotBefore });
    await decide(o, o.admin, scheduledPost, 'approved');
    expect((await get(o, scheduledPost)).variants[0]).toMatchObject({ status: 'scheduled', effectiveAt: slotBefore, error: null });
    await decide(o, o.admin, approvedPost, 'approved');
    expect((await get(o, approvedPost)).variants[0]).toMatchObject({ status: 'approved', error: null });
    const events = await admin(async (c) => (await c.query<{ payload: { post_id: string } }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.submitted' AND payload->>'by_policy' = 'true'", [o.orgId])).rows);
    expect(events.map((e) => e.payload.post_id).sort()).toEqual([approvedPost, scheduledPost].sort());
  });

  it('leaves a re-approved variant approved when its kept time has passed, and an edit ends the mark', async () => {
    const o = await org();
    const conn = await connection(o);
    const late = await inReview(o, conn);
    await decide(o, o.owner, late, 'approved');
    await schedule(o, late);
    const edited = await inReview(o, conn);
    await decide(o, o.owner, edited, 'approved');
    await schedule(o, edited);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });

    // The kept time went by while the variant waited for its second approval.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 minute' WHERE post_id = $1", [late]));
    await decide(o, o.admin, late, 'approved');
    expect((await get(o, late)).variants[0]).toMatchObject({ status: 'approved', error: null });

    const post = await get(o, edited);
    await exec(o, o.member, 'social.post.update', { postId: edited, revision: post.revision, body: 'Khai trương, mở cửa 8 giờ' });
    expect((await get(o, edited)).variants[0]).toMatchObject({ status: 'draft', error: null });
  });

  it('refuses to schedule a variant approved under a bar its channel has raised since', async () => {
    const o = await org();
    const conn = await connection(o);
    const postId = await inReview(o, conn);
    await decide(o, o.owner, postId, 'approved');
    // The policy rose without set_policy re-checking (an approval that raced it).
    await admin((c) => c.query('INSERT INTO crove_social.channel_policy (org_id, channel_connection_id, approvals_required, updated_by) VALUES ($1, $2, 2, $3)', [o.orgId, conn, o.owner]));
    await expect(schedule(o, postId)).rejects.toMatchObject({ code: 'APPROVALS_MISSING' });
  });

  it('counts the variants waiting paused on each channel (#577)', async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    const [p1, p2] = [await inReview(o, a), await inReview(o, a)];
    await inReview(o, b);
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'paused' WHERE post_id = ANY($1)", [[p1, p2]]));
    expect(await rt.query('social.channel.waiting', {}, { actor: asUser(o.member), orgId: o.orgId })).toEqual([{ connectionId: a, paused: 2 }]);
  });

  it('hides the policy of a revoked channel', async () => {
    const o = await org();
    const conn = await connection(o);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE id = $1", [conn]));
    expect(await rt.query('social.channel.policies', {}, { actor: asUser(o.member), orgId: o.orgId })).toEqual([]);
  });

  it('approves what already meets a lowered policy, and leaves a channel without one at a single approval', async () => {
    const o = await org();
    const strict = await connection(o);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: strict, approvalsRequired: 3 });
    const postId = await inReview(o, strict);
    await decide(o, o.owner, postId, 'approved');
    await decide(o, o.admin, postId, 'approved');
    expect((await get(o, postId)).variants[0]?.status).toBe('in_review');
    const lowered = await exec<{ approved: string[] }>(o, o.owner, 'social.channel.set_policy', { connectionId: strict, approvalsRequired: 2 });
    expect(lowered.approved).toEqual([(await get(o, postId)).variants[0]?.id]);
    expect((await get(o, postId)).variants[0]?.status).toBe('approved');
    // The approval reaches event consumers as a decision would, marked as made by the policy (#408).
    const events = await admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.variant.decided' AND payload->>'by_policy' = 'true'", [o.orgId])).rows);
    expect(events.map((e) => e.payload)).toEqual([{ post_id: postId, decision: 'approved', variant_ids: lowered.approved, waiting_variant_ids: [], by_policy: true }]);

    const plain = await inReview(o, await connection(o));
    expect((await get(o, plain)).variants[0]?.review).toEqual({ required: 1, approvedBy: [], fourEyes: false, client: false, clientVerdict: null });
    expect((await decide(o, o.admin, plain, 'approved')).waiting).toEqual([]);
    expect((await get(o, plain)).variants[0]?.status).toBe('approved');
  });
});
