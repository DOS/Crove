// An invited address cannot be pre-claimed (issue #563). Supabase Auth keeps the password of the first unconfirmed
// sign-up for an address and does not update the user on a later sign-up (v2.197 internal/api/signup.go, "do not
// update the user"). If a restricted sign-up policy admitted any sign-up for an invited address, whoever knew it could
// sign up first with their own password; the invitee would confirm that account from the email Supabase Auth sends,
// join the org on it, and the attacker would sign in as that member. With AUTH_SIGNUP_POLICY restricted, the kernel's
// /auth/v1 proxy forwards a sign-up for an invited address only with the token of that address's invite (the accept
// link mailed to it), so the account an invitee confirms and accepts with carries the password of someone who opened
// the link. Proven end to end on a real PostgreSQL 17: the real proxy in front of a fake Supabase Auth that keeps the
// first sign-up's password like the real one, Supabase Auth's tables in the same database, and acceptance in db mode
// (confirmed email required). Also the database check the proxy asks, signup_invite_token_valid(). Part of the
// invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL
// to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { applyAuthGrants, migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FN = 'crove_kernel.signup_invite_token_valid(text,text)';

const suite = ADMIN ? describe : describe.skip;

type App = ReturnType<typeof createHttpApp>;
type Created = { inviteId: string; acceptPath: string };

suite('an invited address cannot be pre-claimed by an earlier sign-up (#563)', () => {
  const dbName = `crove_test_preclaim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let upstream: Server;
  let upstreamUrl = '';
  // Sign-ups that reached the fake Supabase Auth, and any invite token header it was sent.
  const reached: string[] = [];
  const leaked: string[] = [];
  let seq = 0;
  const nextClient = () => `198.51.100.${(++seq % 250) + 1}`;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '3c1f0b7e-5a2d-4e9f-8b61-0d4c2a7e9f15',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  function appWith(env: Record<string, string>): App {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused@localhost/unused',
      AUTH_JWT_SECRET: 'x'.repeat(32),
      AUTH_ISSUER: 'crove-auth',
      AUTH_UPSTREAM_URL: upstreamUrl,
      AUTH_AUTOCONFIRM: 'false',
      AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: '1000',
      AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS: '0',
      WEB_DIST: '/nonexistent',
      ...env,
    });
    return createHttpApp({
      config,
      runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool,
      aiEnabled: false,
    });
  }

  // A sign-up as a browser sends it through the proxy; `invite` is the token header the web app adds from a link.
  const signup = (app: App, email: string, password: string, invite?: string) =>
    app.fetch(
      new Request('http://localhost/auth/v1/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(invite === undefined ? {} : { 'x-crove-invite': invite }) },
        body: JSON.stringify({ email, password }),
      }),
      { incoming: { socket: { remoteAddress: nextClient() } } },
    );

  // The fake Supabase Auth's account for an address: its subject, the password it kept, and whether it is confirmed.
  async function account(email: string) {
    const { rows } = await admin((c) =>
      c.query<{ id: string; password: string; confirmed: boolean }>(
        'SELECT id, encrypted_password AS password, email_confirmed_at IS NOT NULL AS confirmed FROM auth.users WHERE email = $1',
        [email],
      ),
    );
    return rows[0] ?? null;
  }
  // Password sign-in as Supabase Auth does it: a confirmed account whose kept password matches.
  async function signIn(email: string, password: string) {
    const row = await account(email);
    return row && row.confirmed && row.password === password ? row.id : null;
  }
  // The invitee clicks the confirmation link Supabase Auth mailed to the address.
  const confirm = (email: string) => admin((c) => c.query('UPDATE auth.users SET email_confirmed_at = now() WHERE email = $1', [email]));

  // A signed-in session for a Supabase Auth subject, as the kernel would see it after verifying the access token.
  async function sessionOf(subject: string, email: string) {
    const session = randomUUID();
    await admin((c) => c.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [session, subject]));
    const id = await upsertIdentity(db, { issuer: 'test', subject, email, name: null });
    return { id, actor: { type: 'user' as const, userId: id, aal: 'aal1' as const, sessionId: session } };
  }

  async function orgOwner() {
    const ownerId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@owners.test`, name: null });
    const { orgId } = await createOrg(runtime, asUser(ownerId), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, ownerId };
  }
  const invite = async (orgId: string, inviter: string, email: string, role: 'admin' | 'member' | 'viewer' = 'member') => {
    const created = await runtime.execute<Created>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
    return { inviteId: created.inviteId, token: created.acceptPath.slice(created.acceptPath.indexOf('#') + 1) };
  };
  const unique = (label: string, domain = 'partner.test') => `${label}-${randomUUID().slice(0, 8)}@${domain}`;
  const valid = async (email: string | null, token: string | null) =>
    (await pool.query<{ ok: boolean }>('SELECT crove_kernel.signup_invite_token_valid($1, $2) AS ok', [email, token])).rows[0]?.ok;

  async function memberships(userId: string) {
    return admin(async (c) => (await c.query<{ org_id: string; role: string }>('SELECT org_id, role FROM crove_kernel.tenant_member WHERE user_id = $1', [userId])).rows);
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    // Supabase Auth's tables, with the columns the kernel reads plus the password this fake keeps (in clear: a test).
    await admin(async (c) => {
      await c.query('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
      await c.query('SET ROLE supabase_auth_admin');
      await c.query(`
        CREATE TABLE auth.users (
          id uuid PRIMARY KEY, email text UNIQUE, encrypted_password text, email_confirmed_at timestamptz,
          banned_until timestamptz, deleted_at timestamptz);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, not_after timestamptz);
        CREATE TABLE auth.mfa_factors (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, status text NOT NULL);
        ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;`);
    });
    await applyAuthGrants({ adminUrl, timeoutMs: 5000 });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });

    // The fake Supabase Auth's /signup: a new address gets an unconfirmed account with the password sent; an address
    // that already has an unconfirmed account keeps it unchanged, password included ("do not update the user"), and
    // the answer is the same.
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const header = req.headers['x-crove-invite'];
        if (header !== undefined) leaked.push(String(header));
        void (async () => {
          if (req.url?.startsWith('/signup')) {
            const { email, password } = JSON.parse(raw) as { email: string; password: string };
            const address = email.trim().toLowerCase();
            reached.push(address);
            await admin((c) =>
              c.query('INSERT INTO auth.users (id, email, encrypted_password) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING', [randomUUID(), address, password]),
            );
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end('{}');
        })();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    await pool?.end().catch(() => {});
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  for (const policy of [
    { name: 'invite_only', env: { AUTH_SIGNUP_POLICY: 'invite_only' }, domain: 'partner.test' },
    // An invited address at an allowed domain needs its link as well.
    { name: 'allowlist (allowed domain)', env: { AUTH_SIGNUP_POLICY: 'allowlist', AUTH_SIGNUP_ALLOWED_DOMAINS: 'partner.test' }, domain: 'partner.test' },
    { name: 'allowlist (outside accountant)', env: { AUTH_SIGNUP_POLICY: 'allowlist', AUTH_SIGNUP_ALLOWED_DOMAINS: 'partner.test' }, domain: 'outside.test' },
  ]) {
    it(`${policy.name}: someone without the link cannot create the invitee's account first, so the account the invitee confirms and accepts with is the invitee's`, async () => {
      const app = appWith(policy.env);
      const upstreamAuth = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('db'), stepUp: 'off' }).register({
        commands: kernelCommands,
        queries: kernelQueries({ inboundDomain: null }),
      });
      const { orgId, ownerId } = await orgOwner();
      const victim = unique('invitee', policy.domain);
      const { token } = await invite(orgId, ownerId, victim);
      // The attacker holds a real invite of their own (another org), and knows the invitee's address.
      const attackerEmail = unique('attacker', 'elsewhere.test');
      const other = await orgOwner();
      const { token: attackerToken } = await invite(other.orgId, other.ownerId, attackerEmail);

      // The pre-claim: the attacker signs up first as the invitee, with their own password. Refused without the
      // invitee's token, with the attacker's own token, and with a token that is not one; nothing reaches Supabase
      // Auth and no account exists for the address.
      const before = reached.length;
      for (const header of [undefined, attackerToken, '', 'x'.repeat(43), `${token}x`]) {
        const response = await signup(app, victim, 'attacker-pw-1', header);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error_code: 'signup_not_allowed' });
      }
      expect(reached.length).toBe(before);
      expect(await account(victim)).toBeNull();

      // The invitee signs up from the link: forwarded, and the account keeps the invitee's password. The token stays
      // with the proxy.
      expect((await signup(app, victim, 'invitee-pw-1', token)).status).toBe(200);
      expect(reached.slice(before)).toEqual([victim]);
      expect(leaked).toEqual([]);
      // A later sign-up by the attacker is still refused (and could not change the password anyway).
      expect((await signup(app, victim, 'attacker-pw-1')).status).toBe(403);
      expect((await account(victim))?.password).toBe('invitee-pw-1');

      // Before confirming, nobody can accept; after, the invitee accepts in db mode (confirmed email required) and joins.
      const subject = (await account(victim))!.id;
      const invitee = await sessionOf(subject, victim);
      await expect(upstreamAuth.executeOrgless('kernel.member.invite.accept', { token }, { actor: invitee.actor })).rejects.toMatchObject({
        code: 'INVITE_EMAIL_UNCONFIRMED',
      });
      await confirm(victim);
      await expect(upstreamAuth.executeOrgless('kernel.member.invite.accept', { token }, { actor: invitee.actor })).resolves.toMatchObject({
        orgId,
        role: 'member',
      });
      expect(await memberships(invitee.id)).toEqual([{ org_id: orgId, role: 'member' }]);

      // The attacker's password opens nothing: the only account for the address is the invitee's.
      expect(await signIn(victim, 'attacker-pw-1')).toBeNull();
      expect(await signIn(victim, 'invitee-pw-1')).toBe(subject);
      // And the used link no longer admits a sign-up.
      expect(await valid(victim, token)).toBe(false);
    });
  }

  it('open forwards sign-ups as before, and never forwards the token header', async () => {
    const app = appWith({});
    const email = unique('open', 'anywhere.test');
    expect((await signup(app, email, 'pw-open-1', 'A'.repeat(43))).status).toBe(200);
    expect(leaked).toEqual([]);
  });

  it('the check is a definer with the pinned search_path that only crove_app may execute', async () => {
    const rows = await admin(async (c) => {
      const def = await c.query<{ prosecdef: boolean; proconfig: string[] }>('SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure', [FN]);
      const roles = await c.query<{ role: string; can: boolean }>(
        `SELECT r.rolname AS role, has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE') AS can
         FROM pg_roles r WHERE r.rolname LIKE 'crove\\_%' ORDER BY 1`,
        [FN],
      );
      const acl = await c.query<{ acl: string[] | null }>('SELECT proacl::text[] AS acl FROM pg_proc WHERE oid = $1::regprocedure', [FN]);
      return { def: def.rows[0], roles: roles.rows, acl: acl.rows[0]?.acl ?? [] };
    });
    expect(rows.def).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] });
    expect(rows.roles.filter((r) => r.can).map((r) => r.role)).toEqual(['crove_app']);
    expect(rows.acl.some((entry) => entry.startsWith('='))).toBe(false);
  });

  it('admits a token only for its own address while its invite is pending, unexpired and its inviter may grant it', async () => {
    const { orgId, ownerId } = await orgOwner();
    const email = unique('bound');
    const second = unique('second');
    const { token } = await invite(orgId, ownerId, email);
    const { token: secondToken } = await invite(orgId, ownerId, second);
    expect(await valid(email, token)).toBe(true);
    // Bound to its address, in the stored form only; another invite's token, a malformed or absent one never count.
    const [local, domain] = email.split('@') as [string, string];
    for (const other of [second, email.toUpperCase(), ` ${email}`, `${local}+x@${domain}`, null]) {
      expect(await valid(other, token)).toBe(false);
    }
    for (const bad of [secondToken, token.slice(1), `${token}x`, token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(), '', null]) {
      expect(await valid(email, bad)).toBe(false);
    }

    // Revoked; replaced by a new invite (the old link dies, the new one works); expired.
    await runtime.execute('kernel.member.invite.revoke', { inviteId: (await invite(orgId, ownerId, second)).inviteId }, { actor: asUser(ownerId), orgId });
    expect(await valid(second, secondToken)).toBe(false);
    const replaced = await invite(orgId, ownerId, email);
    expect(await valid(email, token)).toBe(false);
    expect(await valid(email, replaced.token)).toBe(true);
    // Expired: an invite past its expiry (inserted so, since nothing may change an invite's expiry).
    const expiredToken = 'E'.repeat(42) + 'x';
    const expiredEmail = unique('expired');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, created_at, expires_at, token_sha256)
         VALUES ($1, $2, 'member', $3, now() - interval '8 days', now() - interval '1 minute', encode(sha256(convert_to($4, 'UTF8')), 'hex'))`,
        [orgId, expiredEmail, ownerId, expiredToken],
      ),
    );
    expect(await valid(expiredEmail, expiredToken)).toBe(false);

    // An admin's invite dies with the admin's right to issue it.
    const adminEmail = unique('admin');
    const adminId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: adminEmail, name: null });
    const adminInvite = await invite(orgId, ownerId, adminEmail, 'admin');
    await runtime.executeOrgless('kernel.member.invite.accept', { token: adminInvite.token }, { actor: asUser(adminId) });
    const byAdmin = unique('by-admin');
    const { token: byAdminToken } = await invite(orgId, adminId, byAdmin);
    expect(await valid(byAdmin, byAdminToken)).toBe(true);
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, adminId]));
    expect(await valid(byAdmin, byAdminToken)).toBe(false);
  });
});
