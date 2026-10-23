// Posts published outside Crove on PostgreSQL 17 (#1054): the worker's sweep lists each channel's own recent posts
// through its adapter and keeps the ones Crove did not publish, reads their counts through metrics(), marks a channel
// whose token is refused for reconnecting, and the Metrics tab and client report links count them only when asked, once
// each, for their own org. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import type { MetricsInput, MetricsResult, Publisher, PublishResult, RecentPostsInput, RecentPostsResult } from '@crove/channel';
import { socialCommands, socialQueries, sweepExternalPosts, type ExternalPostRow, type MetricsRow } from '@crove/mod-social';
import { reportView, type ReportPage } from '../src/report-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;

// A platform whose accounts list the posts set for them, and whose posts report the counts set for them.
class FakePlatform implements Publisher {
  readonly provider = 'sandbox' as const;
  readonly publishSafety = 'reconcile_only' as const;
  listings = new Map<string, RecentPostsResult>();
  counts = new Map<string, MetricsResult>();
  listed: RecentPostsInput[] = [];
  measured: MetricsInput[] = [];
  async publish(): Promise<PublishResult> {
    return { kind: 'rejected', error: 'bad_request', code: 'NOT_IN_THIS_TEST' };
  }
  async listRecentPosts(input: RecentPostsInput): Promise<RecentPostsResult> {
    this.listed.push(input);
    return this.listings.get(input.externalAccountId) ?? null;
  }
  async metrics(input: MetricsInput): Promise<MetricsResult> {
    this.measured.push(input);
    return this.counts.get(input.externalId) ?? null;
  }
}

interface Totals {
  posts: number;
  metrics: Record<string, number>;
  clicks: number | null;
}
interface WindowTotals extends Totals {
  channels: (Totals & { connectionId: string; provider: string })[];
}
type Org = { orgId: string; owner: string; viewer: string };

suite('social posts published outside Crove (#1054)', () => {
  const dbName = `crove_test_social_external_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function org(): Promise<Org> {
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@external.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Cửa hàng ${randomUUID().slice(0, 6)}`);
    const viewer = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `viewer-${randomUUID().slice(0, 8)}@external.test`, name: null });
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    return { orgId, owner, viewer };
  }

  async function connect(o: Org, account: string) {
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_test' }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: account });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'sandbox', externalAccountId: account, displayName: account, scopes: ['publish'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return connectionId;
  }

  // A post Crove published on a channel some days ago, as the platform's id (and its address), with its latest counts.
  async function published(o: Org, conn: string, externalId: string, daysAgo: number, metrics: Record<string, number>, url: string | null = null) {
    const { postId } = await api.execute<{ postId: string }>('social.post.create', { body: `Bài của Crove ${externalId}`, channels: [{ connectionId: conn }] }, { actor: asUser(o.owner), orgId: o.orgId });
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "UPDATE crove_social.post_variant SET status = 'published', published_at = now() - make_interval(secs => $2), external_post_id = $3, external_url = $4 WHERE post_id = $1 RETURNING id",
        [postId, daysAgo * 86_400, externalId, url],
      );
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'k', $3)", [o.orgId, rows[0]?.id, JSON.stringify(metrics)]);
    });
    return postId;
  }

  // A post brought in earlier, as the sweep would have kept it.
  async function outside(o: Org, conn: string, externalId: string, daysAgo: number, metrics: Record<string, number>) {
    await admin((c) =>
      c.query(
        "INSERT INTO crove_social.external_post (org_id, channel_connection_id, external_post_id, excerpt, permalink, published_at, metrics, captured_at) VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6), $7, now())",
        [o.orgId, conn, externalId, `Đăng thẳng ${externalId}`, `https://www.facebook.com/${externalId}`, daysAgo * 86_400, JSON.stringify(metrics)],
      ),
    );
  }

  const totals = (o: Org, input: Record<string, unknown>, as = o.owner) => api.query<WindowTotals & { previous: WindowTotals }>('social.metrics.totals', input, { actor: asUser(as), orgId: o.orgId });
  const listed = (o: Org, input: Record<string, unknown> = {}, as = o.owner) => api.query<ExternalPostRow[]>('social.metrics.external', input, { actor: asUser(as), orgId: o.orgId });
  const sweep = (platform: FakePlatform) => sweepExternalPosts({ runtime: worker, broker: vault, workerDb, publishers: { sandbox: platform } });
  const ago = (days: number) => new Date(Date.now() - days * DAY);

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
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 4 });
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    api = new Runtime(appDb).register(registry);
    worker = new Runtime(workerDb).register(registry);
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

  it('brings in the posts Crove did not publish, measures them, and counts them only when asked, once each', async () => {
    const o = await org();
    const conn = await connect(o, 'acct-page');
    await published(o, conn, 'crove-1', 2, { reach: 100, reactions: 10 });
    const before = await totals(o, { days: 30 });
    const beforeSummary = await api.query<MetricsRow[]>('social.metrics.summary', { days: 30 }, { actor: asUser(o.owner), orgId: o.orgId });

    const platform = new FakePlatform();
    platform.listings.set('acct-page', {
      posts: [
        { externalId: 'crove-1', text: 'Bài Crove đã đăng', permalink: 'https://www.facebook.com/crove-1', publishedAt: ago(2) },
        { externalId: 'out-1', text: '  Đăng thẳng​ trên\n\n Facebook ‮abc ', permalink: 'https://www.facebook.com/out-1', publishedAt: ago(1) },
        { externalId: 'out-2', text: 'x'.repeat(800), permalink: 'http://www.facebook.com/out-2', publishedAt: ago(3) },
        { externalId: 'bad id!', text: 'refused id', permalink: null, publishedAt: ago(1) },
      ],
    });
    platform.counts.set('out-1', { metrics: { reach: 50, reactions: 5 } });
    // out-2: no answer this time.
    const done = await sweep(platform);
    expect(done).toMatchObject({ imported: 1, expired: 0, measured: 1 });
    // The token reached the adapter opened, with since 30 days back.
    expect(platform.listed[0]?.secret).toBe(JSON.stringify({ accessToken: 'sbx_test' }));
    expect(Math.abs((platform.listed[0]?.since.getTime() ?? 0) - ago(30).getTime())).toBeLessThan(60_000);
    expect(platform.measured.map((m) => m.externalId).sort()).toEqual(['out-1', 'out-2']);

    const rows = await admin(async (c) => (await c.query<{ external_post_id: string; excerpt: string; permalink: string | null; metrics: Record<string, number>; checked_at: Date | null }>('SELECT external_post_id, excerpt, permalink, metrics, checked_at FROM crove_social.external_post WHERE org_id = $1 ORDER BY external_post_id', [o.orgId])).rows);
    expect(rows.map((r) => r.external_post_id)).toEqual(['out-1', 'out-2']);
    expect(rows[0]).toMatchObject({ excerpt: 'Đăng thẳng trên Facebook abc', permalink: 'https://www.facebook.com/out-1', metrics: { reach: 50, reactions: 5 } });
    expect(rows[1]?.excerpt).toHaveLength(500);
    expect(rows[1]).toMatchObject({ permalink: null, metrics: {} });
    expect(rows.every((r) => r.checked_at !== null)).toBe(true);
    const run = await admin(async (c) => (await c.query('SELECT found, error FROM crove_social.external_import WHERE channel_connection_id = $1', [conn])).rows);
    expect(run).toEqual([{ found: 3, error: null }]);

    // With the switch off, every total and the list are as before.
    expect(await totals(o, { days: 30 })).toEqual(before);
    expect(await totals(o, { days: 30, includeExternal: false })).toEqual(before);
    expect(await api.query<MetricsRow[]>('social.metrics.summary', { days: 30 }, { actor: asUser(o.owner), orgId: o.orgId })).toEqual(beforeSummary);
    // With it on, the outside posts count, once each, and a viewer reads the same.
    const on = await totals(o, { days: 30, includeExternal: true }, o.viewer);
    expect(on).toMatchObject({ posts: 3, metrics: { reach: 150, reactions: 15 }, clicks: null });
    expect(on.channels).toEqual([{ connectionId: conn, provider: 'sandbox', posts: 3, metrics: { reach: 150, reactions: 15 }, clicks: null, rateBases: { reach: { engagement: 15, denominator: 150 } } }]);
    // A label filter leaves them out: they carry no label.
    const { labelId } = await api.execute<{ labelId: string }>('social.label.create', { name: 'Khuyến mãi', color: 'red' }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await totals(o, { days: 30, labelId, includeExternal: true })).toEqual(await totals(o, { days: 30, labelId }));
    const list = await listed(o, { days: 30 }, o.viewer);
    expect(list.map((r) => [r.provider, r.url, r.metrics])).toEqual([
      ['sandbox', 'https://www.facebook.com/out-1', { reach: 50, reactions: 5 }],
      ['sandbox', null, {}],
    ]);
    expect(list[1]?.excerpt).toHaveLength(160);
    expect(await listed(o, { days: 1 })).toHaveLength(0);

    // Nothing is due again within 6 hours, neither the channel nor the posts.
    platform.listed = [];
    platform.measured = [];
    await sweep(platform);
    expect(platform.listed.filter((x) => x.externalAccountId === 'acct-page')).toEqual([]);
    expect(platform.measured.filter((x) => x.externalId.startsWith('out-'))).toEqual([]);

    // A later capture with no answer keeps the last real counts.
    const out1 = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_social.external_post WHERE external_post_id = 'out-1'")).rows[0]?.id as string);
    await worker.execute('social.external_post.record', { externalId: out1 }, { actor: system, orgId: o.orgId });
    expect((await listed(o))[0]?.metrics).toEqual({ reach: 50, reactions: 5 });
    // A post the platform no longer has is never asked again.
    await worker.execute('social.external_post.record', { externalId: out1, gone: true }, { actor: system, orgId: o.orgId });
    await admin((c) => c.query("UPDATE crove_social.external_post SET checked_at = now() - interval '7 hours' WHERE org_id = $1", [o.orgId]));
    platform.measured = [];
    await sweep(platform);
    expect(platform.measured.map((m) => m.externalId)).toEqual(['out-2']);

    // A post that turns out to be Crove's (its variant got the id later) is counted once, as Crove's.
    await published(o, conn, 'out-2', 3, { reach: 7 });
    const once = await totals(o, { days: 30, includeExternal: true });
    expect(once).toMatchObject({ posts: 3, metrics: { reach: 157, reactions: 15 } });
    expect((await listed(o)).map((r) => r.url)).toEqual(['https://www.facebook.com/out-1']);
    await admin((c) => c.query("UPDATE crove_social.external_post SET checked_at = now() - interval '7 hours', gone = false WHERE org_id = $1", [o.orgId]));
    platform.measured = [];
    await sweep(platform);
    expect(platform.measured.map((m) => m.externalId)).toEqual(['out-1']);
    // And a new bring-in never adds it again.
    await admin((c) => c.query("UPDATE crove_social.external_import SET ran_at = now() - interval '7 hours' WHERE channel_connection_id = $1", [conn]));
    await admin((c) => c.query("DELETE FROM crove_social.external_post WHERE external_post_id = 'out-2'"));
    await sweep(platform);
    expect((await admin(async (c) => (await c.query("SELECT external_post_id FROM crove_social.external_post WHERE org_id = $1 ORDER BY 1", [o.orgId])).rows)).map((r) => r.external_post_id)).toEqual(['out-1']);
  });

  it('moves a channel whose token is refused to reconnect, and keeps why nothing came', async () => {
    const o = await org();
    const dead = await connect(o, 'acct-dead');
    const denied = await connect(o, 'acct-denied');
    const silent = await connect(o, 'acct-silent');
    const platform = new FakePlatform();
    platform.listings.set('acct-dead', { refused: 'token_expired' });
    platform.listings.set('acct-denied', { refused: 'permission' });
    const done = await sweep(platform);
    expect(done.expired).toBe(1);
    const status = await admin(async (c) => (await c.query<{ id: string; status: string }>('SELECT id, status FROM crove_kernel.channel_connection WHERE org_id = $1', [o.orgId])).rows);
    expect(new Map(status.map((r) => [r.id, r.status]))).toEqual(new Map([[dead, 'expired'], [denied, 'active'], [silent, 'active']]));
    const events = await admin(async (c) => (await c.query("SELECT payload->>'connection_id' AS id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.channel.expired'", [o.orgId])).rows);
    expect(events).toEqual([{ id: dead }]);
    const runs = await admin(async (c) => (await c.query<{ channel_connection_id: string; error: string | null }>('SELECT channel_connection_id, error FROM crove_social.external_import WHERE org_id = $1', [o.orgId])).rows);
    expect(new Map(runs.map((r) => [r.channel_connection_id, r.error]))).toEqual(new Map([[dead, 'token_expired'], [denied, 'permission'], [silent, 'no_answer']]));
    // An expired channel is not listed again until it is reconnected.
    await admin((c) => c.query("UPDATE crove_social.external_import SET ran_at = now() - interval '7 hours' WHERE org_id = $1", [o.orgId]));
    platform.listed = [];
    await sweep(platform);
    expect(platform.listed.map((x) => x.externalAccountId).sort()).toEqual(['acct-denied', 'acct-silent']);
  });

  it('keeps the posts to their org, lets only the system write them, and the scans to the worker', async () => {
    const o = await org();
    const stranger = await org();
    const mine = await connect(o, 'acct-mine');
    await outside(o, mine, 'mine-1', 1, { reach: 40 });
    const theirs = await connect(stranger, 'acct-theirs');
    await outside(stranger, theirs, 'theirs-1', 1, { reach: 4000 });
    expect((await listed(o)).map((r) => r.connectionId)).toEqual([mine]);
    expect((await listed(stranger)).map((r) => r.connectionId)).toEqual([theirs]);
    expect(await totals(o, { includeExternal: true })).toMatchObject({ posts: 1, metrics: { reach: 40 } });
    // Members never write them, whatever their role.
    await expect(api.execute('social.external_post.import', { connectionId: mine, posts: [] }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    const row = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_social.external_post WHERE external_post_id = 'mine-1'")).rows[0]?.id as string);
    await expect(api.execute('social.external_post.record', { externalId: row, metrics: { reach: 1 } }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    // The system writes only within the org it runs in.
    await expect(worker.execute('social.external_post.import', { connectionId: mine, posts: [] }, { actor: system, orgId: stranger.orgId })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(worker.execute('social.external_post.record', { externalId: row, metrics: { reach: 1 } }, { actor: system, orgId: stranger.orgId })).rejects.toMatchObject({ code: 'EXTERNAL_POST_NOT_FOUND' });
    await expect(worker.query('social.external_post.target', { externalId: row }, { actor: system, orgId: stranger.orgId })).rejects.toMatchObject({ code: 'EXTERNAL_POST_NOT_FOUND' });
    // Only an https permalink and a known id shape go in.
    await expect(
      worker.execute('social.external_post.import', { connectionId: mine, posts: [{ externalId: 'p-1', excerpt: '', permalink: 'javascript:alert(1)', publishedAt: new Date().toISOString() }] }, { actor: system, orgId: o.orgId }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(admin((c) => c.query("UPDATE crove_social.external_post SET permalink = 'http://x.example/' WHERE external_post_id = 'mine-1'"))).rejects.toMatchObject({ code: '23514' });
    // No control, zero-width or direction marks in an excerpt (U+061C, U+202E), whoever sends it.
    for (const mark of ['\u061C', '\u202E', '\u0007']) {
      await expect(
        worker.execute('social.external_post.import', { connectionId: mine, posts: [{ externalId: 'p-2', excerpt: `a${mark}b`, permalink: null, publishedAt: new Date().toISOString() }] }, { actor: system, orgId: o.orgId }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // Tenant roles change only the text, link and counts, and delete nothing.
    const grants = await admin(async (c) => ({
      table: (await c.query<{ privilege_type: string }>("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'external_post' ORDER BY 1")).rows.map((r) => r.privilege_type),
      update: (await c.query<{ column_name: string }>("SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'external_post' AND privilege_type = 'UPDATE' ORDER BY 1")).rows.map((r) => r.column_name),
      importTable: (await c.query<{ privilege_type: string }>("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'external_import' ORDER BY 1")).rows.map((r) => r.privilege_type),
    }));
    expect(grants).toEqual({ table: ['INSERT', 'SELECT'], update: ['captured_at', 'checked_at', 'excerpt', 'gone', 'metrics', 'permalink', 'updated_at'], importTable: ['INSERT', 'SELECT'] });
    // The scans are the worker's alone.
    await expect(appPool.query("SELECT * FROM crove_social.external_import_due(10, ARRAY['sandbox'], 3600)")).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query("SELECT * FROM crove_social.external_metrics_due(10, ARRAY['sandbox'], 3600)")).rejects.toMatchObject({ code: '42501' });
    // The channel's removal takes its outside posts with it.
    await admin((c) => c.query('DELETE FROM crove_kernel.channel_connection WHERE id = $1', [theirs]));
    expect(await listed(stranger)).toEqual([]);
  });

  it("takes a listed post for Crove's by its page address (a Facebook video or Reel under another post id), and only a published variant as Crove's", async () => {
    const o = await org();
    const conn = await connect(o, 'acct-video');
    // A video and a Reel Crove published: kept as <page>_<video> with the address Crove recorded.
    await published(o, conn, '111_777', 2, { reach: 300 }, 'https://www.facebook.com/111/videos/777');
    await published(o, conn, '111_888', 2, { reach: 200 }, 'https://www.facebook.com/reel/888');
    // A variant that failed after an id was noted: not a post Crove counts, so not Crove's here either.
    const failed = await published(o, conn, 'out-failed', 2, { reach: 1 });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'failed' WHERE post_id = $1", [failed]));
    const platform = new FakePlatform();
    platform.listings.set('acct-video', {
      posts: [
        // Meta lists Crove's video and Reel under other post ids, on the Page's name and the mobile host.
        { externalId: '111_9001', text: 'Video của Crove', permalink: 'https://www.facebook.com/SomePage/videos/777/', publishedAt: ago(2) },
        { externalId: '111_9002', text: 'Reel của Crove', permalink: 'https://m.facebook.com/reel/888', publishedAt: ago(2) },
        { externalId: 'out-failed', text: 'Đăng lại tay', permalink: null, publishedAt: ago(2) },
        { externalId: '111_9003', text: 'Video đăng thẳng', permalink: 'https://www.facebook.com/SomePage/videos/555/', publishedAt: ago(1) },
      ],
    });
    await sweep(platform);
    const kept = await admin(async (c) => (await c.query<{ external_post_id: string }>('SELECT external_post_id FROM crove_social.external_post WHERE org_id = $1 ORDER BY 1', [o.orgId])).rows.map((r) => r.external_post_id));
    expect(kept).toEqual(['111_9003', 'out-failed']);

    // One brought in before Crove recorded its own address is left out of every read, and never measured.
    await admin((c) =>
      c.query("INSERT INTO crove_social.external_post (org_id, channel_connection_id, external_post_id, permalink, published_at, metrics) VALUES ($1, $2, '111_9100', 'https://www.facebook.com/SomePage/videos/777/', now() - interval '2 days', '{\"reach\": 999}')", [o.orgId, conn]),
    );
    expect((await listed(o)).map((r) => r.excerpt).sort()).toEqual(['Video đăng thẳng', 'Đăng lại tay']);
    expect(await totals(o, { days: 30, includeExternal: true })).toMatchObject({ posts: 4, metrics: { reach: 500 } });
    const due = await workerPool.query<{ external_id: string }>("SELECT d.external_id FROM crove_social.external_metrics_due(1000, ARRAY['sandbox'], 3600) d WHERE d.org_id = $1", [o.orgId]);
    const hidden = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_social.external_post WHERE external_post_id = '111_9100'")).rows[0]?.id);
    expect(due.rows.map((r) => r.external_id)).not.toContain(hidden);
    const period = { periodStart: new Date(Date.now() - 30 * DAY).toISOString(), periodEnd: new Date(Date.now() + 60_000).toISOString() };
    const { token } = await api.execute<{ token: string }>('social.report_link.create', { ...period, includeExternal: true }, { actor: asUser(o.owner), orgId: o.orgId });
    expect((await reportView(api, { token })) as ReportPage).toMatchObject({ posts: 4, totals: { reach: 500 } });

    // How addresses compare.
    const key = async (url: string | null) => admin(async (c) => (await c.query<{ k: string | null }>('SELECT crove_social.post_link_key($1) AS k', [url])).rows[0]?.k);
    expect(await key('https://www.facebook.com/111/videos/777')).toBe('facebook.com/video/777');
    expect(await key('https://web.facebook.com/SomePage/videos/a-title/777/')).toBe('facebook.com/video/777');
    expect(await key('https://www.facebook.com/reel/888?s=1')).toBe('facebook.com/video/888');
    expect(await key('https://WWW.Instagram.com/p/AbC123/')).toBe('instagram.com/p/AbC123');
    expect(await key('https://www.facebook.com/photo.php?fbid=42#x')).toBe('facebook.com/photo.php?fbid=42');
    expect(await key('javascript:alert(1)')).toBeNull();
    expect(await key(null)).toBeNull();
  });

  it('counts the outside posts in a client report only for a link made with the option, of its own org and channels', async () => {
    const o = await org();
    const stranger = await org();
    const a = await connect(o, 'acct-report-a');
    const b = await connect(o, 'acct-report-b');
    await published(o, a, 'crove-a', 2, { reach: 100, reactions: 20 });
    await outside(o, a, 'out-a', 1, { reach: 70, reactions: 9 });
    await outside(o, b, 'out-b', 3, { reach: 30 });
    // In the period before the report's.
    await outside(o, a, 'out-old', 35, { reach: 5 });
    // Another org's outside post on the same day never shows.
    const theirs = await connect(stranger, 'acct-report-theirs');
    await outside(stranger, theirs, 'out-theirs', 1, { reach: 9000 });
    const period = { periodStart: new Date(Date.now() - 30 * DAY).toISOString(), periodEnd: new Date(Date.now() + 60_000).toISOString() };
    const link = async (input: Record<string, unknown>) => (await api.execute<{ token: string }>('social.report_link.create', { ...period, ...input }, { actor: asUser(o.owner), orgId: o.orgId })).token;

    const plain = (await reportView(api, { token: await link({}) })) as ReportPage;
    expect(plain).toMatchObject({ posts: 1, totals: { reach: 100, reactions: 20 }, includesExternal: false, previous: { posts: 0 } });
    expect(plain.top.map((t) => t.external)).toEqual([false]);

    const all = (await reportView(api, { token: await link({ includeExternal: true }) })) as ReportPage;
    expect(all).toMatchObject({ posts: 3, totals: { reach: 200, reactions: 29 }, includesExternal: true, previous: { posts: 1, totals: { reach: 5 } } });
    expect(all.channels.map((c) => [c.channel, c.posts])).toEqual([
      ['acct-report-a', 2],
      ['acct-report-b', 1],
    ]);
    expect(all.top.map((t) => [t.excerpt, t.external, t.url])).toEqual([
      ['Bài của Crove crove-a', false, null],
      ['Đăng thẳng out-a', true, 'https://www.facebook.com/out-a'],
      ['Đăng thẳng out-b', true, 'https://www.facebook.com/out-b'],
    ]);

    const onlyB = (await reportView(api, { token: await link({ includeExternal: true, connectionIds: [b] }) })) as ReportPage;
    expect(onlyB).toMatchObject({ posts: 1, totals: { reach: 30 } });

    // A post that is also a variant's on the same channel shows once, as Crove's.
    await published(o, b, 'out-b', 3, { reach: 31 });
    const again = (await reportView(api, { token: await link({ includeExternal: true, connectionIds: [b] }) })) as ReportPage;
    expect(again).toMatchObject({ posts: 1, totals: { reach: 31 } });
    expect(again.top.map((t) => t.external)).toEqual([false]);

    // The link list says which links count them.
    const links = await api.query<{ includeExternal: boolean }[]>('social.report_link.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(links.map((l) => l.includeExternal).sort()).toEqual([false, true, true, true]);
  });
});
