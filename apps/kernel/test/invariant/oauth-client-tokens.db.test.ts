// Invariant suite (Decision 7): the kernel refuses Supabase Auth access tokens issued to OAuth clients (issue #272,
// ADR-0028 section 1, ADR-0032). Supabase Auth's OAuth 2.1 server signs them with the deployment's key and the same
// `aud` and `role` as a browser session's; they carry `client_id` (and `scope`), and their session's `amr` records the
// OAuth authorization code grant (Supabase Auth v2.197.0, internal/tokens/service.go). Such a token is refused with
// 401 OAUTH_CLIENT_TOKEN_REFUSED in every session check mode (db, jwt, off), on reads, R1 commands and org-less
// calls, before any database work; the same user's browser token keeps working. Through the HTTP API on a real
// PostgreSQL 17, one database for the three modes. For db, Supabase Auth's auth.users, auth.sessions and
// auth.mfa_factors are mirrored with the columns the check reads, plus the OAuth columns of auth.sessions. Keep this
// file self-contained: import package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { applyAuthGrants, migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-oauth-client-tokens-0123';
const ISSUER = 'crove-auth';
const MODES = ['db', 'jwt', 'off'] as const;
type Mode = (typeof MODES)[number];

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  // The browser session (the SPA's).
  session: string;
  // The session Supabase Auth's OAuth server created for a third-party client the user approved.
  oauthSession: string;
  userId: string;
  orgSlug: string;
}

type Shape = 'browser' | 'oauth' | 'client-id-only' | 'amr-only';

suite('tokens issued to OAuth clients by Supabase Auth on PostgreSQL (issue #272, every session check mode)', () => {
  const dbName = `crove_test_oauth_client_tokens_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const clientId = randomUUID();
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  const apps = new Map<Mode, ReturnType<typeof createHttpApp>>();
  const accounts = new Map<Mode, Account>();

  async function sql(text: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await client.query(text, params);
    } finally {
      await client.end();
    }
  }

  // An access token as Supabase Auth issues it. browser: the SPA's session after a password sign-in. oauth: the
  // authorization code grant of the OAuth server (client_id, scope and its amr method). client-id-only: a client_id
  // on an otherwise browser-shaped token. amr-only: a token for the OAuth session without client_id, as Supabase Auth
  // reissues it after an MFA verification on that session (updateMFASessionAndClaims), or a Custom Access Token hook
  // that drops client_id leaves it.
  async function tokenFor(a: Pick<Account, 'subject' | 'email' | 'session' | 'oauthSession'>, shape: Shape) {
    const now = Math.floor(Date.now() / 1000);
    const browserAmr = [{ method: 'password', timestamp: now - 60 }];
    const oauthAmr = [{ method: 'oauth_provider/authorization_code', timestamp: now - 30 }];
    const claims: Record<string, unknown> = {
      role: 'authenticated',
      email: a.email,
      phone: '',
      session_id: shape === 'browser' || shape === 'client-id-only' ? a.session : a.oauthSession,
      aal: 'aal1',
      amr: shape === 'oauth' || shape === 'amr-only' ? oauthAmr : browserAmr,
      is_anonymous: false,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
    };
    if (shape === 'oauth' || shape === 'client-id-only') claims.client_id = clientId;
    if (shape === 'oauth' || shape === 'amr-only') claims.scope = 'openid email profile';
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(a.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt(now - 5)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(mode: Mode, path: string, token: string, input?: unknown, org: string | null = null) {
    const app = apps.get(mode) as ReturnType<typeof createHttpApp>;
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    // oRPC answers in its envelope ({ json }); the auth middleware answers plain JSON before oRPC runs.
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  // A read query, an R1 command (the user revoking their own browser session, so an accepted token would end it), an
  // org-less R1 command (org creation) and the org-less profile call.
  async function surfaces(mode: Mode, a: Account, shape: Shape, orgName: string) {
    const token = await tokenFor(a, shape);
    return {
      me: await rpc(mode, 'me/get', token),
      read: await rpc(mode, 'inbox/list', token, {}, a.orgSlug),
      command: await rpc(mode, 'sessions/revoke', token, { userId: a.userId, sessionId: a.session }, a.orgSlug),
      create: await rpc(mode, 'org/create', token, { name: orgName, idempotencyKey: randomUUID() }),
    };
  }

  // What Supabase Auth does on sign-up and on the password sign-in (the browser session), then when the user approves
  // a third-party client on the consent page (a second session bound to that client).
  async function signUp(mode: Mode): Promise<Account> {
    const subject = randomUUID();
    const a: Account = { subject, email: `${mode}-${subject.slice(0, 8)}@oauth.test`, session: randomUUID(), oauthSession: randomUUID(), userId: '', orgSlug: '' };
    if (mode === 'db') await authRows(a);
    const me = await rpc(mode, 'me/get', await tokenFor(a, 'browser'));
    expect(me.status).toBe(200);
    a.userId = String(me.body?.userId);
    const created = await rpc(mode, 'org/create', await tokenFor(a, 'browser'), { name: `Org ${mode} ${subject.slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    a.orgSlug = String(created.body?.slug);
    return a;
  }

  async function authRows(a: Pick<Account, 'subject' | 'email' | 'session' | 'oauthSession'>) {
    await sql('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [a.subject, a.email]);
    await sql('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [a.session, a.subject]);
    await sql(`INSERT INTO auth.sessions (id, user_id, oauth_client_id, scopes) VALUES ($1, $2, $3, 'openid email profile')`, [
      a.oauthSession,
      a.subject,
      clientId,
    ]);
  }

  const sessionRows = (sessionId: string) =>
    sql('SELECT status FROM crove_kernel.auth_session WHERE session_id = $1', [sessionId]).then((r) => r.rows as Array<{ status: string }>);
  const orgsNamed = (name: string) => sql('SELECT 1 FROM crove_kernel.tenant WHERE name = $1', [name]).then((r) => r.rowCount);

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    // Supabase Auth starts and runs its migrations as supabase_auth_admin, the owner of the auth schema. Only the db
    // mode reads these tables; jwt and off never do.
    await sql('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query('SET ROLE supabase_auth_admin');
      await client.query(`
        CREATE TABLE auth.users (
          id uuid PRIMARY KEY, email text, encrypted_password text, email_confirmed_at timestamptz, banned_until timestamptz,
          deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz, aal text, oauth_client_id uuid, scopes text);
        CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone', 'recovery_code');
        CREATE TYPE auth.factor_status AS ENUM ('unverified', 'verified');
        CREATE TABLE auth.mfa_factors (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, friendly_name text,
          factor_type auth.factor_type NOT NULL, status auth.factor_status NOT NULL, created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL, secret text, phone text, last_challenged_at timestamptz UNIQUE,
          web_authn_credential jsonb, web_authn_aaguid uuid, last_webauthn_challenge_data jsonb);
        ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;`);
    } finally {
      await client.end();
    }
    await applyAuthGrants({ adminUrl, timeoutMs: 5000, pollMs: 100 });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);
    const common = { DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' };
    const configs: Record<Mode, ReturnType<typeof loadConfig>> = {
      db: loadConfig({ ...common, AUTH_SESSION_CHECK: 'db' }),
      // Crove Cloud: a remote Supabase Auth. Its GET /user is asked only for R3, which no request here reaches.
      jwt: loadConfig({ ...common, AUTH_SESSION_CHECK: 'jwt', PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'http://127.0.0.1:9/auth/v1' }),
      // Local URLs only.
      off: loadConfig({ ...common, AUTH_SESSION_CHECK: 'off' }),
    };
    for (const mode of MODES) {
      const config = configs[mode];
      expect(config.AUTH_SESSION_CHECK).toBe(mode);
      const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource(mode), stepUp: 'required' }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
      apps.set(mode, createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false }));
    }
    for (const mode of MODES) accounts.set(mode, await signUp(mode));
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  for (const mode of MODES) {
    describe(`session check ${mode}`, () => {
      it("accepts the user's browser token on reads and org-less calls", async () => {
        const a = accounts.get(mode) as Account;
        const token = await tokenFor(a, 'browser');
        expect((await rpc(mode, 'me/get', token)).status).toBe(200);
        expect((await rpc(mode, 'inbox/list', token, {}, a.orgSlug)).status).toBe(200);
        expect((await rpc(mode, 'org/get', token, {}, a.orgSlug)).status).toBe(200);
      });

      for (const shape of ['oauth', 'client-id-only', 'amr-only'] as const) {
        it(`refuses a token issued to an OAuth client (${shape}) on reads, R1 commands and org-less calls, and changes nothing`, async () => {
          const a = accounts.get(mode) as Account;
          const orgName = `Refused ${mode} ${shape} ${randomUUID().slice(0, 6)}`;
          const refused = await surfaces(mode, a, shape, orgName);
          for (const response of Object.values(refused)) {
            expect(response).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
          }
          // The browser session was not revoked, no org was created, and the OAuth session was never recorded.
          expect(await sessionRows(a.session)).toEqual([{ status: 'active' }]);
          expect(await orgsNamed(orgName)).toBe(0);
          expect(await sessionRows(a.oauthSession)).toEqual([]);
          // The same user's browser token still works, R1 included (a revoke of an unknown session of their own).
          const browser = await tokenFor(a, 'browser');
          expect((await rpc(mode, 'inbox/list', browser, {}, a.orgSlug)).status).toBe(200);
          expect((await rpc(mode, 'sessions/revoke', browser, { userId: a.userId, sessionId: randomUUID() }, a.orgSlug)).status).toBe(200);
          expect(await sessionRows(a.session)).toEqual([{ status: 'active' }]);
        });
      }

      it('refuses a first sign-in through an OAuth client before any database work: no user account is created', async () => {
        const subject = randomUUID();
        const fresh = { subject, email: `fresh-${mode}-${subject.slice(0, 8)}@oauth.test`, session: randomUUID(), oauthSession: randomUUID() };
        if (mode === 'db') await authRows(fresh);
        expect(await rpc(mode, 'me/get', await tokenFor(fresh, 'oauth'))).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
        const users = await sql('SELECT 1 FROM crove_kernel.user_account WHERE subject = $1', [subject]);
        expect(users.rowCount).toBe(0);
        expect(await sessionRows(fresh.oauthSession)).toEqual([]);
      });
    });
  }
});
