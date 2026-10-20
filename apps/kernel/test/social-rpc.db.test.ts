// Crove Social through the API (Social plan S3, the oRPC contract): connect the sandbox channel, compose, submit,
// decide on what was seen, schedule; roles and the module switch hold at the RPC edge. The command rules are in
// test/social-posts.db.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { CredentialVault, parseVaultKey, Runtime, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import type { SocialDrafter } from '../src/rpc.ts';
import type { DraftRequest, DraftResult } from '@crove/agent';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-channels-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

suite('social posts through the API', () => {
  const dbName = `crove_test_social_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let config: ReturnType<typeof loadConfig>;
  let apps: Record<'on' | 'off' | 'noAi', ReturnType<typeof createHttpApp>>;
  // Stands in for the model: answers what the test queued, remembers what it was asked.
  const writerAnswers: (DraftResult | null)[] = [];
  const writerAsked: DraftRequest[] = [];
  const rewriteAsked: Parameters<SocialDrafter['rewrite']>[0][] = [];
  const writer: SocialDrafter = {
    draft: async (request) => {
      writerAsked.push(request);
      return writerAnswers.shift() ?? null;
    },
    rewrite: async (request) => {
      rewriteAsked.push(request);
      return request.text === 'nothing' ? null : { text: `${request.action}: ${request.text}`, title: request.title };
    },
  };
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const owner: Account = { subject: randomUUID(), email: 'owner@social-api.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@social-api.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, options: { slug?: string | null; app?: keyof typeof apps } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    const kernel = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernel.commands, ...socialCommands],
      queries: [...kernel.queries, ...socialQueries],
    });
    const withoutSocial = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(kernel);
    config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const store = {} as BlobStore;
    const make = (rt: Runtime, socialWriter?: SocialDrafter) =>
      createHttpApp({ config, runtime: rt, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: { broker: vault, sandbox: true }, ...(socialWriter ? { socialWriter } : {}) });
    apps = { on: make(runtime, writer), off: make(withoutSocial), noAi: make(runtime) };

    for (const who of [owner, viewer]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Kênh', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    const accepted = await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, { slug: null });
    expect(accepted.status).toBe(200);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('composes, reviews and schedules through the API', async () => {
    const owner_ = await tokenFor(owner);
    const connected = await rpc('channels/connectSandbox', owner_, { displayName: 'Trang thử nghiệm', key: randomUUID() });
    expect(connected.status).toBe(200);
    const connectionId = String(connected.body?.connectionId);
    const created = await rpc('social/posts/create', owner_, { body: 'Xin chào Crove Social', channels: [{ connectionId }], idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    const postId = String(created.body?.postId);
    // A retry with the same key returns the first post.
    const key = randomUUID();
    const first = await rpc('social/posts/create', owner_, { body: 'Một lần thôi', channels: [{ connectionId }], idempotencyKey: key });
    const again = await rpc('social/posts/create', owner_, { body: 'Một lần thôi', channels: [{ connectionId }], idempotencyKey: key });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body?.postId).toBe(first.body?.postId);
    const all = await rpc('social/posts/list', owner_, {});
    expect(all.body.filter((p: { body: string }) => p.body === 'Một lần thôi')).toHaveLength(1);

    expect((await rpc('social/posts/submit', owner_, { postId })).status).toBe(200);
    const seen = await rpc('social/posts/get', await tokenFor(viewer), { postId });
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ status: 'draft', variants: [{ status: 'in_review', provider: 'sandbox', issues: [] }] });
    const variants = (seen.body.variants as Array<{ id: string; revision: number; contentHash: string }>).map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
    expect((await rpc('social/variants/decide', await tokenFor(viewer), { postId, decision: 'approved', variants })).status).toBe(403);
    expect((await rpc('social/variants/decide', owner_, { postId, decision: 'approved', variants })).status).toBe(200);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await rpc('social/variants/schedule', owner_, { postId, at });
    expect(scheduled).toMatchObject({ status: 200, body: { scheduled: [{ at }] } });
    const list = await rpc('social/posts/list', owner_, { from: new Date().toISOString(), to: new Date(Date.now() + 7_200_000).toISOString() });
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([postId]);
    // Every other procedure once, so each output passes the contract's schema at runtime.
    const approved = await rpc('social/posts/get', owner_, { postId });
    expect(approved.body.variants[0]).toMatchObject({ status: 'scheduled', latestDecision: { decision: 'approved', current: true } });
    const variantId = String(approved.body.variants[0].id);
    expect((await rpc('social/variants/unschedule', owner_, { variantIds: [variantId] })).status).toBe(200);
    expect((await rpc('social/queues/set', owner_, { connectionId, timeZone: 'Asia/Ho_Chi_Minh', slots: [{ weekday: 1, minute: 540, label: 'Sáng' }] })).status).toBe(200);
    const queue = await rpc('social/queues/get', owner_, { connectionId });
    expect(queue).toMatchObject({ status: 200, body: { slots: [{ weekday: 1, minute: 540, label: 'Sáng', active: true }] } });
    expect(queue.body.nextFree.length).toBeGreaterThan(0);
    const updated = await rpc('social/posts/update', owner_, { postId, revision: approved.body.revision, body: 'Đã sửa' });
    expect(updated).toMatchObject({ status: 200, body: { changedVariants: [variantId] } });
    const v = (await rpc('social/posts/get', owner_, { postId })).body.variants[0];
    expect((await rpc('social/variants/update', owner_, { variantId, revision: v.revision, body: 'Bản riêng' })).body).toMatchObject({ changed: true });
    const second = await rpc('channels/connectSandbox', owner_, { displayName: 'Trang 2', key: randomUUID() });
    expect((await rpc('social/posts/addChannels', owner_, { postId, channels: [{ connectionId: String(second.body?.connectionId) }] })).status).toBe(200);
    // Retry and resolve are for failed or needs_attention variants, and for owners and admins.
    expect((await rpc('social/variants/retry', await tokenFor(viewer), { variantIds: [variantId] })).status).toBe(403);
    expect((await rpc('social/variants/retry', owner_, { variantIds: [variantId] })).body).toMatchObject({ code: 'VARIANT_STATE' });
    expect((await rpc('social/variants/resolve', owner_, { variantIds: [variantId], outcome: 'dropped' })).body).toMatchObject({ code: 'VARIANT_STATE' });
    expect((await rpc('social/variants/cancel', owner_, { variantIds: [variantId] })).status).toBe(200);
  });

  it('answers 404 when the deployment leaves the social module out', async () => {
    const off = await rpc('social/posts/list', await tokenFor(owner), {}, { app: 'off' });
    expect(off.status).toBe(404);
  });

  // AI drafting (S7, #237): the server drafts with the deployment's model and saves an AI post, tainted.
  it('drafts a post with AI for the chosen channels, marked as AI and needing review', async () => {
    const owner_ = await tokenFor(owner);
    const connected = await rpc('channels/connectSandbox', owner_, { displayName: 'Trang AI', key: randomUUID() });
    const connectionId = String(connected.body?.connectionId);
    writerAnswers.push({ body: 'Khai trương chi nhánh Quận 3, giảm 20% tuần đầu!', title: null, variants: [{ key: connectionId, body: 'Bản riêng cho kênh thử', title: null }] });
    const drafted = await rpc('social/posts/draftWithAi', owner_, { brief: 'Khai trương chi nhánh Quận 3, giảm 20% tuần đầu', connectionIds: [connectionId] });
    expect(drafted.status).toBe(200);
    expect(writerAsked.at(-1)?.channels).toEqual([{ key: connectionId, provider: 'sandbox', label: 'test channel (Trang AI)', maxChars: 1000, unit: 'characters', title: null }]);
    const post = await rpc('social/posts/get', owner_, { postId: drafted.body?.postId });
    expect(post.body).toMatchObject({ origin: 'ai', tainted: true, body: 'Khai trương chi nhánh Quận 3, giảm 20% tuần đầu!' });
    expect(post.body.variants).toMatchObject([{ status: 'draft', effective: { body: 'Bản riêng cho kênh thử' } }]);
    // The app's own create cannot claim an origin.
    const forged = await rpc('social/posts/create', owner_, { body: 'x', origin: 'human', channels: [{ connectionId }], idempotencyKey: randomUUID() });
    expect(forged.status).toBe(400);
  });

  it('refuses AI drafting for a viewer, a foreign channel, without AI, and answers an empty draft plainly', async () => {
    const owner_ = await tokenFor(owner);
    const connected = await rpc('channels/connectSandbox', owner_, { displayName: 'Trang AI 2', key: randomUUID() });
    const connectionId = String(connected.body?.connectionId);
    const asked = writerAsked.length;
    expect((await rpc('social/posts/draftWithAi', await tokenFor(viewer), { brief: 'x', connectionIds: [connectionId] })).status).toBe(403);
    // The model was not called for the viewer.
    expect(writerAsked.length).toBe(asked);
    expect(await rpc('social/posts/draftWithAi', owner_, { brief: 'x', connectionIds: [randomUUID()] })).toMatchObject({ status: 404, body: { code: 'CHANNEL_NOT_FOUND' } });
    expect(await rpc('social/posts/draftWithAi', owner_, { brief: 'x', connectionIds: [connectionId] }, { app: 'noAi' })).toMatchObject({ status: 503, body: { code: 'AI_NOT_CONFIGURED' } });
    writerAnswers.push(null);
    expect(await rpc('social/posts/draftWithAi', owner_, { brief: 'x', connectionIds: [connectionId] })).toMatchObject({ status: 422, body: { code: 'AI_DRAFT_EMPTY' } });
  });

  it('rewrites a text for a channel as a proposal, and an accepted one marks the post AI-assisted (#583)', async () => {
    const owner_ = await tokenFor(owner);
    const connected = await rpc('channels/connectSandbox', owner_, { displayName: 'Trang viết lại', key: randomUUID() });
    const connectionId = String(connected.body?.connectionId);
    const rewritten = await rpc('social/posts/rewriteWithAi', owner_, { text: 'Khai trương chi nhánh mới', action: 'shorten', connectionId });
    expect(rewritten).toMatchObject({ status: 200, body: { text: 'shorten: Khai trương chi nhánh mới', title: null } });
    expect(rewriteAsked.at(-1)?.channel).toMatchObject({ key: connectionId, maxChars: 1000 });
    expect((await rpc('social/posts/rewriteWithAi', await tokenFor(viewer), { text: 'x', action: 'formal' })).status).toBe(403);
    expect(await rpc('social/posts/rewriteWithAi', owner_, { text: 'nothing', action: 'casual' })).toMatchObject({ status: 422, body: { code: 'AI_REWRITE_EMPTY' } });
    expect(await rpc('social/posts/rewriteWithAi', owner_, { text: 'x', action: 'formal' }, { app: 'noAi' })).toMatchObject({ status: 503, body: { code: 'AI_NOT_CONFIGURED' } });

    // A person's post stays untainted until they accept a rewrite into it.
    const created = await rpc('social/posts/create', owner_, { body: 'Viết tay', channels: [{ connectionId }], idempotencyKey: randomUUID() });
    const postId = String(created.body?.postId);
    let post = await rpc('social/posts/get', owner_, { postId });
    expect(post.body).toMatchObject({ origin: 'human', tainted: false });
    await rpc('social/posts/update', owner_, { postId, revision: post.body.revision, body: 'shorten: Viết tay', aiAssisted: true });
    post = await rpc('social/posts/get', owner_, { postId });
    expect(post.body).toMatchObject({ origin: 'human', tainted: true });
    const assisted = await rpc('social/posts/create', owner_, { body: 'formal: x', aiAssisted: true, channels: [{ connectionId }], idempotencyKey: randomUUID() });
    expect((await rpc('social/posts/get', owner_, { postId: assisted.body?.postId })).body).toMatchObject({ tainted: true });
  });
});