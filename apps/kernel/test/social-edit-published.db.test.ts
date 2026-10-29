// Correcting a published post's text on its platform on PostgreSQL 17 (#1223): an owner or admin asks with the new
// text, the approval-time checks run on it and their approval of the next revision is recorded, the edit job sends it
// through the sandbox adapter as its own recorded call, and only the platform's confirmation changes the channel's
// text, revision and hash, with a version of the post. A refusal or an unclear answer leaves the live text as it was
// and says so; members and viewers, blocked words and channels whose policy needs several people are refused with
// nothing queued.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxPublisher, type EditInput, type EditResult, type Publisher } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { runEditJob, runPublishJob, runRemoveJob, socialCommands, socialQueries, type ActivityItem, type PostView, type VersionView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type Org = { orgId: string; owner: string };

suite('correcting a published post on PostgreSQL (#1223)', () => {
  const dbName = `crove_test_social_edit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@edit.test`, name: null });

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

  // A post approved, due and published on a fresh sandbox channel, with the channel's signature when one is given.
  async function publishedPost(o: Org, platform: Publisher, options: { body?: string; signature?: string } = {}) {
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const { connectionId } = await connect(o, account);
    if (options.signature) await exec(o, 'social.channel.set_signature', { connectionId, signature: options.signature });
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: options.body ?? 'Phở bò giá 54.000đ', channels: [{ connectionId }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    const id = post.variants[0]?.id as string;
    expect(await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, id, 'sandbox')).toMatchObject({ status: 'published' });
    return { postId, id, account, connectionId };
  }

  const deps = (platform: Publisher) => ({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 });
  const variant = async (o: Org, postId: string) => (await get(o, postId)).variants[0] as PostView['variants'][number];
  const events = (o: Org, type: string) =>
    admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>('SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY created_at', [o.orgId, type])).rows.map((r) => r.payload));
  const editCalls = (id: string) =>
    admin(async (c) => (await c.query<{ key: string; state: string; retry_safety: string; error_code: string | null }>("SELECT key, state, retry_safety, error_code FROM crove_kernel.external_call WHERE key LIKE $1 ORDER BY started_at, key", [`social.publish:${id}:%:edit%`])).rows);
  const approvals = (id: string) =>
    admin(async (c) => (await c.query<{ revision: number; content_hash: string; decided_by: string; snapshot: { body: string }; checklist: unknown }>("SELECT revision, content_hash, decided_by, snapshot, checklist FROM crove_social.post_approval WHERE variant_id = $1 ORDER BY id", [id])).rows);
  const editColumns = (id: string) =>
    admin(async (c) => (await c.query<{ edit_state: string | null; edit_body: string | null; revision: number; published_revision: number | null; body: string | null }>('SELECT edit_state, edit_body, revision, published_revision, body FROM crove_social.post_variant WHERE id = $1', [id])).rows[0]);

  // Nothing was asked: no event, no approval past the publish's, no pending edit.
  async function nothingQueued(o: Org, id: string) {
    expect(await events(o, 'social.variant.edit_requested')).toEqual([]);
    expect(await approvals(id)).toHaveLength(1);
    expect(await editColumns(id)).toMatchObject({ edit_state: null, edit_body: null, revision: 1 });
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
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
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

  it('corrects the live text once the platform confirms it, with the approval, a version and the signature', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id, account } = await publishedPost(o, sandbox, { signature: 'Hotline 0901 234 567' });
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Phở bò giá 54.000đ\n\nHotline 0901 234 567']);
    const before = await variant(o, postId);

    expect(await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Phở bò giá 45.000đ' })).toEqual({ postId, variantId: id, revision: 1, queued: true });
    expect(await events(o, 'social.variant.edit_requested')).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', after: null }]);
    // The person's approval of the next revision and the hash of the text with its signature.
    const asked = await approvals(id);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ revision: 2, decided_by: o.owner, snapshot: { body: 'Phở bò giá 45.000đ\n\nHotline 0901 234 567' }, checklist: null });
    // Live text unchanged until the platform answers; a second ask while it is on its way is refused.
    const pending = await variant(o, postId);
    expect(pending).toMatchObject({ status: 'published', revision: 1, contentHash: before.contentHash, effective: before.effective, liveEdit: { state: 'pending', code: null, body: 'Phở bò giá 45.000đ', requestedBy: o.owner } });
    await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Phở bò giá 46.000đ' })).rejects.toMatchObject({ code: 'EDIT_PENDING' });

    expect(await runEditJob(deps(sandbox), o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Phở bò giá 45.000đ\n\nHotline 0901 234 567']);
    const after = await variant(o, postId);
    expect(after).toMatchObject({ status: 'published', revision: 2, contentHash: asked[1]?.content_hash, liveEdit: null, overrides: { body: 'Phở bò giá 45.000đ' } });
    expect(after.effective.body).toBe('Phở bò giá 45.000đ\n\nHotline 0901 234 567');
    expect(after.contentHash).not.toBe(before.contentHash);
    // The latest decision is the approval of the content as it is now.
    expect(after.latestDecision).toMatchObject({ decision: 'approved', decidedBy: o.owner, revision: 2, current: true });
    expect(await editColumns(id)).toMatchObject({ edit_state: null, edit_body: null, revision: 2, published_revision: 1 });
    expect(await editCalls(id)).toEqual([{ key: `social.publish:${id}:1:1:edit`, state: 'succeeded', retry_safety: 'idempotent', error_code: null }]);
    expect(await events(o, 'social.variant.edited')).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', by: o.owner, revision: 2 }]);
    const audit = await admin(async (c) => (await c.query<{ actor_id: string; target_id: string; detail: Record<string, unknown> }>("SELECT actor_id, target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.variant.edit_published' AND outcome = 'ok'", [o.orgId])).rows);
    expect(audit).toEqual([{ actor_id: o.owner, target_id: id, detail: { post_id: postId, variant_id: id, provider: 'sandbox', revision: 2, content_hash: asked[1]?.content_hash } }]);

    // The versions show the text before and after, the new one the person's, with their approval.
    const { versions } = await api.query<{ versions: VersionView[] }>('social.post.versions', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(versions.map((v) => [v.number, v.createdBy, v.variants[0]?.content.body])).toEqual([
      [2, o.owner, 'Phở bò giá 45.000đ\n\nHotline 0901 234 567'],
      [1, null, 'Phở bò giá 54.000đ\n\nHotline 0901 234 567'],
    ]);
    expect(versions[0]?.variants[0]?.approvals.map((a) => a.decidedBy)).toEqual([o.owner]);
    // The timeline: asked by the owner, then confirmed by the platform.
    const activity = await api.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(activity.items.filter((i) => i.kind === 'live_edit' || i.kind === 'live_edited').map((i) => [i.kind, i.userId, i.variantId])).toEqual([
      ['live_edited', null, id],
      ['live_edit', o.owner, id],
    ]);

    // A second job of the same ask changes nothing; the steps done once for the post keep their keys: a removal is
    // named by the revision it went out under.
    expect(await runEditJob(deps(sandbox), o.orgId, id, 'sandbox', null)).toEqual({ action: 'none', reason: 'not_asked' });
    await exec(o, 'social.variant.remove', { variantId: id });
    expect(await runRemoveJob(deps(sandbox), o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(await admin(async (c) => (await c.query<{ key: string }>("SELECT key FROM crove_kernel.external_call WHERE key LIKE $1", [`social.publish:${id}:%:remove%`])).rows)).toEqual([{ key: `social.publish:${id}:1:1:remove` }]);
  });

  it("hands the adapter the connection's stored scopes, and a reconnect asked for keeps the live text (#1474)", async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const seen: (readonly string[] | undefined)[] = [];
    // As YouTube answers for a connection whose grant lacks youtube.force-ssl, before any call.
    const scoped: Publisher = {
      provider: 'sandbox',
      publishSafety: sandbox.publishSafety,
      publish: (i) => sandbox.publish(i),
      edit: async (i: EditInput) => {
        seen.push(i.scopes);
        return { kind: 'rejected', error: 'permission', code: 'RECONNECT_FOR_EDIT' };
      },
    };
    const { postId, id, account } = await publishedPost(o, scoped);
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá đúng: 45.000đ' });
    expect(await runEditJob(deps(scoped), o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'failed' });
    expect(seen).toEqual([['publish']]);
    expect(await variant(o, postId)).toMatchObject({ status: 'published', revision: 1, overrides: { body: 'Phở bò giá 54.000đ' }, liveEdit: { state: 'failed', code: 'RECONNECT_FOR_EDIT', body: 'Giá đúng: 45.000đ' } });
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Phở bò giá 54.000đ']);
  });

  it('keeps the live text when the platform refuses, leaves an unclear answer to a person, and asks once per ask', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const answers: EditResult[] = [{ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_CANNOT_EDIT' }, { kind: 'unknown', code: 'TIMEOUT' }];
    const flaky: Publisher = {
      provider: 'sandbox',
      publishSafety: sandbox.publishSafety,
      publish: (i) => sandbox.publish(i),
      edit: async (i: EditInput) => answers.shift() ?? sandbox.edit(i),
    };
    const { postId, id, account } = await publishedPost(o, flaky);
    const key = `social.publish:${id}:1:1:edit`;

    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá đúng: 45.000đ' });
    expect(await runEditJob(deps(flaky), o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'failed' });
    expect(await variant(o, postId)).toMatchObject({ status: 'published', revision: 1, overrides: { body: 'Phở bò giá 54.000đ' }, liveEdit: { state: 'failed', code: 'TELEGRAM_CANNOT_EDIT', body: 'Giá đúng: 45.000đ' } });
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Phở bò giá 54.000đ']);
    expect(await events(o, 'social.variant.edit_failed')).toEqual([{ post_id: postId, variant_id: id, provider: 'sandbox', code: 'TELEGRAM_CANNOT_EDIT', unclear: false, by: o.owner }]);

    // Asked again: the ask names the call it saw; a job of the first ask is stale now.
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá đúng: 45.000đ' });
    expect((await events(o, 'social.variant.edit_requested')).at(-1)).toEqual({ post_id: postId, variant_id: id, provider: 'sandbox', after: key });
    expect(await runEditJob(deps(flaky), o.orgId, id, 'sandbox', null)).toEqual({ action: 'none', reason: 'stale' });
    expect(await runEditJob(deps(flaky), o.orgId, id, 'sandbox', key)).toEqual({ action: 'call', state: 'ambiguous' });
    expect(await variant(o, postId)).toMatchObject({ revision: 1, liveEdit: { state: 'unknown', code: 'TIMEOUT' } });
    // An unclear edit goes to a person, never again by the job: the same ask's second job stops.
    expect(await runEditJob(deps(flaky), o.orgId, id, 'sandbox', key)).toEqual({ action: 'none', reason: 'not_asked' });
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá đúng: 45.000đ' });
    expect(await runEditJob(deps(flaky), o.orgId, id, 'sandbox', `${key}_2`)).toEqual({ action: 'call', state: 'succeeded' });
    expect(await editCalls(id)).toEqual([
      { key, state: 'failed', retry_safety: 'idempotent', error_code: 'TELEGRAM_CANNOT_EDIT' },
      { key: `${key}_2`, state: 'ambiguous', retry_safety: 'idempotent', error_code: 'TIMEOUT' },
      { key: `${key}_3`, state: 'succeeded', retry_safety: 'idempotent', error_code: null },
    ]);
    expect(await variant(o, postId)).toMatchObject({ revision: 2, overrides: { body: 'Giá đúng: 45.000đ' }, liveEdit: null });
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Giá đúng: 45.000đ']);
    // The timeline says it failed before it went through.
    const activity = await api.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(activity.items.filter((i) => i.kind === 'live_edit_failed').map((i) => i.code)).toEqual(['TIMEOUT', 'TELEGRAM_CANNOT_EDIT']);
  });

  it('refuses members and viewers, and lets admins whatever channel list they hold', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { id, connectionId } = await publishedPost(o, sandbox);
    for (const role of ['member', 'viewer'] as const) {
      const userId = await member(o, role);
      // A member limited to this very channel (#1081) is refused all the same: the edit is for owners and admins.
      if (role === 'member') await exec(o, 'social.channel_access.set', { userId, channelConnectionIds: [connectionId] });
      await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Sửa' }, userId)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    await nothingQueued(o, id);
    // An admin is never limited by a list (#1081): one kept from when they were a member, naming another channel.
    const other = await connect(o, `acct-${randomUUID().slice(0, 8)}`);
    const adminId = await member(o, 'member');
    await exec(o, 'social.channel_access.set', { userId: adminId, channelConnectionIds: [other.connectionId] });
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [o.orgId, adminId]));
    expect(await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Sửa giá' }, adminId)).toMatchObject({ queued: true });
  });

  it('runs the checks of an approval on the new text: blocked words, the channel rules and the checklist', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id } = await publishedPost(o, sandbox);
    await exec(o, 'social.banned_word.add', { phrase: 'rẻ nhất', level: 'block' });
    await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Phở rẻ nhất phố' })).rejects.toMatchObject({ code: 'BANNED_WORDS' });
    await nothingQueued(o, id);
    await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'VARIANT_INVALID' });
    await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Phở bò giá 54.000đ' })).rejects.toMatchObject({ code: 'EDIT_UNCHANGED' });
    await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 2, body: 'Sửa giá' })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await nothingQueued(o, id);

    // The review checklist: every item ticked, kept on the approval.
    await exec(o, 'social.review_check.set', { items: [{ connectionId: null, label: 'Đúng giá' }] });
    const [check] = (await variant(o, postId)).checklist;
    await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Sửa giá' })).rejects.toMatchObject({ code: 'CHECKLIST_INCOMPLETE' });
    await nothingQueued(o, id);
    expect(await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Sửa giá', checks: [check?.id] })).toMatchObject({ queued: true });
    expect((await approvals(id)).at(-1)?.checklist).toEqual([{ id: check?.id, label: 'Đúng giá' }]);
  });

  it('refuses a channel whose policy needs several people, with nothing queued', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const steps = await publishedPost(o, sandbox);
    await exec(o, 'social.channel.set_policy', { connectionId: steps.connectionId, approvalsRequired: 2 });
    await expect(exec(o, 'social.variant.edit_published', { variantId: steps.id, revision: 1, body: 'Sửa giá' })).rejects.toMatchObject({ code: 'EDIT_NEEDS_REVIEW' });
    await nothingQueued(o, steps.id);
    const foureyes = await publishedPost(o, sandbox);
    await exec(o, 'social.channel.set_four_eyes', { connectionId: foureyes.connectionId, fourEyes: true });
    await expect(exec(o, 'social.variant.edit_published', { variantId: foureyes.id, revision: 1, body: 'Sửa giá' })).rejects.toMatchObject({ code: 'EDIT_NEEDS_REVIEW' });
    await nothingQueued(o, foureyes.id);
    const client = await publishedPost(o, sandbox);
    await exec(o, 'social.channel.set_client_approval', { connectionId: client.connectionId, clientApproval: true });
    await expect(exec(o, 'social.variant.edit_published', { variantId: client.id, revision: 1, body: 'Sửa giá' })).rejects.toMatchObject({ code: 'EDIT_NEEDS_REVIEW' });
    await nothingQueued(o, client.id);
  });

  it('refuses a channel that is not published, a platform with no edit, and a poll', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { connectionId } = await connect(o, `acct-${randomUUID().slice(0, 8)}`);
    const draft = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Nháp', channels: [{ connectionId }] });
    const draftId = (await get(o, draft.postId)).variants[0]?.id as string;
    await expect(exec(o, 'social.variant.edit_published', { variantId: draftId, revision: 1, body: 'Sửa' })).rejects.toMatchObject({ code: 'EDIT_NOT_PUBLISHED' });

    // A published channel on a platform with no edit (as if it were an Instagram account).
    const other = await publishedPost(o, sandbox);
    await admin((c) => c.query("UPDATE crove_social.post_variant SET provider = 'instagram' WHERE id = $1", [other.id]));
    await expect(exec(o, 'social.variant.edit_published', { variantId: other.id, revision: 1, body: 'Sửa' })).rejects.toMatchObject({ code: 'EDIT_NOT_SUPPORTED', details: { reason: 'provider' } });
    // And the job never edits what the command did not ask for.
    expect(await runEditJob(deps(sandbox), o.orgId, other.id, 'sandbox', null)).toEqual({ action: 'none', reason: 'provider_mismatch' });

    const poll = await publishedPost(o, sandbox);
    await admin((c) => c.query(`UPDATE crove_social.post_variant SET settings = settings || '{"poll":{"options":["Có","Không"]}}'::jsonb WHERE id = $1`, [poll.id]));
    await expect(exec(o, 'social.variant.edit_published', { variantId: poll.id, revision: 1, body: 'Sửa' })).rejects.toMatchObject({ code: 'EDIT_NOT_SUPPORTED', details: { reason: 'poll' } });
    await nothingQueued(o, poll.id);
  });

  // The worker's record, called by hand, to put a late answer after a person's second ask.
  const record = (o: Org, id: string, callKey: string, result: EditResult) => worker.execute('social.edit.record', { variantId: id, callKey, result }, { actor: { type: 'system', component: 'social.publisher' }, orgId: o.orgId });
  // The ask's call as begin records it, made two hours ago and gone quiet past EDIT_STALE_MS (a call row's time never
  // changes, so it is written as begin would have then), so a person may ask again.
  const quietCall = (o: Org, id: string, key: string) =>
    admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, request_hash, started_at)
         SELECT org_id, $2, 'social', provider, 'edit', 'idempotent', edit_content_hash, now() - interval '2 hours' FROM crove_social.post_variant WHERE id = $1`,
        [id, key],
      );
      await c.query("UPDATE crove_social.post_variant SET edit_requested_at = now() - interval '3 hours' WHERE id = $1", [id]);
    });

  it('applies a late answer to the ask it was made for, never to a newer one (#1223 review)', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id } = await publishedPost(o, sandbox, { signature: 'Hotline 0901 234 567' });
    const key = `social.publish:${id}:1:1:edit`;

    // E1 is sent and goes quiet; the person asks again with E2 before its answer comes.
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 45.000đ' });
    await quietCall(o, id, key);
    expect((await variant(o, postId)).liveEdit).toMatchObject({ state: 'unknown', code: 'OUTCOME_UNKNOWN' });
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 46.000đ' });

    // E1's confirmation arrives: the channel shows E1, so the variant takes E1 (its text from the approval of its hash),
    // and E2, asked before that was known, is stopped for the person to send again.
    expect(await record(o, id, key, { kind: 'edited' })).toMatchObject({ recorded: true, state: 'succeeded', revision: 2 });
    const after = await variant(o, postId);
    expect(after).toMatchObject({ revision: 2, overrides: { body: 'Giá 45.000đ' }, liveEdit: { state: 'failed', code: 'EDIT_SUPERSEDED', body: 'Giá 46.000đ' } });
    expect(after.effective.body).toBe('Giá 45.000đ\n\nHotline 0901 234 567');
    expect(after.contentHash).toBe((await approvals(id))[1]?.content_hash);
    // E2's job sends nothing.
    expect(await runEditJob(deps(sandbox), o.orgId, id, 'sandbox', key)).toEqual({ action: 'none', reason: 'not_asked' });
    expect(await editCalls(id)).toHaveLength(1);
  });

  it('leaves a newer ask pending when an older ask is refused late, and finishes it when both asked the same text', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id, account } = await publishedPost(o, sandbox);
    const key = `social.publish:${id}:1:1:edit`;
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 45.000đ' });
    await quietCall(o, id, key);
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 46.000đ' });
    // E1 refused late: the platform shows what it showed; E2 is not marked failed and still goes out.
    await record(o, id, key, { kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_CANNOT_EDIT' });
    expect(await variant(o, postId)).toMatchObject({ revision: 1, liveEdit: { state: 'pending', body: 'Giá 46.000đ' } });
    expect(await runEditJob(deps(sandbox), o.orgId, id, 'sandbox', key)).toEqual({ action: 'call', state: 'succeeded' });
    expect(await variant(o, postId)).toMatchObject({ revision: 2, overrides: { body: 'Giá 46.000đ' }, liveEdit: null });
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Giá 46.000đ']);

    // Asked again with the same text: the late confirmation of the first call settles the second ask too.
    const same = await publishedPost(o, sandbox);
    const sameKey = `social.publish:${same.id}:1:1:edit`;
    await exec(o, 'social.variant.edit_published', { variantId: same.id, revision: 1, body: 'Giá 45.000đ' });
    await quietCall(o, same.id, sameKey);
    await exec(o, 'social.variant.edit_published', { variantId: same.id, revision: 1, body: 'Giá 45.000đ' });
    await record(o, same.id, sameKey, { kind: 'edited' });
    expect(await variant(o, same.postId)).toMatchObject({ revision: 2, overrides: { body: 'Giá 45.000đ' }, liveEdit: null });
  });

  it('never sends an ask its job reached too late, or one the policy or the blocked words now refuse', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    // Delayed past EDIT_STALE_MS (a worker outage): the page already said it did not run, and nothing goes out.
    const late = await publishedPost(o, sandbox);
    await exec(o, 'social.variant.edit_published', { variantId: late.id, revision: 1, body: 'Giá 45.000đ' });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET edit_requested_at = now() - interval '2 hours' WHERE id = $1", [late.id]));
    expect(await runEditJob(deps(sandbox), o.orgId, late.id, 'sandbox', null)).toEqual({ action: 'none', reason: 'EDIT_NOT_RUN' });
    expect(await variant(o, late.postId)).toMatchObject({ revision: 1, liveEdit: { state: 'failed', code: 'EDIT_NOT_RUN' } });
    expect(await editCalls(late.id)).toEqual([]);
    expect(sandbox.posts(late.account).map((p) => p.body)).toEqual(['Phở bò giá 54.000đ']);

    // The channel's policy raised after the ask.
    const policy = await publishedPost(o, sandbox);
    await exec(o, 'social.variant.edit_published', { variantId: policy.id, revision: 1, body: 'Giá 45.000đ' });
    await exec(o, 'social.channel.set_policy', { connectionId: policy.connectionId, approvalsRequired: 2 });
    expect(await runEditJob(deps(sandbox), o.orgId, policy.id, 'sandbox', null)).toEqual({ action: 'none', reason: 'EDIT_NEEDS_REVIEW' });
    expect(await variant(o, policy.postId)).toMatchObject({ revision: 1, liveEdit: { state: 'failed', code: 'EDIT_NEEDS_REVIEW' } });
    expect(await editCalls(policy.id)).toEqual([]);

    // A word blocked after the ask.
    const banned = await publishedPost(o, sandbox);
    await exec(o, 'social.variant.edit_published', { variantId: banned.id, revision: 1, body: 'Phở ngon nhất phố' });
    await exec(o, 'social.banned_word.add', { phrase: 'ngon nhất', level: 'block' });
    expect(await runEditJob(deps(sandbox), o.orgId, banned.id, 'sandbox', null)).toEqual({ action: 'none', reason: 'BANNED_WORDS' });
    expect(await variant(o, banned.postId)).toMatchObject({ revision: 1, liveEdit: { state: 'failed', code: 'BANNED_WORDS' } });
    expect(await editCalls(banned.id)).toEqual([]);
    expect((await events(o, 'social.variant.edit_failed')).map((e) => e.code)).toEqual(['EDIT_NOT_RUN', 'EDIT_NEEDS_REVIEW', 'BANNED_WORDS']);
  });

  it('sends nothing while publishing is held, and refuses an ask during the hold (#946)', async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const { postId, id, account } = await publishedPost(o, sandbox);
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 45.000đ' });
    await exec(o, 'social.publishing.hold', { reason: 'Ngày quốc tang' });
    expect(await runEditJob(deps(sandbox), o.orgId, id, 'sandbox', null)).toEqual({ action: 'none', reason: 'PUBLISHING_HELD' });
    expect(await variant(o, postId)).toMatchObject({ revision: 1, liveEdit: { state: 'failed', code: 'PUBLISHING_HELD' } });
    expect(await editCalls(id)).toEqual([]);
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Phở bò giá 54.000đ']);
    await expect(exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 45.000đ' })).rejects.toMatchObject({ code: 'PUBLISHING_HELD' });
    // After the release the person sends it again, and it goes out.
    await exec(o, 'social.publishing.release', {});
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 45.000đ' });
    expect(await runEditJob(deps(sandbox), o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'succeeded' });
    expect(sandbox.posts(account).map((p) => p.body)).toEqual(['Giá 45.000đ']);
  });

  it("hands the adapter public URLs of the variant's own files only, for a platform whose edit fetches its images again (#1430)", async () => {
    const o = await org();
    const sandbox = new SandboxPublisher();
    const asked: (string | null | Error)[] = [];
    const checking = (store: boolean): Publisher => ({
      provider: 'sandbox',
      publishSafety: sandbox.publishSafety,
      publish: (i) => sandbox.publish(i),
      edit: async (i: EditInput) => {
        // Not a file of this variant (it has none): never signed, whatever the store.
        asked.push(await (i.mediaUrl?.(randomUUID()) ?? Promise.resolve('absent')).catch((error: Error) => error));
        return store ? sandbox.edit(i) : { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
      },
    });
    const signing = { direct: { presignDownload: async () => 'https://bucket.example/signed' } } as unknown as NonNullable<Parameters<typeof runEditJob>[0]['store']>;
    const { id } = await publishedPost(o, checking(true));
    await exec(o, 'social.variant.edit_published', { variantId: id, revision: 1, body: 'Giá 45.000đ' });
    expect(await runEditJob({ ...deps(checking(true)), store: signing }, o.orgId, id, 'sandbox', null)).toEqual({ action: 'call', state: 'succeeded' });
    // A store that cannot sign (local disk) answers null before any lookup.
    const other = await publishedPost(o, checking(false));
    await exec(o, 'social.variant.edit_published', { variantId: other.id, revision: 1, body: 'Giá 46.000đ' });
    expect(await runEditJob(deps(checking(false)), o.orgId, other.id, 'sandbox', null)).toEqual({ action: 'call', state: 'failed' });
    expect(asked).toEqual([expect.objectContaining({ message: 'not an image of this variant' }), null]);
  });
});
