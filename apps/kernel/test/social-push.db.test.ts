// Browser push for Social notifications on PostgreSQL 17 (#1238): a member's subscriptions are theirs alone, the
// dispatch names the notifications to push, the push job sends to the member's devices and records the answers (404
// and 410 delete, other failures count up to the limit), and a disabled account, a member who left, a read notice or a
// kind that is not pushed get nothing. The push carries no post text. The sender is a fake that
// records each request; the encryption is checked against RFC 8291 in web-push.test.ts. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { PUSH_DEVICE_LIMIT, PUSH_FAILURE_LIMIT, socialCommands, socialQueries, type PushDevice } from '@crove/mod-social';
import { createPushSender, generateVapidKeys, loadVapidKeys, runPushJob, type PushSender } from '../src/web-push.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A browser's subscription keys: its P-256 public key and auth secret.
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}
const endpoint = () => `https://push.example.com/send/${randomUUID()}`;

suite('social browser push on PostgreSQL (#1238)', () => {
  const dbName = `crove_test_social_push_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
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
  const one = async <T extends pg.QueryResultRow>(text: string, values: unknown[]) => admin(async (c) => (await c.query<T>(text, values)).rows);

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@push.test`, name: null });
  }
  type Org = { orgId: string; owner: string; admin: string; member: string; dispatched: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, owner, admin: await person('admin'), member: await person('member'), dispatched: new Set<string>() };
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, o.admin, o.member]));
    return o;
  }
  async function connection(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        o.owner,
      ]),
    );
    return id;
  }
  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const devices = (o: Org, user: string, ep: string | null = null) => rt.query<{ devices: PushDevice[]; subscribed: boolean }>('social.push.devices', { endpoint: ep }, { actor: asUser(user), orgId: o.orgId });
  const subscribe = (o: Org, user: string, ep = endpoint(), label = 'Chrome trên Windows') => exec<{ id: string }>(o, user, 'social.push.subscribe', { endpoint: ep, ...browserKeys(), label });
  const rows = (o: Org) =>
    one<{ id: string; user_id: string; failure_count: number; last_used_at: Date | null }>('SELECT id, user_id, failure_count, last_used_at FROM crove_social.push_subscription WHERE org_id = $1 ORDER BY id', [o.orgId]);

  // What the worker does for each new event: the dispatch; returns the notifications it names for push.
  async function deliver(o: Org): Promise<string[]> {
    const events = await one<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 ORDER BY created_at, id', [o.orgId]);
    const push: string[] = [];
    for (const e of events) {
      if (o.dispatched.has(e.id)) continue;
      o.dispatched.add(e.id);
      push.push(...(await worker.execute<{ push: string[] }>('social.notification.dispatch', { eventId: e.id }, { actor: system, orgId: o.orgId })).push);
    }
    return push;
  }
  // A post the member sends for review: the owner and the admin are told (review_requested, a pushed kind).
  async function reviewAsked(o: Org, body: string) {
    const conn = await connection(o);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    return { postId, push: await deliver(o) };
  }
  const notificationOf = async (o: Org, ids: string[], user: string) => (await one<{ id: string }>('SELECT id FROM crove_social.notification WHERE org_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])', [o.orgId, user, ids]))[0]?.id as string;

  // A fake push service: answers each endpoint with the status the test gives it (201 by default) and keeps the requests.
  function fakeService(statusOf: (url: string) => number = () => 201) {
    const pair = generateVapidKeys();
    const keys = loadVapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: 'mailto:ops@push.test' });
    if (!keys) throw new Error('no keys');
    const requests: { url: string; headers: Record<string, string>; bytes: number }[] = [];
    const sender: PushSender = createPushSender(keys, {
      request: async (url, request) => {
        requests.push({ url, headers: { ...request.headers }, bytes: request.body?.length ?? 0 });
        return { url, status: statusOf(url), contentType: null, body: Buffer.alloc(0), truncated: false };
      },
    });
    // The plaintext of each send, before encryption, to check what a push says.
    const payloads: string[] = [];
    const spy: PushSender = { publicKey: sender.publicKey, send: async (s, payload) => (payloads.push(payload), sender.send(s, payload)) };
    return { sender: spy, requests, payloads };
  }
  const push = (sender: PushSender, o: Org, notificationId: string) => runPushJob({ runtime: worker, sender, brand: 'Crove' }, { orgId: o.orgId, notificationId });

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
    appUrl = app.toString();
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
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

  it('keeps a subscription to its member: listed, refreshed and removed by them only, never its endpoint or keys', async () => {
    const o = await org();
    const ep = endpoint();
    const { id } = await subscribe(o, o.member, ep);
    expect(await devices(o, o.member, ep)).toEqual({ subscribed: true, devices: [{ id, label: 'Chrome trên Windows', createdAt: expect.any(String), lastUsedAt: null, current: true }] });
    expect(JSON.stringify(await devices(o, o.member, ep))).not.toContain('push.example.com');
    // Another member of the org, even an owner, sees none of it and cannot remove it.
    expect(await devices(o, o.owner, ep)).toEqual({ subscribed: false, devices: [] });
    expect(await exec(o, o.owner, 'social.push.unsubscribe', { id })).toEqual({ removed: 0 });
    expect(await exec(o, o.owner, 'social.push.unsubscribe', { endpoint: ep })).toEqual({ removed: 0 });
    // The table's own policy, below the commands: in a member's context (crove_app, as the API) a member reads and
    // deletes only their own rows; the owner's context sees none of the member's, endpoints and keys included.
    const asApp = async <T>(user: string, fn: (c: pg.Client) => Promise<T>) => {
      const client = new pg.Client({ connectionString: appUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [user, o.orgId]);
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.end();
      }
    };
    expect(await asApp(o.member, async (c) => (await c.query('SELECT endpoint, p256dh, auth FROM crove_social.push_subscription')).rowCount)).toBe(1);
    expect(await asApp(o.owner, async (c) => (await c.query('SELECT endpoint, p256dh, auth FROM crove_social.push_subscription')).rowCount)).toBe(0);
    expect(await asApp(o.owner, async (c) => (await c.query('DELETE FROM crove_social.push_subscription')).rowCount)).toBe(0);
    await expect(
      asApp(o.owner, (c) => c.query('INSERT INTO crove_social.push_subscription (org_id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)', [o.orgId, o.member, endpoint(), browserKeys().p256dh, browserKeys().auth])),
    ).rejects.toThrow(/row-level security/);
    const policy = await one<{ permissive: string }>("SELECT permissive FROM pg_policies WHERE schemaname = 'crove_social' AND tablename = 'push_subscription' AND policyname = 'own_push_subscription'", []);
    expect(policy).toEqual([{ permissive: 'RESTRICTIVE' }]);

    // The same endpoint again refreshes its keys and label and clears its failures: still one row.
    await admin((c) => c.query('UPDATE crove_social.push_subscription SET failure_count = 3 WHERE id = $1', [id]));
    expect((await subscribe(o, o.member, ep, 'Firefox trên Linux')).id).toBe(id);
    expect((await rows(o)).map((r) => r.failure_count)).toEqual([0]);
    expect((await devices(o, o.member, ep)).devices.map((d) => d.label)).toEqual(['Firefox trên Linux']);
    // The browser's spelling of the URL and the stored one always match.
    expect(await exec(o, o.member, 'social.push.unsubscribe', { endpoint: ep })).toEqual({ removed: 1 });
    expect(await rows(o)).toEqual([]);
  });

  it('refuses an endpoint that is not https or keys that are not a P-256 point and a 16-byte secret, and keeps 10 devices', async () => {
    const o = await org();
    const keys = browserKeys();
    for (const bad of [
      { endpoint: 'http://push.example.com/x', ...keys },
      { endpoint: 'https://user:pw@push.example.com/x', ...keys },
      { endpoint: endpoint(), p256dh: randomBytes(65).toString('base64url'), auth: keys.auth },
      // The right length and prefix, but not a point on the curve.
      { endpoint: endpoint(), p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: keys.auth },
      { endpoint: endpoint(), p256dh: keys.p256dh, auth: randomBytes(8).toString('base64url') },
    ]) {
      await expect(exec(o, o.member, 'social.push.subscribe', bad)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // Padded standard base64, as some browsers give it, is stored as base64url.
    const padded = { endpoint: endpoint(), p256dh: Buffer.from(keys.p256dh, 'base64url').toString('base64'), auth: Buffer.from(keys.auth, 'base64url').toString('base64') };
    await exec(o, o.member, 'social.push.subscribe', padded);
    expect(await one('SELECT p256dh, auth FROM crove_social.push_subscription WHERE org_id = $1', [o.orgId])).toEqual([{ p256dh: keys.p256dh, auth: keys.auth }]);
    for (let i = 0; i < PUSH_DEVICE_LIMIT + 2; i++) await subscribe(o, o.member);
    expect(await rows(o)).toHaveLength(PUSH_DEVICE_LIMIT);
  });

  it('pushes a notice someone must act on to each of their devices, with no post text, and records each answer', async () => {
    const o = await org();
    const gone = endpoint();
    const missing = endpoint();
    const busy = endpoint();
    const ok = endpoint();
    for (const ep of [gone, missing, busy, ok]) await subscribe(o, o.admin, ep);
    await subscribe(o, o.owner);
    const { postId, push: ids } = await reviewAsked(o, 'Khai trương cửa hàng bí mật');
    // One notification each for the owner and the admin (the author is never told).
    expect(ids).toHaveLength(2);
    const notice = await notificationOf(o, ids, o.admin);
    const service = fakeService((url) => (url === gone ? 410 : url === missing ? 404 : url === busy ? 503 : 201));
    expect(await push(service.sender, o, notice)).toEqual({ sent: 1, gone: 2, failed: 1 });
    // Every device of the admin was posted to, with a VAPID token for the push service's origin.
    expect(service.requests.map((r) => r.url).sort()).toEqual([gone, missing, busy, ok].sort());
    expect(service.requests.every((r) => r.headers.authorization?.startsWith(`vapid t=`) && r.headers['content-encoding'] === 'aes128gcm' && r.headers.ttl === '86400')).toBe(true);
    const slug = (await one<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [o.orgId]))[0]?.slug;
    expect(JSON.parse(service.payloads[0] ?? '{}')).toEqual({ title: 'Crove', body: 'Có bài đang chờ bạn duyệt', url: `/o/${slug}/social/${postId}`, tag: `review_requested:${postId}` });
    for (const p of service.payloads) expect(p).not.toContain('Khai trương');
    // 404 and 410 deleted; the failed one counts; the delivered one is marked used.
    const after = await one<{ endpoint: string; failure_count: number; used: boolean }>('SELECT endpoint, failure_count, last_used_at IS NOT NULL AS used FROM crove_social.push_subscription WHERE org_id = $1 AND user_id = $2 ORDER BY endpoint', [o.orgId, o.admin]);
    expect(after).toEqual([{ endpoint: busy, failure_count: 1, used: false }, { endpoint: ok, failure_count: 0, used: true }].sort((a, b) => a.endpoint.localeCompare(b.endpoint)));
    // The owner's own notice reaches only the owner's device.
    const owners = fakeService();
    expect(await push(owners.sender, o, await notificationOf(o, ids, o.owner))).toEqual({ sent: 1, gone: 0, failed: 0 });

    // A subscription that keeps failing goes at the limit.
    await admin((c) => c.query('UPDATE crove_social.push_subscription SET failure_count = $3 WHERE org_id = $1 AND endpoint = $2', [o.orgId, busy, PUSH_FAILURE_LIMIT - 1]));
    expect(await push(fakeService(() => 500).sender, o, notice)).toEqual({ sent: 0, gone: 0, failed: 2 });
    expect((await one<{ endpoint: string }>('SELECT endpoint FROM crove_social.push_subscription WHERE org_id = $1 AND user_id = $2', [o.orgId, o.admin])).map((r) => r.endpoint)).toEqual([ok]);
  });

  it('pushes nothing for a kind that is not pushed, a read notice, a disabled account or a member who left', async () => {
    const o = await org();
    await subscribe(o, o.admin);
    await subscribe(o, o.owner);
    await subscribe(o, o.member);
    // An internal comment is an in-app notice only: the dispatch names nothing to push.
    const { postId, push: ids } = await reviewAsked(o, 'Bài thử');
    await exec(o, o.owner, 'social.post_comment.add', { postId, body: 'Ảnh hơi tối' });
    expect(await deliver(o)).toEqual([]);
    const comment = (await one<{ id: string }>("SELECT id FROM crove_social.notification WHERE org_id = $1 AND kind = 'comment'", [o.orgId]))[0]?.id as string;
    expect(await worker.query('social.push.targets', { notificationId: comment }, { actor: system, orgId: o.orgId })).toBeNull();
    // Read before the job ran.
    const ownerNotice = await notificationOf(o, ids, o.owner);
    await exec(o, o.owner, 'social.notification.read', { ids: [ownerNotice] });
    expect(await push(fakeService().sender, o, ownerNotice)).toEqual({ sent: 0, gone: 0, failed: 0 });
    // The admin's account disabled: nothing, and the subscription stays for when it is enabled again.
    const adminNotice = await notificationOf(o, ids, o.admin);
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [o.admin]));
    const service = fakeService();
    expect(await push(service.sender, o, adminNotice)).toEqual({ sent: 0, gone: 0, failed: 0 });
    expect(service.requests).toEqual([]);
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [o.admin]));
    expect(await push(fakeService().sender, o, adminNotice)).toEqual({ sent: 1, gone: 0, failed: 0 });
    // A member who left: the subscriptions go with the membership, and nothing is sent.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.admin]));
    expect((await rows(o)).map((r) => r.user_id).sort()).toEqual([o.owner, o.member].sort());
    expect(await push(fakeService().sender, o, adminNotice)).toEqual({ sent: 0, gone: 0, failed: 0 });
  });

  it('keeps the bookkeeping commands to the system and the member commands to users', async () => {
    const o = await org();
    const { id } = await subscribe(o, o.member);
    await expect(rt.execute('social.push.record', { results: [{ id, outcome: 'gone' }] }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('social.push.targets', { notificationId: randomUUID() }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(worker.execute('social.push.subscribe', { endpoint: endpoint(), ...browserKeys() }, { actor: system, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    expect(await rows(o)).toHaveLength(1);
  });
});
