// ADR-0028 acceptance tests for the self-host `db` adapter, end to end through the HTTP API on a real
// PostgreSQL 17. Supabase Auth's auth.users and auth.sessions are mirrored with the columns the check reads
// (the GoTrue schema pinned in docker-compose.yml); each test changes them the way Supabase Auth does on sign-out,
// expiry, ban and deletion. Set CROVE_TEST_ADMIN_URL to a superuser URL.
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
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource, type SignOutTarget } from '../src/sessions.ts';
import { migrateJobs, startWorker } from '../src/worker.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-sessions-0123456789';
const ISSUER = 'crove-auth';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

suite('sessions and revocation on PostgreSQL (ADR-0028, self-host db adapter)', () => {
  const dbName = `crove_test_sessions_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let app: ReturnType<typeof createHttpApp>;
  let orgSlug = '';
  const accounts: Record<'owner' | 'admin' | 'member', Account> = {
    owner: { subject: randomUUID(), email: 'owner@sessions.test', session: randomUUID(), userId: '' },
    admin: { subject: randomUUID(), email: 'admin@sessions.test', session: randomUUID(), userId: '' },
    member: { subject: randomUUID(), email: 'member@sessions.test', session: randomUUID(), userId: '' },
  };

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

  // What Supabase Auth does on sign-up and sign-in.
  async function signUp(account: Account) {
    await sql('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [account.subject, account.email]);
    await signIn(account.subject, account.session);
  }
  const signIn = (subject: string, session: string) => sql('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [session, subject]);

  // An access token as the bundled Supabase Auth issues it. mfaAgeS sets aal2 with a TOTP amr entry that old.
  async function tokenFor(account: Pick<Account, 'subject' | 'email' | 'session'>, options: { mfaAgeS?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfaAgeS === undefined ? {} : { aal: 'aal2', amr: [{ method: 'totp', timestamp: now - options.mfaAgeS }] };
    return new SignJWT({ role: 'authenticated', email: account.email, session_id: account.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(account.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input?: unknown, org: string | null = orgSlug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(org ? { 'x-crove-org': org } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as { json?: Record<string, unknown> } | null;
    return { status: response.status, body: (body?.json ?? null) as Record<string, any> | null };
  }

  const me = async (account: Pick<Account, 'subject' | 'email' | 'session'>) => rpc('me/get', await tokenFor(account), undefined, null);
  const inbox = async (account: Pick<Account, 'subject' | 'email' | 'session'>) => rpc('inbox/list', await tokenFor(account), {});

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    // Supabase Auth's schema; its tables appear only once Supabase Auth has started (see the fresh-install test).
    await sql('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    workerDb = createDb(workerPool);
    const config = loadConfig({
      DATABASE_URL: login('crove_app', 'test-app-pw'),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'db',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('db'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
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

  it('fails closed with 503 and /readyz reason auth_grants before auth-grants has run', async () => {
    const response = await me(accounts.owner);
    expect(response).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, reason: 'auth_grants' });
    await expect(applyAuthGrants({ adminUrl, timeoutMs: 300, pollMs: 100 })).rejects.toThrow(/do not exist/);
  });

  it('fresh install: auth-grants waits for Supabase Auth, then grants exactly what the check reads', async () => {
    const granting = applyAuthGrants({ adminUrl, timeoutMs: 20_000, pollMs: 100 });
    // Supabase Auth starts and runs its migrations (as supabase_auth_admin, the owner of the auth schema).
    await admin(async (c) => {
      await c.query('SET ROLE supabase_auth_admin');
      await c.query(`
        CREATE TABLE auth.users (
          id uuid PRIMARY KEY, email text, encrypted_password text, banned_until timestamptz, deleted_at timestamptz,
          is_anonymous boolean NOT NULL DEFAULT false);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz, aal text);
        CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, token text, session_id uuid);
        -- As Supabase Auth does: row-level security on, no policies.
        ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;`);
    });
    await granting;

    const { rows } = await sql(
      `SELECT table_name, column_name FROM information_schema.column_privileges
       WHERE grantee = 'crove_auth_reader' AND table_schema = 'auth' ORDER BY 1, 2`,
    );
    expect(rows).toEqual([
      { table_name: 'sessions', column_name: 'id' },
      { table_name: 'sessions', column_name: 'not_after' },
      { table_name: 'sessions', column_name: 'user_id' },
      { table_name: 'users', column_name: 'banned_until' },
      { table_name: 'users', column_name: 'deleted_at' },
      { table_name: 'users', column_name: 'id' },
    ]);
    const secrets = await sql(
      `SELECT has_table_privilege('crove_auth_reader', 'auth.refresh_tokens', 'SELECT') AS refresh,
              has_column_privilege('crove_auth_reader', 'auth.users', 'encrypted_password', 'SELECT') AS password,
              has_schema_privilege('crove_app', 'auth', 'USAGE') AS app`,
    );
    expect(secrets.rows[0]).toEqual({ refresh: false, password: false, app: false });
    // Without the reader's row policy the check would see no rows; readiness says so instead of 401 for everyone.
    await sql('DROP POLICY crove_auth_reader_select ON auth.sessions');
    expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: false }]);
    // Re-running (every `docker compose up`) is harmless and restores it.
    await applyAuthGrants({ adminUrl, timeoutMs: 1000 });
    await applyAuthGrants({ adminUrl, timeoutMs: 1000 });

    const ready = await app.request('/readyz');
    expect(await ready.json()).toEqual({ ready: true });

    // The first sign-up, sign-in and API calls succeed with the db check active.
    for (const account of Object.values(accounts)) await signUp(account);
    const first = await me(accounts.owner);
    expect(first.status).toBe(200);
    accounts.owner.userId = String(first.body?.userId);
    const created = await rpc('org/create', await tokenFor(accounts.owner), { name: 'Session Org' }, null);
    expect(created.status).toBe(200);
    orgSlug = String(created.body?.slug);
    for (const role of ['admin', 'member'] as const) {
      accounts[role].userId = String((await me(accounts[role])).body?.userId);
      const added = await rpc('org/addMember', await tokenFor(accounts.owner, { mfaAgeS: 30 }), { email: accounts[role].email, role });
      expect(added.status).toBe(200);
    }
    expect((await inbox(accounts.member)).status).toBe(200);
    // The check recorded the session it vouched for.
    const recorded = await sql('SELECT status FROM crove_kernel.auth_session WHERE user_id = $1 AND session_id = $2', [
      accounts.owner.userId,
      accounts.owner.session,
    ]);
    expect(recorded.rows).toEqual([{ status: 'active' }]);
  });

  it('refuses an old JWT on the next request after sign-out', async () => {
    const user = { subject: accounts.member.subject, email: accounts.member.email, session: randomUUID() };
    await signIn(user.subject, user.session);
    const token = await tokenFor(user);
    expect((await rpc('inbox/list', token, {})).status).toBe(200);
    // Supabase Auth's sign-out deletes the session row.
    await sql('DELETE FROM auth.sessions WHERE id = $1', [user.session]);
    expect(await rpc('inbox/list', token, {})).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    expect((await rpc('me/get', token, undefined, null)).status).toBe(401);
    // A session id Supabase Auth never issued is refused too.
    expect((await inbox({ ...user, session: randomUUID() })).status).toBe(401);
  });

  it('refuses a session past its not_after', async () => {
    const user = { subject: accounts.member.subject, email: accounts.member.email, session: randomUUID() };
    await signIn(user.subject, user.session);
    expect((await inbox(user)).status).toBe(200);
    await sql(`UPDATE auth.sessions SET not_after = now() - interval '1 second' WHERE id = $1`, [user.session]);
    expect((await inbox(user)).status).toBe(401);
  });

  it('refuses banned and deleted users, and a user disabled in Crove with 403', async () => {
    const subject = randomUUID();
    const user = { subject, email: 'banned@sessions.test', session: randomUUID() };
    await sql('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [subject, user.email]);
    await signIn(subject, user.session);
    expect((await me(user)).status).toBe(200);

    await sql(`UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1`, [subject]);
    expect((await me(user)).status).toBe(401);
    await sql(`UPDATE auth.users SET banned_until = now() - interval '1 second' WHERE id = $1`, [subject]);
    expect((await me(user)).status).toBe(200);

    await sql('UPDATE auth.users SET deleted_at = now() WHERE id = $1', [subject]);
    expect((await me(user)).status).toBe(401);
    await sql('UPDATE auth.users SET deleted_at = NULL WHERE id = $1', [subject]);
    expect((await me(user)).status).toBe(200);

    await sql(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE subject = $1`, [subject]);
    expect(await me(user)).toMatchObject({ status: 403, body: { code: 'USER_DISABLED' } });
    await sql(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE subject = $1`, [subject]);

    await sql('DELETE FROM auth.users WHERE id = $1', [subject]);
    expect((await me(user)).status).toBe(401);
  });

  it('applies an owner revoke immediately, also to tokens refreshed from that session', async () => {
    const signOuts: SignOutTarget[] = [];
    await migrateJobs(adminUrl);
    const stop = await startWorker({
      connectionString: workerUrl,
      workerDb,
      runtime: new Runtime(workerDb).register({ commands: kernelCommands, queries: [] }),
      store: {} as BlobStore,
      extractor: null,
      inboundDomain: null,
      revoker: {
        async signOut(target) {
          signOuts.push(target);
        },
      },
    });
    try {
      const phone = { subject: accounts.member.subject, email: accounts.member.email, session: randomUUID() };
      const laptop = { ...phone, session: randomUUID() };
      await signIn(phone.subject, phone.session);
      await signIn(laptop.subject, laptop.session);
      const phoneToken = await tokenFor(phone);
      expect((await rpc('inbox/list', phoneToken, {})).status).toBe(200);
      expect((await inbox(laptop)).status).toBe(200);

      const ownerToken = await tokenFor(accounts.owner);
      const revoked = await rpc('sessions/revoke', ownerToken, { userId: accounts.member.userId, sessionId: phone.session, reason: 'Mất điện thoại' });
      expect(revoked).toMatchObject({ status: 200, body: { revoked: [phone.session] } });

      // The same token, and a token refreshed from the same session (new iat, same session_id), are refused.
      expect((await rpc('inbox/list', phoneToken, {})).status).toBe(401);
      expect((await inbox(phone)).status).toBe(401);
      // Supabase Auth still has the row: the Crove record alone blocks it.
      expect((await sql('SELECT 1 FROM auth.sessions WHERE id = $1', [phone.session])).rowCount).toBe(1);
      // Other sessions of the member keep working.
      expect((await inbox(laptop)).status).toBe(200);

      const listed = await rpc('sessions/list', ownerToken, { userId: accounts.member.userId });
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: phone.session, status: 'revoked', revokedAt: expect.any(String) }),
          expect.objectContaining({ sessionId: laptop.session, status: 'active', revokedAt: null }),
        ]),
      );

      // Audited, and handed to the worker for the Supabase Auth sign-out.
      const audit = await sql(
        `SELECT actor_id, outcome FROM crove_kernel.audit_event WHERE command = 'kernel.session.revoke' AND target_id = $1`,
        [accounts.member.userId],
      );
      expect(audit.rows).toEqual([{ actor_id: accounts.owner.userId, outcome: 'ok' }]);
      const deadline = Date.now() + 30_000;
      while (!signOuts.some((t) => t.sessionId === phone.session)) {
        if (Date.now() > deadline) throw new Error('the worker never asked Supabase Auth to sign the session out');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(signOuts).toContainEqual({ subject: phone.subject, sessionId: phone.session });

      // "Revoke all" also blocks a session Crove has never seen.
      const unseen = { ...phone, session: randomUUID() };
      await signIn(unseen.subject, unseen.session);
      const all = await rpc('sessions/revoke', ownerToken, { userId: accounts.member.userId, all: true });
      expect(all.status).toBe(200);
      expect(all.body?.revoked).toEqual(expect.arrayContaining([laptop.session, unseen.session]));
      expect((await inbox(laptop)).status).toBe(401);
      expect((await inbox(unseen)).status).toBe(401);
    } finally {
      await stop();
    }
  });

  it('lets users revoke their own sessions, admins only those of members, and nobody else', async () => {
    const member = { ...accounts.member, session: randomUUID() };
    await signIn(member.subject, member.session);
    const memberToken = await tokenFor(member);
    // A member cannot revoke or list someone else's sessions.
    expect((await rpc('sessions/revoke', memberToken, { userId: accounts.admin.userId, all: true })).status).toBe(403);
    expect((await rpc('sessions/list', memberToken, { userId: accounts.admin.userId })).status).toBe(403);
    // An admin cannot revoke the owner's sessions.
    expect((await rpc('sessions/revoke', await tokenFor(accounts.admin), { userId: accounts.owner.userId, all: true })).status).toBe(403);
    expect((await me(accounts.owner)).status).toBe(200);
    // Exactly one of sessionId and all.
    expect((await rpc('sessions/revoke', memberToken, { userId: member.userId })).status).toBe(400);
    // A user signs their own device out.
    expect((await rpc('sessions/revoke', memberToken, { userId: member.userId, sessionId: member.session })).status).toBe(200);
    expect((await rpc('inbox/list', memberToken, {})).status).toBe(401);
    // An admin may revoke a member's session.
    const another = { ...accounts.member, session: randomUUID() };
    await signIn(another.subject, another.session);
    expect((await rpc('sessions/revoke', await tokenFor(accounts.admin), { userId: member.userId, sessionId: another.session })).status).toBe(200);
    expect((await inbox(another)).status).toBe(401);
  });

  it('requires fresh MFA for membership changes through the API', async () => {
    const add = async (mfaAgeS?: number) =>
      rpc('org/addMember', await tokenFor(accounts.owner, mfaAgeS === undefined ? {} : { mfaAgeS }), { email: accounts.member.email, role: 'member' });
    expect(await add()).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await add(10 * 60)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect((await add(20)).status).toBe(200);
  });

  it('refuses a removed member on the next request in that org', async () => {
    const member = { ...accounts.member, session: randomUUID() };
    await signIn(member.subject, member.session);
    expect((await inbox(member)).status).toBe(200);
    await sql(
      `DELETE FROM crove_kernel.tenant_member WHERE user_id = $1 AND org_id = (SELECT org_id FROM crove_kernel.tenant WHERE slug = $2)`,
      [member.userId, orgSlug],
    );
    expect(await inbox(member)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    // Still signed in: org-less calls keep working, without the org.
    const still = await me(member);
    expect(still.status).toBe(200);
    expect(still.body?.orgs).toEqual([]);
  });

  it('keeps a revoked record revoked, even for the database owner', async () => {
    const { rows } = await sql(`SELECT user_id, session_id FROM crove_kernel.auth_session WHERE status = 'revoked' LIMIT 1`);
    const row = rows[0] as { user_id: string; session_id: string };
    await expect(
      sql(`UPDATE crove_kernel.auth_session SET status = 'active', revoked_at = NULL WHERE user_id = $1 AND session_id = $2`, [row.user_id, row.session_id]),
    ).rejects.toThrow(/stays revoked/);
  });
});
