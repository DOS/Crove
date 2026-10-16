// Invariant suite (Decision 7): a user with a verified MFA factor gets nothing with an aal1 token (issue #126,
// ADR-0028 section 3, self-host `db` adapter). Through the HTTP API on a real PostgreSQL 17. Supabase Auth's
// auth.users, auth.sessions and auth.mfa_factors are mirrored with the columns and types of the Supabase Auth version
// pinned in docker-compose.yml (row-level security on, owned by supabase_auth_admin). Keep this file self-contained:
// import package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run creates and drops its own database.
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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-mfa-required-0123';
const ISSUER = 'crove-auth';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
}

type Factor = 'none' | 'verified' | 'unverified';

suite('aal1 tokens of users with a verified MFA factor on PostgreSQL (issue #126, self-host db adapter)', () => {
  const dbName = `crove_test_mfa_required_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createHttpApp>;
  // Each account owns its own org, so every request below runs in an org the account is a member of.
  const orgs = new Map<string, string>();

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

  // A token as the bundled Supabase Auth issues it: aal1 after the password (or a recovery link), aal2 with a TOTP
  // amr entry after the MFA challenge.
  async function tokenFor(account: Account, aal: 'aal1' | 'aal2') {
    const now = Math.floor(Date.now() / 1000);
    const amr = aal === 'aal2' ? [{ method: 'totp', timestamp: now - 10 }, { method: 'password', timestamp: now - 60 }] : [{ method: 'password', timestamp: now - 60 }];
    return new SignJWT({ role: 'authenticated', email: account.email, session_id: account.session, aal, amr, is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(account.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input?: unknown, org: string | null = null) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(org ? { 'x-crove-org': org } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  async function upload(token: string, org: string) {
    const form = new FormData();
    form.append('file', new File([new TextEncoder().encode('<?xml version="1.0"?><HDon></HDon>')], 'hd.xml', { type: 'text/xml' }));
    const response = await app.request('/api/files', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-crove-org': org }, body: form });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null };
  }

  // What Supabase Auth does on sign-up and sign-in, then on TOTP enrollment (unverified until the first challenge).
  async function account(factor: Factor): Promise<Account> {
    const subject = randomUUID();
    const a = { subject, email: `${factor}-${subject.slice(0, 8)}@mfa.test`, session: randomUUID() };
    await sql('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [subject, a.email]);
    await sql('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [a.session, subject]);
    // The org is created before enrollment, as a user does on onboarding.
    const created = await rpc('org/create', await tokenFor(a, 'aal1'), { name: `Org ${subject.slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    orgs.set(subject, String(created.body?.slug));
    if (factor !== 'none') await enroll(a, factor);
    return a;
  }
  const enroll = (a: Account, status: 'verified' | 'unverified') =>
    sql(
      `INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
       VALUES ($1, $2, 'phone', 'totp', $3, now(), now(), 'not-a-real-secret')`,
      [randomUUID(), a.subject, status],
    );

  // A read query, an R1 command (the user's own session revoke for an unknown id), an upload (R1 file ingest) and
  // the org-less profile call.
  async function surfaces(a: Account, aal: 'aal1' | 'aal2') {
    const token = await tokenFor(a, aal);
    const org = orgs.get(a.subject) as string;
    const me = await rpc('me/get', token);
    return {
      read: await rpc('inbox/list', token, {}, org),
      files: await rpc('files/recent', token, undefined, org),
      command: await rpc('sessions/revoke', token, { userId: String(me.body?.userId ?? randomUUID()), sessionId: randomUUID() }, org),
      upload: await upload(token, org),
      me,
    };
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
    // Supabase Auth starts and runs its migrations as supabase_auth_admin, the owner of the auth schema.
    await sql('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
    await admin(async (c) => {
      await c.query('SET ROLE supabase_auth_admin');
      await c.query(`
        CREATE TABLE auth.users (
          id uuid PRIMARY KEY, email text, encrypted_password text, email_confirmed_at timestamptz, banned_until timestamptz,
          deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz, aal text);
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
    });
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
    const blobs = new Map<string, Uint8Array>();
    const store: BlobStore = {
      async put(key, bytes) {
        blobs.set(key, bytes);
      },
      async get(key) {
        const bytes = blobs.get(key);
        if (!bytes) throw new Error('not found');
        return bytes;
      },
      async delete(key) {
        blobs.delete(key);
      },
    };
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('db'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('grants the reader only user_id and status of auth.mfa_factors, never the factor secret', async () => {
    const { rows } = await sql(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE grantee = 'crove_auth_reader' AND table_schema = 'auth' AND table_name = 'mfa_factors' ORDER BY 1`,
    );
    expect(rows).toEqual([{ column_name: 'status' }, { column_name: 'user_id' }]);
    const secret = await sql(`SELECT has_column_privilege('crove_auth_reader', 'auth.mfa_factors', 'secret', 'SELECT') AS secret`);
    expect(secret.rows).toEqual([{ secret: false }]);
    // The factor reader belongs to crove_auth_reader and is reachable only through the session check.
    const fn = await sql(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
       FROM pg_proc p WHERE p.oid = 'crove_kernel.auth_user_has_verified_factor(uuid)'::regprocedure`,
    );
    expect(fn.rows).toEqual([{ owner: 'crove_auth_reader', definer: true, config: ['search_path=pg_catalog, pg_temp'], app: false, public: false }]);
    // No session check without the assurance level is left to call.
    const old = await sql(`SELECT to_regprocedure('crove_kernel.session_check(uuid, uuid, boolean, uuid)') AS fn`);
    expect(old.rows).toEqual([{ fn: null }]);
  });

  it('refuses an aal1 token of a user with a verified factor on reads, R1 commands, uploads and org-less calls', async () => {
    const user = await account('verified');
    const refused = await surfaces(user, 'aal1');
    for (const response of Object.values(refused)) {
      expect(response).toMatchObject({ status: 401, body: { code: 'MFA_REQUIRED' } });
    }
    // Nothing was written: no session revoke, no file.
    const files = await sql(
      `SELECT count(*)::int AS n FROM crove_kernel.file f JOIN crove_kernel.tenant t ON t.org_id = f.org_id WHERE t.slug = $1`,
      [orgs.get(user.subject)],
    );
    expect(files.rows).toEqual([{ n: 0 }]);
    const revokes = await sql(
      `SELECT count(*)::int AS n FROM crove_kernel.auth_session s JOIN crove_kernel.user_account u ON u.id = s.user_id
       WHERE u.subject = $1 AND s.status = 'revoked'`,
      [user.subject],
    );
    expect(revokes.rows).toEqual([{ n: 0 }]);
  });

  it('lets the same session through with aal2 after the MFA challenge', async () => {
    const user = await account('verified');
    const passed = await surfaces(user, 'aal2');
    expect(passed.me.status).toBe(200);
    expect(passed.read.status).toBe(200);
    expect(passed.files.status).toBe(200);
    expect(passed.command.status).toBe(200);
    expect(passed.upload.status).toBe(200);
  });

  it('keeps aal1 access for a user without factors and for a user whose only factor is unverified', async () => {
    for (const factor of ['none', 'unverified'] as const) {
      const user = await account(factor);
      const passed = await surfaces(user, 'aal1');
      for (const response of Object.values(passed)) expect(response.status).toBe(200);
    }
  });

  it('follows the factor state on the next request: verified, then unenrolled', async () => {
    const user = await account('none');
    const org = orgs.get(user.subject) as string;
    expect((await rpc('inbox/list', await tokenFor(user, 'aal1'), {}, org)).status).toBe(200);
    // The user verifies a factor on another device: the old aal1 token stops working at once.
    await enroll(user, 'verified');
    expect(await rpc('inbox/list', await tokenFor(user, 'aal1'), {}, org)).toMatchObject({ status: 401, body: { code: 'MFA_REQUIRED' } });
    // Unenrolling (Supabase Auth requires aal2 for it) deletes the factor row.
    await sql('DELETE FROM auth.mfa_factors WHERE user_id = $1', [user.subject]);
    expect((await rpc('inbox/list', await tokenFor(user, 'aal1'), {}, org)).status).toBe(200);
  });

  it('answers a signed-out session with 401 UNAUTHENTICATED, not with the MFA challenge', async () => {
    const user = await account('verified');
    await sql('DELETE FROM auth.sessions WHERE id = $1', [user.session]);
    expect(await rpc('me/get', await tokenFor(user, 'aal1'))).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } });
  });

  it('fails closed with 503 when the factor grant is missing, and re-running auth-grants restores it', async () => {
    const user = await account('none');
    await sql('REVOKE SELECT (status) ON auth.mfa_factors FROM crove_auth_reader');
    expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: false }]);
    expect(await rpc('me/get', await tokenFor(user, 'aal1'))).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
    await applyAuthGrants({ adminUrl, timeoutMs: 1000 });
    // Without the reader's row policy the check would see no factors at all: not ready either.
    await sql('DROP POLICY crove_auth_reader_select ON auth.mfa_factors');
    expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: false }]);
    await applyAuthGrants({ adminUrl, timeoutMs: 1000 });
    expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: true }]);
    expect((await rpc('me/get', await tokenFor(user, 'aal1'))).status).toBe(200);
  });

  // A Supabase Auth upgrade that renames or drops the table must not turn the MFA rule off (issue #180): every
  // request fails closed, for users with and without a factor, until the table is back and auth-grants ran again.
  it('fails closed with 503 when auth.mfa_factors is missing, and auth-grants waits for it', async () => {
    const plain = await account('none');
    const enrolled = await account('verified');
    await admin(async (c) => {
      await c.query('SET ROLE supabase_auth_admin');
      await c.query('ALTER TABLE auth.mfa_factors RENAME TO mfa_factors_moved');
    });
    try {
      expect((await sql('SELECT crove_kernel.auth_grants_ready() AS ok')).rows).toEqual([{ ok: false }]);
      for (const user of [plain, enrolled]) {
        const token = await tokenFor(user, 'aal1');
        expect(await rpc('me/get', token)).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
        expect(await rpc('inbox/list', token, {}, orgs.get(user.subject) as string)).toMatchObject({ status: 503, body: { code: 'AUTH_NOT_READY' } });
      }
      const ready = await app.request('/readyz');
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ready: false, reason: 'auth_grants' });
      // auth-grants does not settle for the other two tables: it keeps waiting, then gives up.
      await expect(applyAuthGrants({ adminUrl, timeoutMs: 300, pollMs: 100 })).rejects.toThrow(/auth\.mfa_factors do not exist/);
    } finally {
      await admin(async (c) => {
        await c.query('SET ROLE supabase_auth_admin');
        await c.query('ALTER TABLE auth.mfa_factors_moved RENAME TO mfa_factors');
      });
    }
    await applyAuthGrants({ adminUrl, timeoutMs: 1000 });
    expect((await rpc('me/get', await tokenFor(plain, 'aal1'))).status).toBe(200);
    expect(await rpc('me/get', await tokenFor(enrolled, 'aal1'))).toMatchObject({ status: 401, body: { code: 'MFA_REQUIRED' } });
    expect((await rpc('me/get', await tokenFor(enrolled, 'aal2'))).status).toBe(200);
  });
});
