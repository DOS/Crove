// Client report links of Crove Social on PostgreSQL 17 (#643): who makes and revokes them, the report a token opens
// (the period, the chosen channels, totals, per channel, the best posts), and that nothing else of the org is reachable
// through it. The public side runs as the API login role with no org context, as the HTTP edge does. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ReportLinkView } from '@crove/mod-social';
import { reportView, type ReportPage } from '../src/report-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social report links on PostgreSQL (#643)', () => {
  const dbName = `crove_test_social_report_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Cửa hàng ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, member, 'member']));
    return { orgId, owner, member };
  }

  async function connection(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }

  const exec = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });

  // A post published on a channel at a time, with its latest counts (and an older, smaller capture).
  async function published(o: { orgId: string; owner: string }, conn: string, body: string, at: string, metrics: Record<string, unknown>) {
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body, channels: [{ connectionId: conn }] });
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = $2, external_url = $3 WHERE post_id = $1 RETURNING id", [postId, at, `https://social.example/p/${postId.slice(0, 8)}`]);
      const id = rows[0]?.id;
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics, captured_at) VALUES ($1, $2, 'old', '{\"reach\": 1}', now() - interval '2 days')", [o.orgId, id]);
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'new', $3)", [o.orgId, id, JSON.stringify(metrics)]);
    });
    return postId;
  }

  const view = (token: string) => reportView(rt, { token });

  // A short link of a post's variant (as the worker writes it when the post goes out), with clicks by day (UTC).
  async function shortLink(o: { orgId: string }, postId: string, revision: number, clicks: Record<string, number>) {
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO crove_social.short_link (org_id, code, variant_id, revision, post_id, target_url) SELECT org_id, $2, id, $3, post_id, 'https://shop.example/' FROM crove_social.post_variant WHERE post_id = $1 RETURNING id",
        [postId, randomUUID().replace(/-/g, '').slice(0, 12), revision],
      );
      for (const [day, n] of Object.entries(clicks)) await c.query('INSERT INTO crove_social.short_link_click (org_id, short_link_id, day, clicks) VALUES ($1, $2, $3, $4)', [o.orgId, rows[0]?.id, day, n]);
    });
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

  it('opens a report of the period on the chosen channels: totals, per channel and the best posts', async () => {
    const o = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang Facebook');
    const zalo = await connection(o.orgId, o.owner, 'Zalo OA');
    const other = await connection(o.orgId, o.owner, 'Kênh khác');
    await published(o, fb, 'Khai trương   cửa hàng', '2026-10-05T03:00:00Z', { reach: 1000, reactions: 50, comments: 10, shares: 5, secret_internal: 99 });
    await published(o, fb, 'Giảm giá cuối tuần', '2026-10-12T03:00:00Z', { reach: 400, reactions: 5 });
    await published(o, zalo, 'Tin nhắn Zalo', '2026-10-20T03:00:00Z', { reach: 300, reactions: 80, views: 900 });
    // Outside the period, and on a channel the link does not name.
    await published(o, fb, 'Bài tháng trước', '2026-09-28T03:00:00Z', { reach: 5000 });
    await published(o, other, 'Kênh khác', '2026-10-10T03:00:00Z', { reach: 7000 });
    // A draft in the period is not in a report.
    await exec(o, o.owner, 'social.post.create', { body: 'Bản nháp', channels: [{ connectionId: fb }] });

    const { token, linkId } = await exec<{ token: string; linkId: string }>(o, o.owner, 'social.report_link.create', {
      periodStart: '2026-10-01T00:00:00+07:00',
      periodEnd: '2026-11-01T00:00:00+07:00',
      connectionIds: [fb, zalo],
      title: 'Báo cáo tháng 10',
    });
    const page = (await view(token)) as ReportPage;
    expect(page).toMatchObject({ title: 'Báo cáo tháng 10', posts: 3, totals: { reach: 1700, reactions: 135, comments: 10, shares: 5, views: 900 } });
    expect(page.org).toMatch(/^Cửa hàng /);
    expect(page.totals).not.toHaveProperty('secret_internal');
    expect(page.channels).toEqual([
      // The post of 28 September is in the 31 days before the period (#947).
      { channel: 'Trang Facebook', provider: 'sandbox', posts: 2, totals: { reach: 1400, reactions: 55, comments: 10, shares: 5 }, previous: { posts: 1, totals: { reach: 5000 } } },
      { channel: 'Zalo OA', provider: 'sandbox', posts: 1, totals: { reach: 300, reactions: 80, views: 900 }, previous: { posts: 0, totals: {} } },
    ]);
    // Best first by reactions, comments, shares, saves and clicks.
    expect(page.top.map((p) => p.excerpt)).toEqual(['Tin nhắn Zalo', 'Khai trương cửa hàng', 'Giảm giá cuối tuần']);
    expect(page.top[1]).toMatchObject({ channel: 'Trang Facebook', metrics: { reach: 1000, reactions: 50, comments: 10, shares: 5 } });
    expect(page.top[1]?.url).toMatch(/^https:\/\/social\.example\/p\//);
    // Nothing that names people or rows of the org.
    expect(JSON.stringify(page)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(JSON.stringify(page)).not.toContain('@social.test');

    // Revoked: the token opens nothing, the same answer as a wrong or malformed one.
    await exec(o, o.owner, 'social.report_link.revoke', { linkId });
    expect(await view(token)).toBeNull();
    expect(await view('x'.repeat(43))).toBeNull();
    expect(await view('short')).toBeNull();
    expect(await reportView(rt, { token, extra: 1 })).toBeNull();
  });

  it('adds the clicks on short links of the period to the totals, each channel and the best posts (#724)', async () => {
    const o = await org();
    const stranger = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang Facebook');
    const zalo = await connection(o.orgId, o.owner, 'Zalo OA');
    const sale = await published(o, fb, 'Giảm giá', '2026-10-05T03:00:00Z', { reach: 100, reactions: 1 });
    const zaloPost = await published(o, zalo, 'Tin Zalo', '2026-10-06T03:00:00Z', { reach: 50, reactions: 9 });
    // Two revisions went out with a link. The period is 2026-09-30T17:00Z to 2026-10-31T17:00Z: a UTC day counts when its
    // midday is in it, so 31 October does and 30 September and 1 November do not.
    await shortLink(o, sale, 1, { '2026-09-30': 100, '2026-10-03': 7, '2026-10-31': 3, '2026-11-01': 50 });
    await shortLink(o, sale, 2, { '2026-10-10': 2 });
    // A link whose only clicks fall after the period counts 0, not nothing.
    await shortLink(o, zaloPost, 1, { '2026-11-05': 40 });
    // Another org's clicks stay its own.
    const theirConn = await connection(stranger.orgId, stranger.owner, 'Của họ');
    await shortLink(stranger, await published(stranger, theirConn, 'Của họ', '2026-10-05T03:00:00Z', { reach: 1 }), 1, { '2026-10-05': 900 });

    const { token } = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00' });
    const page = (await view(token)) as ReportPage;
    expect(page.totals).toEqual({ reach: 150, reactions: 10, linkClicks: 12 });
    expect(page.channels).toEqual([
      { channel: 'Trang Facebook', provider: 'sandbox', posts: 1, totals: { reach: 100, reactions: 1, linkClicks: 12 }, previous: { posts: 0, totals: {} } },
      { channel: 'Zalo OA', provider: 'sandbox', posts: 1, totals: { reach: 50, reactions: 9, linkClicks: 0 }, previous: { posts: 0, totals: {} } },
    ]);
    // Link clicks do not make a post do better: the Zalo post still leads on its reactions.
    expect(page.top.map((p) => [p.excerpt, p.metrics])).toEqual([
      ['Tin Zalo', { reach: 50, reactions: 9, linkClicks: 0 }],
      ['Giảm giá', { reach: 100, reactions: 1, linkClicks: 12 }],
    ]);
  });

  it('compares the report with the period of the same length just before, on the same channels (#947)', async () => {
    const o = await org();
    const stranger = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang Facebook');
    const zalo = await connection(o.orgId, o.owner, 'Zalo OA');
    const other = await connection(o.orgId, o.owner, 'Kênh khác');
    // The period: 2026-09-30T17:00Z to 2026-10-31T17:00Z (31 days); the one before: 2026-08-30T17:00Z to 2026-09-30T17:00Z.
    await published(o, fb, 'Bài mới', '2026-10-10T03:00:00Z', { reach: 1200, reactions: 30 });
    await published(o, zalo, 'Zalo mới', '2026-10-15T03:00:00Z', { reach: 100 });
    const old = await published(o, fb, 'Bài cũ', '2026-09-10T03:00:00Z', { reach: 1000, reactions: 40 });
    await published(o, fb, 'Bài cũ hai', '2026-09-30T16:00:00Z', { reach: 200 });
    // A channel of the link that posted only in the period before.
    const quiet = await connection(o.orgId, o.owner, 'Kênh tháng trước');
    await published(o, quiet, 'Chỉ tháng trước', '2026-09-05T03:00:00Z', { reach: 50 });
    // Before the period before, and on a channel the link does not name.
    await published(o, fb, 'Bài rất cũ', '2026-08-30T16:00:00Z', { reach: 9999 });
    await published(o, other, 'Kênh khác', '2026-09-12T03:00:00Z', { reach: 3000 });
    // Clicks count in the period of their post, on its days only: 15 September yes, 5 October (the next period) no.
    await shortLink(o, old, 1, { '2026-09-15': 4, '2026-10-05': 6 });
    // Another org's posts of the period before stay its own.
    const theirs = await connection(stranger.orgId, stranger.owner, 'Của họ');
    await published(stranger, theirs, 'Của họ', '2026-09-12T03:00:00Z', { reach: 7777, reactions: 70 });

    const { token } = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', {
      periodStart: '2026-10-01T00:00:00+07:00',
      periodEnd: '2026-11-01T00:00:00+07:00',
      connectionIds: [fb, zalo, quiet],
    });
    const page = (await view(token)) as ReportPage;
    expect(page).toMatchObject({ posts: 2, totals: { reach: 1300, reactions: 30 } });
    expect(page.previous).toMatchObject({ posts: 3, totals: { reach: 1250, reactions: 40, linkClicks: 4 } });
    expect(Object.keys(page.previous.totals).sort()).toEqual(['linkClicks', 'reach', 'reactions']);
    expect(Date.parse(page.previous.periodStart)).toBe(Date.parse('2026-08-30T17:00:00Z'));
    expect(Date.parse(page.previous.periodEnd)).toBe(Date.parse(page.periodStart));
    expect(page.channels).toEqual([
      { channel: 'Trang Facebook', provider: 'sandbox', posts: 1, totals: { reach: 1200, reactions: 30 }, previous: { posts: 2, totals: { reach: 1200, reactions: 40, linkClicks: 4 } } },
      { channel: 'Zalo OA', provider: 'sandbox', posts: 1, totals: { reach: 100 }, previous: { posts: 0, totals: {} } },
      // Every channel that posted in either period, so the channels add up to both totals.
      { channel: 'Kênh tháng trước', provider: 'sandbox', posts: 0, totals: {}, previous: { posts: 1, totals: { reach: 50 } } },
    ]);
    // The best posts stay those of the period.
    expect(page.top.map((p) => p.excerpt)).toEqual(['Bài mới', 'Zalo mới']);
    expect(JSON.stringify(page)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    // A period with nothing before it compares with nothing.
    const { token: empty } = await exec<{ token: string }>(stranger, stranger.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-08T00:00:00Z' });
    expect(await view(empty)).toMatchObject({ posts: 0, totals: {}, channels: [], previous: { posts: 0, totals: {} } });

    // The period before has the period's exact length whatever the session's time zone: 30 days after the end of US
    // daylight saving (1 November 2026) still start 30 times 24 hours earlier.
    const { token: dst, linkId } = await exec<{ token: string; linkId: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-31T00:00:00Z' });
    await admin((c) => c.query("UPDATE crove_social.report_link SET period_start = '2026-11-10T00:00:00Z', period_end = '2026-12-10T00:00:00Z' WHERE id = $1", [linkId]));
    const starts = await admin(async (c) => {
      const out: number[] = [];
      for (const zone of ['UTC', 'America/New_York', 'Asia/Ho_Chi_Minh']) {
        await c.query(`SET TimeZone = '${zone}'`);
        const { rows } = await c.query<{ start: string }>("SELECT crove_social.report_link_view($1) #>> '{previous,periodStart}' AS start", [dst]);
        out.push(Date.parse(rows[0]?.start ?? ''));
      }
      return out;
    });
    expect(starts).toEqual([Date.parse('2026-10-11T00:00:00Z'), Date.parse('2026-10-11T00:00:00Z'), Date.parse('2026-10-11T00:00:00Z')]);
  });

  // #1087: a Story's own counts (STORY_METRIC_NAMES of packages/channel) reach the report like the post counts, and
  // are not part of a post's score.
  it("counts a Story's replies, taps, exits, swipes, follows and profile visits in the report (#1087)", async () => {
    const o = await org();
    const ig = await connection(o.orgId, o.owner, 'Instagram shop');
    const story = await published(o, ig, 'Tin 24 giờ', '2026-10-05T03:00:00Z', {
      reach: 300, views: 420, shares: 2, replies: 7, tapsForward: 120, tapsBack: 15, exits: 30, nextStory: 12, follows: 3, profileVisits: 9,
    });
    await admin((c) => c.query(`UPDATE crove_social.post_variant SET settings = settings || '{"postType":"story"}'::jsonb WHERE post_id = $1`, [story]));
    await published(o, ig, 'Bài thường', '2026-10-06T03:00:00Z', { reach: 100, reactions: 5 });
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00' });
    const page = (await view(token)) as ReportPage;
    const storyCounts = { replies: 7, tapsForward: 120, tapsBack: 15, exits: 30, nextStory: 12, follows: 3, profileVisits: 9 };
    expect(page.totals).toEqual({ reach: 400, views: 420, shares: 2, reactions: 5, ...storyCounts });
    expect(page.channels).toEqual([{ channel: 'Instagram shop', provider: 'sandbox', posts: 2, totals: { reach: 400, views: 420, shares: 2, reactions: 5, ...storyCounts }, previous: { posts: 0, totals: {} } }]);
    // The feed post's 5 reactions beat the Story's 2 shares: replies, taps and the rest do not make a post do better.
    expect(page.top.map((p) => [p.excerpt, p.metrics])).toEqual([
      ['Bài thường', { reach: 100, reactions: 5 }],
      ['Tin 24 giờ', { reach: 300, views: 420, shares: 2, ...storyCounts }],
    ]);
  });

  // #1087 re-created report_link_view with the Story names added and nothing else: for a report whose posts carry no
  // Story counts, its output is byte for byte what the previous definition (migration 20261028200000) gives.
  it('gives exactly the previous output for a report without Story counts (#1087)', async () => {
    const o = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang Facebook');
    const zalo = await connection(o.orgId, o.owner, 'Zalo OA');
    const all = { impressions: 900, reach: 700, reactions: 40, comments: 8, shares: 6, saves: 4, clicks: 3, views: 1200 };
    const first = await published(o, fb, 'Khai trương', '2026-10-05T03:00:00Z', { ...all, secret_internal: 99, likes_raw: 'x' });
    await published(o, zalo, 'Tin Zalo', '2026-10-06T03:00:00Z', { reach: 50, views: 80 });
    await published(o, fb, 'Tháng trước', '2026-09-20T03:00:00Z', { reach: 30, reactions: 2 });
    // A Story with only the names every post has still reports the same.
    const story = await published(o, fb, 'Tin 24 giờ', '2026-10-07T03:00:00Z', { reach: 60, views: 90, shares: 1 });
    await admin((c) => c.query(`UPDATE crove_social.post_variant SET settings = settings || '{"postType":"story"}'::jsonb WHERE post_id = $1`, [story]));
    await shortLink(o, first, 1, { '2026-10-08': 5 });
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', {
      periodStart: '2026-10-01T00:00:00+07:00',
      periodEnd: '2026-11-01T00:00:00+07:00',
      title: 'Tháng 10',
    });
    const previous = readFileSync(join(MIGRATIONS, '20261028200000_crove_social_report_external.sql'), 'utf8');
    const [now, before] = await admin(async (c) => {
      const read = async () => (await c.query<{ page: string }>('SELECT crove_social.report_link_view($1)::text AS page', [token])).rows[0]?.page;
      // The audience list (#1146) came after: left out of today's answer, which has it empty here.
      const current = (await c.query<{ page: string; audience: string }>("SELECT (crove_social.report_link_view($1) - 'audience')::text AS page, crove_social.report_link_view($1) -> 'audience' AS audience", [token])).rows[0];
      expect(current?.audience).toEqual([]);
      await c.query('BEGIN');
      try {
        await c.query(previous);
        return [current?.page, await read()];
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(now).toBeTruthy();
    expect(now).toBe(before);
    expect(JSON.parse(now as string)).toMatchObject({ posts: 3, totals: { reach: 810, linkClicks: 5 } });
  });

  // Who follows each channel (#1146): the latest audience of the link's channels taken on a UTC day whose midday is in
  // the period; an ask that got nothing, a day outside the period and a channel the link does not name are left out.
  const AUDIENCE = {
    age: [{ key: '18-24', count: 410 }, { key: '25-34', count: 620 }],
    gender: [{ key: 'F', count: 780 }, { key: 'M', count: 400 }],
    cities: [{ key: 'Hanoi, Hanoi', count: 300 }],
    countries: [{ key: 'VN', count: 1100 }],
  };
  async function snapshot(orgId: string, conn: string, on: string, audience: unknown) {
    await admin((c) => c.query('INSERT INTO crove_social.account_snapshot (org_id, channel_connection_id, captured_on, followers, audience) VALUES ($1, $2, $3, 1000, $4::jsonb)', [orgId, conn, on, audience === null ? null : JSON.stringify(audience)]));
  }

  it('shows the latest audience in the period of each of the link\'s channels (#1146)', async () => {
    const o = await org();
    const stranger = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang Facebook');
    const zalo = await connection(o.orgId, o.owner, 'Zalo OA');
    const ig = await connection(o.orgId, o.owner, 'Instagram Hoa Mai');
    const other = await connection(o.orgId, o.owner, 'Kênh khác');
    const earlier = { ...AUDIENCE, countries: [{ key: 'US', count: 5 }] };
    const later = { ...AUDIENCE, countries: [{ key: 'JP', count: 9 }] };
    // The period is 2026-09-30T17:00Z to 2026-10-31T17:00Z: 30 September's midday is before it, 31 October's in it.
    await snapshot(o.orgId, fb, '2026-09-30', later);
    await snapshot(o.orgId, fb, '2026-10-08', earlier);
    await snapshot(o.orgId, fb, '2026-10-22', AUDIENCE);
    await snapshot(o.orgId, fb, '2026-10-29', null);
    await snapshot(o.orgId, fb, '2026-11-01', later);
    await snapshot(o.orgId, zalo, '2026-10-15', {});
    await snapshot(o.orgId, ig, '2026-10-31', later);
    await snapshot(o.orgId, other, '2026-10-10', AUDIENCE);
    const theirs = await connection(stranger.orgId, stranger.owner, 'Của họ');
    await snapshot(stranger.orgId, theirs, '2026-10-10', AUDIENCE);
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00', connectionIds: [fb, zalo, ig] });
    const page = (await view(token)) as ReportPage;
    expect(page.posts).toBe(0);
    expect(page.audience).toEqual([
      { channel: 'Instagram Hoa Mai', provider: 'sandbox', day: '2026-10-31', audience: later },
      { channel: 'Trang Facebook', provider: 'sandbox', day: '2026-10-22', audience: AUDIENCE },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    // A link on every channel shows each one that has an audience.
    const all = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00' });
    expect(((await view(all.token)) as ReportPage).audience.map((a) => a.channel)).toEqual(['Instagram Hoa Mai', 'Kênh khác', 'Trang Facebook']);
  });

  it('gives exactly the previous output, with an empty audience, for a report without one (#1146)', async () => {
    const o = await org();
    const fb = await connection(o.orgId, o.owner, 'Trang Facebook');
    const first = await published(o, fb, 'Khai trương', '2026-10-05T03:00:00Z', { reach: 700, reactions: 40, replies: 3 });
    await published(o, fb, 'Tháng trước', '2026-09-20T03:00:00Z', { reach: 30, reactions: 2 });
    await shortLink(o, first, 1, { '2026-10-08': 5 });
    await snapshot(o.orgId, fb, '2026-10-10', {});
    await snapshot(o.orgId, fb, '2026-10-11', null);
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00' });
    const previous = readFileSync(join(MIGRATIONS, '20261028240000_crove_social_story_report.sql'), 'utf8');
    const [now, audience, before] = await admin(async (c) => {
      const current = (await c.query<{ page: string; audience: unknown }>("SELECT (crove_social.report_link_view($1) - 'audience')::text AS page, crove_social.report_link_view($1) -> 'audience' AS audience", [token])).rows[0];
      await c.query('BEGIN');
      try {
        await c.query(previous);
        return [current?.page, current?.audience, (await c.query<{ page: string }>('SELECT crove_social.report_link_view($1)::text AS page', [token])).rows[0]?.page];
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(audience).toEqual([]);
    expect(now).toBeTruthy();
    expect(now).toBe(before);
  });

  it('lets only owners and admins make and revoke links, within the limits, and lists them without tokens', async () => {
    const o = await org();
    const stranger = await org();
    const conn = await connection(o.orgId, o.owner, 'Trang');
    const period = { periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-31T00:00:00Z' };
    await expect(exec(o, o.member, 'social.report_link.create', period)).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.owner, 'social.report_link.create', { periodStart: period.periodEnd, periodEnd: period.periodStart })).rejects.toMatchObject({ code: 'REPORT_PERIOD_INVALID' });
    await expect(exec(o, o.owner, 'social.report_link.create', { periodStart: '2025-01-01T00:00:00Z', periodEnd: '2026-10-01T00:00:00Z' })).rejects.toMatchObject({ code: 'REPORT_PERIOD_INVALID' });
    await expect(exec(o, o.owner, 'social.report_link.create', { ...period, days: 91 })).rejects.toMatchObject({ status: 422 });
    // Another org's channel is not this org's to report on.
    const theirs = await connection(stranger.orgId, stranger.owner, 'Của họ');
    await expect(exec(o, o.owner, 'social.report_link.create', { ...period, connectionIds: [conn, theirs] })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });

    const made = await exec<{ token: string; linkId: string; expiresAt: string }>(o, o.owner, 'social.report_link.create', { ...period, days: 7 });
    expect(new Date(made.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const list = await rt.query<ReportLinkView[]>('social.report_link.list', {}, { actor: asUser(o.member), orgId: o.orgId });
    expect(list).toEqual([expect.objectContaining({ id: made.linkId, connectionIds: [], revokedAt: null, title: null })]);
    expect(JSON.stringify(list)).not.toContain(made.token);
    const stored = await admin(async (c) => (await c.query<{ token_sha256: string }>('SELECT token_sha256 FROM crove_social.report_link WHERE id = $1', [made.linkId])).rows[0]?.token_sha256);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(made.token);
    // Another org sees none of it and cannot revoke it.
    expect(await rt.query('social.report_link.list', {}, { actor: asUser(stranger.owner), orgId: stranger.orgId })).toEqual([]);
    await expect(exec(stranger, stranger.owner, 'social.report_link.revoke', { linkId: made.linkId })).rejects.toMatchObject({ code: 'REPORT_LINK_NOT_FOUND' });
    // An empty report still opens.
    expect(await view(made.token)).toMatchObject({ posts: 0, totals: {}, channels: [], top: [] });

    // Expired: nothing.
    await admin((c) => c.query("UPDATE crove_social.report_link SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [made.linkId]));
    expect(await view(made.token)).toBeNull();
  });

  it('keeps the definer to the API role, and lets no tenant transaction rewrite a link', async () => {
    const grants = await admin(async (c) =>
      (
        await c.query<{ grantee: string }>(
          "SELECT grantee FROM information_schema.role_routine_grants WHERE routine_schema = 'crove_social' AND routine_name = 'report_link_view' AND grantee NOT IN ('postgres') ORDER BY 1",
        )
      ).rows.map((r) => r.grantee),
    );
    expect(grants).toEqual(['crove_app']);
    const columns = await admin(async (c) =>
      (
        await c.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'report_link' AND privilege_type = 'UPDATE' ORDER BY 1",
        )
      ).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(['revoked_at', 'revoked_by']);
    // The worker role may not call it.
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    const w = new pg.Client({ connectionString: worker.toString() });
    await w.connect();
    try {
      await expect(w.query("SELECT crove_social.report_link_view('x')")).rejects.toMatchObject({ code: '42501' });
    } finally {
      await w.end();
    }
  });
});
