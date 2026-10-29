// A post doing much better than usual (#1132) on PostgreSQL 17: a variant's 24-hour capture at twice its channel's
// usual engagement or more tells the post's author and assignee once, in the app and by email; nothing at 1.5x, never
// twice (two checks at once included), nothing for a channel with fewer than 10 earlier posts, for a Story, before
// the 24-hour capture or a day after it; a post found usual is weighed once, and a check that failed is tried again at
// the next capture; a muted member hears nothing, Social mail off keeps the mail only, and a member limited to some
// channels (#1081) hears only of posts on theirs. The metrics sweep runs the check only while a post waits to be
// weighed, so later captures add no command or audit row. The worker's check and dispatch are run here by hand. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Publisher } from '@crove/channel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, sweepMetrics, type NotificationItem, type OutperformState } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social posts doing much better than usual on PostgreSQL (#1132)', () => {
  const dbName = `crove_test_social_outperforming_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  // The worker's runtime (the crove_worker login): only it enters an org's system context.
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'test' };
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);

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

  type Org = { orgId: string; owner: string; admin: string; author: string; assignee: string; a: string; b: string; dispatched: Set<string> };
  async function connection(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        name,
        owner,
      ]),
    );
    return id;
  }
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), author: await person('author'), assignee: await person('assignee') };
    const role = { admin: 'admin', author: 'member', assignee: 'member' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles, a: await connection(orgId, owner, 'Trang thử'), b: await connection(orgId, owner, 'Kênh khác'), dispatched: new Set() };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });

  // A post by the author on a channel, published hoursAgo, with the assignee, and a capture with these counts taken
  // capturedHoursAgo (none when metrics is null). story: published as a Story.
  async function published(o: Org, conn: string, hoursAgo: number, metrics: Record<string, number> | null, opts: { capturedHoursAgo?: number; story?: boolean } = {}): Promise<{ postId: string; variantId: string }> {
    const { postId } = await exec<{ postId: string }>(o, o.author, 'social.post.create', { body: `Bài ${hoursAgo} giờ trước`, channels: [{ connectionId: conn }] });
    return admin(async (c) => {
      await c.query('UPDATE crove_social.post SET assignee_user_id = $2 WHERE id = $1', [postId, o.assignee]);
      const { rows } = await c.query<{ id: string }>(
        `UPDATE crove_social.post_variant SET status = 'published', published_at = now() - make_interval(hours => $2::int), external_post_id = $3,
           settings = CASE WHEN $4::boolean THEN coalesce(settings, '{}'::jsonb) || '{"postType": "story"}'::jsonb ELSE settings END
         WHERE post_id = $1 RETURNING id`,
        [postId, hoursAgo, `ext-${randomUUID().slice(0, 8)}`, opts.story === true],
      );
      const variantId = rows[0]?.id as string;
      if (metrics) {
        await c.query('INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics, captured_at) VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5::int))', [
          o.orgId,
          variantId,
          `k-${randomUUID().slice(0, 8)}`,
          JSON.stringify(metrics),
          opts.capturedHoursAgo ?? 0,
        ]);
      }
      return { postId, variantId };
    });
  }
  // n earlier posts on the channel, a day or more apart, each with this engagement (reactions) and reach.
  async function history(o: Org, conn: string, n: number, reactions: number, reach?: number, opts: { story?: boolean } = {}) {
    for (let i = 0; i < n; i++) await published(o, conn, 48 + 24 * i, { reactions, ...(reach === undefined ? {} : { reach }) }, opts);
  }
  const capture = (o: Org, variantId: string, metrics: Record<string, number>, hoursAgo = 0) =>
    admin((c) =>
      c.query('INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics, captured_at) VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5::int))', [
        o.orgId,
        variantId,
        `k-${randomUUID().slice(0, 8)}`,
        JSON.stringify(metrics),
        hoursAgo,
      ]),
    );

  const check = (o: Org, variantId: string) => worker.execute<{ state: OutperformState; ratio: string | null }>('social.metrics.check_outperforming', { variantId }, { actor: system, orgId: o.orgId });

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
  type List = { items: NotificationItem[] };
  const notices = async (o: Org, user: string) => (await rt.query<List>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId })).items.filter((i) => i.kind === 'post_outperforming');
  const events = (o: Org) =>
    admin(async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.variant.outperforming'", [o.orgId])).rows[0]?.n ?? 0);
  const mails = (o: Org) =>
    admin(
      async (c) =>
        (
          await c.query<{ user_id: string; subject: string }>(
            `SELECT n.user_id, m.subject FROM crove_kernel.mail_message m
             JOIN crove_social.notification n ON n.org_id = m.org_id AND n.id = m.source_id
             WHERE m.org_id = $1 AND m.source = 'social.notification.dispatch' AND n.kind = 'post_outperforming'`,
            [o.orgId],
          )
        ).rows,
    );
  const marker = (variantId: string) => admin(async (c) => (await c.query<{ at: Date | null }>('SELECT outperform_notified_at AS at FROM crove_social.post_variant WHERE id = $1', [variantId])).rows[0]?.at ?? null);
  const checked = (variantId: string) => admin(async (c) => (await c.query<{ at: Date | null }>('SELECT outperform_checked_at AS at FROM crove_social.post_variant WHERE id = $1', [variantId])).rows[0]?.at ?? null);

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 6 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
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

  it('tells the author and the assignee once, in the app and by email, at twice the usual engagement', async () => {
    const o = await org();
    await history(o, o.a, 10, 10, 1000);
    // Another channel's posts and a Story on this one never count.
    await history(o, o.b, 3, 1);
    await published(o, o.a, 30, { reactions: 1 }, { story: true });
    const { postId, variantId } = await published(o, o.a, 25, { reactions: 15, comments: 5, reach: 3000 });

    expect(await check(o, variantId)).toEqual({ state: 'notified', ratio: '2' });
    expect(await marker(variantId)).not.toBeNull();
    expect(await deliver(o)).toBe(2);
    for (const user of [o.author, o.assignee]) {
      expect((await notices(o, user)).map((n) => ({ postId: n.postId, connectionId: n.connectionId, channel: n.channel, detail: n.detail }))).toEqual([
        { postId, connectionId: o.a, channel: 'Trang thử', detail: { provider: 'sandbox', ratio: '2', reach: '3' } },
      ]);
    }
    // Nobody else hears of it.
    for (const user of [o.owner, o.admin]) expect(await notices(o, user)).toEqual([]);
    const sent = await mails(o);
    expect(sent.map((m) => m.user_id).sort()).toEqual([o.author, o.assignee].sort());
    expect(sent[0]?.subject).toBe('Bài trên Trang thử đang được tương tác gấp 2 lần mức thường lệ: Bài 25 giờ trước');

    // Never twice: the same capture checked again, and a later capture.
    expect((await check(o, variantId)).state).toBe('skipped');
    await capture(o, variantId, { reactions: 100 });
    expect((await check(o, variantId)).state).toBe('skipped');
    expect(await events(o)).toBe(1);
    expect(await deliver(o)).toBe(0);
    expect(await notices(o, o.author)).toHaveLength(1);
  });

  it('tells nobody at 1.5x the usual engagement, and weighs the post once', async () => {
    const o = await org();
    await history(o, o.a, 12, 10);
    const { variantId } = await published(o, o.a, 26, { reactions: 15 });
    expect(await check(o, variantId)).toEqual({ state: 'usual', ratio: null });
    expect(await marker(variantId)).toBeNull();
    expect(await checked(variantId)).not.toBeNull();
    // A later capture far above the usual changes nothing: the 24-hour capture was weighed.
    await capture(o, variantId, { reactions: 500 });
    expect((await check(o, variantId)).state).toBe('skipped');
    expect(await events(o)).toBe(0);
  });

  it('tells them once when two checks run at once', async () => {
    const o = await org();
    await history(o, o.a, 10, 10);
    const { variantId } = await published(o, o.a, 25, { reactions: 50 });
    const states = (await Promise.all([1, 2, 3, 4].map(() => check(o, variantId)))).map((r) => r.state);
    expect(states.filter((s) => s === 'notified')).toHaveLength(1);
    expect(states.filter((s) => s !== 'notified').every((s) => s === 'skipped')).toBe(true);
    expect(await events(o)).toBe(1);
    expect(await deliver(o)).toBe(2);
  });

  it('tells nobody for a channel with fewer than 10 earlier posts', async () => {
    const o = await org();
    // Nine posts with counts, one without a capture yet, three Stories and a later post: still too little history.
    await history(o, o.a, 9, 10);
    await published(o, o.a, 400, null);
    await history(o, o.a, 3, 10, undefined, { story: true });
    const { variantId } = await published(o, o.a, 25, { reactions: 100 });
    await published(o, o.a, 2, { reactions: 10 });
    expect((await check(o, variantId)).state).toBe('usual');
    expect(await events(o)).toBe(0);
  });

  it('tells nobody for a Story, before the 24-hour capture or a day after it, and weighs the 24-hour capture itself', async () => {
    const o = await org();
    await history(o, o.a, 10, 10);
    const story = await published(o, o.a, 25, { reactions: 100 }, { story: true });
    expect((await check(o, story.variantId)).state).toBe('skipped');
    // Twelve hours old: its 24-hour capture is still to come.
    const young = await published(o, o.a, 12, { reactions: 100 });
    expect((await check(o, young.variantId)).state).toBe('skipped');
    // A later capture far above the usual: the 24-hour capture (at the usual) is what is weighed.
    const older = await published(o, o.a, 40, { reactions: 10 }, { capturedHoursAgo: 14 });
    await capture(o, older.variantId, { reactions: 100 });
    expect((await check(o, older.variantId)).state).toBe('usual');
    // Its 24-hour capture was taken more than a day ago (a post already past it when this shipped): never weighed.
    const stale = await published(o, o.a, 80, { reactions: 100 }, { capturedHoursAgo: 50 });
    expect((await check(o, stale.variantId)).state).toBe('skipped');
    expect(await checked(stale.variantId)).toBeNull();
    // An empty capture (a failed try) is not the 24-hour capture.
    const failed = await published(o, o.a, 30, {}, { capturedHoursAgo: 4 });
    expect((await check(o, failed.variantId)).state).toBe('skipped');
    await capture(o, failed.variantId, { reactions: 100 });
    expect((await check(o, failed.variantId)).state).toBe('notified');
    expect(await events(o)).toBe(1);
  });

  it('never tells a member who turned the kind off, and Social mail off keeps the mail only', async () => {
    const o = await org();
    await exec(o, o.author, 'social.notification.mute', { kind: 'post_outperforming', muted: true });
    await exec(o, o.assignee, 'social.notification.mail', { enabled: false });
    await history(o, o.a, 10, 10);
    const { variantId } = await published(o, o.a, 25, { reactions: 30 });
    expect(await check(o, variantId)).toEqual({ state: 'notified', ratio: '3' });
    expect(await deliver(o)).toBe(1);
    expect(await notices(o, o.author)).toEqual([]);
    expect(await notices(o, o.assignee)).toHaveLength(1);
    expect(await mails(o)).toEqual([]);
  });

  it('tells a member limited to some channels only of posts on theirs', async () => {
    const o = await org();
    await history(o, o.a, 10, 10, 1000);
    // Reach below the usual is not named: "0.4 times" would read as more.
    const { variantId } = await published(o, o.a, 25, { reactions: 30, reach: 400 });
    // The author may use this channel; the assignee only another one.
    await exec(o, o.admin, 'social.channel_access.set', { userId: o.author, channelConnectionIds: [o.a] });
    await exec(o, o.admin, 'social.channel_access.set', { userId: o.assignee, channelConnectionIds: [o.b] });
    expect((await check(o, variantId)).state).toBe('notified');
    expect(await deliver(o)).toBe(1);
    expect((await notices(o, o.author)).map((n) => n.detail)).toEqual([{ provider: 'sandbox', ratio: '3' }]);
    expect(await notices(o, o.assignee)).toEqual([]);
    expect((await mails(o)).map((m) => m.user_id)).toEqual([o.author]);
  });

  it('runs the check from the sweep only for the 24-hour capture, so later captures add no audit row', async () => {
    const o = await org();
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_test' }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: 'acct-sweep' });
    const { connectionId: conn } = await exec<{ connectionId: string }>(o, o.owner, 'kernel.channel.connect', {
      provider: 'sandbox',
      externalAccountId: 'acct-sweep',
      displayName: 'Trang thử',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
    // Captured just now, so the first sweep does not ask about them, and weighed long ago.
    await history(o, conn, 10, 10);
    await admin((c) => c.query('UPDATE crove_social.post_variant SET outperform_checked_at = now() WHERE org_id = $1', [o.orgId]));
    // Past its 24-hour capture by more than a day; already weighed; too young; one due for its 24-hour capture; and one
    // whose check failed at its 24-hour capture six hours ago (rolled back, so nothing is set), tried again now.
    const stale = await published(o, conn, 60, { reactions: 10 }, { capturedHoursAgo: 30 });
    const weighed = await published(o, conn, 50, null);
    await admin((c) => c.query('UPDATE crove_social.post_variant SET outperform_checked_at = now() WHERE id = $1', [weighed.variantId]));
    const young = await published(o, conn, 5, null);
    const fresh = await published(o, conn, 25, null);
    const retry = await published(o, conn, 31, { reactions: 50 }, { capturedHoursAgo: 6 });
    const asked: string[] = [];
    const platform = {
      metrics: async (input: { externalId: string }) => {
        asked.push(input.externalId);
        return { metrics: { reactions: 30 } };
      },
    } as unknown as Publisher;
    const audits = () =>
      admin(
        async (c) =>
          (await c.query<{ target_id: string }>("SELECT target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.metrics.check_outperforming'", [o.orgId])).rows.map(
            (r) => r.target_id,
          ),
      );
    const snapshots = (variantId: string) =>
      admin(async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM crove_social.metric_snapshot WHERE variant_id = $1 AND metrics <> '{}'::jsonb", [variantId])).rows[0]?.n ?? 0);

    await sweepMetrics({ runtime: worker, broker: vault, workerDb: createDb(workerPool), publishers: { sandbox: platform } });
    for (const v of [weighed, young, fresh]) expect(await snapshots(v.variantId)).toBe(1);
    expect({ stale: await snapshots(stale.variantId), retry: await snapshots(retry.variantId) }).toEqual({ stale: 2, retry: 2 });
    expect((await audits()).sort()).toEqual([fresh.variantId, retry.variantId].sort());
    expect(await marker(fresh.variantId)).not.toBeNull();
    // The retry weighs its 24-hour capture (50 against the usual 10), not the capture just taken (30).
    expect(await marker(retry.variantId)).not.toBeNull();
    expect(await deliver(o)).toBe(4);
    expect((await notices(o, o.author)).map((n) => n.detail.ratio).sort()).toEqual(['3', '5']);

    // Seven hours on (the captures in an earlier bucket), every one of them is captured again: no check runs.
    await admin((c) => c.query("UPDATE crove_social.metric_snapshot SET captured_at = captured_at - interval '7 hours', capture_key = capture_key || '-before' WHERE org_id = $1", [o.orgId]));
    await admin((c) => c.query("UPDATE crove_social.post_variant SET published_at = published_at - interval '7 hours' WHERE org_id = $1", [o.orgId]));
    const before = asked.length;
    await sweepMetrics({ runtime: worker, broker: vault, workerDb: createDb(workerPool), publishers: { sandbox: platform } });
    expect(asked.length).toBeGreaterThan(before);
    expect(await snapshots(fresh.variantId)).toBe(2);
    expect((await audits()).sort()).toEqual([fresh.variantId, retry.variantId].sort());
    expect(await events(o)).toBe(2);
  });

  it('runs for the system only', async () => {
    const o = await org();
    const { variantId } = await published(o, o.a, 25, { reactions: 30 });
    await expect(rt.execute('social.metrics.check_outperforming', { variantId }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });
});
