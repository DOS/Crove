// The posting calendar feed of Crove Social on PostgreSQL 17 (#862): who makes, replaces and revokes it, what its token
// opens (the org's scheduled and published channel posts from 30 days back to 60 ahead, with a short title) and that
// nothing else of the org is reachable through it, through the definer and through GET /cal/<token>.ics. The public
// side runs as the API login role with no org context, as the HTTP edge does. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type CalendarFeedView } from '@crove/mod-social';
import { createAuthenticator } from '../src/auth.ts';
import { calendarFeed, type CalendarFeed } from '../src/calendar-feed.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DAY = 86_400_000;
const suite = ADMIN ? describe : describe.skip;

suite('social calendar feed on PostgreSQL (#862)', () => {
  const dbName = `crove_test_social_calfeed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let http: (limit?: RateLimiter) => ReturnType<typeof createHttpApp>;
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
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@calfeed.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Cửa hàng ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, user] of Object.entries(roles)) await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]));
    const conn = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, conn, 'sandbox', `acct-${conn.slice(0, 8)}`, 'Kênh thử', owner]),
    );
    const slug = await admin(async (c) => (await c.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.slug as string);
    return { orgId, owner, conn, slug, ...roles };
  }

  type Org = Awaited<ReturnType<typeof org>>;
  const exec = <O>(o: Org, user: string, name: string, input: unknown = {}) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });

  // A post on the org's channel, its variant moved to a state at a time (as the scheduling and publish jobs would).
  async function post(o: Org, body: string, set: { status: string; scheduledAt?: Date; queueSlotAt?: Date; publishedAt?: Date; title?: string; variantBody?: string }) {
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body, channels: [{ connectionId: o.conn }] });
    return admin(async (c) => {
      if (set.title !== undefined) await c.query('UPDATE crove_social.post SET title = $2 WHERE id = $1', [postId, set.title]);
      const { rows } = await c.query<{ id: string }>(
        'UPDATE crove_social.post_variant SET status = $2, scheduled_at = $3, queue_slot_at = $4, published_at = $5, body = coalesce($6, body) WHERE post_id = $1 RETURNING id',
        [postId, set.status, set.scheduledAt ?? null, set.queueSlotAt ?? null, set.publishedAt ?? null, set.variantBody ?? null],
      );
      return { postId, variantId: rows[0]?.id as string };
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
    const config = loadConfig({
      DATABASE_URL: app.toString(),
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-calendar-feed-0123',
      AUTH_ISSUER: 'crove-auth',
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      PUBLIC_URL: 'http://localhost:8080/',
    });
    http = (limit) => createHttpApp({ config, runtime: rt, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, ...(limit ? { calendarFeedLimit: limit } : {}) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('opens the scheduled, queued and published channel posts of the window, with a short title', async () => {
    const o = await org();
    const stranger = await org();
    const now = Date.now();
    const at = (days: number) => new Date(now + days * DAY);
    const titled = await post(o, 'Nội dung đầy đủ, không được lộ ra', { status: 'scheduled', scheduledAt: at(2), title: '  Khai trương  ' });
    const queued = await post(o, '\n\n  Dòng đầu tiên của bài  \nDòng hai bí mật', { status: 'scheduled', queueSlotAt: at(5), scheduledAt: at(50) });
    const done = await post(o, 'Bài chung', { status: 'published', publishedAt: at(-10), variantBody: `${'Rất dài '.repeat(20)}\nnữa` });
    const early = await post(o, 'Sắp hết khung', { status: 'scheduled', scheduledAt: at(59) });
    // Outside the window, or not going out.
    await post(o, 'Quá xa', { status: 'scheduled', scheduledAt: at(61) });
    await post(o, 'Quá cũ', { status: 'published', publishedAt: at(-31) });
    await post(o, 'Bản nháp', { status: 'draft', scheduledAt: at(3) });
    await post(o, 'Đang chờ duyệt', { status: 'in_review', scheduledAt: at(3) });
    await post(o, 'Đã hủy', { status: 'cancelled', scheduledAt: at(3) });
    // Another org's post.
    await post(stranger, 'Của họ', { status: 'scheduled', scheduledAt: at(1) });

    const { token } = await exec<{ token: string }>(o, o.owner, 'social.calendar_feed.create');
    const feed = (await calendarFeed(rt, token)) as CalendarFeed;
    expect(feed.slug).toBe(o.slug);
    expect(feed.name).toMatch(/^Cửa hàng /);
    expect(feed.events.map((e) => [e.id, e.postId, e.status, e.title])).toEqual([
      // The variant's own text, its first line cut to 100 characters.
      [done.variantId, done.postId, 'published', 'Rất dài '.repeat(20).slice(0, 100).trim()],
      [titled.variantId, titled.postId, 'scheduled', 'Khai trương'],
      [queued.variantId, queued.postId, 'scheduled', 'Dòng đầu tiên của bài'],
      [early.variantId, early.postId, 'scheduled', 'Sắp hết khung'],
    ]);
    // The queue slot wins over the default time.
    expect(Date.parse(feed.events[2]?.at as string)).toBe(at(5).getTime());
    expect(feed.events[0]).toEqual({ id: done.variantId, postId: done.postId, provider: 'sandbox', at: expect.any(String), status: 'published', title: expect.any(String) });
    // No full text, no people.
    expect(JSON.stringify(feed)).not.toMatch(/bí mật|không được lộ|@calfeed\.test/);
    expect(JSON.stringify(feed)).not.toContain(o.owner);

    // Through the HTTP edge: an iCalendar file with an event per channel post.
    const res = await http().request(`/cal/${token}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const ics = await res.text();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4);
    expect(ics.replace(/\r\n /g, '')).toContain(`UID:${titled.variantId}@crove\r\n`);
    expect(ics.replace(/\r\n /g, '')).toContain(`URL:http://localhost:8080/o/${o.slug}/social/${titled.postId}\r\n`);
    expect(ics.replace(/\r\n /g, '')).toContain('SUMMARY:Sandbox: Khai trương\r\n');
    // Without the extension, or with a wrong token: a plain 404.
    expect((await http().request(`/cal/${token}`)).status).toBe(404);
    expect((await http().request(`/cal/${'x'.repeat(43)}.ics`)).status).toBe(404);
    expect((await http().request('/cal/short.ics')).status).toBe(404);
  });

  it('keeps one live feed: making a new one revokes the old, and a revoked token opens nothing', async () => {
    const o = await org();
    expect(await rt.query('social.calendar_feed.get', {}, { actor: asUser(o.viewer), orgId: o.orgId })).toBeNull();
    const first = await exec<{ token: string }>(o, o.admin, 'social.calendar_feed.create');
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = await exec<{ token: string }>(o, o.owner, 'social.calendar_feed.create');
    expect(await calendarFeed(rt, first.token)).toBeNull();
    expect(await calendarFeed(rt, second.token)).toMatchObject({ slug: o.slug, events: [] });
    const live = await admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_social.calendar_feed WHERE org_id = $1 AND revoked_at IS NULL', [o.orgId])).rows[0]?.n);
    expect(live).toBe(1);
    // Everyone sees that there is one and who made it, never the token.
    const seen = await rt.query<CalendarFeedView | null>('social.calendar_feed.get', {}, { actor: asUser(o.viewer), orgId: o.orgId });
    expect(seen).toEqual({ createdAt: expect.any(String), createdBy: o.owner });
    expect(JSON.stringify(seen)).not.toContain(second.token);
    const stored = await admin(async (c) => (await c.query<{ token_sha256: string }>('SELECT token_sha256 FROM crove_social.calendar_feed WHERE org_id = $1 AND revoked_at IS NULL', [o.orgId])).rows[0]?.token_sha256);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // The audit keeps no token.
    const audit = await admin(async (c) => JSON.stringify((await c.query("SELECT * FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'social.calendar_feed.%'", [o.orgId])).rows));
    expect(audit).toContain('social.calendar_feed.create');
    expect(audit).not.toContain(first.token);
    expect(audit).not.toContain(second.token);

    expect(await exec(o, o.admin, 'social.calendar_feed.revoke')).toEqual({ revoked: true });
    expect(await exec(o, o.admin, 'social.calendar_feed.revoke')).toEqual({ revoked: false });
    expect(await calendarFeed(rt, second.token)).toBeNull();
    expect(await rt.query('social.calendar_feed.get', {}, { actor: asUser(o.member), orgId: o.orgId })).toBeNull();
    expect((await http().request(`/cal/${second.token}.ics`)).status).toBe(404);

    // A closed org's feed opens nothing either.
    const third = await exec<{ token: string }>(o, o.owner, 'social.calendar_feed.create');
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [o.orgId]));
    expect(await calendarFeed(rt, third.token)).toBeNull();
  });

  it('lets only owners and admins make and revoke the feed, each org its own', async () => {
    const o = await org();
    const stranger = await org();
    for (const user of [o.member, o.viewer]) {
      await expect(exec(o, user, 'social.calendar_feed.create')).rejects.toMatchObject({ status: 403 });
      await expect(exec(o, user, 'social.calendar_feed.revoke')).rejects.toMatchObject({ status: 403 });
    }
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.calendar_feed.create');
    // Another org's revoke and create leave it alone.
    expect(await exec(stranger, stranger.owner, 'social.calendar_feed.revoke')).toEqual({ revoked: false });
    await exec(stranger, stranger.owner, 'social.calendar_feed.create');
    expect(await rt.query('social.calendar_feed.get', {}, { actor: asUser(stranger.member), orgId: stranger.orgId })).toMatchObject({ createdBy: stranger.owner });
    expect(await calendarFeed(rt, token)).toMatchObject({ slug: o.slug });
  });

  it('answers 429 past the per-client budget', async () => {
    const o = await org();
    const { token } = await exec<{ token: string }>(o, o.owner, 'social.calendar_feed.create');
    const app = http(new RateLimiter({ perMinute: 1 }));
    expect((await app.request(`/cal/${token}.ics`)).status).toBe(200);
    const limited = await app.request(`/cal/${token}.ics`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('keeps the definer to the API role, and lets no tenant transaction rewrite a feed', async () => {
    const grants = await admin(async (c) =>
      (
        await c.query<{ grantee: string }>(
          "SELECT grantee FROM information_schema.role_routine_grants WHERE routine_schema = 'crove_social' AND routine_name = 'calendar_feed_events' AND grantee NOT IN ('postgres') ORDER BY 1",
        )
      ).rows.map((r) => r.grantee),
    );
    expect(grants).toEqual(['crove_app']);
    const columns = await admin(async (c) =>
      (
        await c.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'calendar_feed' AND privilege_type = 'UPDATE' ORDER BY 1",
        )
      ).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(['revoked_at', 'revoked_by']);
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    const w = new pg.Client({ connectionString: worker.toString() });
    await w.connect();
    try {
      await expect(w.query("SELECT crove_social.calendar_feed_events('x')")).rejects.toMatchObject({ code: '42501' });
    } finally {
      await w.end();
    }
  });
});
