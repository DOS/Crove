// Client report links of Crove Social on PostgreSQL 17 (#643): who makes and revokes them, the report a token opens
// (the period, the chosen channels, totals, per channel, the best posts), and that nothing else of the org is reachable
// through it. The public side runs as the API login role with no org context, as the HTTP edge does. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
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
      { channel: 'Trang Facebook', provider: 'sandbox', posts: 2, totals: { reach: 1400, reactions: 55, comments: 10, shares: 5 } },
      { channel: 'Zalo OA', provider: 'sandbox', posts: 1, totals: { reach: 300, reactions: 80, views: 900 } },
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
    await published(o, zalo, 'Tin Zalo', '2026-10-06T03:00:00Z', { reach: 50, reactions: 9 });
    // Two revisions went out with a link. The period is 2026-09-30T17:00Z to 2026-10-31T17:00Z: a UTC day counts when its
    // midday is in it, so 31 October does and 30 September and 1 November do not.
    await shortLink(o, sale, 1, { '2026-09-30': 100, '2026-10-03': 7, '2026-10-31': 3, '2026-11-01': 50 });
    await shortLink(o, sale, 2, { '2026-10-10': 2 });
    // Another org's clicks stay its own.
    const theirConn = await connection(stranger.orgId, stranger.owner, 'Của họ');
    await shortLink(stranger, await published(stranger, theirConn, 'Của họ', '2026-10-05T03:00:00Z', { reach: 1 }), 1, { '2026-10-05': 900 });

    const { token } = await exec<{ token: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00' });
    const page = (await view(token)) as ReportPage;
    expect(page.totals).toEqual({ reach: 150, reactions: 10, linkClicks: 12 });
    expect(page.channels).toEqual([
      { channel: 'Trang Facebook', provider: 'sandbox', posts: 1, totals: { reach: 100, reactions: 1, linkClicks: 12 } },
      { channel: 'Zalo OA', provider: 'sandbox', posts: 1, totals: { reach: 50, reactions: 9 } },
    ]);
    // Link clicks do not make a post do better: the Zalo post still leads on its reactions.
    expect(page.top.map((p) => [p.excerpt, p.metrics])).toEqual([
      ['Tin Zalo', { reach: 50, reactions: 9 }],
      ['Giảm giá', { reach: 100, reactions: 1, linkClicks: 12 }],
    ]);
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
