// Taking a post down at a set time on PostgreSQL 17 (#861): a published post whose settings.removeAt has come is asked
// to come down by the worker's sweep (no member, no reason), the remove job takes it down, and the channel shows it as
// removed by nobody. A channel whose adapter cannot remove, a post that went out after its takedown time and one
// already asked for are never picked; the commands refuse a takedown less than five minutes after the post goes out.
// A planned ask whose job never recorded an answer is told to the owners and admins by its watch (#937).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlueskyPublisher, SandboxPublisher, ZaloOaPublisher, type Fetch, type Publisher } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { removeWindowMs, runPublishJob, runRemoveJob, runRemoveWatch, socialCommands, socialQueries, sweepRemovals, type PostView, type Provider } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type Org = { orgId: string; owner: string };

// A time as the composer of a person in Vietnam would write it, with its +07:00 offset.
const inVietnam = (ms: number) => `${new Date(ms + 7 * 3_600_000).toISOString().slice(0, 19)}+07:00`;

suite('taking a post down at a set time on PostgreSQL (#861)', () => {
  const dbName = `crove_test_social_remove_at_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
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

  async function org(): Promise<Org> {
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@remove-at.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  const exec = <O>(o: Org, name: string, input: unknown) => api.execute<O>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
  const get = (o: Org, postId: string) => api.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const variant = async (o: Org, postId: string) => (await get(o, postId)).variants[0] as PostView['variants'][number];

  async function connect(o: Org, provider: Provider, account: string, secret: string) {
    const sealed = vault.seal(secret, { orgId: o.orgId, provider, externalAccountId: account });
    return exec<{ connectionId: string }>(o, 'kernel.channel.connect', {
      provider,
      externalAccountId: account,
      displayName: 'Trang thử',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
  }

  // A post with these settings, approved and scheduled an hour from now.
  async function scheduledPost(o: Org, provider: Provider, settings: Record<string, unknown>, account = `acct-${randomUUID().slice(0, 8)}`, secret = JSON.stringify({ accessToken: 'sbx_test' })) {
    const { connectionId } = await connect(o, provider, account, secret);
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: `Bài ${randomUUID().slice(0, 6)}`, channels: [{ connectionId, settings }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    return { postId, id: post.variants[0]?.id as string, account };
  }

  // Published now, through the publish job; then its takedown time moved to `removeAt` and the time it went out to
  // `publishedAgoMs` ago, as if the post had gone out earlier in the day.
  async function publishedPost(o: Org, platform: Publisher, opts: { removeAt: string | null; publishedAgoMs: number; provider?: Provider; account?: string; secret?: string }) {
    const provider = opts.provider ?? 'sandbox';
    const { postId, id, account } = await scheduledPost(o, provider, {}, opts.account, opts.secret);
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE id = $1", [id]));
    expect(await runPublishJob({ runtime: worker, broker: vault, publishers: { [provider]: platform }, callTimeoutMs: 2_000 }, o.orgId, id, provider)).toMatchObject({ status: 'published' });
    await admin((c) =>
      c.query(
        `UPDATE crove_social.post_variant SET published_at = now() - make_interval(secs => $2::double precision / 1000),
           settings = CASE WHEN $3::text IS NULL THEN settings - 'removeAt' ELSE jsonb_set(settings, '{removeAt}', to_jsonb($3::text)) END
         WHERE id = $1`,
        [id, opts.publishedAgoMs, opts.removeAt],
      ),
    );
    return { postId, id, account };
  }

  const requested = (o: Org, id: string) =>
    admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.variant.remove_requested' AND payload->>'variant_id' = $2", [o.orgId, id])).rows.map((r) => r.payload));
  const due = (providers: string[]) => admin(async (c) => (await c.query<{ variant_id: string }>('SELECT variant_id FROM crove_social.remove_due(1000, $1, $2)', [providers, providers.map((p) => Math.floor(removeWindowMs(p) / 1000))])).rows.map((r) => r.variant_id));
  const sweep = (providers: string[] = ['sandbox']) => sweepRemovals({ runtime: worker, workerDb }, new Set(providers));

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

  it('takes a published post down when its time comes, once, with nobody asking', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    // Set for 22:00 (Vietnam time) on a post that went out this morning: that time came a minute ago.
    const removeAt = inVietnam(Date.now() - 60_000);
    const { postId, id, account } = await publishedPost(o, sandbox, { removeAt, publishedAgoMs: 10 * 3_600_000 });
    expect(await variant(o, postId)).toMatchObject({ status: 'published', removal: null });
    expect(await due(['sandbox'])).toContain(id);

    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const asked = await requested(o, id);
    expect(asked).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', after: null, scheduled: true }]);
    expect(await variant(o, postId)).toMatchObject({ status: 'published', removal: { state: 'pending', code: null } });
    const audit = await admin(async (c) => (await c.query<{ actor_type: string; detail: Record<string, unknown> }>("SELECT actor_type, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.remove.schedule' AND outcome = 'ok'", [o.orgId])).rows);
    expect(audit).toEqual([{ actor_type: 'system', detail: expect.objectContaining({ post_id: postId, variant_id: id, provider: 'sandbox', scheduled: true, remove_at: new Date(Date.parse(removeAt)).toISOString() }) }]);
    // Asked already: a later sweep, before the job ran, asks nothing more.
    await sweep();
    expect(await requested(o, id)).toHaveLength(1);
    expect(await due(['sandbox'])).not.toContain(id);

    // The relay turns the event into the remove job, which the worker runs.
    expect(await runRemoveJob({ runtime: worker, broker: vault, publishers: { sandbox }, callTimeoutMs: 2_000 }, o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(sandbox.posts(account)).toHaveLength(0);
    const v = await variant(o, postId);
    expect(v).toMatchObject({ status: 'removed', removedBy: null, removeReason: null, removal: null });
    expect(await admin(async (c) => (await c.query<{ removed_by: string | null }>('SELECT removed_by FROM crove_social.post_variant WHERE id = $1', [id])).rows[0])).toEqual({ removed_by: null });
    await sweep();
    expect(await requested(o, id)).toHaveLength(1);
  });

  it('takes a Bluesky post set for 22:00 down then, against recorded XRPC answers', async () => {
    const o = await org();
    const DID = 'did:plc:abc123def456ghi789jkl012';
    const PDS = 'https://morel.us-east.host.bsky.network';
    const RKEY = `3kq2${randomUUID().replace(/-/g, '').slice(0, 9)}`;
    const deleted: unknown[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
      const answer =
        route === `GET plc.directory/${DID}`
          ? { id: DID, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] }
          : route.endsWith('/xrpc/com.atproto.server.createSession')
            ? { did: DID, handle: 'quan-a.bsky.social', accessJwt: 'access-jwt-1', refreshJwt: 'refresh-jwt-1', didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] } }
            : route === `POST ${new URL(PDS).host}/xrpc/com.atproto.repo.deleteRecord`
              ? (deleted.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null), { commit: { cid: 'bafyreib', rev: '3kq2' } })
              : null;
      return answer ? new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify({ error: 'InternalServerError' }), { status: 500 });
    };
    const bluesky = new BlueskyPublisher(fetchImpl);
    // Publishing is not what this test is about: the post goes out through a stand-in that answers like Bluesky.
    const platform: Publisher = { provider: 'bluesky', publishSafety: bluesky.publishSafety, publish: async () => ({ kind: 'accepted', externalId: `at://${DID}/app.bsky.feed.post/${RKEY}`, url: `https://bsky.app/profile/quan-a.bsky.social/post/${RKEY}` }), remove: (i) => bluesky.remove(i) };
    const today22 = inVietnam(Date.now() - 30_000);
    const { postId, id } = await publishedPost(o, platform, { removeAt: today22, publishedAgoMs: 12 * 3_600_000, provider: 'bluesky', account: DID, secret: JSON.stringify({ identifier: DID, appPassword: 'abcd-efgh-ijkl-mnop' }) });

    expect(await sweep(['bluesky'])).toBeGreaterThanOrEqual(1);
    expect(await requested(o, id)).toEqual([{ post_id: postId, variant_id: id, provider: 'bluesky', after: null, scheduled: true }]);
    expect(await runRemoveJob({ runtime: worker, broker: vault, publishers: { bluesky: platform }, callTimeoutMs: 2_000 }, o.orgId, id, 'bluesky', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(deleted).toEqual([{ repo: DID, collection: 'app.bsky.feed.post', rkey: RKEY }]);
    expect(await variant(o, postId)).toMatchObject({ status: 'removed', removedBy: null });
  });

  it('takes a Zalo OA article set for 22:00 down then, against recorded article/remove answers (#1430)', async () => {
    const o = await org();
    const ARTICLE = `a${randomUUID().replace(/-/g, '').slice(0, 19)}`;
    const removed: unknown[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      if (`${init?.method ?? 'GET'} ${url.host}${url.pathname}` !== 'POST openapi.zalo.me/v2.0/article/remove') return new Response(JSON.stringify({ error: -1, message: 'unexpected' }), { status: 500 });
      removed.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify({ error: 0, message: 'Success' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const zalo = new ZaloOaPublisher({ appId: '4318000000000000001', appSecret: 'test-zalo-secret-not-real' }, fetchImpl);
    // Publishing is not what this test is about: the article goes out through a stand-in on a sandbox channel (a Zalo
    // article needs images and a title the sandbox post has not), and the variant becomes the Zalo OA one it stands for.
    const platform: Publisher = { provider: 'sandbox', publishSafety: zalo.publishSafety, publish: async () => ({ kind: 'accepted', externalId: ARTICLE, url: null }) };
    const secret = JSON.stringify({ accessToken: 'zalo-access-1', refreshToken: 'zalo-refresh-1' });
    const { postId, id } = await publishedPost(o, platform, { removeAt: inVietnam(Date.now() - 30_000), publishedAgoMs: 12 * 3_600_000, secret });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET provider = 'zalo_oa' WHERE id = $1", [id]));

    expect(await sweep(['zalo_oa'])).toBeGreaterThanOrEqual(1);
    expect(await requested(o, id)).toEqual([{ post_id: postId, variant_id: id, provider: 'zalo_oa', after: null, scheduled: true }]);
    expect(await runRemoveJob({ runtime: worker, broker: vault, publishers: { zalo_oa: zalo }, callTimeoutMs: 2_000 }, o.orgId, id, 'zalo_oa', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(removed).toEqual([{ id: ARTICLE }]);
    expect(await variant(o, postId)).toMatchObject({ status: 'removed', removedBy: null });
  });

  it('never picks a channel Crove cannot remove from, a post that went out after its time, or a time not yet come', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const past = inVietnam(Date.now() - 60_000);
    // A channel outside REMOVE_READY (as if it were a Threads account) with a takedown due.
    const other = await publishedPost(o, sandbox, { removeAt: past, publishedAgoMs: 3_600_000 });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET provider = 'threads' WHERE id = $1", [other.id]));
    // Published late, an hour after its takedown time: it stays up.
    const late = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() - 3_600_000), publishedAgoMs: 60_000 });
    // Not yet: tomorrow.
    const later = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() + 86_400_000), publishedAgoMs: 60_000 });
    // A value the domain would refuse, written past it: skipped, and the scan does not fail.
    const broken = await publishedPost(o, sandbox, { removeAt: '2026-02-30T22:00:00+07:00', publishedAgoMs: 60_000 });
    const garbled = await publishedPost(o, sandbox, { removeAt: 'tối nay', publishedAgoMs: 60_000 });
    // Went out late (a rate limit, a paused channel), 4 minutes 50 seconds before its takedown time: under the gap.
    const close = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 60_000 + 290_000 });
    // Planned more than a year after the post (written past the command), or on a post over a year old.
    const far = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 366 * 86_400_000 });
    // Telegram: past the 48 hours in which a bot may delete a channel post; and one within them, which is taken down.
    const stale = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 49 * 3_600_000 });
    const fresh = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 47 * 3_600_000 });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET provider = 'telegram' WHERE id = ANY($1::uuid[])", [[stale.id, fresh.id]]));
    // Planned exactly a year after the post, and swept half an hour late: still taken down.
    const yearly = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() - 1_800_000), publishedAgoMs: 365 * 86_400_000 + 1_800_000 });

    await sweep(['sandbox', 'telegram', 'threads']);
    expect(await requested(o, yearly.id)).toEqual([{ post_id: yearly.postId, variant_id: yearly.id, provider: 'sandbox', after: null, scheduled: true }]);
    for (const v of [other, late, later, broken, garbled, close, far, stale]) {
      expect(await requested(o, v.id)).toEqual([]);
      expect((await variant(o, v.postId)).status).toBe('published');
    }
    expect(await requested(o, fresh.id)).toEqual([{ post_id: fresh.postId, variant_id: fresh.id, provider: 'telegram', after: null, scheduled: true }]);
    for (const v of [late, later, broken, garbled, close, far, stale]) expect(await due(['sandbox', 'telegram'])).not.toContain(v.id);
    // The command checks again on its own: a provider outside REMOVE_READY, a late publish.
    const schedule = (variantId: string) => worker.execute('social.remove.schedule', { variantId }, { actor: { type: 'system', component: 'social.remove' }, orgId: o.orgId });
    expect(await schedule(other.id)).toEqual({ queued: false, reason: 'not_supported' });
    for (const v of [late, close, far, stale]) expect(await schedule(v.id)).toEqual({ queued: false, reason: 'not_due' });
    // A person may not run it.
    await expect(api.execute('social.remove.schedule', { variantId: late.id }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('leaves a post a person already asked to remove to that ask', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id } = await publishedPost(o, sandbox, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 3_600_000 });
    await exec(o, 'social.variant.remove', { variantId: id, reason: 'Sai giá' });
    await sweep();
    expect(await requested(o, id)).toHaveLength(1);
    expect(await variant(o, postId)).toMatchObject({ removal: { state: 'pending' } });
  });

  it('refuses a takedown less than five minutes after the post goes out, at a time, in the queue or now', async () => {
    const o = await org();
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const { postId, id } = await scheduledPost(o, 'sandbox', { removeAt: soon });
    await expect(exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject({ code: 'REMOVE_AT_BEFORE_PUBLISH' });
    await expect(exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 27 * 60_000).toISOString() })).rejects.toMatchObject({ code: 'REMOVE_AT_BEFORE_PUBLISH' });
    // The queue's next slot is about twelve hours away: after the takedown.
    const connectionId = (await get(o, postId)).variants[0]?.connectionId as string;
    const halfDay = new Date(Date.now() + 7 * 3_600_000 + 12 * 3_600_000);
    const minute = halfDay.getUTCHours() * 60 + halfDay.getUTCMinutes();
    await exec(o, 'social.queue.set', { connectionId, timeZone: 'Asia/Ho_Chi_Minh', slots: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute })) });
    await expect(exec(o, 'social.variant.schedule', { postId, queue: true })).rejects.toMatchObject({ code: 'REMOVE_AT_BEFORE_PUBLISH' });
    expect(await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 20 * 60_000).toISOString() })).toMatchObject({ scheduled: [{ variantId: id }] });
    await expect(exec(o, 'social.variant.reschedule', { variantId: id, at: new Date(Date.now() + 40 * 60_000).toISOString() })).rejects.toMatchObject({ code: 'REMOVE_AT_BEFORE_PUBLISH' });
    // A failed post sent again now, with its takedown already past.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'failed', settings = jsonb_set(settings, '{removeAt}', to_jsonb($2::text)) WHERE id = $1", [id, new Date(Date.now() - 60_000).toISOString()]));
    await expect(exec(o, 'social.variant.retry', { variantIds: [id] })).rejects.toMatchObject({ code: 'REMOVE_AT_BEFORE_PUBLISH' });
    // More than a year after the post goes out.
    const far = await scheduledPost(o, 'sandbox', { removeAt: new Date(Date.now() + 3_600_000 + 366 * 86_400_000).toISOString() });
    await expect(exec(o, 'social.variant.schedule', { postId: far.postId, at: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject({ code: 'REMOVE_AT_TOO_LATE', details: { limit: 8760 } });
    // Telegram: more than 48 hours after; within them it is taken.
    const telegram = { secret: JSON.stringify({ botToken: '123:test', chatId: '@kenh' }) };
    const tooLate = await scheduledPost(o, 'telegram', { removeAt: new Date(Date.now() + 3_600_000 + 49 * 3_600_000).toISOString() }, `@kenh-${randomUUID().slice(0, 6)}`, telegram.secret);
    await expect(exec(o, 'social.variant.schedule', { postId: tooLate.postId, at: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject({ code: 'REMOVE_AT_TOO_LATE', details: { limit: 48 } });
    const inTime = await scheduledPost(o, 'telegram', { removeAt: new Date(Date.now() + 3_600_000 + 47 * 3_600_000).toISOString() }, `@kenh-${randomUUID().slice(0, 6)}`, telegram.secret);
    expect(await exec(o, 'social.variant.schedule', { postId: inTime.postId, at: new Date(Date.now() + 3_600_000).toISOString() })).toMatchObject({ scheduled: [{ variantId: inTime.id }] });
    // A malformed time is an issue of the variant itself, shown by the composer.
    const draft = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Nháp', channels: [{ connectionId, settings: { removeAt: 'tối nay' } }] });
    expect((await variant(o, draft.postId)).issues.map((i) => i.code)).toEqual(['REMOVE_AT_INVALID']);
  });

  it('tells the owners and admins when a planned takedown fails, and leaves the failed ask of a person as it was', async () => {
    const o = await org();
    const adminId = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `admin-${randomUUID().slice(0, 8)}@remove-at.test`, name: null });
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [o.orgId, adminId]));
    const sandbox = new SandboxPublisher();
    const refusing: Publisher = { provider: 'sandbox', publishSafety: sandbox.publishSafety, publish: (i) => sandbox.publish(i), remove: async () => ({ kind: 'rejected', error: 'permission', code: 'NO_RIGHTS' }) };
    const deps = { runtime: worker, broker: vault, publishers: { sandbox: refusing }, callTimeoutMs: 2_000 };
    const failures = () =>
      admin(async (c) => (await c.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.variant.remove_failed' ORDER BY created_at", [o.orgId])).rows);
    const dispatch = (eventId: string) => worker.execute<{ sent: number; mailed: number }>('social.notification.dispatch', { eventId }, { actor: { type: 'system', component: 'social.notify' }, orgId: o.orgId });
    const notices = (postId: string) =>
      admin(async (c) => (await c.query<{ user_id: string; kind: string; detail: Record<string, string> }>('SELECT user_id, kind, detail FROM crove_social.notification WHERE org_id = $1 AND post_id = $2 ORDER BY user_id', [o.orgId, postId])).rows);

    // The planned takedown: nobody asked, so the owners and admins are told.
    const planned = await publishedPost(o, refusing, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 3_600_000 });
    await sweep();
    expect(await runRemoveJob(deps, o.orgId, planned.id, 'sandbox', null)).toEqual({ action: 'call', state: 'failed' });
    const [first] = await failures();
    expect(first?.payload).toEqual({ post_id: planned.postId, variant_id: planned.id, provider: 'sandbox', code: 'NO_RIGHTS', scheduled: true });
    expect(await dispatch(first?.id as string)).toMatchObject({ sent: 2 });
    expect(await notices(planned.postId)).toEqual(
      [o.owner, adminId].sort().map((user_id) => ({ user_id, kind: 'failed', detail: { provider: 'sandbox', removal: 'scheduled' } })),
    );
    // Still up: a person may ask again from the post page.
    expect(await variant(o, planned.postId)).toMatchObject({ status: 'published', removal: { state: 'failed', code: 'NO_RIGHTS' } });

    // A person's own ask that fails: shown on the post as before, no notification.
    const asked = await publishedPost(o, refusing, { removeAt: null, publishedAgoMs: 3_600_000 });
    await exec(o, 'social.variant.remove', { variantId: asked.id });
    expect(await runRemoveJob(deps, o.orgId, asked.id, 'sandbox', null)).toEqual({ action: 'call', state: 'failed' });
    const second = (await failures()).at(-1);
    expect(second?.payload).toEqual({ post_id: asked.postId, variant_id: asked.id, provider: 'sandbox', code: 'NO_RIGHTS' });
    expect(await dispatch(second?.id as string)).toEqual({ sent: 0, mailed: 0, push: [] });
    expect(await notices(asked.postId)).toEqual([]);
  });

  // #937: the remove queue never retries, so a worker that died before or during the call left the planned ask with no
  // answer, and nobody was told. The watch, queued with the job, tells the owners and admins once and never calls.
  it('tells the owners and admins once when a planned takedown never got an answer, without calling the platform (#937)', async () => {
    const o = await org();
    let removals = 0;
    const sandbox = new SandboxPublisher();
    const counting: Publisher = { provider: 'sandbox', publishSafety: sandbox.publishSafety, publish: (i) => sandbox.publish(i), remove: async () => (removals++, { kind: 'removed' }) };
    const deps = { runtime: worker, broker: vault, publishers: { sandbox: counting }, callTimeoutMs: 2_000 };
    const failures = () => admin(async (c) => (await c.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.variant.remove_failed' ORDER BY created_at", [o.orgId])).rows);
    const calls = (id: string) => admin(async (c) => (await c.query<{ key: string; state: string; error_kind: string | null; error_code: string | null; finished: boolean }>("SELECT key, state, error_kind, error_code, finished_at IS NOT NULL AS finished FROM crove_kernel.external_call WHERE key LIKE $1 ORDER BY started_at, key", [`social.publish:${id}:%:remove%`])).rows);
    const age = (id: string) => admin((c) => c.query("UPDATE crove_social.post_variant SET remove_requested_at = now() - interval '11 minutes' WHERE id = $1", [id]));

    // The job never ran. Watched before the ask went stale: nothing yet (the worker runs the watch again later).
    const lost = await publishedPost(o, counting, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 3_600_000 });
    await sweep();
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, lost.id, null)).toEqual({ told: false, reason: 'not_stale' });
    await age(lost.id);
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, lost.id, null)).toEqual({ told: true, code: 'REMOVE_NOT_RUN' });
    expect(await calls(lost.id)).toEqual([{ key: `social.publish:${lost.id}:1:1:remove`, state: 'failed', error_kind: 'transient', error_code: 'REMOVE_NOT_RUN', finished: true }]);
    expect((await failures()).map((f) => f.payload)).toEqual([{ post_id: lost.postId, variant_id: lost.id, provider: 'sandbox', code: 'REMOVE_NOT_RUN', scheduled: true }]);
    expect(await variant(o, lost.postId)).toMatchObject({ status: 'published', removal: { state: 'failed', code: 'REMOVE_NOT_RUN' } });
    const [notice] = await failures();
    expect(await worker.execute('social.notification.dispatch', { eventId: notice?.id }, { actor: { type: 'system', component: 'social.notify' }, orgId: o.orgId })).toMatchObject({ sent: 1 });
    // Once: a second watch finds the answer, and the job, had it only been late, stops at its begin.
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, lost.id, null)).toEqual({ told: false, reason: 'recorded' });
    expect(await runRemoveJob(deps, o.orgId, lost.id, 'sandbox', null)).toEqual({ action: 'none', reason: 'stale' });
    expect(removals).toBe(0);
    expect(await failures()).toHaveLength(1);
    // A person asks again from the post page: the call is made, the watch of the old ask stays quiet.
    await exec(o, 'social.variant.remove', { variantId: lost.id });
    expect(await runRemoveJob(deps, o.orgId, lost.id, 'sandbox', `social.publish:${lost.id}:1:1:remove`)).toEqual({ action: 'call', state: 'succeeded' });
    expect(removals).toBe(1);
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, lost.id, null)).toEqual({ told: false, reason: 'not_published' });

    // The worker died mid-call: the call is still started past the stale limit. Its answer is unclear, recorded as such,
    // and the platform is not asked again.
    const cut = await publishedPost(o, counting, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 3_600_000 });
    await sweep();
    await age(cut.id);
    const key = `social.publish:${cut.id}:1:1:remove`;
    await admin((c) => c.query("INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, request_hash, started_at) VALUES ($1, $2, 'social', 'sandbox', 'remove', 'idempotent', NULL, now() - interval '5 minutes')", [o.orgId, key]));
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, cut.id, null)).toEqual({ told: false, reason: 'not_stale' });
    await admin((c) => c.query('DELETE FROM crove_kernel.external_call WHERE org_id = $1 AND key = $2', [o.orgId, key]));
    await admin((c) => c.query("INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, request_hash, started_at) VALUES ($1, $2, 'social', 'sandbox', 'remove', 'idempotent', NULL, now() - interval '11 minutes')", [o.orgId, key]));
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, cut.id, null)).toEqual({ told: true, code: 'OUTCOME_UNKNOWN' });
    expect(await calls(cut.id)).toEqual([{ key, state: 'ambiguous', error_kind: 'unknown', error_code: 'OUTCOME_UNKNOWN', finished: false }]);
    expect((await failures()).at(-1)?.payload).toEqual({ post_id: cut.postId, variant_id: cut.id, provider: 'sandbox', code: 'OUTCOME_UNKNOWN', scheduled: true });
    expect(await variant(o, cut.postId)).toMatchObject({ status: 'published', removal: { state: 'unknown', code: 'OUTCOME_UNKNOWN' } });
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, cut.id, null)).toEqual({ told: false, reason: 'recorded' });
    expect(removals).toBe(1);

    // A planned takedown whose job recorded its answer: the watch finds it and says nothing.
    const done = await publishedPost(o, counting, { removeAt: inVietnam(Date.now() - 60_000), publishedAgoMs: 3_600_000 });
    await sweep();
    expect(await runRemoveJob(deps, o.orgId, done.id, 'sandbox', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, done.id, null)).toEqual({ told: false, reason: 'not_published' });
    // A person's own ask is left to them, and a person may not run the watch.
    const own = await publishedPost(o, counting, { removeAt: null, publishedAgoMs: 3_600_000 });
    await exec(o, 'social.variant.remove', { variantId: own.id });
    await age(own.id);
    expect(await runRemoveWatch({ runtime: worker }, o.orgId, own.id, null)).toEqual({ told: false, reason: 'not_scheduled' });
    await expect(api.execute('social.remove.watch', { variantId: own.id, after: null }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await failures()).toHaveLength(2);
  });

  it('never copies a planned takedown into a duplicate or an evergreen repost', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const later = inVietnam(Date.now() + 86_400_000);
    const { postId } = await publishedPost(o, sandbox, { removeAt: later, publishedAgoMs: 3_600_000 });
    expect((await variant(o, postId)).settings).toEqual({ removeAt: later });
    const settingsOfPost = async (id: string) => (await variant(o, id)).settings;

    const { postId: copy } = await exec<{ postId: string }>(o, 'social.post.duplicate', { postId });
    expect(await settingsOfPost(copy)).toEqual({});
    await exec(o, 'social.post.set_evergreen', { postId, days: 7 });
    const { postId: repost } = await worker.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId }, { actor: { type: 'system', component: 'social.evergreen' }, orgId: o.orgId });
    expect(repost).not.toBeNull();
    expect(await settingsOfPost(repost as string)).toEqual({});
    // The source keeps its own.
    expect(await settingsOfPost(postId)).toEqual({ removeAt: later });
  });

  it('lets only the worker run the scan', async () => {
    const { rows } = await admin((c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
         WHERE has_function_privilege(r, 'crove_social.remove_due(int, text[], int[])', 'EXECUTE') ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(['crove_worker']);
    const helper = await admin(async (c) => (await c.query<{ role: string }>(`SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r WHERE has_function_privilege(r, 'crove_social.remove_at_of(jsonb)', 'EXECUTE')`)).rows);
    expect(helper).toEqual([]);
    const client = await appPool.connect();
    try {
      await expect(client.query("SELECT * FROM crove_social.remove_due(10, ARRAY['sandbox'], ARRAY[60])")).rejects.toThrow(/permission denied/);
    } finally {
      client.release();
    }
  });
});
