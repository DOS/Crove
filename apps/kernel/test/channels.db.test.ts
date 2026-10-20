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
import { ConnectorError, type ConnectedAccount, type OAuthConnector } from '@crove/channel';
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

// Stands in for Meta: authorize URLs carry the state, and exchange answers with whatever the test queued.
function fakeConnector() {
  const exchanges: { code: string; redirectUri: string; codeVerifier: string | null }[] = [];
  let next: ConnectedAccount[] | Error = [];
  const connector: OAuthConnector = {
    provider: 'facebook_page',
    pkce: false,
    authorizeUrl: ({ state, redirectUri }) => `https://www.facebook.com/v24.0/dialog/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchange: async (input) => {
      exchanges.push(input);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { connector, exchanges, answer: (value: ConnectedAccount[] | Error) => (next = value) };
}

const page = (id: string, name: string, token: string): ConnectedAccount => ({
  provider: 'facebook_page',
  externalAccountId: id,
  displayName: name,
  scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
  expiresAt: null,
  secret: JSON.stringify({ accessToken: token }),
});

suite('channel connections through the API (ADR-0025)', () => {
  const dbName = `crove_test_channels_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Runtime;
  let config: ReturnType<typeof loadConfig>;
  let apps: Record<'on' | 'noKey' | 'sandboxOff', ReturnType<typeof createHttpApp>>;
  // The OAuth connector the 'on' app uses for facebook_page: a stand-in for Meta that records what it was asked.
  const fake = fakeConnector();
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const owner: Account = { subject: randomUUID(), email: 'owner@channels-api.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@channels-api.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

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
    const make = (channels: { broker: typeof vault | typeof noCredentialBroker; sandbox: boolean; connectors?: Record<string, OAuthConnector>; publicUrl?: string }) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels });
    apps = {
      on: make({ broker: vault, sandbox: true, connectors: { facebook_page: fake.connector }, publicUrl: 'https://crove.example/' }),
      noKey: make({ broker: noCredentialBroker, sandbox: true, connectors: { facebook_page: fake.connector }, publicUrl: 'https://crove.example/' }),
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
    const accessToken = (JSON.parse(token) as { accessToken: string }).accessToken;
    expect(accessToken).toMatch(/^sbx_/);
    // The token the server made never left the envelope: not in audit rows, events, idempotency records or rows.
    const dump = await admin(async (c) => {
      const parts: string[] = [];
      for (const q of [
        'SELECT detail::text || coalesce(input_sha256, \'\') AS t FROM crove_kernel.audit_event WHERE org_id = $1',
        'SELECT payload::text AS t FROM crove_kernel.outbox_event WHERE org_id = $1',
        "SELECT coalesce(response::text, '') AS t FROM crove_kernel.idempotency_key WHERE org_id = $1",
        'SELECT row_to_json(c)::text AS t FROM crove_kernel.channel_connection c WHERE org_id = $1',
      ]) {
        const { rows } = await c.query<{ t: string }>(q, [org.orgId]);
        parts.push(...rows.map((r) => r.t));
      }
      return parts.join('\n');
    });
    expect(dump).toContain(connectionId);
    expect(dump).not.toContain(accessToken);
    expect(dump).not.toContain(sealed.envelope);
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

  describe('connecting through an OAuth dialog (S6.1)', () => {
    const REDIRECT = 'https://crove.example/channels/oauth/facebook_page/callback';
    const start = async (who: Account = owner) => {
      const started = await rpc('channels/oauthStart', await tokenFor(who), { provider: 'facebook_page' });
      return started;
    };

    it('offers only configured providers in /api/config', async () => {
      const on = (await (await apps.on.request('/api/config')).json()) as { channels: unknown };
      expect(on.channels).toEqual({ sandbox: true, bluesky: false, telegram: false, mastodon: false, discord: false, oauth: ['facebook_page'] });
      const off = (await (await apps.sandboxOff.request('/api/config')).json()) as { channels: unknown };
      expect(off.channels).toEqual({ sandbox: false, bluesky: false, telegram: false, mastodon: false, discord: false, oauth: [] });
    });

    it('starts an attempt, then connects every Page the grant covers with its sealed Page token', async () => {
      const started = await start();
      expect(started.status).toBe(200);
      const url = new URL(String(started.body?.authorizeUrl));
      expect(url.searchParams.get('state')).toBe(started.body?.state);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      fake.answer([page('111', 'Quán Cà Phê A', 'page-token-111'), page('333', 'Tiệm Bánh B', 'page-token-333')]);
      const finished = await rpc('channels/oauthFinish', await tokenFor(owner), { provider: 'facebook_page', state: started.body?.state, code: 'code-1' });
      expect(finished.status).toBe(200);
      expect(finished.body.connections).toMatchObject([
        { displayName: 'Quán Cà Phê A', reconnected: false },
        { displayName: 'Tiệm Bánh B', reconnected: false },
      ]);
      expect(fake.exchanges.at(-1)).toEqual({ code: 'code-1', redirectUri: REDIRECT, codeVerifier: null });
      const listed = await rpc('channels/list', await tokenFor(viewer), {});
      expect(listed.body.filter((c: { provider: string }) => c.provider === 'facebook_page').map((c: { externalAccountId: string }) => c.externalAccountId).sort()).toEqual(['111', '333']);
      // The worker opens each Page token for its own Page.
      const first = finished.body.connections[0].connectionId as string;
      const sealed = await worker.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: first }, { actor: { type: 'system', component: 'test' }, orgId: org.orgId });
      expect(vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: org.orgId, provider: 'facebook_page', externalAccountId: '111' })).toBe(
        JSON.stringify({ accessToken: 'page-token-111' }),
      );
      // No Page token, code or state in audit rows, events, idempotency records or connection rows.
      const dump = await admin(async (c) => {
        const parts: string[] = [];
        for (const q of [
          "SELECT detail::text || coalesce(input_sha256, '') AS t FROM crove_kernel.audit_event WHERE org_id = $1",
          'SELECT payload::text AS t FROM crove_kernel.outbox_event WHERE org_id = $1',
          "SELECT coalesce(response::text, '') AS t FROM crove_kernel.idempotency_key WHERE org_id = $1",
          'SELECT row_to_json(c)::text AS t FROM crove_kernel.channel_connection c WHERE org_id = $1',
        ]) {
          const { rows } = await c.query<{ t: string }>(q, [org.orgId]);
          parts.push(...rows.map((r) => r.t));
        }
        return parts.join('\n');
      });
      for (const secret of ['page-token-111', 'page-token-333', 'code-1', String(started.body?.state)]) expect(dump).not.toContain(secret);
    });

    it('finishes an attempt once, and reconnects a Page connected before', async () => {
      const started = await start();
      fake.answer([page('111', 'Quán Cà Phê A (mới)', 'page-token-111b')]);
      const input = { provider: 'facebook_page', state: started.body?.state, code: 'code-2' };
      const first = await rpc('channels/oauthFinish', await tokenFor(owner), input);
      expect(first.body.connections).toMatchObject([{ displayName: 'Quán Cà Phê A (mới)', reconnected: true }]);
      const again = await rpc('channels/oauthFinish', await tokenFor(owner), input);
      expect(again).toMatchObject({ status: 409, body: { code: 'OAUTH_STATE_USED' } });
    });

    it('keeps the accounts that connected when another fails, and says which did not (#375)', async () => {
      const started = await start();
      // A name over the connect command's 200 characters: that one account is refused, the others connect.
      fake.answer([page('551', 'Trang D', 'page-token-551'), page('552', 'X'.repeat(201), 'page-token-552'), page('553', 'Trang E', 'page-token-553')]);
      const finished = await rpc('channels/oauthFinish', await tokenFor(owner), { provider: 'facebook_page', state: started.body?.state, code: 'code-p' });
      expect(finished.status).toBe(200);
      expect(finished.body.connections.map((c: { displayName: string }) => c.displayName)).toEqual(['Trang D', 'Trang E']);
      expect(finished.body.failed).toEqual([{ displayName: 'X'.repeat(201), code: 'VALIDATION' }]);
      expect(finished.body.skipped).toBe(0);

      // When none connects, the grant is an error as before.
      const again = await start();
      fake.answer([page('554', 'Y'.repeat(201), 'page-token-554')]);
      expect(await rpc('channels/oauthFinish', await tokenFor(owner), { provider: 'facebook_page', state: again.body?.state, code: 'code-q' })).toMatchObject({ status: 422, body: { code: 'VALIDATION' } });
    });

    it('refuses a state started by someone else, an unknown state and a viewer', async () => {
      expect((await start(viewer)).status).toBe(403);
      const started = await start();
      const stolen = await rpc('channels/oauthFinish', await tokenFor(viewer), { provider: 'facebook_page', state: started.body?.state, code: 'code-3' });
      expect(stolen.status).toBe(403);
      const unknown = await rpc('channels/oauthFinish', await tokenFor(owner), { provider: 'facebook_page', state: 'A'.repeat(43), code: 'code-3' });
      expect(unknown).toMatchObject({ status: 400, body: { code: 'OAUTH_STATE_INVALID' } });
      // The owner's own attempt is still usable after those tries.
      fake.answer([page('444', 'Trang C', 'page-token-444')]);
      expect((await rpc('channels/oauthFinish', await tokenFor(owner), { provider: 'facebook_page', state: started.body?.state, code: 'code-3' })).status).toBe(200);
    });

    it('answers a refused code, a missing permission and no Pages with fixed messages, and uses the attempt up', async () => {
      const cases: [ConnectedAccount[] | Error, number, string][] = [
        [new ConnectorError('invalid_grant', 'This authorization code has been used.', '100'), 400, 'OAUTH_CODE_REJECTED'],
        [new ConnectorError('denied', 'Meta did not grant pages_manage_posts', 'MISSING_PERMISSION'), 422, 'OAUTH_PERMISSION_MISSING'],
        [new ConnectorError('provider', 'Service temporarily unavailable', '2'), 503, 'OAUTH_PROVIDER_FAILED'],
        [[], 422, 'CHANNEL_NO_ACCOUNTS'],
      ];
      for (const [answer, status, code] of cases) {
        const started = await start();
        fake.answer(answer);
        const input = { provider: 'facebook_page', state: started.body?.state, code: 'code-x' };
        const failed = await rpc('channels/oauthFinish', await tokenFor(owner), input);
        expect(failed).toMatchObject({ status, body: { code } });
        expect(JSON.stringify(failed.body)).not.toContain('Meta');
        expect((await rpc('channels/oauthFinish', await tokenFor(owner), input)).body.code).toBe('OAUTH_STATE_USED');
      }
    });

    it('refuses to start without a credential key, and does not offer the provider', async () => {
      const noKey = await rpc('channels/oauthStart', await tokenFor(owner), { provider: 'facebook_page' }, { app: 'noKey' });
      expect(noKey).toMatchObject({ status: 503, body: { code: 'BROKER_NOT_CONFIGURED' } });
      const config = (await (await apps.noKey.request('/api/config')).json()) as { channels: unknown };
      expect(config.channels).toEqual({ sandbox: true, bluesky: false, telegram: false, mastodon: false, discord: false, oauth: [] });
    });

    it('answers 404 for a provider the deployment did not configure', async () => {
      const off = await rpc('channels/oauthStart', await tokenFor(owner), { provider: 'facebook_page' }, { app: 'sandboxOff' });
      expect(off).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
    });
  });
});
