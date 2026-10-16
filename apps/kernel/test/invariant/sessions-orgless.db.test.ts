// A user's own session revoke without an org (issue #184, ADR-0028 section 4), end to end through the HTTP API on a
// real PostgreSQL 17 with the jwt session check. Sign-out on the onboarding and invite pages sends no org header:
// the user's own revoke must still take effect, while revoking anyone else's sessions stays org-scoped. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
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
const SECRET = 'test-only-jwt-secret-for-orgless-revoke-0123456789';
const ISSUER = 'crove-auth';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

suite('own session revoke without an org (issue #184)', () => {
  const dbName = `crove_test_orgless_revoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createHttpApp>;
  let orgSlug = '';
  let orgId = '';

  const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@orgless.test`, session: randomUUID(), userId: '' });
  const owner = account('owner');
  const member = account('member');

  async function sql(text: string, params: unknown[] = [], url = adminUrl) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await client.query(text, params);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Pick<Account, 'subject' | 'email' | 'session'>) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 900)
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

  // Signs the account in (me.get records the session and creates the user) and returns its Crove user id.
  async function signIn(who: Account): Promise<string> {
    const me = await rpc('me/get', await tokenFor(who));
    expect(me.status).toBe(200);
    return String(me.body?.userId);
  }

  const sessionRow = (userId: string, sessionId: string) =>
    sql('SELECT status, revoked_by, reason FROM crove_kernel.auth_session WHERE user_id = $1 AND session_id = $2', [userId, sessionId]).then(
      (r) => r.rows[0] ?? null,
    );
  const revokeAudits = (userId: string) =>
    sql(
      `SELECT org_id, actor_id, outcome, target_id FROM crove_kernel.audit_event
       WHERE command = 'kernel.session.revoke' AND target_id = $1 ORDER BY occurred_at`,
      [userId],
    ).then((r) => r.rows);

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      PUBLIC_URL: 'https://books.example.com',
      PUBLIC_AUTH_URL: 'http://127.0.0.1:9/auth/v1',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    expect(config.AUTH_SESSION_CHECK).toBe('jwt');
    const runtime = new Runtime(db, { sessions: createSessionStatusSource(config.AUTH_SESSION_CHECK), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    owner.userId = await signIn(owner);
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Orgless Revoke', idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    orgSlug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    member.userId = await signIn(member);
    // The member joins the owner's org (the invite flow has its own tests; R3 here would need a live Auth check).
    await sql(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member.userId]);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets a user with no org revoke their own session without an org header, effective on the next request', async () => {
    const user = account('onboarding');
    user.userId = await signIn(user);
    const token = await tokenFor(user);
    const revoked = await rpc('sessions/revoke', token, { userId: user.userId, sessionId: user.session, reason: 'sign-out' });
    expect(revoked).toMatchObject({ status: 200, body: { revoked: [user.session] } });
    expect(await sessionRow(user.userId, user.session)).toEqual({ status: 'revoked', revoked_by: user.userId, reason: 'sign-out' });
    // The same token, and one refreshed from that session, are refused; another session of the user is not.
    expect(await rpc('me/get', token)).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    expect((await rpc('me/get', await tokenFor(user))).status).toBe(401);
    expect((await rpc('me/get', await tokenFor({ ...user, session: randomUUID() }))).status).toBe(200);
  });

  it('lets a user with no org revoke all their sessions without an org header', async () => {
    const user = account('everywhere');
    user.userId = await signIn(user);
    const laptop = { ...user, session: randomUUID() };
    expect((await rpc('me/get', await tokenFor(laptop))).status).toBe(200);
    const result = await rpc('sessions/revoke', await tokenFor(user), { userId: user.userId, all: true });
    expect(result.status).toBe(200);
    expect([...((result.body?.revoked ?? []) as string[])].sort()).toEqual([user.session, laptop.session].sort());
    expect((await rpc('me/get', await tokenFor(user))).status).toBe(401);
    expect((await rpc('me/get', await tokenFor(laptop))).status).toBe(401);
  });

  it("revokes a user's own session without an org header through the audited command in their org", async () => {
    const tablet = { ...member, session: randomUUID() };
    const token = await tokenFor(tablet);
    expect((await rpc('inbox/list', token, {}, orgSlug)).status).toBe(200);
    const before = (await revokeAudits(member.userId)).length;

    const revoked = await rpc('sessions/revoke', token, { userId: member.userId, sessionId: tablet.session });
    expect(revoked).toMatchObject({ status: 200, body: { revoked: [tablet.session] } });
    // A self revoke is global: refused everywhere, org-less too.
    expect((await rpc('me/get', token)).status).toBe(401);
    expect((await rpc('inbox/list', token, {}, orgSlug)).status).toBe(401);
    const audits = await revokeAudits(member.userId);
    expect(audits).toHaveLength(before + 1);
    expect(audits.at(-1)).toEqual({ org_id: orgId, actor_id: member.userId, outcome: 'ok', target_id: member.userId });
  });

  it("refuses revoking another user's sessions without an org header, and changes nothing", async () => {
    const phone = { ...member, session: randomUUID() };
    const token = await tokenFor(phone);
    expect((await rpc('inbox/list', token, {}, orgSlug)).status).toBe(200);
    const stranger = account('stranger');
    stranger.userId = await signIn(stranger);
    for (const [caller, input] of [
      // The member's org owner, single and all.
      [owner, { userId: member.userId, sessionId: phone.session }],
      [owner, { userId: member.userId, all: true }],
      // A user with no org at all.
      [stranger, { userId: member.userId, sessionId: phone.session }],
      [stranger, { userId: member.userId, all: true }],
    ] as const) {
      expect(await rpc('sessions/revoke', await tokenFor(caller), input)).toMatchObject({ status: 400, body: { code: 'ORG_REQUIRED' } });
    }
    expect(await sessionRow(member.userId, phone.session)).toEqual({ status: 'active', revoked_by: null, reason: null });
    expect((await rpc('inbox/list', token, {}, orgSlug)).status).toBe(200);
  });

  it("keeps an owner's revoke of a member org-scoped: refused in that org, the session still works outside it", async () => {
    const desktop = { ...member, session: randomUUID() };
    const token = await tokenFor(desktop);
    expect((await rpc('inbox/list', token, {}, orgSlug)).status).toBe(200);
    const before = (await revokeAudits(member.userId)).length;
    expect((await rpc('sessions/revoke', await tokenFor(owner), { userId: member.userId, sessionId: desktop.session }, orgSlug)).status).toBe(200);
    expect((await rpc('inbox/list', token, {}, orgSlug)).status).toBe(401);
    expect((await rpc('me/get', token)).status).toBe(200);
    expect(await sessionRow(member.userId, desktop.session)).toEqual({ status: 'active', revoked_by: null, reason: null });
    const audits = await revokeAudits(member.userId);
    expect(audits).toHaveLength(before + 1);
    expect(audits.at(-1)).toEqual({ org_id: orgId, actor_id: owner.userId, outcome: 'ok', target_id: member.userId });
  });

  it('keeps the org-less definer to the API role, to a live session of the user, outside any org, and away from users with an org', async () => {
    const fn = 'crove_kernel.session_revoke_orgless(uuid,uuid,uuid,text)';
    const grants = await sql(
      `SELECT r AS role, has_function_privilege(r, $1, 'EXECUTE') AS can FROM unnest($2::text[]) r ORDER BY r`,
      [fn, ['crove_app', 'crove_tenant', 'crove_worker']],
    );
    expect(grants.rows).toEqual([
      { role: 'crove_app', can: true },
      { role: 'crove_tenant', can: false },
      { role: 'crove_worker', can: false },
    ]);

    const user = account('definer');
    user.userId = await signIn(user);
    const call = (userId: string, current: string, target: string | null) =>
      sql('SELECT * FROM crove_kernel.session_revoke_orgless($1::uuid, $2::uuid, $3::uuid, NULL)', [userId, current, target], appUrl);
    // Not bound to a live session of that user: an unknown caller session, or another user's session.
    await expect(call(user.userId, randomUUID(), null)).rejects.toMatchObject({ code: '28000', message: 'SESSION_INVALID' });
    await expect(call(user.userId, owner.session, null)).rejects.toMatchObject({ code: '28000', message: 'SESSION_INVALID' });
    // A user with an org revokes through the audited command in it.
    await expect(call(owner.userId, owner.session, owner.session)).rejects.toMatchObject({ code: '42501', message: 'ORG_REQUIRED' });
    expect(await sessionRow(user.userId, user.session)).toEqual({ status: 'active', revoked_by: null, reason: null });
    expect(await sessionRow(owner.userId, owner.session)).toMatchObject({ status: 'active' });

    // Never inside an org context.
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, orgId]);
      await expect(
        client.query('SELECT * FROM crove_kernel.session_revoke_orgless($1::uuid, $2::uuid, NULL, NULL)', [owner.userId, owner.session]),
      ).rejects.toMatchObject({ code: '42501', message: 'NOT_ORGLESS' });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
