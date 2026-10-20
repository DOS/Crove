// Crove Social publishing on PostgreSQL 17 (Social plan §3.4, step S4, issue #234): a due variant goes out exactly
// once, a run that dies between the provider call and its result never posts again on its own, and every refusal
// ends where the plan says (failed, a new attempt, paused until the channel is reconnected, or a person's decision).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FacebookPagePublisher, SandboxPublisher, type Publisher, type PublishInput, type PublishResult, type ReconcileInput, type ReconcileResult, type RetrySafety } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey, type BlobStore } from '@crove/kernel-runtime';
import { captureKey, runCommentJob, runPublishJob, runThreadJob, socialCommands, socialQueries, sweepMetrics, type BeginResult, type MetricsRow, type PostView } from '@crove/mod-social';
import { shortLinkTarget } from '../src/short-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const noMedia = async (): Promise<Uint8Array> => {
  throw new Error('no media in this test');
};

// A platform that remembers what was posted, answers what a test scripts, and can be asked about a call.
class FakePlatform implements Publisher {
  readonly provider = 'sandbox' as const;
  posts: PublishInput[] = [];
  answers: Array<PublishResult | 'throw'> = [];
  statuses: PublishResult[] = [];
  // false: the platform cannot be asked (a member-only LinkedIn app cannot list its posts).
  reconcileEnabled = true;
  readonly publishSafety: RetrySafety;
  constructor(publishSafety: RetrySafety = 'reconcile_only') {
    this.publishSafety = publishSafety;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const answer = this.answers.shift() ?? { kind: 'accepted', externalId: `post-${this.posts.length + 1}`, url: `https://example.test/p/${this.posts.length + 1}` };
    if (answer === 'throw') {
      this.posts.push(input);
      throw new Error('socket hang up');
    }
    if (answer.kind === 'accepted' || answer.kind === 'pending' || answer.kind === 'unknown') this.posts.push(input);
    return answer;
  }

  async status(): Promise<PublishResult> {
    return this.statuses.shift() ?? { kind: 'accepted', externalId: 'post-after-processing', url: null };
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    if (!this.reconcileEnabled) return { found: 'unknown' };
    const i = this.posts.findIndex((p) => p.callKey === input.callKey);
    return i < 0 ? { found: false } : { found: true, externalId: `post-${i + 1}`, url: null };
  }
}

suite('social publishing on PostgreSQL (S4)', () => {
  const dbName = `crove_test_social_publish_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let api: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'social-publish-test' };

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
    return upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@publish.test`, name: null });
  }

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  const exec = <O>(o: { orgId: string; owner: string }, name: string, input: unknown) => api.execute<O>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
  const get = (o: { orgId: string; owner: string }, postId: string) => api.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });

  async function connect(o: { orgId: string; owner: string }, account: string, token = 'sbx_test') {
    const sealed = vault.seal(JSON.stringify({ accessToken: token }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: account });
    return exec<{ connectionId: string }>(o, 'kernel.channel.connect', {
      provider: 'sandbox',
      externalAccountId: account,
      displayName: 'Trang thử',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
  }

  // A post approved and scheduled on fresh channels, made due now. Returns its variants' ids in channel order.
  async function duePost(o: { orgId: string; owner: string }, channels = 1, body = `Bài ${randomUUID().slice(0, 6)}`) {
    const connections: string[] = [];
    const accounts: string[] = [];
    for (let i = 0; i < channels; i++) {
      const account = `acct-${randomUUID().slice(0, 8)}`;
      accounts.push(account);
      connections.push((await connect(o, account)).connectionId);
    }
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })) });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', {
      postId,
      decision: 'approved',
      variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })),
    });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    return { postId, variants: post.variants.map((v) => v.id), connections, accounts };
  }

  const run = (o: { orgId: string }, variantId: string, platform: Publisher) =>
    runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, variantId, 'sandbox');

  const variant = async (o: { orgId: string; owner: string }, postId: string, i = 0) => {
    const v = (await get(o, postId)).variants[i];
    if (!v) throw new Error('no variant');
    return v;
  };

  const calls = (variantId: string) =>
    admin(async (c) => (await c.query<{ key: string; state: string; calls: number }>("SELECT key, state, calls FROM crove_kernel.external_call WHERE key LIKE $1 ORDER BY started_at, key", [`social.publish:${variantId}:%`])).rows);

  // Ages a variant's last change, as if the worker that started it had died that long ago.
  const age = (variantId: string, seconds: number) =>
    admin((c) => c.query(`UPDATE crove_social.post_variant SET updated_at = now() - make_interval(secs => $2) WHERE id = $1`, [variantId, seconds]));

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
    workerDb = createDb(workerPool);
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

  it('publishes a due variant once and records the call before making it', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;

    const due = await admin(async (c) => (await c.query("SELECT variant_id, status FROM crove_social.publish_due(100, 600, ARRAY['sandbox'])")).rows);
    expect(due).toContainEqual({ variant_id: id, status: 'scheduled' });

    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'published' });
    const v = await variant(o, postId);
    expect([v.status, v.externalUrl, v.error]).toEqual(['published', 'https://example.test/p/1', null]);
    expect((await get(o, postId)).status).toBe('published');
    expect(await calls(id)).toEqual([{ key: `social.publish:${id}:1:1:publish`, state: 'succeeded', calls: 1 }]);
    expect(platform.posts.map((p) => p.content.body)).toHaveLength(1);
    // The channel keeps what it went out with in its own columns (#335).
    const frozen = await admin(async (c) => (await c.query<{ content_frozen: boolean; body: string | null }>('SELECT content_frozen, body FROM crove_social.post_variant WHERE id = $1', [id])).rows[0]);
    expect(frozen).toEqual({ content_frozen: true, body: platform.posts[0]?.content.body });

    // Another run, or the sweep, finds nothing to do.
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'published' });
    expect(platform.posts).toHaveLength(1);
  });

  it('sends a post link as a Crove short link where the channel asks, and counts clicks without the visitor (#706)', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const conn = (await connect(o, `acct-${randomUUID().slice(0, 8)}`)).connectionId;
    const plain = (await connect(o, `acct-${randomUUID().slice(0, 8)}`)).connectionId;
    await exec(o, 'social.channel.set_short_links', { connectionId: conn, shortLinks: true });
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', {
      body: 'Ưu đãi tuần này: https://tiembanh.example/uu-dai',
      linkUrl: 'https://tiembanh.example/uu-dai',
      channels: [{ connectionId: conn }, { connectionId: plain }],
    });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    const [short, other] = post.variants;
    const deps = { runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000, publicUrl: 'https://crove.example/' };
    expect(await runPublishJob(deps, o.orgId, short?.id as string, 'sandbox')).toEqual({ action: 'call', status: 'published' });
    expect(await runPublishJob(deps, o.orgId, other?.id as string, 'sandbox')).toEqual({ action: 'call', status: 'published' });

    const rows = await admin(async (c) => (await c.query<{ code: string; target_url: string }>('SELECT code, target_url FROM crove_social.short_link WHERE post_id = $1', [postId])).rows);
    expect(rows).toHaveLength(1);
    const code = rows[0]?.code as string;
    expect(code).toMatch(/^[A-Za-z0-9]{12}$/);
    // The target is the link as the channel sends it (with its UTM tags when the post has some).
    expect(rows[0]?.target_url).toBe('https://tiembanh.example/uu-dai');
    // The shortened channel's text and link name the short link; the other channel's are its own.
    expect(platform.posts[0]?.content).toMatchObject({ linkUrl: `https://crove.example/l/${code}` });
    expect(platform.posts[0]?.content.body).not.toContain('tiembanh.example');
    expect(platform.posts[1]?.content.linkUrl).toMatch(/^https:\/\/tiembanh\.example\/uu-dai/);

    // The redirect: a person counts, a link preview does not, an unknown or malformed code is nothing.
    expect(await shortLinkTarget(api, code, 'Mozilla/5.0 (iPhone)')).toBe(rows[0]?.target_url);
    expect(await shortLinkTarget(api, code, 'Mozilla/5.0 (iPhone)')).toBe(rows[0]?.target_url);
    expect(await shortLinkTarget(api, code, 'facebookexternalhit/1.1')).toBe(rows[0]?.target_url);
    expect(await shortLinkTarget(api, 'AAAAAAAAAAAA', 'Mozilla/5.0')).toBeNull();
    expect(await shortLinkTarget(api, "x' OR 1=1", 'Mozilla/5.0')).toBeNull();
    const summary = await api.query<{ variantId: string; clicks: number | null }[]>('social.metrics.summary', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(Object.fromEntries(summary.map((r) => [r.variantId, r.clicks]))).toEqual({ [short?.id as string]: 2, [other?.id as string]: null });
    // Only the redirect's definer counts: members read the counts, and the API role cannot write them.
    await expect(appPool.query("INSERT INTO crove_social.short_link_click (org_id, short_link_id, day, clicks) SELECT org_id, id, current_date, 99 FROM crove_social.short_link")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT crove_social.short_link_hit($1, true)', [code])).rejects.toMatchObject({ code: '42501' });
    // A member cannot switch a channel's links.
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, member]));
    await expect(api.execute('social.channel.set_short_links', { connectionId: plain, shortLinks: true }, { actor: asUser(member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('never publishes a variant short of what its channel asks for now, and sends it back to review (#408)', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const { postId, variants, connections } = await duePost(o);
    const id = variants[0] as string;
    // The policy rose without set_policy re-checking (as after a retry or a resume brings a variant back).
    await admin((c) => c.query('INSERT INTO crove_social.channel_policy (org_id, channel_connection_id, approvals_required, updated_by) VALUES ($1, $2, 2, $3)', [o.orgId, connections[0], o.owner]));
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'approval' });
    expect(platform.posts).toHaveLength(0);
    expect((await variant(o, postId)).status).toBe('in_review');
    const events = await admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.submitted' AND payload->>'by_policy' = 'true'", [o.orgId])).rows);
    expect(events.map((e) => e.payload)).toEqual([{ post_id: postId, variant_ids: [id], by_policy: true }]);
  });
  it('posts the first comment once after the post, and shows it on the post (#587)', async () => {
    const o = await org();
    const platform = new SandboxPublisher();
    const conn = (await connect(o, `acct-${randomUUID().slice(0, 8)}`)).connectionId;
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Khai trương', channels: [{ connectionId: conn, settings: { firstComment: '#khaitruong' } }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    const id = post.variants[0]?.id as string;
    expect(await run(o, id, platform)).toMatchObject({ status: 'published' });
    expect(platform.comments.map((c) => c.text)).toEqual(['#khaitruong']);
    expect((await variant(o, postId)).commentStatus).toBe('posted');
    // A later run, or the retry command, posts no second comment.
    await runCommentJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, id, 'sandbox', { after: `social.publish:${id}:1:1:comment` });
    expect(platform.comments).toHaveLength(1);
    await expect(exec(o, 'social.comment.retry', { variantId: id })).rejects.toMatchObject({ code: 'COMMENT_NOT_RETRYABLE' });
    // A post without a first comment shows none.
    const plain = await duePost(o);
    expect(await run(o, plain.variants[0] as string, platform)).toMatchObject({ status: 'published' });
    expect((await variant(o, plain.postId)).commentStatus).toBeNull();
  });

  it('lets a person retry a first comment whose job never ran or whose call went quiet, once per ask (#587)', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const conn = (await connect(o, `acct-${randomUUID().slice(0, 8)}`)).connectionId;
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Khai trương', channels: [{ connectionId: conn, settings: { firstComment: '#khaitruong' } }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    const id = post.variants[0]?.id as string;
    const key = `social.publish:${id}:1:1:comment`;
    const deps = { runtime: worker, broker: vault, publishers: { sandbox }, callTimeoutMs: 2_000 };
    // Waiting at first, then the person's to retry.
    // Published on the same sandbox by a publisher without comments, as if the comment job never came.
    const quiet: Publisher = { provider: 'sandbox', publishSafety: sandbox.publishSafety, publish: (i) => sandbox.publish(i), reconcile: (i) => sandbox.reconcile(i) };
    expect(await run(o, id, quiet)).toMatchObject({ status: 'published' });
    expect((await variant(o, postId)).commentStatus).toBe('pending');
    await expect(exec(o, 'social.comment.retry', { variantId: id })).rejects.toMatchObject({ code: 'COMMENT_NOT_RETRYABLE' });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET published_at = now() - interval '11 minutes' WHERE id = $1", [id]));
    expect((await variant(o, postId)).commentStatus).toBe('failed');

    // A call started and never answered (the worker died): unclear once it is old, and retried only after it.
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, request_hash, started_at) VALUES ($1, $2, 'social', 'sandbox', 'comment', 'never', NULL, now() - interval '11 minutes')", [o.orgId, key]),
    );
    expect((await variant(o, postId)).commentStatus).toBe('unknown');
    await exec(o, 'social.comment.retry', { variantId: id });
    const asks = await admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.comment.retry_requested'", [o.orgId])).rows);
    expect(asks.map((a) => a.payload)).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', after: key }]);
    // An ask that saw no call is stale now; the ask that saw the quiet call posts once, and a second job of it stops.
    expect(await runCommentJob(deps, o.orgId, id, 'sandbox', { after: null })).toEqual({ action: 'none', reason: 'unknown' });
    expect(await runCommentJob(deps, o.orgId, id, 'sandbox', { after: key })).toEqual({ action: 'call', state: 'succeeded' });
    expect(await runCommentJob(deps, o.orgId, id, 'sandbox', { after: key })).toEqual({ action: 'none', reason: 'posted' });
    expect(sandbox.comments.map((c) => c.text)).toEqual(['#khaitruong']);
    expect(await calls(id)).toContainEqual(expect.objectContaining({ key: `${key}_2`, state: 'succeeded' }));
    expect((await variant(o, postId)).commentStatus).toBe('posted');
  });

  // A post with thread parts, approved and due.
  async function dueThread(o: Awaited<ReturnType<typeof org>>, threadParts: string[]) {
    const conn = (await connect(o, `acct-${randomUUID().slice(0, 8)}`)).connectionId;
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Phần một', channels: [{ connectionId: conn, settings: { threadParts } }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    return { postId, id: post.variants[0]?.id as string };
  }
  const partRefs = (variantId: string) =>
    admin(async (c) => (await c.query<{ key: string; state: string; external_ref: string | null }>("SELECT key, state, external_ref, error_code FROM crove_kernel.external_call WHERE key LIKE $1 ORDER BY started_at, key", [`social.publish:${variantId}:%:part\\_%`])).rows);

  it('posts thread parts as a chain of replies after the post, each once (#742)', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id } = await dueThread(o, ['Phần hai', 'Phần ba', 'Phần bốn']);
    expect(await run(o, id, sandbox)).toMatchObject({ status: 'published' });
    const v = await variant(o, postId);
    expect(v.threadStatus).toEqual({ state: 'posted', posted: 4, total: 4 });
    expect(v.commentStatus).toBeNull();
    const refs = await partRefs(id);
    expect(refs.map((r) => [r.key.split(':').at(-1), r.state])).toEqual([['part_2', 'succeeded'], ['part_3', 'succeeded'], ['part_4', 'succeeded']]);
    // Part 2 answers the post, each later part the part before it.
    expect(sandbox.comments.map((c) => c.text)).toEqual(['Phần hai', 'Phần ba', 'Phần bốn']);
    const root = await admin(async (c) => (await c.query<{ external_post_id: string }>('SELECT external_post_id FROM crove_social.post_variant WHERE id = $1', [id])).rows[0]?.external_post_id);
    expect(sandbox.comments.map((c) => c.postId)).toEqual([root, refs[0]?.external_ref, refs[1]?.external_ref]);
    expect(sandbox.comments.map((c) => c.rootId)).toEqual([root, root, root]);
    // A later run posts nothing again, and there is nothing to retry.
    expect(await runThreadJob({ runtime: worker, broker: vault, publishers: { sandbox }, callTimeoutMs: 2_000 }, o.orgId, id, 'sandbox')).toMatchObject({ action: 'none', reason: 'posted' });
    expect(sandbox.comments).toHaveLength(3);
    await expect(exec(o, 'social.thread.retry', { variantId: id })).rejects.toMatchObject({ code: 'THREAD_NOT_RETRYABLE' });
  });

  it('stops at a part that fails, keeps the parts that went out, and goes on from there when a person asks (#742)', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id } = await dueThread(o, ['Phần hai', 'Phần ba', 'Phần bốn']);
    // The platform refuses the second reply once, then answers an unclear one.
    let n = 0;
    const answers: ('ok' | 'refuse' | 'unclear')[] = ['ok', 'refuse', 'ok', 'unclear'];
    const flaky: Publisher = {
      provider: 'sandbox',
      publishSafety: sandbox.publishSafety,
      publish: (i) => sandbox.publish(i),
      reconcile: (i) => sandbox.reconcile(i),
      comment: async (i) => {
        const answer = answers[n++] ?? 'ok';
        if (answer === 'refuse') return { kind: 'rejected', error: 'bad_request', code: 'TOO_FAST' };
        if (answer === 'unclear') return { kind: 'unknown', code: 'TIMEOUT' };
        return sandbox.comment(i);
      },
    };
    const deps = { runtime: worker, broker: vault, publishers: { sandbox: flaky }, callTimeoutMs: 2_000 };
    expect(await run(o, id, flaky)).toMatchObject({ status: 'published' });
    expect((await variant(o, postId)).threadStatus).toEqual({ state: 'failed', posted: 2, total: 4 });
    // Only a person's ask goes on, once per ask: it names the last call it saw.
    expect(await runThreadJob(deps, o.orgId, id, 'sandbox')).toMatchObject({ action: 'none', reason: 'failed' });
    const failedKey = `social.publish:${id}:1:1:part_3`;
    await exec(o, 'social.thread.retry', { variantId: id });
    const asks = await admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.thread.retry_requested'", [o.orgId])).rows);
    expect(asks.map((a) => a.payload)).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', after: failedKey }]);
    // The retry posts part 3 under a new key, then stops at an unclear part 4, which nothing posts again by itself.
    expect(await runThreadJob(deps, o.orgId, id, 'sandbox', { after: failedKey })).toMatchObject({ action: 'call', state: 'ambiguous', parts: 2 });
    expect(await runThreadJob(deps, o.orgId, id, 'sandbox', { after: failedKey })).toMatchObject({ action: 'none', reason: 'unknown' });
    expect((await variant(o, postId)).threadStatus).toEqual({ state: 'unknown', posted: 3, total: 4 });
    // The person checked part 4 is not there and asks again: it goes out, answering part 3.
    const unclearKey = `social.publish:${id}:1:1:part_4`;
    await exec(o, 'social.thread.retry', { variantId: id });
    expect(await runThreadJob(deps, o.orgId, id, 'sandbox', { after: unclearKey })).toMatchObject({ action: 'call', state: 'succeeded', parts: 1 });
    const refs = await partRefs(id);
    expect(refs.map((r) => [r.key.split(':').at(-1), r.state])).toEqual([['part_2', 'succeeded'], ['part_3', 'failed'], ['part_3_2', 'succeeded'], ['part_4', 'ambiguous'], ['part_4_2', 'succeeded']]);
    expect(sandbox.comments.map((c) => c.text)).toEqual(['Phần hai', 'Phần ba', 'Phần bốn']);
    expect(sandbox.comments.at(-1)?.postId).toBe(refs[2]?.external_ref);
    expect((await variant(o, postId)).threadStatus).toEqual({ state: 'posted', posted: 4, total: 4 });
  });

  it('resumes a chain whose worker died between parts, without posting a part twice (#742)', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id } = await dueThread(o, ['Phần hai', 'Phần ba']);
    // Published by a publisher without replies, as if the worker died before the thread.
    const quiet: Publisher = { provider: 'sandbox', publishSafety: sandbox.publishSafety, publish: (i) => sandbox.publish(i), reconcile: (i) => sandbox.reconcile(i) };
    expect(await run(o, id, quiet)).toMatchObject({ status: 'published' });
    const deps = { runtime: worker, broker: vault, publishers: { sandbox }, callTimeoutMs: 2_000 };
    // Part 2 goes out; the worker dies before part 3.
    const only: Publisher = { ...quiet, comment: (i) => sandbox.comment(i) };
    let left = 1;
    const dying: Publisher = { ...only, comment: async (i) => (left-- > 0 ? sandbox.comment(i) : Promise.reject(new Error('worker died'))) };
    await runThreadJob({ ...deps, publishers: { sandbox: dying } }, o.orgId, id, 'sandbox');
    expect((await variant(o, postId)).threadStatus).toEqual({ state: 'unknown', posted: 2, total: 3 });
    // Its part-3 call never got an answer: once a person checked and asks, part 3 goes out once; part 2 is not posted again.
    const key = `social.publish:${id}:1:1:part_3`;
    await exec(o, 'social.thread.retry', { variantId: id });
    expect(await runThreadJob(deps, o.orgId, id, 'sandbox', { after: key })).toMatchObject({ action: 'call', state: 'succeeded', parts: 1 });
    expect((await partRefs(id)).map((r) => [r.key.split(':').at(-1), r.state])).toEqual([['part_2', 'succeeded'], ['part_3', 'ambiguous'], ['part_3_2', 'succeeded']]);
    expect(sandbox.comments.map((c) => c.text)).toEqual(['Phần hai', 'Phần ba']);
  });

  it('does nothing before the time, and never for a variant of another provider', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const { variants } = await duePost(o);
    const id = variants[0] as string;
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() + interval '1 hour' WHERE id = $1", [id]));
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'not_due' });
    await expect(
      worker.execute<BeginResult>('social.publish.begin', { variantId: id, provider: 'facebook_page', safety: 'never' }, { actor: system, orgId: o.orgId }),
    ).resolves.toEqual({ action: 'none', reason: 'provider_mismatch' });
    expect(platform.posts).toHaveLength(0);
  });

  it('reconciles a call whose result was lost, and never posts it twice', async () => {
    const o = await org();
    const platform = new FakePlatform('reconcile_only');
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;

    // The worker begins, makes the call, and dies before recording the result.
    const begun = await worker.execute<BeginResult>('social.publish.begin', { variantId: id, provider: 'sandbox', safety: 'reconcile_only' }, { actor: system, orgId: o.orgId });
    expect(begun.action).toBe('call');
    if (begun.action !== 'call') return;
    await platform.publish({ externalAccountId: 'x', secret: '{}', content: begun.content, readMedia: noMedia, mediaUrl: async () => null, settings: {}, callKey: begun.callKey, contentHash: begun.contentHash });

    // A run while the first could still be alive waits.
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'in_flight' });
    // Once it is stale, the next run asks the platform instead of posting.
    await age(id, 700);
    expect(await run(o, id, platform)).toEqual({ action: 'reconcile', status: 'published' });
    expect(platform.posts).toHaveLength(1);
    expect((await variant(o, postId)).status).toBe('published');
    expect(await calls(id)).toEqual([{ key: `social.publish:${id}:1:1:publish`, state: 'succeeded', calls: 1 }]);
  });

  it('hands a lost result to a person when the platform cannot be asked; only their retry posts again', async () => {
    const o = await org();
    const platform = new FakePlatform('never');
    platform.reconcileEnabled = false;
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    const begun = await worker.execute<BeginResult>('social.publish.begin', { variantId: id, provider: 'sandbox', safety: 'never' }, { actor: system, orgId: o.orgId });
    if (begun.action !== 'call') throw new Error('expected a call');
    await platform.publish({ externalAccountId: 'x', secret: '{}', content: begun.content, readMedia: noMedia, mediaUrl: async () => null, settings: {}, callKey: begun.callKey, contentHash: begun.contentHash });
    await age(id, 700);

    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'needs_attention' });
    let v = await variant(o, postId);
    expect([v.status, v.error?.code]).toEqual(['needs_attention', 'OUTCOME_UNKNOWN']);
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'needs_attention' });
    expect(platform.posts).toHaveLength(1);

    // The owner checked the page and asks for it again: a new attempt, with a new key.
    await exec(o, 'social.variant.retry', { variantIds: [id] });
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'published' });
    expect(platform.posts).toHaveLength(2);
    expect((await calls(id)).map((c) => [c.key.split(':').slice(2).join(':'), c.state])).toEqual([
      ['1:1:publish', 'ambiguous'],
      ['1:2:publish', 'succeeded'],
    ]);
    v = await variant(o, postId);
    expect([v.status, v.attempt]).toEqual(['published', 2]);
  });

  it('lets a person confirm a post they found on the platform, or drop it', async () => {
    const o = await org();
    const platform = new FakePlatform('never');
    platform.reconcileEnabled = false;
    platform.answers.push({ kind: 'unknown', code: 'TIMEOUT' }, { kind: 'unknown', code: 'TIMEOUT' });
    const { postId, variants } = await duePost(o, 2);
    for (const id of variants) {
      expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'ambiguous' });
      // The reconcile runs once the platform had a minute; this platform cannot be asked.
      await age(id, 90);
      expect(await run(o, id, platform)).toEqual({ action: 'reconcile', status: 'needs_attention' });
    }
    await expect(exec(o, 'social.variant.resolve', { variantIds: [variants[0]], outcome: 'published', url: 'https://example.test/found' })).resolves.toMatchObject({ outcome: 'published' });
    await exec(o, 'social.variant.resolve', { variantIds: [variants[1]], outcome: 'dropped' });
    const post = await get(o, postId);
    expect(post.variants.map((v) => [v.status, v.externalUrl])).toEqual([
      ['published', 'https://example.test/found'],
      ['cancelled', null],
    ]);
    expect(post.status).toBe('published');
    // Resolving is for needs_attention only.
    await expect(exec(o, 'social.variant.resolve', { variantIds: [variants[0]], outcome: 'dropped' })).rejects.toMatchObject({ code: 'VARIANT_STATE' });
  });

  it('treats a thrown or timed-out call as unknown, never as a failure to retry', async () => {
    const o = await org();
    const platform = new FakePlatform('reconcile_only');
    platform.answers.push('throw');
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'ambiguous' });
    expect((await variant(o, postId)).error?.code).toBe('ADAPTER_ERROR');
    await age(id, 90);
    // The throw came after the platform took the post: found, not posted again.
    expect(await run(o, id, platform)).toEqual({ action: 'reconcile', status: 'published' });
    expect(platform.posts).toHaveLength(1);
  });

  it('retries a rate-limited call at the provider’s time with a new attempt', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const retryAt = new Date(Date.now() + 600_000);
    platform.answers.push({ kind: 'rejected', error: 'rate_limited', code: 'LIMIT', retryAt });
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'scheduled' });
    let v = await variant(o, postId);
    expect([v.status, v.attempt, v.error?.kind, v.error?.retryAt, v.effectiveAt]).toEqual(['scheduled', 2, 'rate_limited', retryAt.toISOString(), retryAt.toISOString()]);
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'not_due' });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET error_retry_at = now() - interval '1 second' WHERE id = $1", [id]));
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'published' });
    v = await variant(o, postId);
    expect([v.status, v.error]).toEqual(['published', null]);
    expect((await calls(id)).map((c) => c.state)).toEqual(['failed', 'succeeded']);
  });

  it('keeps waiting on a used-up publishing quota past the usual attempt limit (#743)', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const retryAt = new Date(Date.now() + 600_000);
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    await admin((c) => c.query('UPDATE crove_social.post_variant SET attempt = 5 WHERE id = $1', [id]));
    platform.answers.push({ kind: 'rejected', error: 'rate_limited', code: 'QUOTA_EXHAUSTED', retryAt });
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'scheduled' });
    expect((await variant(o, postId)).error).toMatchObject({ code: 'QUOTA_EXHAUSTED', retryAt: retryAt.toISOString() });
    // Any other rate limit at that count stops for a person.
    const other = await duePost(o);
    const second = other.variants[0] as string;
    await admin((c) => c.query('UPDATE crove_social.post_variant SET attempt = 5 WHERE id = $1', [second]));
    platform.answers.push({ kind: 'rejected', error: 'rate_limited', code: 'LIMIT', retryAt });
    expect(await run(o, second, platform)).toEqual({ action: 'call', status: 'failed' });
  });

  it('fails a variant the platform refused for good, and lets an admin publish it again', async () => {
    const o = await org();
    const platform = new FakePlatform();
    platform.answers.push({ kind: 'rejected', error: 'bad_request', code: '100', message: 'Nội dung không hợp lệ', httpStatus: 400 });
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'failed' });
    const v = await variant(o, postId);
    expect([v.status, v.error?.kind, v.error?.message]).toEqual(['failed', 'bad_request', 'Nội dung không hợp lệ']);
    expect((await get(o, postId)).status).toBe('failed');
    await exec(o, 'social.variant.retry', { variantIds: [id] });
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'published' });
  });

  it('pauses on an expired token, marks the channel, and resumes once it is reconnected', async () => {
    const o = await org();
    const platform = new FakePlatform();
    platform.answers.push({ kind: 'rejected', error: 'token_expired', code: '190' });
    const { postId, variants, connections, accounts } = await duePost(o);
    const id = variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'paused' });
    const channels = await api.query<Array<{ id: string; status: string; statusReason: string | null }>>('kernel.channel.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(channels.find((c) => c.id === connections[0])).toMatchObject({ status: 'expired', statusReason: '190' });
    expect((await variant(o, postId)).status).toBe('paused');

    // Nothing happens while the channel stays expired.
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'paused' });
    // Reconnecting the same account resumes it as a new attempt, which then goes out.
    await connect(o, accounts[0] as string);
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'resumed' });
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'published' });
    expect((await variant(o, postId)).attempt).toBe(2);
  });

  it('pauses without calling when the channel was disconnected', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const { postId, variants, connections } = await duePost(o);
    await exec(o, 'kernel.channel.disconnect', { connectionId: connections[0] });
    expect(await run(o, variants[0] as string, platform)).toEqual({ action: 'none', reason: 'paused' });
    const v = await variant(o, postId);
    // A disconnected channel does not come back: the page says so instead of waiting for a reconnect.
    expect([v.status, v.error?.code]).toEqual(['paused', 'CHANNEL_REVOKED']);
    expect(platform.posts).toHaveLength(0);
  });

  it('waits a minute before reconciling, and leaves a queue that was paused meanwhile alone', async () => {
    const o = await org();
    const platform = new FakePlatform('reconcile_only');
    platform.answers.push({ kind: 'unknown', code: 'TIMEOUT' });
    const first = await duePost(o);
    const id = first.variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'ambiguous' });
    // Straight after the unknown answer the platform may not show the post yet.
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'reconcile_wait' });
    await age(id, 90);
    expect(await run(o, id, platform)).toEqual({ action: 'reconcile', status: 'published' });

    const queued = await duePost(o);
    const qid = queued.variants[0] as string;
    await exec(o, 'social.queue.set', { connectionId: queued.connections[0], timeZone: 'Asia/Ho_Chi_Minh', paused: true, slots: [{ weekday: 1, minute: 540 }] });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = NULL, queue_slot_at = now() - interval '1 second' WHERE id = $1", [qid]));
    expect(await run(o, qid, platform)).toEqual({ action: 'none', reason: 'queue_paused' });
  });

  it('lists only work this worker can do: its providers, active orgs, each kind in its own share', async () => {
    const o = await org();
    const closed = await org();
    const mine = (await duePost(o)).variants[0] as string;
    const theirs = (await duePost(closed)).variants[0] as string;
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [closed.orgId]));
    const due = async (providers: string[]) =>
      (await admin(async (c) => (await c.query<{ variant_id: string }>('SELECT variant_id FROM crove_social.publish_due(1000, 600, $1)', [providers])).rows)).map((r) => r.variant_id);
    expect(await due(['sandbox'])).toContain(mine);
    expect(await due(['sandbox'])).not.toContain(theirs);
    expect(await due(['facebook_page'])).not.toContain(mine);
  });

  it('resumes a paused variant on any change of its reconnected channel, whatever the clocks say', async () => {
    const o = await org();
    const platform = new FakePlatform();
    platform.answers.push({ kind: 'rejected', error: 'token_expired', code: '190' });
    const { variants, connections } = await duePost(o);
    const id = variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'paused' });
    // A reconnect that committed with a clock behind the pause's.
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'active', updated_at = now() - interval '1 hour' WHERE id = $1", [connections[0]]));
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'resumed' });
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'published' });
  });

  it('publishes with the new token when the old one was refused after a reconnect', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const { postId, variants, accounts } = await duePost(o);
    const id = variants[0] as string;
    const begun = await worker.execute<BeginResult>('social.publish.begin', { variantId: id, provider: 'sandbox', safety: 'reconcile_only' }, { actor: system, orgId: o.orgId });
    if (begun.action !== 'call') throw new Error('expected a call');
    // The owner reconnects while the call with the old token is out; the platform refuses the old token.
    await connect(o, accounts[0] as string);
    await worker.execute(
      'social.publish.record',
      { variantId: id, callKey: begun.callKey, phase: 'call', result: { kind: 'rejected', error: 'token_expired', code: '190' }, connectionVersion: begun.connectionVersion },
      { actor: system, orgId: o.orgId },
    );
    const channels = await api.query<Array<{ status: string }>>('kernel.channel.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(channels.map((c) => c.status)).toEqual(['active']);
    expect((await variant(o, postId)).status).toBe('scheduled');
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'published' });
  });

  it('checks a pending post until the platform has published it', async () => {
    const o = await org();
    const platform = new FakePlatform();
    platform.answers.push({ kind: 'pending', externalRef: 'container-1', checkAfterSeconds: 30 });
    platform.statuses.push({ kind: 'pending', externalRef: 'container-1', checkAfterSeconds: 30 });
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'processing' });
    expect((await get(o, postId)).status).toBe('publishing');
    expect(await run(o, id, platform)).toEqual({ action: 'none', reason: 'not_due' });
    const checkNow = () => admin((c) => c.query("UPDATE crove_social.post_variant SET next_check_at = now() - interval '1 second' WHERE id = $1", [id]));
    await checkNow();
    expect(await run(o, id, platform)).toEqual({ action: 'status', status: 'processing' });
    await checkNow();
    expect(await run(o, id, platform)).toEqual({ action: 'status', status: 'published' });
    expect(platform.posts).toHaveLength(1);
  });

  it('reconciles a post still processing after a day, and records it published when the platform has it', async () => {
    const o = await org();
    const platform = new FakePlatform();
    platform.answers.push({ kind: 'pending', externalRef: 'container-2', checkAfterSeconds: 30 });
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    expect(await run(o, id, platform)).toEqual({ action: 'call', status: 'processing' });
    // A day later (the ledger's start time cannot change through tenant roles; the test moves it as the owner, with
    // triggers off).
    await admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE crove_kernel.external_call SET started_at = now() - interval '25 hours' WHERE key LIKE $1", [`social.publish:${id}:%`]);
      await c.query("UPDATE crove_social.post_variant SET next_check_at = now() - interval '1 second' WHERE id = $1", [id]);
    });
    expect(await run(o, id, platform)).toEqual({ action: 'reconcile', status: 'published' });
    expect((await variant(o, postId)).status).toBe('published');
    expect((await calls(id)).map((c) => c.state)).toEqual(['succeeded']);
  });

  it('ignores an answer for a key that is no longer the variant’s', async () => {
    const o = await org();
    const { variants } = await duePost(o);
    const id = variants[0] as string;
    const begun = await worker.execute<BeginResult>('social.publish.begin', { variantId: id, provider: 'sandbox', safety: 'reconcile_only' }, { actor: system, orgId: o.orgId });
    if (begun.action !== 'call') throw new Error('expected a call');
    const record = (callKey: string) =>
      worker.execute('social.publish.record', { variantId: id, callKey, phase: 'call', result: { kind: 'accepted', externalId: 'x', url: null } }, { actor: system, orgId: o.orgId });
    await expect(record(begun.callKey.replace(':1:1:', ':1:9:'))).resolves.toEqual({ recorded: false, reason: 'stale' });
    await expect(record(begun.callKey)).resolves.toEqual({ recorded: true, status: 'published' });
    // People cannot run the job's commands.
    await expect(exec(o, 'social.publish.begin', { variantId: id, provider: 'sandbox', safety: 'safe' })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps the call ledger append-only for tenant roles', async () => {
    const o = await org();
    const platform = new FakePlatform();
    const { variants } = await duePost(o);
    await run(o, variants[0] as string, platform);
    const asTenant = async (text: string) => {
      const u = new URL(adminUrl);
      u.username = 'crove_worker';
      u.password = 'test-worker-pw';
      const client = new pg.Client({ connectionString: u.toString() });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
        return await client.query(text);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    };
    await expect(asTenant("UPDATE crove_kernel.external_call SET state = 'started', finished_at = NULL")).rejects.toThrow(/EXTERNAL_CALL_FINISHED/);
    await expect(asTenant("UPDATE crove_kernel.external_call SET key = 'other'")).rejects.toThrow(/permission denied/);
    await expect(asTenant('DELETE FROM crove_kernel.external_call')).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(`INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, state, finished_at) VALUES ('${o.orgId}', 'k', 'social', 'sandbox', 'publish', 'never', 'succeeded', now())`),
    ).rejects.toThrow(/EXTERNAL_CALL_INSERT/);
    const { rows } = await admin((c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
         WHERE has_function_privilege(r, 'crove_social.publish_due(int, int, text[])', 'EXECUTE') ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(['crove_worker']);
  });

  // S6.2 (#371): the Facebook Page publisher through the same pipeline, against recorded Graph answers.
  describe('Facebook Page', () => {
    function graph(answer: { status: number; body: unknown }) {
      const asked: { path: string; form: string }[] = [];
      const fetchImpl = async (input: string, init?: RequestInit) => {
        asked.push({ path: new URL(input).pathname, form: typeof init?.body === 'string' ? init.body : '' });
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
      };
      return { asked, publisher: new FacebookPagePublisher({ appSecret: 'test-app-secret-not-real' }, fetchImpl) };
    }

    async function duePagePost(o: { orgId: string; owner: string }, body: string, media: { fileId: string }[] = []) {
      const page = String(100000 + Math.floor(Math.random() * 899999));
      const sealed = vault.seal(JSON.stringify({ accessToken: 'page-token-db' }), { orgId: o.orgId, provider: 'facebook_page', externalAccountId: page });
      const { connectionId } = await exec<{ connectionId: string }>(o, 'kernel.channel.connect', {
        provider: 'facebook_page',
        externalAccountId: page,
        displayName: 'Quán Cà Phê A',
        scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      });
      const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body, media, channels: [{ connectionId }] });
      await exec(o, 'social.post.submit', { postId });
      const post = await get(o, postId);
      await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
      await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
      await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
      return { postId, page, connectionId, variantId: post.variants[0]?.id as string };
    }

    const runPage = (o: { orgId: string }, variantId: string, publisher: Publisher) =>
      runPublishJob({ runtime: worker, broker: vault, publishers: { facebook_page: publisher }, callTimeoutMs: 2_000 }, o.orgId, variantId, 'facebook_page');

    it('publishes to the Page feed once and keeps the post link', async () => {
      const o = await org();
      const { postId, page, variantId } = await duePagePost(o, 'Khai trương chi nhánh mới!');
      const { asked, publisher } = graph({ status: 200, body: { id: `${page}_42` } });
      expect(await runPage(o, variantId, publisher)).toEqual({ action: 'call', status: 'published' });
      expect(asked).toEqual([{ path: `/v24.0/${page}/feed`, form: new URLSearchParams({ message: 'Khai trương chi nhánh mới!' }).toString() }]);
      const v = await variant(o, postId);
      expect([v.status, v.externalUrl]).toEqual(['published', `https://www.facebook.com/${page}_42`]);
      expect(await runPage(o, variantId, publisher)).toEqual({ action: 'none', reason: 'published' });
      expect(asked).toHaveLength(1);
    });

    it('reads the approved image from storage and posts it with the text', async () => {
      const o = await org();
      const bytes = new Uint8Array(Buffer.from('fake-jpeg-bytes'));
      const sha = createHash('sha256').update(bytes).digest('hex');
      const fileId = randomUUID();
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
           VALUES ($1, $2, $3, $4, $5, 'anh.jpg', 'image/jpeg', $6, 'social')`,
          [o.orgId, fileId, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, bytes.byteLength],
        ),
      );
      const { postId, page, variantId } = await duePagePost(o, 'Có ảnh', [{ fileId }]);
      const asked: { path: string; multipart: boolean }[] = [];
      const answers = [{ id: 'photo-1' }, { id: `${page}_99` }];
      const publisher = new FacebookPagePublisher({ appSecret: 'test-app-secret-not-real' }, async (input, init) => {
        asked.push({ path: new URL(input).pathname, multipart: init?.body instanceof FormData });
        return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      const reads: string[] = [];
      const store = { get: async (key: string) => (reads.push(key), bytes) } as unknown as BlobStore;
      const outcome = await runPublishJob({ runtime: worker, broker: vault, publishers: { facebook_page: publisher }, store, callTimeoutMs: 2_000 }, o.orgId, variantId, 'facebook_page');
      expect(outcome).toEqual({ action: 'call', status: 'published' });
      expect(reads).toEqual([`org/${o.orgId}/${sha}`]);
      expect(asked).toEqual([
        { path: `/v24.0/${page}/photos`, multipart: true },
        { path: `/v24.0/${page}/feed`, multipart: false },
      ]);
      expect((await variant(o, postId)).externalUrl).toBe(`https://www.facebook.com/${page}_99`);
    });

    it('posts nothing when the stored image no longer matches its hash', async () => {
      const o = await org();
      const sha = createHash('sha256').update('the approved bytes').digest('hex');
      const fileId = randomUUID();
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
           VALUES ($1, $2, $3, $4, $5, 'anh.jpg', 'image/jpeg', 18, 'social')`,
          [o.orgId, fileId, sha, `org/${o.orgId}/${sha}`, `content:${sha}`],
        ),
      );
      const { postId, variantId } = await duePagePost(o, 'Ảnh bị tráo', [{ fileId }]);
      const { asked, publisher } = graph({ status: 200, body: { id: 'never' } });
      const store = { get: async () => new Uint8Array(Buffer.from('swapped bytes')) } as unknown as BlobStore;
      await runPublishJob({ runtime: worker, broker: vault, publishers: { facebook_page: publisher }, store, callTimeoutMs: 2_000 }, o.orgId, variantId, 'facebook_page');
      expect(asked).toEqual([]);
      const v = await variant(o, postId);
      expect([v.status, v.error?.code]).toEqual(['failed', 'MEDIA_UNREADABLE']);
    });

    it('pauses the variant and expires the channel when Meta refuses the Page token', async () => {
      const o = await org();
      const { postId, connectionId, variantId } = await duePagePost(o, 'Bài sẽ bị từ chối');
      const { publisher } = graph({ status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } });
      await runPage(o, variantId, publisher);
      expect((await variant(o, postId)).status).toBe('paused');
      const channel = await admin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [connectionId])).rows[0]);
      expect(channel?.status).toBe('expired');
    });
  });

  // #642: a video's cover image is a file of the org the variant names in its settings; the job reads it like media.
  it('reads a video cover image for the platform, and only files a variant shows', async () => {
    const o = await org();
    const stored = new Map<string, Uint8Array>();
    const file = async (name: string, contentType: string, source = 'social') => {
      const bytes = new Uint8Array(Buffer.from(`${name}-${randomUUID()}`));
      const sha = createHash('sha256').update(bytes).digest('hex');
      const fileId = randomUUID();
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [o.orgId, fileId, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, name, contentType, bytes.byteLength, source],
        ),
      );
      stored.set(`org/${o.orgId}/${sha}`, bytes);
      return { fileId, bytes };
    };
    const video = await file('clip.mp4', 'video/mp4');
    const cover = await file('bia.png', 'image/png');
    const stray = await file('khac.png', 'image/png');
    const webp = await file('bia.webp', 'image/webp');
    const document = await file('hoadon.png', 'image/png', 'upload');
    const { connectionId } = await connect(o, `acct-${randomUUID().slice(0, 8)}`);
    const create = (settings: Record<string, unknown>) => exec<{ postId: string }>(o, 'social.post.create', { body: 'Video có ảnh bìa', media: [{ fileId: video.fileId }], channels: [{ connectionId, settings }] });
    // Only a JPEG or PNG image uploaded for posts, in a shape the adapters read.
    await expect(create({ cover: { fileId: document.fileId } })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(create({ cover: { fileId: webp.fileId } })).rejects.toMatchObject({ code: 'COVER_TYPE_UNSUPPORTED' });
    await expect(create({ cover: { atMs: -1 } })).rejects.toMatchObject({ code: 'COVER_INVALID' });
    await expect(create({ cover: { fileId: 'not-a-uuid' } })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });

    const { postId } = await create({ cover: { fileId: cover.fileId } });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    const v = post.variants[0];
    expect(v?.settings).toEqual({ cover: { fileId: cover.fileId } });
    expect(v?.issues).toEqual([]);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((x) => ({ variantId: x.id, revision: x.revision, contentHash: x.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));

    const read: Record<string, string> = {};
    const platform = new FakePlatform();
    const publish = platform.publish.bind(platform);
    platform.publish = async (input) => {
      for (const f of [video, cover, stray]) {
        read[f.fileId] = await input.readMedia(f.fileId).then(
          (b) => (Buffer.from(b).equals(Buffer.from(f.bytes)) ? 'read' : 'other'),
          () => 'refused',
        );
      }
      return publish(input);
    };
    const store = { get: async (key: string) => stored.get(key) as Uint8Array } as unknown as BlobStore;
    const outcome = await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, store, callTimeoutMs: 2_000 }, o.orgId, v?.id as string, 'sandbox');
    expect(outcome).toEqual({ action: 'call', status: 'published' });
    expect(platform.posts[0]?.settings).toEqual({ cover: { fileId: cover.fileId } });
    expect(read).toEqual({ [video.fileId]: 'read', [cover.fileId]: 'read', [stray.fileId]: 'refused' });
  });

  // S8 (#238): the metrics sweep asks the platform about published variants and keeps a snapshot per 6-hour capture.
  it('captures metrics of published variants once per capture and shows the latest in the summary', async () => {
    const o = await org();
    const platform = new SandboxPublisher();
    const { postId, variants } = await duePost(o);
    const id = variants[0] as string;
    expect(await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, id, 'sandbox')).toMatchObject({ status: 'published' });

    const first = await sweepMetrics({ runtime: worker, broker: vault, workerDb, publishers: { sandbox: platform } });
    expect(first.recorded).toBeGreaterThanOrEqual(1);
    // Captured now, it is not due again for 6 hours: a second sweep records nothing for it.
    await sweepMetrics({ runtime: worker, broker: vault, workerDb, publishers: { sandbox: platform } });
    const snapshots = await admin(async (c) => (await c.query<{ capture_key: string; metrics: Record<string, number> }>('SELECT capture_key, metrics FROM crove_social.metric_snapshot WHERE variant_id = $1', [id])).rows);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.capture_key).toBe(captureKey(new Date()));
    expect(snapshots[0]?.metrics).toMatchObject({ impressions: 40, reach: 30, reactions: 3 });

    const summary = await api.query<MetricsRow[]>('social.metrics.summary', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(summary).toMatchObject([{ variantId: id, postId, provider: 'sandbox', metrics: { reach: 30 } }]);
    // One post's channels, for the post screen (#578), and the window as an audited CSV file.
    expect(await api.query<MetricsRow[]>('social.metrics.summary', { postId }, { actor: asUser(o.owner), orgId: o.orgId })).toMatchObject([{ variantId: id }]);
    expect(await api.query<MetricsRow[]>('social.metrics.summary', { postId: randomUUID() }, { actor: asUser(o.owner), orgId: o.orgId })).toEqual([]);
    const file = await api.execute<{ filename: string; csv: string; truncated: boolean }>('social.metrics.export', { days: 30 }, { actor: asUser(o.owner), orgId: o.orgId });
    const lines = file.csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('post_id,channel,provider,published_at,url,text,labels,impressions,reach,reactions,comments,shares,saves,clicks,views,captured_at');
    expect(lines[1]).toContain(`${postId},Trang thử,sandbox,`);
    const audits = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.metrics.export' AND outcome = 'ok'", [o.orgId])).rows);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ days: 30, rows: 1, truncated: false });
    expect(file.truncated).toBe(false);
    // Tenant roles read snapshots but never write them: the record command is the system's.
    await expect(api.execute('social.metrics.record', { variantId: id, captureKey: 'x', metrics: {} }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    const roles = await admin(async (c) =>
      (await c.query<{ role: string }>(`SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r WHERE has_function_privilege(r, 'crove_social.metrics_due(int, text[], int)', 'EXECUTE')`)).rows,
    );
    expect(roles.map((r) => r.role)).toEqual(['crove_worker']);
  });

  it('keeps a failed metrics try as an empty capture, never asks a gone post again, and shows the last real answer', async () => {
    const o = await org();
    const platform = new SandboxPublisher();
    const { variants } = await duePost(o);
    const id = variants[0] as string;
    await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, id, 'sandbox');
    await sweepMetrics({ runtime: worker, broker: vault, workerDb, publishers: { sandbox: platform } });
    // Six hours later the platform does not answer: an empty capture, and the summary keeps the real numbers.
    await admin((c) => c.query("UPDATE crove_social.metric_snapshot SET captured_at = captured_at - interval '7 hours' WHERE variant_id = $1", [id]));
    const silent = Object.assign(Object.create(SandboxPublisher.prototype) as SandboxPublisher, platform, { metrics: async () => null });
    const later = new Date(Date.now() + 7 * 3_600_000);
    await sweepMetrics({ runtime: worker, broker: vault, workerDb, publishers: { sandbox: silent }, now: () => later });
    const rows = await admin(async (c) => (await c.query<{ extra: unknown }>('SELECT extra FROM crove_social.metric_snapshot WHERE variant_id = $1 ORDER BY captured_at', [id])).rows);
    expect(rows.map((r) => r.extra)).toEqual([null, { error: 'no_answer' }]);
    const summary = await api.query<MetricsRow[]>('social.metrics.summary', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(summary.find((r) => r.variantId === id)?.metrics).toMatchObject({ reach: 30 });
    // A post the platform says is gone is not due any more.
    await admin((c) => c.query("UPDATE crove_social.metric_snapshot SET captured_at = captured_at - interval '7 hours' WHERE variant_id = $1", [id]));
    const gone = Object.assign(Object.create(SandboxPublisher.prototype) as SandboxPublisher, platform, { metrics: async () => ({ refused: 'gone' as const }) });
    await sweepMetrics({ runtime: worker, broker: vault, workerDb, publishers: { sandbox: gone }, now: () => new Date(Date.now() + 14 * 3_600_000) });
    const due = await admin(async (c) => (await c.query<{ variant_id: string }>("SELECT variant_id FROM crove_social.metrics_due(1000, ARRAY['sandbox'], 600)")).rows);
    expect(due.map((r) => r.variant_id)).not.toContain(id);
  });
});