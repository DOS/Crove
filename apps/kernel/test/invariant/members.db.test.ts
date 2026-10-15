// Invariant suite (Decision 7): who may change roles and remove members, and what a removal or demotion revokes
// (issue #36, plan §4.6 and §7.3). Through the HTTP API where the claim is "the next request", against a real
// PostgreSQL 17. Keep this file self-contained: import package code under test, never helpers from outside
// test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
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
const SECRET = 'test-only-jwt-secret-for-members-0123456789';
const ISSUER = 'crove-auth';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

type Role = 'owner' | 'admin' | 'member' | 'viewer';

suite('member role changes and removal on PostgreSQL (issue #36)', () => {
  const dbName = `crove_test_members_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let app: ReturnType<typeof createHttpApp>;

  const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@members.test`, session: randomUUID(), userId: '' });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // An access token as Supabase Auth issues it; mfa adds aal2 with a TOTP used just now (R3, policy P11).
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

  async function rpc(path: string, token: string, input: unknown, org: string | null) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  // Signs the account in once (creating its Crove user) and returns its user id.
  async function signIn(who: Account): Promise<Account> {
    const me = await rpc('me/get', await tokenFor(who), undefined, null);
    expect(me.status).toBe(200);
    who.userId = String(me.body?.userId);
    return who;
  }

  async function signInAll<N extends string>(...names: N[]): Promise<Record<N, Account>> {
    const signedIn = await Promise.all(names.map((n) => signIn(account(n))));
    return Object.fromEntries(names.map((n, i) => [n, signedIn[i]])) as Record<N, Account>;
  }

  // An org owned by `owner`, with the other accounts added in the given roles (owners are promoted after adding).
  async function orgWith(owner: Account, members: Array<[Account, Role]>) {
    const created = await rpc('org/create', await tokenFor(owner), { name: `Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    const slug = String(created.body?.slug);
    const orgId = String(created.body?.orgId);
    const ownerToken = await tokenFor(owner, { mfa: true });
    for (const [who, role] of members) {
      const added = await rpc('org/addMember', ownerToken, { email: who.email, role: role === 'owner' ? 'admin' : role }, slug);
      expect(added.status).toBe(200);
      if (role === 'owner') expect((await changeRole(owner, slug, who, 'owner')).status).toBe(200);
    }
    return { slug, orgId };
  }

  const changeRole = async (actor: Account, slug: string, target: Pick<Account, 'userId'>, role: string, idempotencyKey = randomUUID()) =>
    rpc('org/changeMemberRole', await tokenFor(actor, { mfa: true }), { userId: target.userId, role, idempotencyKey }, slug);
  const remove = async (actor: Account, slug: string, target: Pick<Account, 'userId'>, idempotencyKey = randomUUID()) =>
    rpc('org/removeMember', await tokenFor(actor, { mfa: true }), { userId: target.userId, idempotencyKey }, slug);

  async function roles(orgId: string): Promise<Record<string, Role>> {
    return admin(async (c) => {
      const { rows } = await c.query<{ user_id: string; role: Role }>('SELECT user_id, role FROM crove_kernel.tenant_member WHERE org_id = $1', [orgId]);
      return Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
    });
  }

  async function audit(orgId: string, command: string) {
    return admin(async (c) => {
      const { rows } = await c.query<{ actor_id: string; outcome: string; target_id: string | null; detail: Record<string, unknown> }>(
        'SELECT actor_id, outcome, target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at, id',
        [orgId, command],
      );
      return rows;
    });
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);
    // Session check "off" still checks Crove's own session record and membership in the request transaction.
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only owners change roles or remove members; admins, members and viewers are refused and audited', async () => {
    const { owner, admin: adminA, member, viewer } = await signInAll('owner', 'admin', 'member', 'viewer');
    const { slug, orgId } = await orgWith(owner, [
      [adminA, 'admin'],
      [member, 'member'],
      [viewer, 'viewer'],
    ]);
    const before = await roles(orgId);
    for (const actor of [adminA, member, viewer]) {
      expect(await changeRole(actor, slug, viewer, 'member')).toMatchObject({ status: 403 });
      expect(await changeRole(actor, slug, actor, 'owner')).toMatchObject({ status: 403 });
      expect(await changeRole(actor, slug, owner, 'viewer')).toMatchObject({ status: 403 });
      expect(await remove(actor, slug, member)).toMatchObject({ status: 403 });
      expect(await remove(actor, slug, owner)).toMatchObject({ status: 403 });
    }
    expect(await roles(orgId)).toEqual(before);
    const denied = await audit(orgId, 'kernel.member.remove');
    expect(denied).toHaveLength(6);
    expect(denied.every((r) => r.outcome === 'denied' && r.detail.code === 'FORBIDDEN')).toBe(true);
  });

  it('needs a fresh second factor (R3, P11) for both commands', async () => {
    const { owner, member } = await signInAll('owner', 'member');
    const { slug, orgId } = await orgWith(owner, [[member, 'member']]);
    const aal1 = await tokenFor(owner);
    expect(await rpc('org/changeMemberRole', aal1, { userId: member.userId, role: 'viewer', idempotencyKey: randomUUID() }, slug)).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect(await rpc('org/removeMember', aal1, { userId: member.userId, idempotencyKey: randomUUID() }, slug)).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect((await roles(orgId))[member.userId]).toBe('member');
  });

  it('never reaches members of another org: commands, and raw writes in another org context (RLS)', async () => {
    const { ownerA, memberA, ownerB, memberB } = await signInAll('ownerA', 'memberA', 'ownerB', 'memberB');
    const a = await orgWith(ownerA, [[memberA, 'member']]);
    const b = await orgWith(ownerB, [[memberB, 'member']]);
    const beforeA = await roles(a.orgId);

    // The owner of B names A's members while in B: they are not B's members.
    expect(await changeRole(ownerB, b.slug, memberA, 'viewer')).toMatchObject({ status: 404, body: { code: 'MEMBER_NOT_FOUND' } });
    expect(await changeRole(ownerB, b.slug, ownerA, 'viewer')).toMatchObject({ status: 404 });
    expect(await remove(ownerB, b.slug, memberA)).toMatchObject({ status: 404, body: { code: 'MEMBER_NOT_FOUND' } });
    expect(await remove(ownerB, b.slug, ownerA)).toMatchObject({ status: 404 });
    // Pointing the header at A does not help: B's owner is not a member of A.
    expect(await changeRole(ownerB, a.slug, memberA, 'viewer')).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await remove(ownerB, a.slug, memberA)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    // Nor does the runtime with A's org id for a user who is not a member there.
    const asOwnerB = { type: 'user' as const, userId: ownerB.userId, aal: 'aal2' as const, sessionId: ownerB.session, mfaAt: Math.floor(Date.now() / 1000) };
    await expect(runtime.execute('kernel.member.remove', { userId: memberA.userId }, { actor: asOwnerB, orgId: a.orgId })).rejects.toMatchObject({
      code: 'NOT_A_MEMBER',
    });

    // The API login role in B's context cannot update or delete A's membership rows, nor move a row into A.
    const touched = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${ownerB.userId}::uuid, ${b.orgId}::uuid)`.execute(trx);
      const updated = await sql`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = ${a.orgId}::uuid`.execute(trx);
      const deleted = await sql`DELETE FROM crove_kernel.tenant_member WHERE org_id = ${a.orgId}::uuid`.execute(trx);
      return Number(updated.numAffectedRows ?? 0) + Number(deleted.numAffectedRows ?? 0);
    });
    expect(touched).toBe(0);
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_context(${ownerB.userId}::uuid, ${b.orgId}::uuid)`.execute(trx);
        await sql`UPDATE crove_kernel.tenant_member SET org_id = ${a.orgId}::uuid WHERE user_id = ${memberB.userId}::uuid`.execute(trx);
      }),
    ).rejects.toThrow(/row-level security/);
    expect(await roles(a.orgId)).toEqual(beforeA);
  });

  it('keeps at least one owner: the last owner cannot demote or remove themselves', async () => {
    const { owner, second, member } = await signInAll('owner', 'second', 'member');
    const { slug, orgId } = await orgWith(owner, [[member, 'member']]);
    for (const role of ['admin', 'member', 'viewer']) {
      expect(await changeRole(owner, slug, owner, role)).toMatchObject({ status: 409, body: { code: 'LAST_OWNER' } });
    }
    expect(await remove(owner, slug, owner)).toMatchObject({ status: 422, body: { code: 'CANNOT_REMOVE_SELF' } });
    expect((await roles(orgId))[owner.userId]).toBe('owner');

    // With a co-owner, an owner may step down, but the one left is again the last owner.
    await rpc('org/addMember', await tokenFor(owner, { mfa: true }), { email: second.email, role: 'admin' }, slug);
    expect((await changeRole(owner, slug, second, 'owner')).status).toBe(200);
    expect(await remove(second, slug, second)).toMatchObject({ status: 422, body: { code: 'CANNOT_REMOVE_SELF' } });
    expect(await changeRole(second, slug, second, 'admin')).toMatchObject({ status: 200, body: { role: 'admin', previousRole: 'owner' } });
    expect(await changeRole(owner, slug, owner, 'admin')).toMatchObject({ status: 409, body: { code: 'LAST_OWNER' } });
    // The demoted co-owner has lost the owner right from its next request.
    expect(await changeRole(second, slug, owner, 'admin')).toMatchObject({ status: 403 });
    expect(await remove(second, slug, member)).toMatchObject({ status: 403 });
    const owners = Object.values(await roles(orgId)).filter((r) => r === 'owner');
    expect(owners).toHaveLength(1);
    const failed = (await audit(orgId, 'kernel.member.change_role')).filter((r) => r.outcome === 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(4);
    expect(failed.every((r) => r.detail.code === 'LAST_OWNER')).toBe(true);
  });

  it('two owners demoting or removing each other at the same moment leave exactly one owner', async () => {
    for (const mode of ['demote', 'remove'] as const) {
      const { x, y } = await signInAll('x', 'y');
      const { slug, orgId } = await orgWith(x, [[y, 'owner']]);
      expect(Object.values(await roles(orgId)).filter((r) => r === 'owner')).toHaveLength(2);
      const [tokenX, tokenY] = await Promise.all([tokenFor(x, { mfa: true }), tokenFor(y, { mfa: true })]);
      const act = (token: string, target: Account) =>
        mode === 'demote'
          ? rpc('org/changeMemberRole', token, { userId: target.userId, role: 'admin', idempotencyKey: randomUUID() }, slug)
          : rpc('org/removeMember', token, { userId: target.userId, idempotencyKey: randomUUID() }, slug);

      // Hold both owner rows so the two commands are certainly in flight together, then let them race.
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query("SELECT 1 FROM crove_kernel.tenant_member WHERE org_id = $1 AND role = 'owner' FOR UPDATE", [orgId]);
      const racing = Promise.all([act(tokenX, y), act(tokenY, x)]);
      await waitForLockWaiters(2);
      await holder.query('COMMIT');
      await holder.end();
      const results = await racing;

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 403 || r.status === 409)).toBe(true);
      expect(Object.values(await roles(orgId)).filter((r) => r === 'owner')).toHaveLength(1);
    }
  });

  // Waits until `count` backends of this database wait on a row lock.
  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 100; i++) {
      const waiting = await admin(async (c) => {
        const { rows } = await c.query<{ n: string }>(
          "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
          [dbName],
        );
        return Number(rows[0]?.n ?? 0);
      });
      if (waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the racing commands never waited on the lock');
  }

  it('revokes access on the next request after removal, with the same token and session', async () => {
    const { owner, member } = await signInAll('owner', 'member');
    const { slug, orgId } = await orgWith(owner, [[member, 'admin']]);
    const memberToken = await tokenFor(member, { mfa: true });
    expect(await rpc('inbox/list', memberToken, {}, slug)).toMatchObject({ status: 200 });
    expect((await rpc('me/get', memberToken, undefined, null)).body?.orgs).toEqual([expect.objectContaining({ slug })]);

    expect(await remove(owner, slug, member)).toMatchObject({ status: 200, body: { userId: member.userId, previousRole: 'admin' } });

    // The very next requests with the token that worked a moment ago: no org, no reads, no writes.
    expect(await rpc('inbox/list', memberToken, {}, slug)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await rpc('org/get', memberToken, undefined, slug)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await rpc('org/addMember', memberToken, { email: owner.email, role: 'viewer' }, slug)).toMatchObject({ status: 403 });
    expect((await rpc('me/get', memberToken, undefined, null)).body?.orgs).toEqual([]);
    // Below the API too: the runtime refuses the removed user for this org.
    const asMember = { type: 'user' as const, userId: member.userId, aal: 'aal2' as const, sessionId: member.session, mfaAt: Math.floor(Date.now() / 1000) };
    await expect(runtime.query('kernel.org.get', {}, { actor: asMember, orgId })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    await expect(
      runtime.execute('kernel.member.add', { email: owner.email, role: 'viewer' }, { actor: asMember, orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    expect((await roles(orgId))[member.userId]).toBeUndefined();
  });

  it('applies a demotion on the next request: a demoted admin can no longer add members', async () => {
    const { owner, admin: adminA, other } = await signInAll('owner', 'admin', 'other');
    const { slug } = await orgWith(owner, [[adminA, 'admin']]);
    const adminToken = await tokenFor(adminA, { mfa: true });
    expect((await rpc('org/get', adminToken, undefined, slug)).body?.role).toBe('admin');
    expect((await changeRole(owner, slug, adminA, 'viewer')).status).toBe(200);
    expect((await rpc('org/get', adminToken, undefined, slug)).body?.role).toBe('viewer');
    expect(await rpc('org/addMember', adminToken, { email: other.email, role: 'member' }, slug)).toMatchObject({ status: 403 });
  });

  it('validates role values and ids', async () => {
    const { owner, member } = await signInAll('owner', 'member');
    const { slug, orgId } = await orgWith(owner, [[member, 'member']]);
    for (const role of ['superuser', 'OWNER', '', 'finance.chief_accountant']) {
      expect(await changeRole(owner, slug, member, role)).toMatchObject({ status: 400 });
    }
    expect(await rpc('org/removeMember', await tokenFor(owner, { mfa: true }), { userId: 'not-a-uuid', idempotencyKey: randomUUID() }, slug)).toMatchObject({
      status: 400,
    });
    const asOwner = { type: 'user' as const, userId: owner.userId, aal: 'aal2' as const, sessionId: owner.session, mfaAt: Math.floor(Date.now() / 1000) };
    await expect(runtime.execute('kernel.member.change_role', { userId: member.userId, role: 'root' }, { actor: asOwner, orgId })).rejects.toMatchObject({
      code: 'VALIDATION',
      status: 422,
    });
    expect((await roles(orgId))[member.userId]).toBe('member');
  });
});
