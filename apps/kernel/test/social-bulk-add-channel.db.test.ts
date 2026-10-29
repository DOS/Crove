// One channel added to many Social posts at once on PostgreSQL 17 (#1178): one transaction, the posts locked in id
// order, each post through social.post.add_channels with its own audit row and version, a draft with the post's
// content and planned time, each post left out named with its reason, which added channels already fit their rules,
// and a member limited to some channels (#1081) kept to theirs without learning of posts they cannot see. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type BulkAddChannelResult, type PostView, type VersionView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social bulk add channel on PostgreSQL (#1178)', () => {
  const dbName = `crove_test_social_bulk_add_channel_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Org = { orgId: string; owner: string; member: string; viewer: string; a: string; b: string };
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@bulk-add.test`, name: null });
  async function connection(orgId: string, owner: string, name: string, provider = 'sandbox') {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, provider, `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }
  // An org with an owner, a member and a viewer, and two channels A and B.
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer, a: await connection(orgId, owner, 'Kênh A'), b: await connection(orgId, owner, 'Kênh B') };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  async function post(o: Org, connections: string[], content: { body: string; scheduledAt?: string; title?: string }, by = o.owner) {
    const { postId } = await exec<{ postId: string }>(o, by, 'social.post.create', { ...content, channels: connections.map((connectionId) => ({ connectionId })) });
    return postId;
  }
  const add = (o: Org, user: string, postIds: string[], connectionId: string) => exec<BulkAddChannelResult>(o, user, 'social.post.bulk_add_channel', { postIds, connectionId });
  const versions = async (o: Org, postId: string) => (await rt.query<{ versions: VersionView[] }>('social.post.versions', { postId }, { actor: asUser(o.owner), orgId: o.orgId })).versions;
  const audits = (o: Org, command: string, outcome = 'ok') =>
    admin(async (c) => (await c.query<{ target_id: string | null; detail: Record<string, unknown> | null }>('SELECT target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = $3 ORDER BY occurred_at, id', [o.orgId, command, outcome])).rows);
  const setStatus = (o: Org, postId: string, status: string) =>
    admin(async (c) => {
      await c.query('UPDATE crove_social.post_variant SET status = $3 WHERE org_id = $1 AND post_id = $2', [o.orgId, postId, status]);
      if (status === 'published') await c.query("UPDATE crove_social.post SET status = 'published' WHERE org_id = $1 AND id = $2", [o.orgId, postId]);
    });
  const sorted = (ids: readonly string[]) => [...ids].sort();

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("adds a draft channel to 30 posts with each post's content and planned time, an audit row and a version", async () => {
    const o = await org();
    const at = new Date(Date.now() + 5 * 86_400_000);
    at.setUTCMinutes(0, 0, 0);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await post(o, [o.a], { body: `Bài số ${i + 1}`, scheduledAt: new Date(at.getTime() + i * 3_600_000).toISOString() }));
    const before = new Map<string, number>();
    for (const id of ids) before.set(id, (await get(o, id)).revision);

    const result = await add(o, o.member, ids, o.b);
    expect(result.skipped).toEqual([]);
    expect(result.done).toEqual(sorted(ids));
    // The sandbox channel takes text alone: every added channel already fits its rules.
    expect(result.added.map((x) => x.postId)).toEqual(sorted(ids));
    expect(result.added.every((x) => x.issues.length === 0)).toBe(true);

    for (const [i, id] of ids.entries()) {
      const p = await get(o, id);
      const added = p.variants.find((v) => v.connectionId === o.b);
      expect(added).toMatchObject({ status: 'draft', overrides: { body: null, title: null, linkUrl: null } });
      expect(added?.id).toBe(result.added.find((x) => x.postId === id)?.variantId);
      // It goes out when the post is planned to.
      expect(Date.parse(added?.effectiveAt ?? '')).toBe(at.getTime() + i * 3_600_000);
      expect(p.body).toBe(`Bài số ${i + 1}`);
      // The base content did not change; the channel list did, so the history shows it.
      expect(p.revision).toBe(before.get(id));
      const history = await versions(o, id);
      expect(history[0]?.variants.map((v) => v.variantId)).toContain(added?.id);
      expect(history.length).toBe(2);
    }
    // One audit row per post, each on its post; the bulk row lists them all.
    expect((await audits(o, 'social.post.add_channels')).map((r) => r.target_id).sort()).toEqual(sorted(ids));
    const [bulk] = await audits(o, 'social.post.bulk_add_channel');
    expect(bulk?.detail).toMatchObject({ connection_id: o.b, done: 30, post_ids: sorted(ids), needs_edits: 0 });
  });

  it('says which added channels need edits for their rules', async () => {
    const o = await org();
    const ig = await connection(o.orgId, o.owner, 'Instagram', 'instagram');
    const text = await post(o, [o.a], { body: 'Chỉ có chữ' });
    const result = await add(o, o.owner, [text], ig);
    expect(result.done).toEqual([text]);
    // Instagram takes no post without an image or a video.
    expect(result.added[0]?.issues.length).toBeGreaterThan(0);
    expect((await get(o, text)).variants.find((v) => v.connectionId === ig)?.status).toBe('draft');
    const [bulk] = await audits(o, 'social.post.bulk_add_channel');
    expect(bulk?.detail).toMatchObject({ needs_edits: 1 });
  });

  it('leaves out each post it cannot add the channel to, with the reason, and adds it to the others', async () => {
    const o = await org();
    const fine = await post(o, [o.a], { body: 'Được thêm' });
    const already = await post(o, [o.a, o.b], { body: 'Đã có B' });
    const published = await post(o, [o.a], { body: 'Đã đăng' });
    await setStatus(o, published, 'published');
    const going = await post(o, [o.a], { body: 'Đang đăng' });
    await setStatus(o, going, 'publishing');
    // B was cancelled on this post: a cancelled channel is history, so B can be added again.
    const cancelledB = await post(o, [o.a, o.b], { body: 'B đã hủy' });
    const bOf = (await get(o, cancelledB)).variants.find((v) => v.connectionId === o.b);
    await exec(o, o.owner, 'social.variant.cancel', { variantIds: [bOf?.id] });
    // Twenty channels already: one more would be too many.
    const many = [o.a];
    for (let i = 0; i < 19; i++) many.push(await connection(o.orgId, o.owner, `Kênh ${i}`));
    const full = await post(o, many, { body: 'Đủ 20 kênh' });
    const missing = randomUUID();
    const foreign = await org();
    const theirs = await post(foreign, [foreign.a], { body: 'Bài của tổ chức khác' });

    const result = await add(o, o.member, [fine, already, published, going, cancelledB, full, missing, theirs], o.b);
    expect(sorted(result.done)).toEqual(sorted([fine, cancelledB]));
    expect(result.done).toEqual(sorted(result.done));
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { postId: already, reason: 'already_on' },
        { postId: published, reason: 'published' },
        { postId: going, reason: 'in_flight' },
        { postId: full, reason: 'too_many_channels' },
        { postId: missing, reason: 'not_found' },
        { postId: theirs, reason: 'not_found' },
      ]),
    );
    expect(result.skipped).toHaveLength(6);
    expect((await get(o, cancelledB)).variants.filter((v) => v.connectionId === o.b).map((v) => v.status).sort()).toEqual(['cancelled', 'draft']);
    expect((await get(o, already)).variants.filter((v) => v.connectionId === o.b)).toHaveLength(1);
    for (const id of [published, going, full]) expect((await get(o, id)).variants.some((v) => v.connectionId === o.b)).toBe(false);
    expect((await get(foreign, theirs)).variants.map((v) => v.connectionId)).toEqual([foreign.a]);
    // Only the posts it changed have an audit row of the single add.
    expect((await audits(o, 'social.post.add_channels')).map((r) => r.target_id).sort()).toEqual(sorted([fine, cancelledB]));
  });

  it('keeps a member limited to some channels to theirs, saying nothing of a post they cannot see', async () => {
    const o = await org();
    const c = await connection(o.orgId, o.owner, 'Kênh C');
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [o.a, c] });
    const onA = await post(o, [o.a], { body: 'Trên A' });
    // On B only, and published: the member hears not_allowed, not that it is published.
    const hidden = await post(o, [o.b], { body: 'Chỉ B' });
    await setStatus(o, hidden, 'published');

    // A channel outside their list refuses the whole command, changing nothing.
    await expect(add(o, o.member, [onA], o.b)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED', status: 403 });
    expect((await get(o, onA)).variants.map((v) => v.connectionId)).toEqual([o.a]);
    expect(await audits(o, 'social.post.add_channels')).toEqual([]);

    const result = await add(o, o.member, [onA, hidden], c);
    expect(result.done).toEqual([onA]);
    expect(result.skipped).toEqual([{ postId: hidden, reason: 'not_allowed' }]);
    expect((await get(o, hidden)).variants.map((v) => v.connectionId)).toEqual([o.b]);

    // The owner is never limited.
    const owner = await add(o, o.owner, [hidden], c);
    expect(owner.skipped).toEqual([{ postId: hidden, reason: 'published' }]);
  });

  it('refuses viewers, a channel that is not live, and input past its bounds, changing nothing', async () => {
    const o = await org();
    const p = await post(o, [o.a], { body: 'Bài' });
    await expect(add(o, o.viewer, [p], o.b)).rejects.toMatchObject({ status: 403 });
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [o.orgId, o.b]));
    await expect(add(o, o.owner, [p], o.b)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    const foreign = await org();
    await expect(add(o, o.owner, [p], foreign.a)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(add(o, o.owner, Array.from({ length: 101 }, () => randomUUID()), o.a)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(add(o, o.owner, [p, p], o.a)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await get(o, p)).variants).toHaveLength(1);
    expect(await audits(o, 'social.post.add_channels')).toEqual([]);
  });

  it('locks every post it names in id order before adding to any, in one transaction', async () => {
    const o = await org();
    const ids = sorted([await post(o, [o.a], { body: 'Một' }), await post(o, [o.a], { body: 'Hai' }), await post(o, [o.a], { body: 'Ba' })]);
    const [low, mid, high] = ids as [string, string, string];
    // Another transaction holds the highest post: the bulk add takes the lower ones first, then waits.
    const holder = new pg.Client({ connectionString: adminUrl });
    const prober = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    await prober.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM crove_social.post WHERE org_id = $1 AND id = $2 FOR UPDATE', [o.orgId, high]);
      const running = add(o, o.member, [high, low, mid], o.b);
      // Bounded, so a run that never waits fails here rather than hanging the suite.
      let waiting = 0;
      for (let tries = 0; waiting < 1 && tries < 250; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { rows } = await prober.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        waiting = rows[0]?.n ?? 0;
      }
      expect(waiting).toBeGreaterThan(0);
      // While it waits, the lower posts are already its own, and none has the channel yet.
      for (const id of [low, mid]) {
        await expect(prober.query('SELECT id FROM crove_social.post WHERE org_id = $1 AND id = $2 FOR UPDATE NOWAIT', [o.orgId, id])).rejects.toMatchObject({ code: '55P03' });
      }
      const { rows: early } = await prober.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_social.post_variant WHERE org_id = $1 AND channel_connection_id = $2', [o.orgId, o.b]);
      expect(early[0]?.n).toBe(0);
      await holder.query('COMMIT');
      const result = await running;
      expect(result.done).toEqual(ids);
    } finally {
      await holder.end();
      await prober.end();
    }
    for (const id of ids) expect((await get(o, id)).variants.map((v) => v.connectionId).sort()).toEqual(sorted([o.a, o.b]));
  });
});
