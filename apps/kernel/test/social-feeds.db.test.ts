// Drafts from a blog's feed on PostgreSQL 17 (#708): owners and admins add feeds for the org's channels; the worker's
// record drafts each new item once (only those published since the feed was added on its first read, at most five a
// read), tainted and for review; five failed reads pause the feed and tell the owners and admins; the worker's scan
// skips paused feeds. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type FeedResult, type FeedView, type NotificationItem } from '@crove/mod-social';
import { sweepFeeds } from '../src/feeds.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social blog feeds on PostgreSQL (#708)', () => {
  const dbName = `crove_test_social_feeds_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  // The worker's runtime (the crove_worker login): only it enters an org's system context.
  let worker: Runtime;
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

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string; viewer: string; dispatched: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), other: await person('other'), viewer: await person('viewer') };
    const role = { admin: 'admin', member: 'member', other: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles, dispatched: new Set() };
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

  // What the worker does for each new event of the org: the dispatch, in the org's system context.
  async function deliver(o: Org): Promise<number> {
    const events = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 ORDER BY created_at, id', [o.orgId])).rows);
    let sent = 0;
    for (const e of events) {
      if (o.dispatched.has(e.id)) continue;
      o.dispatched.add(e.id);
      sent += (await worker.execute<{ sent: number }>('social.notification.dispatch', { eventId: e.id }, { actor: system, orgId: o.orgId })).sent;
    }
    return sent;
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
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
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

  const item = (n: number, publishedAt: string | null = new Date().toISOString()) => ({ key: `post-${n}`, title: `Bài ${n}`, link: `https://blog.example/${n}`, publishedAt, summary: `Tóm tắt ${n}`, image: null });
  const ok = (items: ReturnType<typeof item>[]): FeedResult => ({ ok: true, title: 'Blog Tiệm Bánh', items });
  const record = (o: Org, feedId: string, result: FeedResult) => worker.execute<{ drafted: number; paused: boolean }>('social.feed.record', { feedId, result }, { actor: system, orgId: o.orgId });
  const feeds = (o: Org, user: string) => rt.query<FeedView[]>('social.feed.list', {}, { actor: asUser(user), orgId: o.orgId });
  const drafts = (o: Org) =>
    admin(async (c) => (await c.query<{ body: string; link_url: string | null; tainted: boolean; actor_origin: string; author: string; status: string; variants: number }>(
      "SELECT p.body, p.link_url, p.tainted, p.actor_origin, p.author_user_id AS author, p.status, (SELECT count(*)::int FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id) AS variants FROM crove_social.post p WHERE p.org_id = $1 ORDER BY p.body", [o.orgId])).rows);

  it('drafts each new item once, for review, and only items published since the feed was added', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await expect(exec(o, o.member, 'social.feed.add', { url: 'https://blog.example/feed', connectionIds: [conn] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { feedId } = await exec<{ feedId: string }>(o, o.admin, 'social.feed.add', { url: 'https://blog.example/feed', connectionIds: [conn] });
    await expect(exec(o, o.owner, 'social.feed.add', { url: 'https://blog.example/feed', connectionIds: [conn] })).rejects.toMatchObject({ code: 'FEED_EXISTS' });

    // First read: the old article is noted, the one published since is drafted.
    const old = item(1, '2020-01-01T00:00:00.000Z');
    expect(await record(o, feedId, ok([item(2), old]))).toEqual({ drafted: 1, paused: false });
    expect(await drafts(o)).toEqual([{ body: 'Bài 2\n\nTóm tắt 2', link_url: 'https://blog.example/2', tainted: true, actor_origin: 'system', author: o.admin, status: 'draft', variants: 1 }]);
    // The same items again draft nothing; a new one is drafted, however old its date, now that the feed was read once.
    expect(await record(o, feedId, ok([item(3, '2019-05-05T00:00:00.000Z'), item(2), old]))).toEqual({ drafted: 1, paused: false });
    expect((await drafts(o)).map((d) => d.body)).toEqual(['Bài 2\n\nTóm tắt 2', 'Bài 3\n\nTóm tắt 3']);
    expect(await feeds(o, o.viewer)).toEqual([expect.objectContaining({ id: feedId, title: 'Blog Tiệm Bánh', drafts: 2, failures: 0, paused: false })]);

    // At most five a read; the rest wait for the next one.
    const many = Array.from({ length: 7 }, (_, i) => item(10 + i));
    expect(await record(o, feedId, ok(many))).toEqual({ drafted: 5, paused: false });
    expect(await record(o, feedId, ok(many))).toEqual({ drafted: 2, paused: false });
    expect((await drafts(o)).length).toBe(9);
  });

  it('pauses after five failed reads, tells the owners and admins, and the scan skips it until resumed', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { feedId } = await exec<{ feedId: string }>(o, o.owner, 'social.feed.add', { url: 'https://down.example/rss', connectionIds: [conn] });
    for (let i = 0; i < 4; i++) expect(await record(o, feedId, { ok: false, error: 'timeout' })).toEqual({ drafted: 0, paused: false });
    expect(await record(o, feedId, { ok: false, error: 'http' })).toEqual({ drafted: 0, paused: true });
    expect(await feeds(o, o.owner)).toEqual([expect.objectContaining({ paused: true, failures: 5, lastError: 'http' })]);
    await deliver(o);
    for (const user of [o.owner, o.admin]) expect((await rt.query<{ items: NotificationItem[] }>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId })).items.map((n) => [n.kind, n.detail])).toEqual([['feed_paused', { feed: 'https://down.example/rss' }]]);
    expect((await rt.query<{ items: NotificationItem[] }>('social.notification.list', {}, { actor: asUser(o.member), orgId: o.orgId })).items).toEqual([]);
    const due = async () => (await admin(async (c) => (await c.query<{ feed_id: string }>('SELECT feed_id FROM crove_social.feeds_due(1000)')).rows)).map((r) => r.feed_id);
    expect(await due()).not.toContain(feedId);
    await exec(o, o.owner, 'social.feed.update', { feedId, paused: false });
    expect(await feeds(o, o.owner)).toEqual([expect.objectContaining({ paused: false, failures: 0, lastError: null })]);
    expect(await due()).toContain(feedId);
  });

  it('reads due feeds through the guard and the sandbox, and keeps tenants apart', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { feedId } = await exec<{ feedId: string }>(o, o.owner, 'social.feed.add', { url: 'https://reader.example/atom', connectionIds: [conn] });
    const fetched: string[] = [];
    const fetch = (async (url: string) => {
      fetched.push(url);
      return { status: 200, contentType: 'application/atom+xml', body: new TextEncoder().encode('<feed/>') };
    }) as unknown as NonNullable<Parameters<typeof sweepFeeds>[0]['fetch']>;
    const extract = { extract: async () => ({ ok: true as const, kind: 'feed' as const, feed: { title: 'Nhật ký', items: [item(1)] } }) } as unknown as Parameters<typeof sweepFeeds>[0]['extract'];
    expect(await sweepFeeds({ runtime: worker, workerDb: createDb(workerPool), extract, fetch })).toBeGreaterThanOrEqual(1);
    expect(fetched).toContain('https://reader.example/atom');
    expect(await feeds(o, o.owner)).toEqual([expect.objectContaining({ id: feedId, title: 'Nhật ký', drafts: 1 })]);

    // Another org's channel or feed is nothing here.
    const b = await org();
    await expect(exec(b, b.owner, 'social.feed.add', { url: 'https://x.example/rss', connectionIds: [conn] })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(exec(b, b.owner, 'social.feed.remove', { feedId })).rejects.toMatchObject({ code: 'FEED_NOT_FOUND' });
    expect(await feeds(b, b.owner)).toEqual([]);
    await expect(rt.execute('social.feed.record', { feedId, result: { ok: false, error: 'http' } }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toThrow();
  });
});
