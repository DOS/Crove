// ADR-0028 acceptance tests for the `jwt` session check (Crove Cloud, or any remote Supabase Auth Crove cannot read),
// end to end through the HTTP API on a real PostgreSQL 17. There is no auth schema here: Crove has no database access
// to the identity provider. A local HTTP server plays Supabase Auth's GET /user, the only call the kernel makes, and
// only for R3. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-jwt-sessions-0123456789';
const ISSUER = 'crove-auth';
const ANON_KEY = 'anon-key-for-the-live-check';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

// How the fake Supabase Auth answers GET /user: as Supabase Auth does for a live session (the token's own user),
// with another user's id, with a status code, or by dropping the connection.
type Answer = 'live' | 'other-user' | 'drop' | number;

suite('sessions on PostgreSQL with the jwt session check (ADR-0028, Crove Cloud)', () => {
  const dbName = `crove_test_jwt_sessions_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createHttpApp>;
  let auth: Server;
  let answer: Answer = 'live';
  const calls: Array<{ method: string; path: string; headers: IncomingHttpHeaders }> = [];
  let orgSlug = '';

  const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@jwt.test`, session: randomUUID(), userId: '' });
  const owner = account('owner');
  const member = account('member');

  async function sql(text: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await client.query(text, params);
    } finally {
      await client.end();
    }
  }

  // An access token as Supabase Auth issues it. mfaAgeS sets aal2 with a TOTP amr entry that old; exp may be
  // in the past.
  async function tokenFor(who: Pick<Account, 'subject' | 'email' | 'session'>, options: { mfaAgeS?: number; exp?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfaAgeS === undefined ? {} : { aal: 'aal2', amr: [{ method: 'totp', timestamp: now - options.mfaAgeS }] };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt(now - 60)
      .setExpirationTime(options.exp ?? now + 900)
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
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  const pendingInvites = (email: string) =>
    sql(`SELECT 1 FROM crove_kernel.member_invite WHERE email = $1 AND status = 'pending'`, [email]).then((r) => r.rowCount);

  beforeAll(async () => {
    auth = createServer((req, res) => {
      calls.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
      if (answer === 'drop') {
        req.socket.destroy();
        return;
      }
      if (typeof answer === 'number') {
        res.writeHead(answer, { 'content-type': 'application/json' }).end(JSON.stringify({ code: answer, error_code: 'session_not_found' }));
        return;
      }
      // Supabase Auth loads the user from the token's sub; the fake reads it without verifying.
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const claims = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}') as { sub?: string; email?: string };
      const id = answer === 'other-user' ? randomUUID() : claims.sub;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, aud: 'authenticated', email: claims.email }));
    });
    await new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve));
    const authUrl = `http://127.0.0.1:${(auth.address() as AddressInfo).port}/auth/v1`;

    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    // No AUTH_SESSION_CHECK and no AUTH_UPSTREAM_URL: the Cloud default.
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      PUBLIC_URL: 'https://books.example.com',
      PUBLIC_AUTH_URL: authUrl,
      PUBLIC_AUTH_ANON_KEY: ANON_KEY,
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    expect(config.AUTH_SESSION_CHECK).toBe('jwt');
    const runtime = new Runtime(db, { sessions: createSessionStatusSource(config.AUTH_SESSION_CHECK), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    owner.userId = String((await rpc('me/get', await tokenFor(owner), undefined, null)).body?.userId);
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Cloud Org', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    orgSlug = String(created.body?.slug);
    member.userId = String((await rpc('me/get', await tokenFor(member), undefined, null)).body?.userId);
    const invited = await rpc('org/invite', await tokenFor(owner, { mfaAgeS: 30 }), { email: member.email, role: 'member' });
    expect(invited.status).toBe(200);
    const inviteToken = String(invited.body?.acceptPath).split('#')[1];
    expect((await rpc('invites/accept', await tokenFor(member), { token: inviteToken }, null)).status).toBe(200);
  });

  afterAll(async () => {
    await pool?.end();
    await new Promise<void>((resolve) => (auth ? auth.close(() => resolve()) : resolve()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('accepts valid tokens with no call to Supabase Auth outside R3, and is ready without an auth schema', async () => {
    calls.length = 0;
    const user = { ...member, session: randomUUID() };
    const token = await tokenFor(user);
    expect((await rpc('me/get', token, undefined, null)).status).toBe(200);
    expect((await rpc('inbox/list', token, {})).status).toBe(200);
    expect((await rpc('org/get', token, {})).status).toBe(200);
    expect(calls).toEqual([]);
    // The session it vouched for is recorded, so it can be revoked in Crove.
    const recorded = await sql('SELECT status FROM crove_kernel.auth_session WHERE user_id = $1 AND session_id = $2', [member.userId, user.session]);
    expect(recorded.rows).toEqual([{ status: 'active' }]);
    const ready = await app.request('/readyz');
    expect(await ready.json()).toEqual({ ready: true });
  });

  it('refuses an expired token and one from another issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await rpc('inbox/list', await tokenFor(member, { exp: now - 120 }), {})).status).toBe(401);
    const foreign = await new SignJWT({ role: 'authenticated', email: member.email, session_id: member.session })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(member.subject)
      .setIssuer('someone-else')
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(SECRET));
    expect((await rpc('inbox/list', foreign, {})).status).toBe(401);
  });

  it("applies the user's own revoke immediately, for the same token and one refreshed from that session", async () => {
    const phone = { ...member, session: randomUUID() };
    const token = await tokenFor(phone);
    expect((await rpc('inbox/list', token, {})).status).toBe(200);
    expect((await rpc('sessions/revoke', token, { userId: member.userId, sessionId: phone.session })).status).toBe(200);
    expect(await rpc('inbox/list', token, {})).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    expect((await rpc('me/get', token, undefined, null)).status).toBe(401);
    // A refresh keeps the session_id: the new token is refused too.
    expect((await rpc('inbox/list', await tokenFor(phone), {})).status).toBe(401);
    // Other sessions of the user keep working.
    expect((await rpc('inbox/list', await tokenFor({ ...member, session: randomUUID() }), {})).status).toBe(200);
  });

  it("applies an owner's revoke of a member's session immediately in that org", async () => {
    const laptop = { ...member, session: randomUUID() };
    const token = await tokenFor(laptop);
    expect((await rpc('inbox/list', token, {})).status).toBe(200);
    expect((await rpc('sessions/revoke', await tokenFor(owner), { userId: member.userId, sessionId: laptop.session })).status).toBe(200);
    expect((await rpc('inbox/list', token, {})).status).toBe(401);
  });

  it('refuses a user disabled in Crove with 403', async () => {
    const user = account('disabled');
    expect((await rpc('me/get', await tokenFor(user), undefined, null)).status).toBe(200);
    await sql('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE subject = $1', [user.subject]);
    expect(await rpc('me/get', await tokenFor(user), undefined, null)).toMatchObject({ status: 403, body: { code: 'USER_DISABLED' } });
  });

  it('confirms R3 live with Supabase Auth: a 200 for the same user passes, with the token and the publishable key', async () => {
    answer = 'live';
    calls.length = 0;
    const email = `live-${randomUUID().slice(0, 8)}@jwt.test`;
    const token = await tokenFor(owner, { mfaAgeS: 10 });
    expect((await rpc('org/invite', token, { email, role: 'member' })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/auth/v1/user' });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(calls[0]?.headers.apikey).toBe(ANON_KEY);
    // No cache: the next R3 asks again.
    expect((await rpc('org/invite', token, { email, role: 'member' })).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('refuses R3 with 401 when Supabase Auth refuses the session or names another user, and changes nothing', async () => {
    for (const refusal of [400, 401, 403, 404, 'other-user'] as const) {
      answer = refusal;
      const email = `refused-${randomUUID().slice(0, 8)}@jwt.test`;
      expect(await rpc('org/invite', await tokenFor(owner, { mfaAgeS: 10 }), { email, role: 'member' })).toMatchObject({
        status: 401,
        body: { code: 'UNAUTHENTICATED' },
      });
      expect(await pendingInvites(email)).toBe(0);
    }
    answer = 'live';
  });

  it('refuses R3 with 503 when Supabase Auth is unavailable, rate limited or unreachable, while other requests keep working', async () => {
    for (const outage of [429, 500, 502, 503, 'drop'] as const) {
      answer = outage;
      const email = `outage-${randomUUID().slice(0, 8)}@jwt.test`;
      expect(await rpc('org/invite', await tokenFor(owner, { mfaAgeS: 10 }), { email, role: 'member' })).toMatchObject({
        status: 503,
        body: { code: 'AUTH_UNAVAILABLE' },
      });
      expect(await pendingInvites(email)).toBe(0);
      // An Auth outage does not log anyone out: non-R3 work goes on.
      expect((await rpc('inbox/list', await tokenFor(owner), {})).status).toBe(200);
    }
    answer = 'live';
  });

  it('asks Supabase Auth only after the role and step-up checks pass', async () => {
    calls.length = 0;
    const email = `early-${randomUUID().slice(0, 8)}@jwt.test`;
    // A member may not invite: refused on the role.
    expect((await rpc('org/invite', await tokenFor(member, { mfaAgeS: 10 }), { email, role: 'member' })).status).toBe(403);
    // An owner without fresh MFA: sent to the MFA challenge.
    expect(await rpc('org/invite', await tokenFor(owner), { email, role: 'member' })).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await rpc('org/invite', await tokenFor(owner, { mfaAgeS: 600 }), { email, role: 'member' })).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect(calls).toEqual([]);
  });

  it('checks membership on every request: a removed member is refused on the next one', async () => {
    const leaver = account('leaver');
    leaver.userId = String((await rpc('me/get', await tokenFor(leaver), undefined, null)).body?.userId);
    const invited = await rpc('org/invite', await tokenFor(owner, { mfaAgeS: 10 }), { email: leaver.email, role: 'member' });
    const inviteToken = String(invited.body?.acceptPath).split('#')[1];
    expect((await rpc('invites/accept', await tokenFor(leaver), { token: inviteToken }, null)).status).toBe(200);
    const token = await tokenFor(leaver);
    expect((await rpc('inbox/list', token, {})).status).toBe(200);
    calls.length = 0;
    expect((await rpc('org/removeMember', await tokenFor(owner, { mfaAgeS: 10 }), { userId: leaver.userId, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await rpc('inbox/list', token, {})).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
  });
});
