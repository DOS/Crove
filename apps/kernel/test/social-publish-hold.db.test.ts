// A hold on all of an org's publishing on PostgreSQL 17 (issue #946): while it is on, no post of the org goes out,
// whether set for a time or waiting in a queue slot, and no first comment, repost, auto-reply or evergreen repost runs;
// another org goes on. On release the due posts go out once each, and one more than an hour past its time waits for a
// person. Owners and admins hold and release; every member reads it; the team is told.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxPublisher, type Publisher, type PublishInput, type PublishResult } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { HELD_TOO_LONG, runCommentJob, runPublishJob, socialCommands, socialQueries, type NotificationItem, type PostView, type PublishHoldView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// The sandbox, counting the posts it was asked to publish.
class Counting extends SandboxPublisher {
  readonly sent: string[] = [];
  override async publish(input: PublishInput): Promise<PublishResult> {
    this.sent.push(input.callKey);
    return super.publish(input);
  }
}

suite('social publishing hold on PostgreSQL (#946)', () => {
  const dbName = `crove_test_social_hold_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'social-hold-test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@hold.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const people = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(people)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...people };
  }

  const exec = <O>(o: Org, name: string, input: unknown, user = o.owner) => api.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => api.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const holdOf = (o: Org, user: string) => api.query<PublishHoldView>('social.publishing.hold_get', {}, { actor: asUser(user), orgId: o.orgId });

  async function connect(o: Org) {
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_test' }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: account });
    const { connectionId } = await exec<{ connectionId: string }>(o, 'kernel.channel.connect', {
      provider: 'sandbox',
      externalAccountId: account,
      displayName: 'Trang thử',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
    return connectionId;
  }

  // A post approved and scheduled on a fresh channel, then made due `ago` before now: at its time, or (queue) in a
  // slot of the channel's running queue.
  async function duePost(o: Org, options: { ago?: string; queue?: boolean; settings?: Record<string, unknown> } = {}) {
    const connectionId = await connect(o);
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: `Bài ${randomUUID().slice(0, 6)}`, channels: [{ connectionId, ...(options.settings ? { settings: options.settings } : {}) }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    const ago = options.ago ?? '1 second';
    if (options.queue) {
      await exec(o, 'social.queue.set', { connectionId, timeZone: 'Asia/Ho_Chi_Minh', slots: [{ weekday: 1, minute: 540 }] });
      await admin((c) => c.query('UPDATE crove_social.post_variant SET scheduled_at = NULL, queue_slot_at = now() - $2::interval WHERE post_id = $1', [postId, ago]));
    } else {
      await admin((c) => c.query('UPDATE crove_social.post_variant SET scheduled_at = now() - $2::interval WHERE post_id = $1', [postId, ago]));
    }
    return { postId, id: post.variants[0]?.id as string };
  }

  const deps = (platform: Publisher) => ({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 });
  const run = (o: Org, variantId: string, platform: Publisher) => runPublishJob(deps(platform), o.orgId, variantId, 'sandbox');
  const status = async (o: Org, postId: string) => {
    const v = (await get(o, postId)).variants[0];
    return { status: v?.status, code: v?.error?.code ?? null };
  };
  const due = () => admin(async (c) => (await c.query<{ variant_id: string }>("SELECT variant_id FROM crove_social.publish_due(1000, 600, ARRAY['sandbox'])")).rows.map((r) => r.variant_id));
  // One sweep as the worker runs it: a publish job for every variant the scan finds, of the orgs given.
  async function sweep(platform: Publisher, orgs: readonly Org[]) {
    const ids = new Set(await due());
    for (const o of orgs) {
      const mine = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_social.post_variant WHERE org_id = $1', [o.orgId])).rows.map((r) => r.id));
      for (const id of mine) if (ids.has(id)) await run(o, id, platform);
    }
  }

  async function deliver(o: Org, type: string) {
    const { rows } = await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY created_at, id', [o.orgId, type]));
    for (const e of rows) await worker.execute('social.notification.dispatch', { eventId: e.id }, { actor: system, orgId: o.orgId });
    return rows.length;
  }
  // What a command audited, for the runs that wrote a hold or a release.
  const auditOf = (o: Org, command: string) =>
    admin(async (c) => (await c.query<{ detail: { reason: string; held_too_long?: number } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND detail ? 'hold_id' ORDER BY occurred_at, id", [o.orgId, command])).rows.map((r) => r.detail));
  const notices = async (o: Org, user: string) =>
    (await api.query<{ items: NotificationItem[] }>('social.notification.list', {}, { actor: asUser(user), orgId: o.orgId })).items.filter((n) => n.kind === 'publishing_hold').map((n) => n.detail);

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
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    api = new Runtime(appDb).register(registry);
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

  it('lets owners and admins hold, one live hold per org, and shows it to every member', async () => {
    const o = await org();
    for (const user of [o.member, o.viewer]) {
      await expect(exec(o, 'social.publishing.hold', { reason: 'Không được' }, user)).rejects.toMatchObject({ status: 403 });
    }
    await expect(exec(o, 'social.publishing.hold', { reason: '   ' }, o.admin)).rejects.toBeDefined();
    const first = await exec<{ holdId: string; created: boolean }>(o, 'social.publishing.hold', { reason: '  Ngày quốc tang  ' }, o.admin);
    expect(first.created).toBe(true);
    // A second hold while one is live answers the live one.
    const second = await exec<{ holdId: string; created: boolean }>(o, 'social.publishing.hold', { reason: 'Lần nữa' });
    expect(second).toMatchObject({ holdId: first.holdId, created: false });
    for (const user of [o.owner, o.admin, o.member, o.viewer]) {
      const view = await holdOf(o, user);
      expect(view).toMatchObject({ held: true, hold: { id: first.holdId, reason: 'Ngày quốc tang', heldBy: o.admin } });
      expect(view.hold?.heldByName).toMatch(/^admin-/);
    }
    // Audited with the reason, by the person who held it.
    const audited = await auditOf(o, 'social.publishing.hold');
    expect(audited.map((a) => a.reason)).toEqual(['Ngày quốc tang']);
    // Members cannot release it either; nothing was released.
    await expect(exec(o, 'social.publishing.release', {}, o.member)).rejects.toMatchObject({ status: 403 });
    expect((await holdOf(o, o.member)).held).toBe(true);
    // The team is told, all but the person who acted.
    expect(await deliver(o, 'social.publishing.held')).toBe(1);
    for (const user of [o.owner, o.member, o.viewer]) expect(await notices(o, user)).toEqual([{ state: 'held', reason: 'Ngày quốc tang' }]);
    expect(await notices(o, o.admin)).toEqual([]);
    // Released, it is history; a second release changes nothing.
    expect(await exec(o, 'social.publishing.release', {})).toEqual({ released: true, heldTooLong: 0 });
    expect(await exec(o, 'social.publishing.release', {})).toEqual({ released: false, heldTooLong: 0 });
    expect(await holdOf(o, o.viewer)).toEqual({ held: false, hold: null });
    expect(await deliver(o, 'social.publishing.released')).toBe(1);
    expect(await notices(o, o.admin)).toEqual([{ state: 'released', reason: 'Ngày quốc tang', heldTooLong: '0' }]);
    // A new hold after the release is a new row.
    const again = await exec<{ holdId: string; created: boolean }>(o, 'social.publishing.hold', { reason: 'Sự cố' });
    expect(again.created).toBe(true);
    expect(again.holdId).not.toBe(first.holdId);
    await exec(o, 'social.publishing.release', {});
  });

  it('sends no post while held, at a time or in a queue slot, and goes on for another org', async () => {
    const o = await org();
    const other = await org();
    const platform = new Counting();
    const timed = await duePost(o);
    const queued = await duePost(o, { queue: true });
    const elsewhere = await duePost(other);
    await exec(o, 'social.publishing.hold', { reason: 'Sự cố truyền thông' });

    // The scan skips the held org, and a job that runs anyway sends nothing and leaves the variants scheduled.
    const found = await due();
    expect(found).not.toContain(timed.id);
    expect(found).not.toContain(queued.id);
    expect(found).toContain(elsewhere.id);
    for (const v of [timed, queued]) {
      expect(await run(o, v.id, platform)).toEqual({ action: 'none', reason: 'held' });
      expect(await status(o, v.postId)).toEqual({ status: 'scheduled', code: null });
    }
    expect(platform.sent).toHaveLength(0);
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.external_call WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);

    // Another org's post goes out.
    await sweep(platform, [o, other]);
    expect((await get(other, elsewhere.postId)).status).toBe('published');
    expect(platform.sent).toHaveLength(1);
    await exec(o, 'social.publishing.release', {});
  });

  it('on release publishes the due posts exactly once, and leaves one more than an hour past its time to a person', async () => {
    const o = await org();
    const platform = new Counting();
    const recent = await duePost(o, { ago: '5 minutes' });
    const queued = await duePost(o, { queue: true, ago: '10 minutes' });
    const stale = await duePost(o, { ago: '2 hours' });
    const staleQueued = await duePost(o, { queue: true, ago: '90 minutes' });
    await exec(o, 'social.publishing.hold', { reason: 'Ngày quốc tang' }, o.admin);
    await sweep(platform, [o]);
    expect(platform.sent).toHaveLength(0);

    expect(await exec(o, 'social.publishing.release', {}, o.admin)).toEqual({ released: true, heldTooLong: 2 });
    for (const v of [stale, staleQueued]) {
      expect(await status(o, v.postId)).toEqual({ status: 'failed', code: HELD_TOO_LONG });
      expect((await get(o, v.postId)).status).toBe('failed');
    }
    // The audit and the team's notice say how many wait for a person.
    const audited = await auditOf(o, 'social.publishing.release');
    expect(audited.map((a) => a.held_too_long)).toEqual([2]);
    await deliver(o, 'social.publishing.released');
    expect(await notices(o, o.member)).toEqual([{ state: 'released', reason: 'Ngày quốc tang', heldTooLong: '2' }]);

    // The next sweeps publish the due ones, once each.
    await sweep(platform, [o]);
    await sweep(platform, [o]);
    for (const v of [recent, queued]) expect(await run(o, v.id, platform)).toEqual({ action: 'none', reason: 'published' });
    expect((await get(o, recent.postId)).status).toBe('published');
    expect((await get(o, queued.postId)).status).toBe('published');
    expect(platform.sent).toHaveLength(2);
    expect(await status(o, stale.postId)).toEqual({ status: 'failed', code: HELD_TOO_LONG });

    // A person publishes a stale one now.
    await exec(o, 'social.variant.retry', { variantIds: [stale.id] });
    expect(await run(o, stale.id, platform)).toMatchObject({ status: 'published' });
    expect(platform.sent).toHaveLength(3);
  });

  it('runs no first comment, repost, auto-reply or evergreen repost while held (#587, #773, #393)', async () => {
    const o = await org();
    const platform = new Counting();
    const commented = await duePost(o, { settings: { firstComment: '#khaitruong' } });
    const reposted = await duePost(o, { settings: { repost: { afterHours: 1 } } });
    const replied = await duePost(o, { settings: { autoReply: { text: 'Cảm ơn!', likes: 1 } } });
    // Published before the hold, the first comment's job left for later (the worker stopped after the post).
    const noComment: Publisher = { provider: 'sandbox', publishSafety: platform.publishSafety, publish: (i) => platform.publish(i), reconcile: (i) => platform.reconcile(i) };
    for (const v of [commented, reposted, replied]) expect(await run(o, v.id, noComment)).toMatchObject({ status: 'published' });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET published_at = now() - interval '2 hours' WHERE id = $1", [reposted.id]));
    await admin((c) => c.query("UPDATE crove_social.post SET evergreen_days = 7 WHERE id = $1", [commented.postId]));
    await admin((c) => c.query("UPDATE crove_social.post_variant SET published_at = now() - interval '8 days' WHERE id = $1", [commented.id]));
    const evergreenDue = () => admin(async (c) => (await c.query<{ post_id: string }>('SELECT post_id FROM crove_social.evergreen_due(500)')).rows.map((r) => r.post_id));
    expect(await evergreenDue()).toContain(commented.postId);

    await exec(o, 'social.publishing.hold', { reason: 'Sự cố' });
    expect(await runCommentJob(deps(platform), o.orgId, commented.id, 'sandbox')).toEqual({ action: 'none', reason: 'held' });
    expect(await worker.execute('social.repost.begin', { variantId: reposted.id, likes: null }, { actor: system, orgId: o.orgId })).toEqual({ action: 'none', reason: 'held' });
    expect(await worker.execute('social.auto_reply.begin', { variantId: replied.id, likes: 5 }, { actor: system, orgId: o.orgId })).toEqual({ action: 'none', reason: 'held' });
    expect(await evergreenDue()).not.toContain(commented.postId);
    expect(await worker.execute('social.post.repost_evergreen', { postId: commented.postId }, { actor: system, orgId: o.orgId })).toEqual({ postId: null });
    expect(platform.comments).toHaveLength(0);
    const after = await admin(async (c) => (await c.query<{ key: string }>("SELECT key FROM crove_kernel.external_call WHERE org_id = $1 AND step <> 'publish'", [o.orgId])).rows);
    expect(after).toEqual([]);
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_social.post WHERE repost_of = $1', [commented.postId])).rowCount)).toBe(0);

    // After the release each goes, once.
    await exec(o, 'social.publishing.release', {});
    expect(await runCommentJob(deps(platform), o.orgId, commented.id, 'sandbox')).toEqual({ action: 'call', state: 'succeeded' });
    expect(await worker.execute('social.repost.begin', { variantId: reposted.id, likes: null }, { actor: system, orgId: o.orgId })).toMatchObject({ action: 'call' });
    expect(await worker.execute('social.auto_reply.begin', { variantId: replied.id, likes: 5 }, { actor: system, orgId: o.orgId })).toMatchObject({ action: 'call' });
    expect(await evergreenDue()).toContain(commented.postId);
    expect(await worker.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId: commented.postId }, { actor: system, orgId: o.orgId })).toMatchObject({ postId: expect.any(String) });
  });

  it('keeps holds apart by org: another org cannot see or release them', async () => {
    const o = await org();
    const other = await org();
    await exec(o, 'social.publishing.hold', { reason: 'Riêng tổ chức này' });
    expect(await holdOf(other, other.owner)).toEqual({ held: false, hold: null });
    expect(await exec(other, 'social.publishing.release', {})).toEqual({ released: false, heldTooLong: 0 });
    expect((await holdOf(o, o.viewer)).held).toBe(true);
    // The tenant login never edits a hold's reason or removes one.
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE crove_tenant');
          await c.query('UPDATE crove_social.publish_hold SET reason = $1', ['x']);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toThrow(/permission denied/);
    await exec(o, 'social.publishing.release', {});
  });
});
