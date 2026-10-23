// The Metrics tab's totals against the window just before (#947) on PostgreSQL 17: the same sums for the window of
// the same length that ends where the chosen one starts, in total and per channel, with the label filter, and never
// another org's posts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Totals {
  posts: number;
  metrics: Record<string, number>;
  clicks: number | null;
}
interface WindowTotals extends Totals {
  channels: (Totals & { connectionId: string; provider: string })[];
}

suite('social metrics against the window before (#947)', () => {
  const dbName = `crove_test_social_compare_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function org() {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@social.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Cửa hàng ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connection(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }

  const exec = <O>(o: { orgId: string; owner: string }, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(o.owner), orgId: o.orgId });

  // A post published on a channel some days ago, with its latest counts (and an older, smaller capture), and a short
  // link with clicks by day when given (days ago: clicks).
  async function published(o: { orgId: string; owner: string }, conn: string, daysAgo: number, metrics: Record<string, unknown>, clicks?: Record<number, number>) {
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: `Bài ${daysAgo} ngày trước`, channels: [{ connectionId: conn }] });
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = now() - make_interval(days => $2) WHERE post_id = $1 RETURNING id", [postId, daysAgo]);
      const id = rows[0]?.id;
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics, captured_at) VALUES ($1, $2, 'old', '{\"reach\": 1}', now() - interval '2 days')", [o.orgId, id]);
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'new', $3)", [o.orgId, id, JSON.stringify(metrics)]);
      if (clicks !== undefined) {
        const link = await c.query<{ id: string }>(
          "INSERT INTO crove_social.short_link (org_id, code, variant_id, revision, post_id, target_url) VALUES ($1, $2, $3, 1, $4, 'https://shop.example/') RETURNING id",
          [o.orgId, randomUUID().replace(/-/g, '').slice(0, 12), id, postId],
        );
        for (const [ago, n] of Object.entries(clicks)) {
          await c.query('INSERT INTO crove_social.short_link_click (org_id, short_link_id, day, clicks) VALUES ($1, $2, current_date - $3::int, $4)', [o.orgId, link.rows[0]?.id, Number(ago), n]);
        }
      }
    });
    return postId;
  }

  const totals = (o: { orgId: string; owner: string }, input: { days?: number; labelId?: string }) =>
    rt.query<WindowTotals & { previous: WindowTotals }>('social.metrics.totals', input, { actor: asUser(o.owner), orgId: o.orgId });

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

  it('sums the window and the window of the same length just before, in total and per channel', async () => {
    const o = await org();
    const stranger = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang Facebook');
    const zalo = await connection(o.orgId, o.owner, 'Zalo OA');
    const quiet = await connection(o.orgId, o.owner, 'Kênh cũ');
    // The last 30 days.
    await published(o, fb, 2, { reach: 600, reactions: 30, secret_internal: 'x' }, { 1: 5 });
    await published(o, fb, 20, { reach: 400, reactions: 10 });
    await published(o, zalo, 10, { reach: 100, views: 50 });
    // The 30 days before them.
    // Its clicks of 3 days ago are in the last 30 days: they count in neither window, not in the one before.
    await published(o, fb, 35, { reach: 800, reactions: 50 }, { 34: 7, 3: 100 });
    await published(o, fb, 59, { reach: 200 });
    // A channel that posted only in the window before.
    await published(o, quiet, 45, { reach: 30 });
    // Older than both windows.
    await published(o, fb, 61, { reach: 9999, reactions: 999 });
    // Another org's posts in both windows are never counted.
    const theirs = await connection(stranger.orgId, stranger.owner, 'Của họ');
    await published(stranger, theirs, 3, { reach: 7000, reactions: 700 }, { 1: 70 });
    await published(stranger, theirs, 40, { reach: 8000, reactions: 800 }, { 38: 80 });

    const t = await totals(o, { days: 30 });
    expect(t).toMatchObject({ posts: 3, metrics: { reach: 1100, reactions: 40, views: 50 }, clicks: 5 });
    // Every channel that posted in either window, in both lists, so the channels add up to both totals.
    expect(t.channels).toEqual([
      { connectionId: fb, provider: 'sandbox', posts: 2, metrics: { reach: 1000, reactions: 40 }, clicks: 5 },
      { connectionId: zalo, provider: 'sandbox', posts: 1, metrics: { reach: 100, views: 50 }, clicks: null },
      { connectionId: quiet, provider: 'sandbox', posts: 0, metrics: {}, clicks: null },
    ]);
    expect(t.previous).toEqual({
      posts: 3,
      metrics: { reach: 1030, reactions: 50 },
      clicks: 7,
      channels: [
        { connectionId: fb, provider: 'sandbox', posts: 2, metrics: { reach: 1000, reactions: 50 }, clicks: 7 },
        { connectionId: zalo, provider: 'sandbox', posts: 0, metrics: {}, clicks: null },
        { connectionId: quiet, provider: 'sandbox', posts: 1, metrics: { reach: 30 }, clicks: null },
      ],
    });
    // The default window is 30 days, the same answer.
    expect(await totals(o, {})).toEqual(t);

    // A 7-day window: the post of 2 days ago, against the week before it (the Zalo post of 10 days ago).
    expect(await totals(o, { days: 7 })).toMatchObject({
      posts: 1,
      metrics: { reach: 600, reactions: 30 },
      channels: [{ connectionId: fb, posts: 1 }, { connectionId: zalo, posts: 0 }],
      previous: { posts: 1, metrics: { reach: 100, views: 50 }, clicks: null, channels: [{ connectionId: fb, posts: 0 }, { connectionId: zalo, posts: 1 }] },
    });
    // A 1-day window with nothing in the day before it: no previous counts at all.
    expect((await totals(o, { days: 1 })).previous).toEqual({ posts: 0, metrics: {}, clicks: null, channels: [] });

    // The other org sees only its own, in both windows.
    expect(await totals(stranger, { days: 30 })).toMatchObject({ posts: 1, metrics: { reach: 7000, reactions: 700 }, clicks: 70, previous: { posts: 1, metrics: { reach: 8000, reactions: 800 }, clicks: 80 } });
  });

  it('keeps to the label in both windows', async () => {
    const o = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang');
    const { labelId } = await exec<{ labelId: string }>(o, 'social.label.create', { name: 'Khuyến mãi' });
    const now = await published(o, fb, 5, { reach: 300 });
    const before = await published(o, fb, 12, { reach: 100 });
    await published(o, fb, 13, { reach: 5000 });
    await exec(o, 'social.post.set_labels', { postId: now, labelIds: [labelId] });
    await exec(o, 'social.post.set_labels', { postId: before, labelIds: [labelId] });
    expect(await totals(o, { days: 7, labelId })).toMatchObject({ posts: 1, metrics: { reach: 300 }, previous: { posts: 1, metrics: { reach: 100 } } });
    expect(await totals(o, { days: 7 })).toMatchObject({ posts: 1, metrics: { reach: 300 }, previous: { posts: 2, metrics: { reach: 5100 } } });
  });

  // #1147: a Reel's total watch time adds up over posts; its average watch time does not, so the totals leave it out.
  it('sums the Reels watch time but never their averages', async () => {
    const o = await org();
    const ig = await connection(o.orgId, o.owner, 'Instagram');
    await published(o, ig, 1, { views: 100, avgWatchTimeMs: 12300, totalWatchTimeMs: 1_230_000 });
    await published(o, ig, 2, { views: 50, avgWatchTimeMs: 8000, totalWatchTimeMs: 400_000 });
    const t = await totals(o, { days: 7 });
    expect(t.metrics).toEqual({ views: 150, totalWatchTimeMs: 1_630_000 });
    expect(t.channels[0]?.metrics).toEqual({ views: 150, totalWatchTimeMs: 1_630_000 });
  });
});
