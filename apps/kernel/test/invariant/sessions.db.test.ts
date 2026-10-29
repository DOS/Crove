// ADR-0028 acceptance tests for the self-host `db` adapter, end to end through the HTTP API on a real
// PostgreSQL 17. Supabase Auth's auth.users, auth.sessions and auth.mfa_factors are mirrored with the columns the
// check reads (the GoTrue schema pinned in docker-compose.yml); each test changes them the way Supabase Auth does on
// sign-out, expiry, ban and deletion. Set CROVE_TEST_ADMIN_URL to a superuser URL.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { applyAuthGrants, migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource, type SignOutTarget } from '../../src/sessions.ts';
import { startWorker } from '../../src/worker.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
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
    await sql('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [account.subject, account.email]);
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
    // oRPC answers in its envelope ({ json }); the auth middleware answers plain JSON before oRPC runs.
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
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
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('db'), stepUp: 'required' }).register({
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
          id uuid PRIMARY KEY, email text, encrypted_password text, email_confirmed_at timestamptz, banned_until timestamptz,
          deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz, aal text);
        CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, token text, session_id uuid);
        CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone', 'recovery_code');
        CREATE TYPE auth.factor_status AS ENUM ('unverified', 'verified');
        CREATE TABLE auth.mfa_factors (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, friendly_name text,
          factor_type auth.factor_type NOT NULL, status auth.factor_status NOT NULL, created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL, secret text, phone text, last_challenged_at timestamptz UNIQUE,
          web_authn_credential jsonb, web_authn_aaguid uuid, last_webauthn_challenge_data jsonb);
        -- As Supabase Auth does: row-level security on, no policies.
        ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;`);
    });
    await granting;

    const { rows } = await sql(
      `SELECT table_name, column_name FROM information_schema.column_privileges
       WHERE grantee = 'crove_auth_reader' AND table_schema = 'auth' ORDER BY 1, 2`,
    );
    expect(rows).toEqual([
      { table_name: 'mfa_factors', column_name: 'status' },
      { table_name: 'mfa_factors', column_name: 'user_id' },
      { table_name: 'sessions', column_name: 'id' },
      { table_name: 'sessions', column_name: 'not_after' },
      { table_name: 'sessions', column_name: 'user_id' },
      { table_name: 'users', column_name: 'banned_until' },
      { table_name: 'users', column_name: 'deleted_at' },
      // Read by the invite definers in db mode (#134); auth-grants waits for it and always grants it (#208).
      { table_name: 'users', column_name: 'email_confirmed_at' },
      { table_name: 'users', column_name: 'id' },
    ]);
    const secrets = await sql(
      `SELECT has_table_privilege('crove_auth_reader', 'auth.refresh_tokens', 'SELECT') AS refresh,
              has_column_privilege('crove_auth_reader', 'auth.users', 'encrypted_password', 'SELECT') AS password,
              has_column_privilege('crove_auth_reader', 'auth.mfa_factors', 'secret', 'SELECT') AS factor,
              has_schema_privilege('crove_app', 'auth', 'USAGE') AS app`,
    );
    expect(secrets.rows[0]).toEqual({ refresh: false, password: false, factor: false, app: false });
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
    const created = await rpc('org/create', await tokenFor(accounts.owner), { name: 'Session Org', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    orgSlug = String(created.body?.slug);
    for (const role of ['admin', 'member'] as const) {
      accounts[role].userId = String((await me(accounts[role])).body?.userId);
      // Members join by accepting an invite (issue #35).
      const invited = await rpc('org/invite', await tokenFor(accounts.owner, { mfaAgeS: 30 }), { email: accounts[role].email, role });
      expect(invited.status).toBe(200);
      const token = String(invited.body?.acceptPath).split('#')[1];
      expect((await rpc('invites/accept', await tokenFor(accounts[role]), { token }, null)).status).toBe(200);
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
    await sql('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [subject, user.email]);
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

  // The member's own org, where nobody else is owner.
  async function memberOrg(): Promise<string> {
    const created = await rpc('org/create', await tokenFor(accounts.member), { name: `Member Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    return String(created.body?.slug);
  }
  const inboxIn = async (account: Pick<Account, 'subject' | 'email' | 'session'>, org: string) => rpc('inbox/list', await tokenFor(account), {}, org);
  const outboxRevocations = () => sql(`SELECT payload FROM crove_kernel.outbox_event WHERE type = 'kernel.session.revoked' ORDER BY created_at, id`);

  it("applies an owner revoke immediately in that org only, without touching the member's other orgs or Supabase Auth", async () => {
    const ownOrg = await memberOrg();
    const phone = { subject: accounts.member.subject, email: accounts.member.email, session: randomUUID() };
    const laptop = { ...phone, session: randomUUID() };
    await signIn(phone.subject, phone.session);
    await signIn(laptop.subject, laptop.session);
    const phoneToken = await tokenFor(phone);
    expect((await rpc('inbox/list', phoneToken, {})).status).toBe(200);
    expect((await inbox(laptop)).status).toBe(200);
    // A session the member only ever used in their own org.
    const privateSession = { ...phone, session: randomUUID() };
    await signIn(privateSession.subject, privateSession.session);
    expect((await inboxIn(privateSession, ownOrg)).status).toBe(200);
    const eventsBefore = (await outboxRevocations()).rowCount;

    const ownerToken = await tokenFor(accounts.owner);
    const revoked = await rpc('sessions/revoke', ownerToken, { userId: accounts.member.userId, sessionId: phone.session, reason: 'Mất điện thoại' });
    expect(revoked).toMatchObject({ status: 200, body: { revoked: [phone.session] } });

    // Refused in this org, for the same token and one refreshed from the session (new iat, same session_id).
    expect((await rpc('inbox/list', phoneToken, {})).status).toBe(401);
    expect((await inbox(phone)).status).toBe(401);
    // The member keeps the session everywhere else: org-less calls and their own org.
    expect((await rpc('me/get', phoneToken, undefined, null)).status).toBe(200);
    expect((await rpc('inbox/list', phoneToken, {}, ownOrg)).status).toBe(200);
    // Other sessions in this org keep working.
    expect((await inbox(laptop)).status).toBe(200);
    // No global record, no sign-out in Supabase Auth.
    expect((await outboxRevocations()).rowCount).toBe(eventsBefore);
    expect((await sql(`SELECT status FROM crove_kernel.auth_session WHERE session_id = $1`, [phone.session])).rows).toEqual([{ status: 'active' }]);
    expect((await sql('SELECT 1 FROM auth.sessions WHERE id = $1', [phone.session])).rowCount).toBe(1);

    // The owner sees only the member's sessions seen in this org, never activity from other orgs.
    const listed = await rpc('sessions/list', ownerToken, { userId: accounts.member.userId });
    expect(listed.status).toBe(200);
    const ids = (listed.body as unknown as Array<{ sessionId: string; status: string }>).map((s) => s.sessionId);
    expect(ids).toEqual(expect.arrayContaining([phone.session, laptop.session]));
    expect(ids).not.toContain(privateSession.session);
    expect(listed.body).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: phone.session, status: 'revoked' })]));

    const audit = await sql(
      `SELECT actor_id, outcome FROM crove_kernel.audit_event WHERE command = 'kernel.session.revoke' AND target_id = $1`,
      [accounts.member.userId],
    );
    expect(audit.rows).toContainEqual({ actor_id: accounts.owner.userId, outcome: 'ok' });

    // "All" from the owner: every session of the member seen in this org, in this org only.
    const all = await rpc('sessions/revoke', ownerToken, { userId: accounts.member.userId, all: true });
    expect(all.status).toBe(200);
    expect(all.body?.revoked).toEqual(expect.arrayContaining([laptop.session]));
    expect(all.body?.revoked).not.toContain(privateSession.session);
    expect((await inbox(laptop)).status).toBe(401);
    expect((await inboxIn(laptop, ownOrg)).status).toBe(200);
    expect((await inboxIn(privateSession, ownOrg)).status).toBe(200);
  });

  // The attack from the #90 review: a stranger makes the victim a member of their own org without consent, then acts
  // on the victim's sessions as that org's owner. Since #35 membership needs the victim's consent: there is no direct
  // add, and the stranger's invite makes nobody a member.
  it("refuses a cross-org attack: a stranger cannot make the victim a member, nor reach the victim's sessions", async () => {
    const victim = { subject: accounts.member.subject, email: accounts.member.email, session: randomUUID() };
    await signIn(victim.subject, victim.session);
    const victimOrg = await memberOrg();
    expect((await inboxIn(victim, victimOrg)).status).toBe(200);

    const attacker: Account = { subject: randomUUID(), email: 'attacker@sessions.test', session: randomUUID(), userId: '' };
    await signUp(attacker);
    attacker.userId = String((await me(attacker)).body?.userId);
    const evil = await rpc('org/create', await tokenFor(attacker), { name: 'Evil Org', idempotencyKey: randomUUID() }, null);
    const evilOrg = String(evil.body?.slug);
    // The direct add is gone, even with fresh MFA.
    expect(await rpc('org/addMember', await tokenFor(attacker, { mfaAgeS: 10 }), { email: victim.email, role: 'member' }, evilOrg)).toMatchObject({ status: 404 });
    // The attacker can only invite: the answer says nothing about the victim's account.
    const invited = await rpc('org/invite', await tokenFor(attacker, { mfaAgeS: 10 }), { email: victim.email, role: 'member' }, evilOrg);
    expect(invited.status).toBe(200);
    expect(Object.keys(invited.body ?? {}).sort()).toEqual(['acceptPath', 'email', 'expiresAt', 'inviteId', 'role']);
    const nobody = await rpc('org/invite', await tokenFor(attacker, { mfaAgeS: 10 }), { email: 'no-account@sessions.test', role: 'member' }, evilOrg);
    expect(Object.keys(nobody.body ?? {}).sort()).toEqual(Object.keys(invited.body ?? {}).sort());
    // The attacker holds the link but cannot accept it for the victim: the invite is bound to the victim's email.
    const token = String(invited.body?.acceptPath).split('#')[1];
    expect(await rpc('invites/accept', await tokenFor(attacker), { token }, null)).toMatchObject({ status: 403, body: { code: 'INVITE_EMAIL_MISMATCH' } });
    const memberships = await sql(
      `SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = $1 AND m.user_id = $2`,
      [evilOrg, accounts.member.userId],
    );
    expect(memberships.rowCount).toBe(0);
    const eventsBefore = (await outboxRevocations()).rowCount;

    // Without membership the attacker can neither list nor revoke the victim's sessions, named or all.
    expect((await rpc('sessions/list', await tokenFor(attacker), { userId: accounts.member.userId }, evilOrg)).status).toBe(403);
    expect((await rpc('sessions/revoke', await tokenFor(attacker, { mfaAgeS: 10 }), { userId: accounts.member.userId, all: true }, evilOrg)).status).toBe(403);
    expect((await rpc('sessions/revoke', await tokenFor(attacker), { userId: accounts.member.userId, sessionId: victim.session }, evilOrg)).status).toBe(403);
    // The victim was never in the attacker's org, and keeps working in their own.
    expect(await inboxIn(victim, evilOrg)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect((await inboxIn(victim, victimOrg)).status).toBe(200);
    expect(
      (await sql(`SELECT 1 FROM crove_kernel.auth_session_org WHERE user_id = $1 AND session_id = $2 AND status = 'revoked'`, [accounts.member.userId, victim.session]))
        .rowCount,
    ).toBe(0);
    expect((await me(victim)).status).toBe(200);
    expect((await outboxRevocations()).rowCount).toBe(eventsBefore);
    expect((await sql('SELECT 1 FROM auth.sessions WHERE id = $1', [victim.session])).rowCount).toBe(1);
  });

  it('lets only the user and the org owner manage sessions: admins and members are refused', async () => {
    const member = { ...accounts.member, session: randomUUID() };
    await signIn(member.subject, member.session);
    const memberToken = await tokenFor(member);
    expect((await rpc('inbox/list', memberToken, {})).status).toBe(200);
    const adminToken = await tokenFor(accounts.admin);
    // An admin cannot revoke or list a member's sessions, nor the owner's.
    expect((await rpc('sessions/revoke', adminToken, { userId: member.userId, sessionId: member.session })).status).toBe(403);
    expect((await rpc('sessions/revoke', adminToken, { userId: member.userId, all: true })).status).toBe(403);
    expect((await rpc('sessions/list', adminToken, { userId: member.userId })).status).toBe(403);
    expect((await rpc('sessions/revoke', adminToken, { userId: accounts.owner.userId, all: true })).status).toBe(403);
    expect((await rpc('inbox/list', memberToken, {})).status).toBe(200);
    // A member cannot touch someone else's sessions.
    expect((await rpc('sessions/revoke', memberToken, { userId: accounts.admin.userId, all: true })).status).toBe(403);
    expect((await rpc('sessions/list', memberToken, { userId: accounts.admin.userId })).status).toBe(403);
    // Exactly one of sessionId and all.
    expect((await rpc('sessions/revoke', memberToken, { userId: member.userId })).status).toBe(400);
  });

  it("revokes the user's own session globally and signs it out in Supabase Auth; revoke-all signs out globally", async () => {
    const signOuts: SignOutTarget[] = [];
    const stop = await startWorker({
      connectionString: workerUrl,
      workerDb,
      runtime: new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: [] }),
      store: {} as BlobStore,
      extractor: null,
      extract: createExtractClient({ url: 'http://crove-extract.test', fetch: async (input, init) => createExtractApp().fetch(new Request(input, init)) }),
      inboundDomain: null,
      revoker: {
        async signOut(target) {
          signOuts.push(target);
        },
      },
    });
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('the worker never asked Supabase Auth to sign out');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    try {
      const ownOrg = await memberOrg();
      const one = { subject: accounts.member.subject, email: accounts.member.email, session: randomUUID() };
      const two = { ...one, session: randomUUID() };
      const unseen = { ...one, session: randomUUID() };
      for (const s of [one, two, unseen]) await signIn(s.subject, s.session);
      expect((await inboxIn(one, ownOrg)).status).toBe(200);
      expect((await inbox(two)).status).toBe(200);

      // One device: refused in every org and org-less, signed out locally upstream.
      const oneToken = await tokenFor(one);
      expect((await rpc('sessions/revoke', oneToken, { userId: accounts.member.userId, sessionId: one.session }, ownOrg)).status).toBe(200);
      expect((await rpc('inbox/list', oneToken, {}, ownOrg)).status).toBe(401);
      expect((await rpc('inbox/list', oneToken, {})).status).toBe(401);
      expect((await rpc('me/get', oneToken, undefined, null)).status).toBe(401);
      await until(() => signOuts.some((t) => t.sessionId === one.session));
      expect(signOuts).toContainEqual({ subject: one.subject, sessionId: one.session, scope: 'local' });

      // A session id that does not belong to the user is recorded but never sent to Supabase Auth.
      const foreign = randomUUID();
      const before = (await outboxRevocations()).rowCount;
      expect((await rpc('sessions/revoke', await tokenFor(two), { userId: accounts.member.userId, sessionId: foreign })).status).toBe(200);
      expect((await outboxRevocations()).rowCount).toBe(before);

      // Revoke all: every session, also one Crove never saw, in every org; one global sign-out upstream.
      const all = await rpc('sessions/revoke', await tokenFor(two), { userId: accounts.member.userId, all: true });
      expect(all.status).toBe(200);
      expect(all.body?.revoked).toEqual(expect.arrayContaining([two.session, unseen.session]));
      for (const s of [two, unseen]) {
        expect((await inbox(s)).status).toBe(401);
        expect((await inboxIn(s, ownOrg)).status).toBe(401);
        expect((await me(s)).status).toBe(401);
      }
      await until(() => signOuts.some((t) => t.scope === 'global'));
      expect(signOuts.filter((t) => t.scope === 'global')).toHaveLength(1);
      expect(signOuts.find((t) => t.scope === 'global')?.subject).toBe(accounts.member.subject);
      // Not from the caller's own session: the web app signs that one out locally at once, and a global sign-out
      // from a session already gone leaves the others alive upstream (issue #163).
      expect(signOuts.find((t) => t.scope === 'global')?.sessionId).not.toBe(two.session);
      // Nor from a session revoked in Crove a moment earlier (`one`, still upstream until its local sign-out lands, and
      // seen more recently than `unseen`): that job deletes it first and the global sign-out would answer 403 (#176).
      expect(signOuts.find((t) => t.scope === 'global')?.sessionId).not.toBe(one.session);

      // Revoke all from the user's only session upstream: a local sign-out of it, never a global one.
      const solo = { subject: randomUUID(), email: 'solo@sessions.test', session: randomUUID(), userId: '' };
      await signUp(solo);
      solo.userId = String((await me(solo)).body?.userId);
      const soloOrg = await rpc('org/create', await tokenFor(solo), { name: 'Solo Org', idempotencyKey: randomUUID() }, null);
      expect(soloOrg.status).toBe(200);
      expect((await rpc('sessions/revoke', await tokenFor(solo), { userId: solo.userId, all: true }, String(soloOrg.body?.slug))).status).toBe(200);
      await until(() => signOuts.some((t) => t.subject === solo.subject));
      expect(signOuts.filter((t) => t.subject === solo.subject)).toEqual([{ subject: solo.subject, sessionId: solo.session, scope: 'local' }]);
      expect(signOuts.filter((t) => t.scope === 'global')).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it('never updates the account of a disabled user or a revoked session', async () => {
    const subject = randomUUID();
    const user = { subject, email: 'renamed-before@sessions.test', session: randomUUID() };
    await sql('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [subject, user.email]);
    await signIn(subject, user.session);
    expect((await me(user)).status).toBe(200);
    await sql(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE subject = $1`, [subject]);
    // A new email misses the identity cache, so the request reaches identity_resolve.
    expect((await me({ ...user, email: 'renamed-disabled@sessions.test' })).status).toBe(403);
    await sql(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE subject = $1`, [subject]);
    await sql(`DELETE FROM auth.sessions WHERE id = $1`, [user.session]);
    expect((await me({ ...user, email: 'renamed-signed-out@sessions.test' })).status).toBe(401);
    const { rows } = await sql('SELECT email FROM crove_kernel.user_account WHERE subject = $1', [subject]);
    expect(rows).toEqual([{ email: 'renamed-before@sessions.test' }]);
  });

  it('requires fresh MFA for membership changes through the API', async () => {
    // Inviting (#35) needs it too, for every role.
    for (const mfaAgeS of [undefined, 10 * 60]) {
      const token = await tokenFor(accounts.owner, mfaAgeS === undefined ? {} : { mfaAgeS });
      expect(await rpc('org/invite', token, { email: 'step-up@sessions.test', role: 'viewer' })).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    }
    expect((await rpc('org/invite', await tokenFor(accounts.owner, { mfaAgeS: 20 }), { email: 'step-up@sessions.test', role: 'viewer' })).status).toBe(200);
    // A role change of an existing member (#36).
    const add = async (mfaAgeS?: number) =>
      rpc('org/changeMemberRole', await tokenFor(accounts.owner, mfaAgeS === undefined ? {} : { mfaAgeS }), {
        userId: accounts.member.userId,
        role: 'member',
        idempotencyKey: randomUUID(),
      });
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
    const orgs = (still.body?.orgs ?? []) as Array<{ slug: string }>;
    expect(orgs.map((o) => o.slug)).not.toContain(orgSlug);
  });

  it('keeps a revoked record revoked, even for the database owner', async () => {
    const { rows } = await sql(`SELECT user_id, session_id FROM crove_kernel.auth_session WHERE status = 'revoked' LIMIT 1`);
    const row = rows[0] as { user_id: string; session_id: string };
    await expect(
      sql(`UPDATE crove_kernel.auth_session SET status = 'active', revoked_at = NULL WHERE user_id = $1 AND session_id = $2`, [row.user_id, row.session_id]),
    ).rejects.toThrow(/stays revoked/);
  });
});
