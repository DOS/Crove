// Channel connections through the API (ADR-0025, Social plan S2, issue #232): the sandbox channel connects,
// reconnects and disconnects; members list connections and never see a credential; without a credential key or
// with the sandbox off, nothing connects. The security properties are in test/invariant/channel-credentials.db.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries, type SealedChannelCredential } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { noCredentialBroker } from '../src/credentials.ts';
import { createHttpApp } from '../src/http.ts';
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

suite('channel connections through the API (ADR-0025)', () => {
  const dbName = `crove_test_channels_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Runtime;
  let config: ReturnType<typeof loadConfig>;
  let apps: Record<'on' | 'noKey' | 'sandboxOff', ReturnType<typeof createHttpApp>>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const owner: Account = { subject: randomUUID(), email: 'owner@channels-api.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@channels-api.test', session: randomUUID(), userId: '' };
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
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(createDb(workerPool)).register(defs);
    config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const store = {} as BlobStore;
    const make = (channels: { broker: typeof vault | typeof noCredentialBroker; sandbox: boolean }) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels });
    apps = {
      on: make({ broker: vault, sandbox: true }),
      noKey: make({ broker: noCredentialBroker, sandbox: true }),
      sandboxOff: make({ broker: vault, sandbox: false }),
    };

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
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  let connectionId = '';
  const sandboxKey = randomUUID();

  it('connects the sandbox channel and lists it without any credential', async () => {
    const connected = await rpc('channels/connectSandbox', await tokenFor(owner), { displayName: 'Trang thử nghiệm', key: sandboxKey });
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ reconnected: false });
    connectionId = String(connected.body?.connectionId);
    for (const who of [owner, viewer]) {
      const listed = await rpc('channels/list', await tokenFor(who), {});
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ id: connectionId, provider: 'sandbox', displayName: 'Trang thử nghiệm', status: 'active', connectedBy: owner.userId });
      expect(Object.keys(listed.body[0]).sort()).toEqual(
        ['connectedAt', 'connectedBy', 'displayName', 'expiresAt', 'externalAccountId', 'id', 'provider', 'scopes', 'status', 'statusReason'].sort(),
      );
    }
    // The worker opens the sealed sandbox token for this org and account.
    const sealed = await worker.query<SealedChannelCredential>('kernel.channel.credential', { connectionId }, { actor: { type: 'system', component: 'test' }, orgId: org.orgId });
    const token = vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: org.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
    expect(JSON.parse(token)).toMatchObject({ accessToken: expect.stringMatching(/^sbx_/) });
  });

  it('reconnects the same sandbox account with the same key', async () => {
    const again = await rpc('channels/connectSandbox', await tokenFor(owner), { displayName: 'Trang thử nghiệm 2', key: sandboxKey });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ connectionId, reconnected: true });
  });

  it('refuses a viewer, and answers 503 without a credential key and 404 with the sandbox off', async () => {
    expect((await rpc('channels/connectSandbox', await tokenFor(viewer), { displayName: 'X', key: randomUUID() })).status).toBe(403);
    const noKey = await rpc('channels/connectSandbox', await tokenFor(owner), { displayName: 'X', key: randomUUID() }, { app: 'noKey' });
    expect(noKey).toMatchObject({ status: 503, body: { code: 'BROKER_NOT_CONFIGURED' } });
    const off = await rpc('channels/connectSandbox', await tokenFor(owner), { displayName: 'X', key: randomUUID() }, { app: 'sandboxOff' });
    expect(off).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
  });

  it('disconnects: the connection stays as history, the token is gone', async () => {
    expect((await rpc('channels/disconnect', await tokenFor(viewer), { connectionId, idempotencyKey: randomUUID() })).status).toBe(403);
    const key = randomUUID();
    const done = await rpc('channels/disconnect', await tokenFor(owner), { connectionId, idempotencyKey: key });
    expect(done).toMatchObject({ status: 200, body: { connectionId, status: 'revoked' } });
    expect((await rpc('channels/disconnect', await tokenFor(owner), { connectionId, idempotencyKey: key })).body).toEqual(done.body);
    expect((await rpc('channels/list', await tokenFor(owner), {})).body).toEqual([]);
    const history = await rpc('channels/list', await tokenFor(owner), { includeRevoked: true });
    expect(history.body).toMatchObject([{ id: connectionId, status: 'revoked', statusReason: 'disconnected' }]);
    await expect(
      worker.query('kernel.channel.credential', { connectionId }, { actor: { type: 'system', component: 'test' }, orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
  });
});
