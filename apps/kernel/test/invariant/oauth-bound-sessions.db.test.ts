// Invariant suite (Decision 7): in the self-host `db` mode the session check refuses a Supabase Auth session bound to
// an OAuth client (auth.sessions.oauth_client_id set), whatever claims the token carries (issue #276, follow-up of
// #272, ADR-0028 section 1). The kernel already refuses tokens with `client_id` or an `oauth_provider/` amr method;
// a Custom Access Token hook may drop both, and then only the session row still tells the OAuth session apart. Here
// the token is browser-shaped (no client_id, no scope, a password amr) and only its session_id names the OAuth
// session. Older Supabase Auth schemas without the column keep working (guard), and once the column exists the
// reader must be granted it or every request fails closed with 503. Through the HTTP API on a real PostgreSQL 17,
// with Supabase Auth's auth.users, auth.sessions and auth.mfa_factors mirrored with the columns the check reads.
// Keep this file self-contained: import package code under test, never helpers from outside test/invariant/. Set
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
const SECRET = 'test-only-jwt-secret-for-oauth-bound-sessions-01';
const ISSUER = 'crove-auth';

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

suite('Supabase Auth sessions bound to an OAuth client on PostgreSQL (issue #276, self-host db adapter)', () => {
  const dbName = `crove_test_oauth_bound_sessions_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const clientId = randomUUID();
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createHttpApp>;
  let account: Account;

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const sql = (text: string, params: unknown[] = []) => admin((c) => c.query(text, params));
  // As Supabase Auth runs its own migrations: as supabase_auth_admin, the owner of the auth schema.
  const asAuth = (text: string) =>
    admin(async (c) => {
      await c.query('SET ROLE supabase_auth_admin');
      await c.query(text);
    });

  // A browser-shaped access token: no client_id, no scope, a password amr (aal1) or password plus TOTP (aal2). Only
  // its session_id may name the OAuth session, as a Custom Access Token hook that drops client_id and rewrites amr
  // would leave it.
  async function tokenFor(a: Pick<Account, 'subject' | 'email'>, sessionId: string, aal: 'aal1' | 'aal2' = 'aal1') {
    const now = Math.floor(Date.now() / 1000);
    const amr =
      aal === 'aal2' ? [{ method: 'totp', timestamp: now - 10 }, { method: 'password', timestamp: now - 60 }] : [{ method: 'password', timestamp: now - 60 }];
    return new SignJWT({
      role: 'authenticated',
      email: a.email,
      phone: '',
      session_id: sessionId,
      aal,
      amr,
      is_anonymous: false,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(a.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt(now - 5)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input?: unknown, org: string | null = null) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    // oRPC answers in its envelope ({ json }); the auth middleware answers plain JSON before oRPC runs.
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  // What Supabase Auth does on sign-up and the password sign-in (the browser session), then when the user approves a
  // third-party client on the consent page (a second session bound to that client).
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
  const readerColumns = () =>
    sql(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE grantee = 'crove_auth_reader' AND table_schema = 'auth' AND table_name = 'sessions' ORDER BY 1`,
    ).then((r) => r.rows.map((row) => row.column_name as string));

  // A read query, an R1 command (the user revoking their own browser session, so an accepted token would end it), an
  // org-less R1 command (org creation) and the org-less profile call.
  async function surfaces(token: string, a: Account, orgName: string) {
    return {
      me: await rpc('me/get', token),
      read: await rpc('inbox/list', token, {}, a.orgSlug),
      command: await rpc('sessions/revoke', token, { userId: a.userId, sessionId: a.session }, a.orgSlug),
      create: await rpc('org/create', token, { name: orgName, idempotencyKey: randomUUID() }),
    };
  }

  async function expectBrowserWorks(a: Account) {
    const token = await tokenFor(a, a.session);
    expect((await rpc('me/get', token)).status).toBe(200);
    expect((await rpc('inbox/list', token, {}, a.orgSlug)).status).toBe(200);
  }

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
    await sql('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
    // auth.sessions as Supabase Auth v2.197.0 has it: the OAuth server's oauth_client_id and scopes included.
    await asAuth(`
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY, email text, encrypted_password text, email_confirmed_at timestamptz, banned_until timestamptz,
        deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false);
      CREATE TABLE auth.sessions (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz, aal text, oauth_client_id uuid, scopes text,
        refresh_token_hmac_key text);
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
    await applyAuthGrants({ adminUrl, timeoutMs: 5000, pollMs: 100 });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'db',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    expect(config.AUTH_SESSION_CHECK).toBe('db');
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('db'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    const subject = randomUUID();
    account = { subject, email: `oauth-${subject.slice(0, 8)}@sessions.test`, session: randomUUID(), oauthSession: randomUUID(), userId: '', orgSlug: '' };
    await authRows(account);
    const me = await rpc('me/get', await tokenFor(account, account.session));
    expect(me.status).toBe(200);
    account.userId = String(me.body?.userId);
    const created = await rpc('org/create', await tokenFor(account, account.session), { name: `Org ${subject.slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    account.orgSlug = String(created.body?.slug);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('grants the reader oauth_client_id when Supabase Auth has it, and the reader is reachable only through the check', async () => {
    // Exactly one column more than before, never the refresh token key or the scopes.
    expect(await readerColumns()).toEqual(['id', 'not_after', 'oauth_client_id', 'user_id']);
    const fn = await sql(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
       FROM pg_proc p WHERE p.oid = 'crove_kernel.auth_session_oauth_bound(uuid)'::regprocedure`,
    );
    expect(fn.rows).toEqual([{ owner: 'crove_auth_reader', definer: true, config: ['search_path=pg_catalog, pg_temp'], app: false, public: false }]);
  });

  it("refuses a browser-shaped token whose session_id names an OAuth-bound session, and changes nothing; the user's browser session keeps working", async () => {
    const token = await tokenFor(account, account.oauthSession);
    const orgName = `Refused ${randomUUID().slice(0, 6)}`;
    const refused = await surfaces(token, account, orgName);
    for (const response of Object.values(refused)) {
      expect(response).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
    }
    // The browser session was not revoked, no org was created, and the OAuth session was never recorded.
    expect(await sessionRows(account.session)).toEqual([{ status: 'active' }]);
    expect(await orgsNamed(orgName)).toBe(0);
    expect(await sessionRows(account.oauthSession)).toEqual([]);
    await expectBrowserWorks(account);
    // R1 still works on the browser session (a revoke of an unknown session of their own).
    const browser = await tokenFor(account, account.session);
    expect((await rpc('sessions/revoke', browser, { userId: account.userId, sessionId: randomUUID() }, account.orgSlug)).status).toBe(200);
  });

  it('refuses it before the MFA rule: aal1 and aal2 tokens of an enrolled user on the OAuth session', async () => {
    const subject = randomUUID();
    const a: Account = { subject, email: `mfa-${subject.slice(0, 8)}@sessions.test`, session: randomUUID(), oauthSession: randomUUID(), userId: '', orgSlug: '' };
    await authRows(a);
    const created = await rpc('org/create', await tokenFor(a, a.session), { name: `MFA Org ${subject.slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    a.orgSlug = String(created.body?.slug);
    await sql(
      `INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
       VALUES ($1, $2, 'phone', 'totp', 'verified', now(), now(), 'not-a-real-secret')`,
      [randomUUID(), subject],
    );
    for (const aal of ['aal1', 'aal2'] as const) {
      const token = await tokenFor(a, a.oauthSession, aal);
      expect(await rpc('me/get', token)).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
      expect(await rpc('inbox/list', token, {}, a.orgSlug)).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
    }
    // The browser session: aal1 asks for MFA, aal2 passes.
    expect(await rpc('inbox/list', await tokenFor(a, a.session, 'aal1'), {}, a.orgSlug)).toMatchObject({ status: 401, body: { code: 'MFA_REQUIRED' } });
    expect((await rpc('inbox/list', await tokenFor(a, a.session, 'aal2'), {}, a.orgSlug)).status).toBe(200);
  });

  it('refuses a first sign-in on an OAuth-bound session: no user account is created', async () => {
    const subject = randomUUID();
    const fresh = { subject, email: `fresh-${subject.slice(0, 8)}@sessions.test`, session: randomUUID(), oauthSession: randomUUID() };
    await authRows(fresh);
    expect(await rpc('me/get', await tokenFor(fresh, fresh.oauthSession))).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
    expect((await sql('SELECT 1 FROM crove_kernel.user_account WHERE subject = $1', [subject])).rowCount).toBe(0);
    expect(await sessionRows(fresh.oauthSession)).toEqual([]);
    // The same user's browser session signs in.
    expect((await rpc('me/get', await tokenFor(fresh, fresh.session))).status).toBe(200);
  });

  it('reads the binding on every request: a session bound after it was recorded is refused on the next request', async () => {
    const session = randomUUID();
    await sql('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [session, account.subject]);
    const token = await tokenFor(account, session);
    expect((await rpc('inbox/list', token, {}, account.orgSlug)).status).toBe(200);
    expect(await sessionRows(session)).toEqual([{ status: 'active' }]);
    await sql('UPDATE auth.sessions SET oauth_client_id = $2 WHERE id = $1', [session, clientId]);
    expect(await rpc('inbox/list', token, {}, account.orgSlug)).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
    expect(await rpc('me/get', token)).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
    await sql('UPDATE auth.sessions SET oauth_client_id = NULL WHERE id = $1', [session]);
    expect((await rpc('inbox/list', token, {}, account.orgSlug)).status).toBe(200);
  });

  it('fails closed with 503 while the column exists but the reader may not select it, until auth-grants runs again', async () => {
    await sql('REVOKE SELECT (oauth_client_id) ON auth.sessions FROM crove_auth_reader');
    expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: false }]);
    const browser = await tokenFor(account, account.session);
    expect(await rpc('me/get', browser)).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
    expect(await rpc('inbox/list', browser, {}, account.orgSlug)).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
    expect(await rpc('inbox/list', await tokenFor(account, account.oauthSession), {}, account.orgSlug)).toMatchObject({
      status: 503,
      body: { code: 'AUTH_NOT_READY' },
    });
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, reason: 'auth_grants' });
    await applyAuthGrants({ adminUrl, timeoutMs: 1000 });
    expect(await readerColumns()).toContain('oauth_client_id');
    expect(await (await app.request('/readyz')).json()).toEqual({ ready: true });
    await expectBrowserWorks(account);
    expect(await rpc('me/get', await tokenFor(account, account.oauthSession))).toMatchObject({ status: 401, body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' } });
  });

  // Runs last: it changes auth.sessions for the rest of the file.
  it('keeps working on a Supabase Auth without the OAuth server (guard), fails closed with the OAuth server but no column, and once an upgrade adds it', async () => {
    await asAuth('ALTER TABLE auth.sessions DROP COLUMN oauth_client_id');
    // auth-grants does not wait for the optional column and grants nothing for it.
    await applyAuthGrants({ adminUrl, timeoutMs: 1000, pollMs: 100 });
    expect(await readerColumns()).toEqual(['id', 'not_after', 'user_id']);
    expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: true }]);
    expect(await (await app.request('/readyz')).json()).toEqual({ ready: true });
    await expectBrowserWorks(account);
    // A new browser session and a first sign-in work too.
    const session = randomUUID();
    await sql('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [session, account.subject]);
    expect((await rpc('inbox/list', await tokenFor(account, session), {}, account.orgSlug)).status).toBe(200);
    const subject = randomUUID();
    const fresh = { subject, email: `old-${subject.slice(0, 8)}@sessions.test` };
    const freshSession = randomUUID();
    await sql('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [subject, fresh.email]);
    await sql('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [freshSession, subject]);
    expect((await rpc('me/get', await tokenFor(fresh, freshSession))).status).toBe(200);

    // The OAuth server without the column (a release that renamed or dropped it): OAuth sessions could not be told
    // apart, so the check fails closed and auth-grants names the column, never a skipped check.
    await asAuth('CREATE TABLE auth.oauth_clients (id uuid PRIMARY KEY, client_name text)');
    expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: false }]);
    expect(await rpc('me/get', await tokenFor(account, account.session))).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
    await expect(applyAuthGrants({ adminUrl, timeoutMs: 300, pollMs: 100 })).rejects.toThrow(/auth\.sessions\.oauth_client_id do not exist/);

    // A Supabase Auth upgrade adds the column after auth-grants ran: 503 until auth-grants runs again, never a
    // skipped check.
    await asAuth('ALTER TABLE auth.sessions ADD COLUMN oauth_client_id uuid');
    expect(await rpc('me/get', await tokenFor(account, account.session))).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
    await applyAuthGrants({ adminUrl, timeoutMs: 1000 });
    expect(await readerColumns()).toEqual(['id', 'not_after', 'oauth_client_id', 'user_id']);
    await sql('UPDATE auth.sessions SET oauth_client_id = $2 WHERE id = $1', [session, clientId]);
    expect(await rpc('inbox/list', await tokenFor(account, session), {}, account.orgSlug)).toMatchObject({
      status: 401,
      body: { code: 'OAUTH_CLIENT_TOKEN_REFUSED' },
    });
    await expectBrowserWorks(account);
  });
});
