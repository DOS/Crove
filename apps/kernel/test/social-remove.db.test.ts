// Removing a published post from its platform on PostgreSQL 17 (#860): an owner asks, the remove job takes the post
// down through the sandbox adapter as its own recorded call, and the channel shows when and by whom; members, viewers
// and channels whose adapter cannot remove are refused, and asking twice changes nothing.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxPublisher, type Publisher, type RemoveInput, type RemoveResult } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { runPublishJob, runRemoveJob, socialCommands, socialQueries, type ActivityItem, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type Org = { orgId: string; owner: string };

suite('removing a published post on PostgreSQL (#860)', () => {
  const dbName = `crove_test_social_remove_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
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

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@remove.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function member(o: Org, role: 'admin' | 'member' | 'viewer'): Promise<string> {
    const id = await person(role);
    await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [o.orgId, id, role]));
    return id;
  }

  const exec = <O>(o: Org, name: string, input: unknown, userId = o.owner) => api.execute<O>(name, input, { actor: asUser(userId), orgId: o.orgId });
  const get = (o: Org, postId: string) => api.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });

  async function connect(o: Org, account: string) {
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_test' }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: account });
    return exec<{ connectionId: string }>(o, 'kernel.channel.connect', {
      provider: 'sandbox',
      externalAccountId: account,
      displayName: 'Trang thử',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
  }

  // A post approved, due and published on a fresh sandbox channel.
  async function publishedPost(o: Org, platform: Publisher) {
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const { connectionId } = await connect(o, account);
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: `Bài ${randomUUID().slice(0, 6)}`, channels: [{ connectionId }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    const id = post.variants[0]?.id as string;
    expect(await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, id, 'sandbox')).toMatchObject({ status: 'published' });
    return { postId, id, account };
  }

  const deps = (platform: Publisher) => ({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 });
  const variant = async (o: Org, postId: string) => (await get(o, postId)).variants[0] as PostView['variants'][number];
  const events = (o: Org, type: string) =>
    admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>('SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY created_at', [o.orgId, type])).rows.map((r) => r.payload));
  const removeCalls = (id: string) =>
    admin(async (c) => (await c.query<{ key: string; state: string; retry_safety: string; error_code: string | null }>("SELECT key, state, retry_safety, error_code FROM crove_kernel.external_call WHERE key LIKE $1 ORDER BY started_at, key", [`social.publish:${id}:%:remove%`])).rows);
  const metricsDue = async (id: string) =>
    admin(async (c) => (await c.query<{ variant_id: string }>("SELECT variant_id FROM crove_social.metrics_due(1000, ARRAY['sandbox'], 600)")).rows.some((r) => r.variant_id === id));

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

  it('takes a published post down once, records the call and the ask, and shows when and by whom', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id, account } = await publishedPost(o, sandbox);
    expect(sandbox.posts(account)).toHaveLength(1);
    expect(await metricsDue(id)).toBe(true);

    expect(await exec(o, 'social.variant.remove', { variantId: id, reason: '  Sai giá khuyến mãi  ' })).toEqual({ postId, variantId: id, status: 'published', queued: true });
    expect(await events(o, 'social.variant.remove_requested')).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', after: null }]);
    // Still up until the platform answers; a second ask while it is on its way queues nothing.
    expect(await variant(o, postId)).toMatchObject({ status: 'published', removal: { state: 'pending', code: null }, removedAt: null });
    expect(await exec(o, 'social.variant.remove', { variantId: id })).toEqual({ postId, variantId: id, status: 'published', queued: false });
    expect(await events(o, 'social.variant.remove_requested')).toHaveLength(1);

    expect(await runRemoveJob(deps(sandbox), o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(sandbox.posts(account)).toHaveLength(0);
    const v = await variant(o, postId);
    expect(v).toMatchObject({ status: 'removed', removedBy: o.owner, removeReason: 'Sai giá khuyến mãi', removal: null });
    expect(Date.parse(v.removedAt as string)).toBeGreaterThan(Date.parse(v.publishedAt as string) - 1);
    // A post whose only channel is removed counts as cancelled; the channel says it was removed.
    expect((await get(o, postId)).status).toBe('cancelled');
    expect(await removeCalls(id)).toEqual([{ key: `social.publish:${id}:1:1:remove`, state: 'succeeded', retry_safety: 'idempotent', error_code: null }]);
    expect(await events(o, 'social.variant.removed')).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', by: o.owner }]);
    const audit = await admin(async (c) => (await c.query<{ actor_id: string; target_id: string; detail: Record<string, unknown> }>("SELECT actor_id, target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.variant.remove' AND outcome = 'ok' ORDER BY occurred_at", [o.orgId])).rows);
    expect(audit[0]).toEqual({ actor_id: o.owner, target_id: id, detail: { post_id: postId, variant_id: id, provider: 'sandbox', reason: 'Sai giá khuyến mãi' } });
    // Metrics stop: the sweep reads published variants only.
    expect(await metricsDue(id)).toBe(false);
    const activity = await api.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(activity.items.find((i) => i.kind === 'removed')).toMatchObject({ userId: o.owner, variantId: id, body: 'Sai giá khuyến mãi' });

    // Idempotent: a second job of the ask, and another ask, change nothing.
    expect(await runRemoveJob(deps(sandbox), o.orgId, id, 'sandbox', null)).toEqual({ action: 'none', reason: 'removed' });
    expect(await exec(o, 'social.variant.remove', { variantId: id })).toEqual({ postId, variantId: id, status: 'removed', queued: false });
    expect(await removeCalls(id)).toHaveLength(1);
    // A removed channel is history: never edited, cancelled or published again.
    await expect(exec(o, 'social.variant.cancel', { variantIds: [id] })).rejects.toMatchObject({ code: 'VARIANT_STATE' });
    await expect(exec(o, 'social.variant.retry', { variantIds: [id] })).rejects.toMatchObject({ code: 'VARIANT_STATE' });
  });

  it('keeps the post up when the platform refuses, and asks again once per ask', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const answers: RemoveResult[] = [{ kind: 'rejected', error: 'rate_limited', code: 'SLOW_DOWN', retryAt: new Date(Date.now() + 60_000) }, { kind: 'unknown', code: 'TIMEOUT' }];
    const flaky: Publisher = {
      provider: 'sandbox',
      publishSafety: sandbox.publishSafety,
      publish: (i) => sandbox.publish(i),
      remove: async (i: RemoveInput) => answers.shift() ?? sandbox.remove(i),
    };
    const { postId, id, account } = await publishedPost(o, flaky);
    const key = `social.publish:${id}:1:1:remove`;

    await exec(o, 'social.variant.remove', { variantId: id });
    expect(await runRemoveJob(deps(flaky), o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'failed' });
    expect(await variant(o, postId)).toMatchObject({ status: 'published', removal: { state: 'failed', code: 'SLOW_DOWN' } });
    expect(await events(o, 'social.variant.remove_failed')).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', code: 'SLOW_DOWN' }]);
    expect(sandbox.posts(account)).toHaveLength(1);

    // Asked again: the ask names the call it saw; a job of the first ask is stale now.
    expect(await exec(o, 'social.variant.remove', { variantId: id, reason: 'Thử lại' })).toMatchObject({ queued: true });
    expect((await events(o, 'social.variant.remove_requested')).at(-1)).toEqual({ post_id: postId, variant_id: id, provider: 'sandbox', after: key });
    expect(await runRemoveJob(deps(flaky), o.orgId, id, 'sandbox', null)).toEqual({ action: 'none', reason: 'stale' });
    expect(await runRemoveJob(deps(flaky), o.orgId, id, 'sandbox', key)).toEqual({ action: 'call', state: 'ambiguous' });
    expect(await variant(o, postId)).toMatchObject({ status: 'published', removal: { state: 'unknown', code: 'TIMEOUT' } });
    // An unclear removal is asked again by a person, never by the job: the same ask's second job stops.
    expect(await runRemoveJob(deps(flaky), o.orgId, id, 'sandbox', key)).toEqual({ action: 'none', reason: 'stale' });
    await exec(o, 'social.variant.remove', { variantId: id });
    expect(await runRemoveJob(deps(flaky), o.orgId, id, 'sandbox', `${key}_2`)).toEqual({ action: 'call', state: 'succeeded' });
    expect(await removeCalls(id)).toEqual([
      { key, state: 'failed', retry_safety: 'idempotent', error_code: 'SLOW_DOWN' },
      { key: `${key}_2`, state: 'ambiguous', retry_safety: 'idempotent', error_code: 'TIMEOUT' },
      { key: `${key}_3`, state: 'succeeded', retry_safety: 'idempotent', error_code: null },
    ]);
    expect(await variant(o, postId)).toMatchObject({ status: 'removed', removeReason: null });
    expect(sandbox.posts(account)).toHaveLength(0);
  });

  it('refuses members and viewers, a channel that is not published, and one whose adapter cannot remove', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id } = await publishedPost(o, sandbox);
    for (const role of ['member', 'viewer'] as const) {
      await expect(exec(o, 'social.variant.remove', { variantId: id }, await member(o, role))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // An admin may.
    expect(await exec(o, 'social.variant.remove', { variantId: id }, await member(o, 'admin'))).toMatchObject({ queued: true });
    await expect(exec(o, 'social.variant.remove', { variantId: id, reason: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'VALIDATION' });

    const { connectionId } = await connect(o, `acct-${randomUUID().slice(0, 8)}`);
    const draft = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Nháp', channels: [{ connectionId }] });
    const draftId = (await get(o, draft.postId)).variants[0]?.id as string;
    await expect(exec(o, 'social.variant.remove', { variantId: draftId })).rejects.toMatchObject({ code: 'VARIANT_NOT_PUBLISHED' });

    // A published channel on a platform whose adapter has no remove (as if it were a Facebook Page).
    const other = await publishedPost(o, sandbox);
    await admin((c) => c.query("UPDATE crove_social.post_variant SET provider = 'facebook_page' WHERE id = $1", [other.id]));
    await expect(exec(o, 'social.variant.remove', { variantId: other.id })).rejects.toMatchObject({ code: 'REMOVE_NOT_SUPPORTED' });
    // And the job never removes what the command did not ask for.
    expect(await runRemoveJob(deps(sandbox), o.orgId, other.id, 'sandbox', null)).toEqual({ action: 'none', reason: 'provider_mismatch' });
    expect((await variant(o, postId)).status).toBe('published');
  });
});
