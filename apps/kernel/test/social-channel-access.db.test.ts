// Channels per member (#1081) on PostgreSQL 17: a member or viewer with rows in crove_social.channel_access uses those
// channels only. A limited member cannot add, edit, submit or cancel a variant on another channel (approving and
// scheduling stay with owners and admins), and can on theirs; the post list, the calendar, a single read, metrics, the
// CSV exports and notifications leave the other channels out; owners and admins are never limited, whatever rows exist;
// only owners and admins change a list, never the limited member; a revoked channel keeps its member limited; another
// org's channel is refused; and a member's rows go with the member.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ChannelAccessEntry, type GoalsProgressView, type MetricsRow, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('social channels per member on PostgreSQL (#1081)', () => {
  const dbName = `crove_test_social_channel_access_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; other: string; a: string; b: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@channel-access.test`, name: null });

  async function connection(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }

  // An org with an owner, an admin, two members and a viewer, and two channels A and B.
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const adminUser = await person('admin');
    const member = await person('member');
    const other = await person('other');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, adminUser, member, other, viewer]),
    );
    return { orgId, owner, admin: adminUser, member, viewer, other, a: await connection(orgId, owner, 'Kênh A'), b: await connection(orgId, owner, 'Kênh B') };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: Org, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const limit = (o: Org, userId: string, ids: string[], by = o.admin) => exec<{ userId: string; limited: boolean; connectionIds: string[] }>(o, by, 'social.channel_access.set', { userId, channelConnectionIds: ids });
  async function post(o: Org, user: string, connections: string[], body = 'Bài thử') {
    const { postId } = await exec<{ postId: string }>(o, user, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })) });
    return postId;
  }
  const get = (o: Org, user: string, postId: string) => query<PostView>(o, user, 'social.post.get', { postId });
  const list = (o: Org, user: string, input: Record<string, unknown> = {}) => query<PostView[]>(o, user, 'social.post.list', input);
  const variantOn = async (o: Org, postId: string, connectionId: string) => {
    const view = await get(o, o.owner, postId);
    const v = view.variants.find((x) => x.connectionId === connectionId);
    if (!v) throw new Error('no variant on that channel');
    return v;
  };
  const notAllowed = { code: 'CHANNEL_NOT_ALLOWED', status: 403 };

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
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(appPool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
    worker = new Runtime(createDb(workerPool)).register(registry);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('owners and admins set and clear a list, audited; members without one use every channel', async () => {
    const o = await org();
    expect(await query(o, o.member, 'social.channel_access.mine', {})).toEqual({ limited: false, connectionIds: [] });
    expect(await limit(o, o.member, [o.a])).toEqual({ userId: o.member, limited: true, connectionIds: [o.a] });
    await limit(o, o.viewer, [o.b, o.a], o.owner);
    expect(await query(o, o.member, 'social.channel_access.mine', {})).toEqual({ limited: true, connectionIds: [o.a] });
    expect(await query(o, o.viewer, 'social.channel_access.mine', {})).toEqual({ limited: true, connectionIds: [o.a, o.b].sort() });
    const lists = await query<ChannelAccessEntry[]>(o, o.admin, 'social.channel_access.list', {});
    expect(lists.map((l) => [l.userId, l.connectionIds]).sort()).toEqual(
      [
        [o.member, [o.a]],
        [o.viewer, [o.a, o.b].sort()],
      ].sort(),
    );
    // Replaced in one go, then lifted with an empty list.
    await limit(o, o.member, [o.b]);
    expect((await query<{ connectionIds: string[] }>(o, o.member, 'social.channel_access.mine', {})).connectionIds).toEqual([o.b]);
    await limit(o, o.member, []);
    expect(await query(o, o.member, 'social.channel_access.mine', {})).toEqual({ limited: false, connectionIds: [] });
    const audited = await admin((c) =>
      c.query<{ detail: { user_id: string; limited: boolean } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.channel_access.set' AND outcome = 'ok' ORDER BY id", [o.orgId]),
    );
    expect(audited.rows.map((r) => [r.detail.user_id, r.detail.limited])).toEqual([
      [o.member, true],
      [o.viewer, true],
      [o.member, true],
      [o.member, false],
    ]);
    // Only an owner or admin reads every member's list.
    await expect(query(o, o.member, 'social.channel_access.list', {})).rejects.toMatchObject({ status: 403 });
  });

  it('a limited member cannot change their own list or anyone else’s', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    for (const user of [o.member, o.viewer, o.other]) {
      await expect(limit(o, o.member, [o.a, o.b], user)).rejects.toMatchObject({ status: 403 });
      await expect(limit(o, o.member, [], user)).rejects.toMatchObject({ status: 403 });
      await expect(limit(o, o.other, [o.b], user)).rejects.toMatchObject({ status: 403 });
    }
    expect(await query(o, o.member, 'social.channel_access.mine', {})).toEqual({ limited: true, connectionIds: [o.a] });
    expect(await query(o, o.other, 'social.channel_access.mine', {})).toEqual({ limited: false, connectionIds: [] });
  });

  it('a limited member adds, edits, submits and cancels on their channels only; approving and scheduling stay with admins', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    await expect(post(o, o.member, [o.b])).rejects.toMatchObject(notAllowed);
    await expect(post(o, o.member, [o.a, o.b])).rejects.toMatchObject(notAllowed);
    const mine = await post(o, o.member, [o.a]);
    await expect(exec(o, o.member, 'social.post.add_channels', { postId: mine, channels: [{ connectionId: o.b }] })).rejects.toMatchObject(notAllowed);
    // A post of the owner on both channels: the member works on A's variant only.
    const shared = await post(o, o.owner, [o.a, o.b]);
    const vb = await variantOn(o, shared, o.b);
    const va = await variantOn(o, shared, o.a);
    await expect(exec(o, o.member, 'social.variant.update', { variantId: vb.id, revision: vb.revision, body: 'Sửa kênh B' })).rejects.toMatchObject(notAllowed);
    await expect(exec(o, o.member, 'social.post.submit', { postId: shared, variantIds: [vb.id] })).rejects.toMatchObject(notAllowed);
    await expect(exec(o, o.member, 'social.variant.cancel', { variantIds: [vb.id] })).rejects.toMatchObject(notAllowed);
    await expect(exec(o, o.member, 'social.post_comment.add', { postId: shared, variantId: vb.id, body: 'Ghi chú' })).rejects.toMatchObject(notAllowed);
    // The shared text reaches B's variant too: refused while B inherits it.
    const p = await get(o, o.owner, shared);
    await expect(exec(o, o.member, 'social.post.update', { postId: shared, revision: p.revision, body: 'Nội dung chung mới' })).rejects.toMatchObject(notAllowed);
    // A's own variant is the member's.
    await exec(o, o.member, 'social.variant.update', { variantId: va.id, revision: va.revision, body: 'Sửa kênh A' });
    await exec(o, o.member, 'social.post_comment.add', { postId: shared, variantId: va.id, body: 'Ghi chú cho kênh A' });
    // Submit without naming variants sends the member's own only.
    const submitted = await exec<{ submitted: string[] }>(o, o.member, 'social.post.submit', { postId: shared });
    expect(submitted.submitted).toEqual([va.id]);
    expect((await variantOn(o, shared, o.b)).status).toBe('draft');
    // Approving and scheduling are for owners and admins, whose lists never apply.
    const inReview = await variantOn(o, shared, o.a);
    await expect(
      exec(o, o.member, 'social.variant.decide', { postId: shared, decision: 'approved', variants: [{ variantId: inReview.id, revision: inReview.revision, contentHash: inReview.contentHash }] }),
    ).rejects.toMatchObject({ status: 403 });
    await exec(o, o.admin, 'social.variant.decide', { postId: shared, decision: 'approved', variants: [{ variantId: inReview.id, revision: inReview.revision, contentHash: inReview.contentHash }] });
    const at = new Date(Date.now() + 2 * HOUR).toISOString();
    await expect(exec(o, o.member, 'social.variant.schedule', { postId: shared, at })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.admin, 'social.variant.schedule', { postId: shared, at });
    // A post with no variant on the member's channels is not theirs to label, assign, copy or repeat.
    const theirs = await post(o, o.owner, [o.b]);
    await expect(exec(o, o.member, 'social.post.set_labels', { postId: theirs, labelIds: [] })).rejects.toMatchObject(notAllowed);
    await expect(exec(o, o.member, 'social.post.duplicate', { postId: theirs })).rejects.toMatchObject(notAllowed);
    await expect(exec(o, o.member, 'social.post.set_evergreen', { postId: shared, days: 30 })).rejects.toMatchObject(notAllowed);
    // The member's own post on A is.
    await exec(o, o.member, 'social.post.set_labels', { postId: mine, labelIds: [] });
    await exec(o, o.member, 'social.post.duplicate', { postId: mine });
  });

  it('lists, the calendar and a single read leave other channels out; a mixed post shows the member’s variants only', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    const onA = await post(o, o.owner, [o.a], 'Chỉ kênh A');
    const onB = await post(o, o.owner, [o.b], 'Chỉ kênh B');
    const both = await post(o, o.owner, [o.a, o.b], 'Hai kênh');
    const ids = (views: PostView[]) => views.map((v) => v.id).sort();
    expect(ids(await list(o, o.owner))).toEqual([onA, onB, both].sort());
    const seen = await list(o, o.member);
    expect(ids(seen)).toEqual([onA, both].sort());
    expect(seen.find((v) => v.id === both)?.variants.map((v) => v.connectionId)).toEqual([o.a]);
    await expect(get(o, o.member, onB)).rejects.toMatchObject({ code: 'POST_NOT_FOUND', status: 404 });
    expect((await get(o, o.member, both)).variants.map((v) => v.connectionId)).toEqual([o.a]);
    await expect(query(o, o.member, 'social.post.activity', { postId: onB })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    await expect(query(o, o.member, 'social.post.versions', { postId: onB })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    // A channel filter on another channel lists nothing; search does not reach another channel's own text.
    expect(await list(o, o.member, { connectionId: o.b })).toEqual([]);
    const vb = await variantOn(o, both, o.b);
    await exec(o, o.owner, 'social.variant.update', { variantId: vb.id, revision: vb.revision, body: 'Chữ riêng của kênh B' });
    expect(await list(o, o.member, { search: 'riêng của kênh B' })).toEqual([]);
    expect(ids(await list(o, o.owner, { search: 'riêng của kênh B' }))).toEqual([both]);
    // The calendar: posts planned in the range, by the member's variants' times.
    const at = new Date(Date.now() + 3 * HOUR);
    await admin((c) => c.query('UPDATE crove_social.post SET scheduled_at = $2 WHERE org_id = $1', [o.orgId, at]));
    const range = { from: new Date(at.getTime() - HOUR).toISOString(), to: new Date(at.getTime() + HOUR).toISOString() };
    expect(ids(await list(o, o.owner, range))).toEqual([onA, onB, both].sort());
    expect(ids(await list(o, o.member, range))).toEqual([onA, both].sort());
    // The queue of another channel is not theirs to read.
    await expect(query(o, o.member, 'social.queue.get', { connectionId: o.b })).rejects.toMatchObject(notAllowed);
  });

  it('metrics, insights and the CSV exports leave other channels out', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    const both = await post(o, o.owner, [o.a, o.b], 'Bài đã đăng');
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = now() - interval '1 day' WHERE post_id = $1 RETURNING id", [both]);
      for (const r of rows) await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'k', '{\"reach\": 10, \"reactions\": 2}')", [o.orgId, r.id]);
    });
    const summary = (user: string) => query<MetricsRow[]>(o, user, 'social.metrics.summary', { days: 7 });
    expect((await summary(o.owner)).map((r) => r.connectionId).sort()).toEqual([o.a, o.b].sort());
    expect((await summary(o.member)).map((r) => r.connectionId)).toEqual([o.a]);
    const totals = (user: string) => query<{ posts: number; metrics: Record<string, number>; channels: { connectionId: string }[] }>(o, user, 'social.metrics.totals', { days: 7 });
    expect((await totals(o.owner)).metrics.reach).toBe(20);
    const limited = await totals(o.member);
    expect([limited.posts, limited.metrics.reach, limited.channels.map((c) => c.connectionId)]).toEqual([1, 10, [o.a]]);
    const insights = await query<{ channels: { connectionId: string }[] }>(o, o.member, 'social.metrics.insights', { days: 7, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(insights.channels.map((c) => c.connectionId)).toEqual([o.a]);
    const csv = async (user: string) => (await exec<{ csv: string }>(o, user, 'social.metrics.export', { days: 7 })).csv;
    expect(await csv(o.owner)).toContain('Kênh B');
    const own = await csv(o.member);
    expect(own).toContain('Kênh A');
    expect(own).not.toContain('Kênh B');
    // The content plan: every channel's rows for the owner, the member's channel only for them; naming another is refused.
    const plan = (user: string, extra: Record<string, unknown> = {}) =>
      exec<{ csv: string }>(o, user, 'social.plan.export', { from: new Date(Date.now() - 3 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString(), timeZone: 'Asia/Ho_Chi_Minh', ...extra });
    expect((await plan(o.owner)).csv).toContain('Kênh B');
    expect((await plan(o.member)).csv).not.toContain('Kênh B');
    expect((await plan(o.member)).csv).toContain('Kênh A');
    await expect(plan(o.member, { connectionIds: [o.b] })).rejects.toMatchObject(notAllowed);
  });

  it('the calendar’s undated drafts leave other channels out, and a member plans only their own (#1145)', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    const onA = await post(o, o.owner, [o.a], 'Nháp kênh A');
    const onB = await post(o, o.owner, [o.b], 'Nháp kênh B');
    const both = await post(o, o.owner, [o.a, o.b], 'Nháp hai kênh');
    const undated = (user: string) => list(o, user, { undated: true }).then((views) => views.map((v) => v.id).sort());
    expect(await undated(o.owner)).toEqual([onA, onB, both].sort());
    // The shared draft is left out: planning it would move channel B's planned time too, which the member may not.
    expect(await undated(o.member)).toEqual([onA]);
    const at = new Date(Date.now() + 26 * HOUR).toISOString();
    const shared = await get(o, o.member, both);
    await expect(exec(o, o.member, 'social.post.update', { postId: both, revision: shared.revision, scheduledAt: at })).rejects.toMatchObject(notAllowed);
    const other = await get(o, o.owner, onB);
    await expect(exec(o, o.member, 'social.post.update', { postId: onB, revision: other.revision, scheduledAt: at })).rejects.toMatchObject(notAllowed);
    const own = await get(o, o.member, onA);
    await exec(o, o.member, 'social.post.update', { postId: onA, revision: own.revision, scheduledAt: at });
    expect(await undated(o.member)).toEqual([]);
    // Once channel B is cancelled, the draft is the member's to plan.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'cancelled' WHERE org_id = $1 AND post_id = $2 AND channel_connection_id = $3", [o.orgId, both, o.b]));
    expect(await undated(o.member)).toEqual([both]);
  });

  it('a limited member sees their channels’ goals only, and cannot retime or stop the repeats of a post on other channels', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    const goal = (connectionId: string | null) => exec(o, o.admin, 'social.goal.set', { connectionId, targets: { posts: 3 }, timeZone: 'Asia/Ho_Chi_Minh' });
    await goal(null);
    await goal(o.a);
    await goal(o.b);
    // The org's own goals count every channel: their progress would give away B's numbers.
    const seen = await query<GoalsProgressView>(o, o.member, 'social.goal.progress', {});
    expect(seen.goals.map((g) => g.connectionId)).toEqual([o.a]);
    expect((await query<GoalsProgressView>(o, o.owner, 'social.goal.progress', {})).goals).toHaveLength(3);
    // The planned time every open variant follows is not the member's to move on a post that also goes to B.
    const shared = await post(o, o.owner, [o.a, o.b]);
    const later = new Date(Date.now() + 5 * HOUR).toISOString();
    const p = await get(o, o.owner, shared);
    await expect(exec(o, o.member, 'social.post.update', { postId: shared, revision: p.revision, scheduledAt: later })).rejects.toMatchObject(notAllowed);
    await expect(exec(o, o.member, 'social.post.set_evergreen', { postId: shared, days: null })).rejects.toMatchObject(notAllowed);
    await expect(exec(o, o.member, 'social.post.recurrence_clear', { postId: shared })).rejects.toMatchObject(notAllowed);
    const mine = await post(o, o.member, [o.a]);
    const m = await get(o, o.member, mine);
    await exec(o, o.member, 'social.post.update', { postId: mine, revision: m.revision, scheduledAt: later });
    await exec(o, o.member, 'social.post.set_evergreen', { postId: mine, days: null });
    await exec(o, o.member, 'social.post.recurrence_clear', { postId: mine });
  });

  it('owners and admins are never limited, whatever rows they have', async () => {
    const o = await org();
    // Not through the command: it refuses a list for them.
    await expect(limit(o, o.admin, [o.a], o.owner)).rejects.toMatchObject({ code: 'CHANNEL_ACCESS_NOT_LIMITABLE', status: 422 });
    await expect(limit(o, o.owner, [o.a])).rejects.toMatchObject({ code: 'CHANNEL_ACCESS_NOT_LIMITABLE' });
    // Rows left from before a promotion do nothing: the database keeps them, the helper skips owners and admins.
    await admin((c) =>
      c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $4, $2), ($1, $3, $4, $2)', [o.orgId, o.owner, o.admin, o.a]),
    );
    const onB = await post(o, o.owner, [o.b]);
    for (const user of [o.owner, o.admin]) {
      expect(await query(o, user, 'social.channel_access.mine', {})).toEqual({ limited: false, connectionIds: [] });
      await post(o, user, [o.b]);
      expect((await get(o, user, onB)).variants.map((v) => v.connectionId)).toEqual([o.b]);
      expect((await list(o, user)).length).toBeGreaterThanOrEqual(1);
    }
    // Clearing such a list is allowed.
    await limit(o, o.admin, [], o.owner);
    expect((await query<ChannelAccessEntry[]>(o, o.owner, 'social.channel_access.list', {})).map((l) => l.userId)).toEqual([o.owner]);
  });

  it('a revoked channel keeps its member limited: revoking their only channel never widens them', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    const onB = await post(o, o.owner, [o.b]);
    await exec(o, o.admin, 'kernel.channel.disconnect', { connectionId: o.a });
    expect(await query(o, o.member, 'social.channel_access.mine', {})).toEqual({ limited: true, connectionIds: [o.a] });
    await expect(post(o, o.member, [o.b])).rejects.toMatchObject(notAllowed);
    expect((await list(o, o.member)).map((v) => v.id)).not.toContain(onB);
    await expect(get(o, o.member, onB)).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    // The list may keep the revoked channel when an admin saves it again.
    await limit(o, o.member, [o.a]);
  });

  it('refuses another org’s channel and a person who is not a member', async () => {
    const o = await org();
    const p = await org();
    await expect(limit(o, o.member, [p.a])).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND', status: 404 });
    await expect(limit(o, o.member, [o.a, p.a])).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(limit(o, p.member, [o.a])).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND', status: 404 });
    expect(await query(o, o.member, 'social.channel_access.mine', {})).toEqual({ limited: false, connectionIds: [] });
    // Another org's rows are not this org's.
    await limit(p, p.member, [p.a]);
    expect(await query<ChannelAccessEntry[]>(o, o.admin, 'social.channel_access.list', {})).toEqual([]);
  });

  it('a limited member hears only of their channels, and their rows go with them', async () => {
    const o = await org();
    await limit(o, o.member, [o.a]);
    // A comment on a post tells its author: the member wrote on A, the owner's other post is on B.
    const mine = await post(o, o.member, [o.a]);
    const onB = await post(o, o.owner, [o.b]);
    await admin((c) => c.query('UPDATE crove_social.post SET author_user_id = $2 WHERE org_id = $1 AND id = $3', [o.orgId, o.member, onB]));
    await exec(o, o.owner, 'social.post_comment.add', { postId: mine, body: 'Góp ý' });
    await exec(o, o.owner, 'social.post_comment.add', { postId: onB, body: 'Góp ý' });
    const events = await admin((c) => c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.commented' ORDER BY id", [o.orgId]));
    for (const e of events.rows) await worker.execute('social.notification.dispatch', { eventId: e.id }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId });
    const told = await query<{ items: { postId: string | null }[] }>(o, o.member, 'social.notification.list', {});
    expect(told.items.map((i) => i.postId)).toEqual([mine]);
    // Removing the member drops their rows (the composite foreign key cascades).
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member]));
    const left = await admin((c) => c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_social.channel_access WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member]));
    expect(left.rows[0]?.n).toBe(0);
  });
});
