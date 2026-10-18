// Crove Social reposts and evergreen posts on PostgreSQL 17 (Social plan S9, issue #393): a repost copies a published
// post for the channels it went out on, an evergreen post gets one repost per period sent to review, never a second
// while one is open, and a post whose channels are gone stops being evergreen.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Publisher, PublishResult, ReconcileResult } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { runPublishJob, socialCommands, socialQueries, sweepEvergreen, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A platform that takes every post.
class Platform implements Publisher {
  readonly provider = 'sandbox' as const;
  readonly publishSafety = 'reconcile_only' as const;
  n = 0;
  async publish(): Promise<PublishResult> {
    this.n += 1;
    return { kind: 'accepted', externalId: `post-${this.n}`, url: null };
  }
  async status(): Promise<PublishResult> {
    return { kind: 'unknown' };
  }
  async reconcile(): Promise<ReconcileResult> {
    return { found: 'unknown' };
  }
}

suite('social reposts and evergreen posts on PostgreSQL (S9)', () => {
  const dbName = `crove_test_social_evergreen_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string };

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
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@evergreen.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  const exec = <O>(o: Org, name: string, input: unknown) => api.execute<O>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
  const get = (o: Org, postId: string) => api.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });

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

  // A post on two channels, the second with its own text, approved and published on both.
  async function published(o: Org) {
    const a = await connect(o);
    const b = await connect(o);
    const body = `Khai trương ${randomUUID().slice(0, 6)}`;
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body, channels: [{ connectionId: a }, { connectionId: b, body: 'Riêng kênh B' }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    const platform = new Platform();
    for (const v of post.variants) await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, v.id, 'sandbox');
    expect((await get(o, postId)).status).toBe('published');
    return { postId, body, connections: [a, b] };
  }

  const reposts = (sourceId: string) =>
    admin(async (c) => (await c.query<{ id: string; status: string }>('SELECT id, status FROM crove_social.post WHERE repost_of = $1 ORDER BY created_at', [sourceId])).rows);
  const agePublished = (postId: string, days: number) =>
    admin((c) => c.query('UPDATE crove_social.post_variant SET published_at = now() - make_interval(days => $2) WHERE post_id = $1', [postId, days]));
  const sweep = () => sweepEvergreen({ runtime: worker, workerDb });
  const repostNow = (o: Org, postId: string) =>
    worker.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId }, { actor: { type: 'system', component: 'social-evergreen-test' }, orgId: o.orgId });

  // An image uploaded for Social, as the upload route records it.
  async function image(orgId: string) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, 'anh.jpg', 'image/jpeg', 120000, 'social')`,
        [orgId, id, sha, `org/${orgId}/${sha}`, `content:${sha}`],
      ),
    );
    return { fileId: id, generation: `content:${sha}`, altText: null, mime: 'image/jpeg', sizeBytes: 120_000 };
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

  it('reposts a published post as a draft for the same channels, keeping a channel its own text', async () => {
    const o = await org();
    const { postId, body, connections } = await published(o);
    const { postId: copy } = await exec<{ postId: string }>(o, 'social.post.repost', { postId });
    const view = await get(o, copy);
    expect([view.status, view.body, view.repostOf, view.evergreenDays]).toEqual(['draft', body, postId, null]);
    expect(view.variants.map((v) => [v.connectionId, v.status, v.effective.body])).toEqual([
      [connections[0], 'draft', body],
      [connections[1], 'draft', 'Riêng kênh B'],
    ]);

    // Nothing went out yet: there is nothing to repost.
    await expect(exec(o, 'social.post.repost', { postId: copy })).rejects.toMatchObject({ code: 'NOTHING_TO_REPOST' });
  });

  it("binds a channel's own images into the repost's hash, so its approval covers them", async () => {
    const o = await org();
    const { postId } = await published(o);
    // The second channel went out with an image the post no longer has.
    const own = await image(o.orgId);
    await admin((c) => c.query('UPDATE crove_social.post_variant SET media = $2::jsonb WHERE post_id = $1 AND position = 1', [postId, JSON.stringify([own])]));
    const { postId: copy } = await exec<{ postId: string }>(o, 'social.post.repost', { postId });
    const view = await get(o, copy);
    expect(view.variants.map((v) => v.media.map((m) => m.fileId))).toEqual([[], [own.fileId]]);
    // A save that changes nothing a hash covers (the time zone) finds every hash current: nothing goes back to draft.
    const saved = await exec<{ changedVariants: string[] }>(o, 'social.post.update', { postId: copy, revision: view.revision, timeZone: 'Asia/Bangkok' });
    expect(saved.changedVariants).toEqual([]);
  });

  it('reposts what went out, not a title or link added to the post since, and leaves out a removed image', async () => {
    const o = await org();
    const { postId, body } = await published(o);
    // After publishing, the post gets a title and a link it did not go out with.
    await admin((c) => c.query("UPDATE crove_social.post SET title = 'Tiêu đề mới', link_url = 'https://example.com/moi' WHERE id = $1", [postId]));
    // The second channel went out with an image that has been removed since.
    const own = await image(o.orgId);
    await admin((c) => c.query('UPDATE crove_social.post_variant SET media = $2::jsonb WHERE post_id = $1 AND position = 1', [postId, JSON.stringify([own])]));
    await admin((c) => c.query('DELETE FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, own.fileId]));
    const { postId: copy } = await exec<{ postId: string }>(o, 'social.post.repost', { postId });
    const view = await get(o, copy);
    expect([view.body, view.title, view.linkUrl]).toEqual([body, null, null]);
    expect(view.variants.map((v) => [v.effective.title, v.effective.linkUrl])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(view.variants[1]?.media).toEqual([]);
  });

  it('marks a post evergreen within 7 to 365 days, and only the worker may scan for due ones', async () => {
    const o = await org();
    const { postId } = await published(o);
    expect(await exec(o, 'social.post.set_evergreen', { postId, days: 30 })).toEqual({ postId, evergreenDays: 30 });
    expect((await get(o, postId)).evergreenDays).toBe(30);
    await expect(exec(o, 'social.post.set_evergreen', { postId, days: 3 })).rejects.toBeDefined();
    await expect(exec(o, 'social.post.repost_evergreen', { postId })).rejects.toBeDefined();
    await expect(appPool.query('SELECT * FROM crove_social.evergreen_due(10)')).rejects.toMatchObject({ code: '42501' });
    expect(await exec(o, 'social.post.set_evergreen', { postId, days: null })).toEqual({ postId, evergreenDays: null });
  });

  it('reposts an evergreen post once per period and sends the repost to review', async () => {
    const o = await org();
    const { postId } = await published(o);
    await exec(o, 'social.post.set_evergreen', { postId, days: 7 });

    // Not due yet.
    await sweep();
    expect(await reposts(postId)).toEqual([]);

    await agePublished(postId, 8);
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const [first] = await reposts(postId);
    if (!first) throw new Error('no repost');
    const view = await get(o, first.id);
    expect(view.variants.map((v) => v.status)).toEqual(['in_review', 'in_review']);

    // While it waits for a person, no second one; once it is dropped, the period runs from the repost.
    await sweep();
    expect(await reposts(postId)).toHaveLength(1);
    await exec(o, 'social.variant.cancel', { variantIds: view.variants.map((v) => v.id) });
    await sweep();
    expect(await reposts(postId)).toHaveLength(1);
    await admin((c) => c.query("UPDATE crove_social.post SET created_at = now() - interval '8 days' WHERE id = $1", [first.id]));
    await sweep();
    expect(await reposts(postId)).toHaveLength(2);
  });

  it('makes no second repost when two runs race, nor one after evergreen is turned off', async () => {
    const o = await org();
    const { postId } = await published(o);
    await exec(o, 'social.post.set_evergreen', { postId, days: 7 });
    await agePublished(postId, 8);
    const [a, b] = await Promise.all([repostNow(o, postId), repostNow(o, postId)]);
    expect([a.postId, b.postId].filter(Boolean)).toHaveLength(1);
    expect(await reposts(postId)).toHaveLength(1);

    const other = await published(o);
    await exec(o, 'social.post.set_evergreen', { postId: other.postId, days: 7 });
    await agePublished(other.postId, 8);
    await exec(o, 'social.post.set_evergreen', { postId: other.postId, days: null });
    expect(await repostNow(o, other.postId)).toEqual({ postId: null });
  });

  it('keeps an evergreen post whose channels are only expired, and reposts once they are back', async () => {
    const o = await org();
    const { postId, connections } = await published(o);
    await exec(o, 'social.post.set_evergreen', { postId, days: 7 });
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = ANY($1::uuid[])", [connections]));
    await agePublished(postId, 8);
    await sweep();
    expect(await reposts(postId)).toEqual([]);
    expect((await get(o, postId)).evergreenDays).toBe(7);
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'active' WHERE id = ANY($1::uuid[])", [connections]));
    await sweep();
    expect(await reposts(postId)).toHaveLength(1);
  });
  it('stops being evergreen when none of its channels is connected any more', async () => {
    const o = await org();
    const { postId, connections } = await published(o);
    await exec(o, 'social.post.set_evergreen', { postId, days: 7 });
    for (const connectionId of connections) await exec(o, 'kernel.channel.disconnect', { connectionId });
    await agePublished(postId, 8);
    await sweep();
    expect(await reposts(postId)).toEqual([]);
    expect((await get(o, postId)).evergreenDays).toBeNull();
  });
});
