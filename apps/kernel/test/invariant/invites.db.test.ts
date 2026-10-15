// Invariant suite (Decision 7): pending member invites with consent (issue #35, plan §7.3). Nobody becomes a member
// of an org before they accept an invite sent to their own account email; only owners and admins invite; expired,
// revoked, declined and used invites are refused; replays and races leave one membership at most; every decision
// is audited. Through the HTTP API, against a real PostgreSQL 17. Keep this file self-contained: import package code
// under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// creates and drops its own database.
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
const SECRET = 'test-only-jwt-secret-for-invites-0123456789';
const ISSUER = 'crove-auth';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

type Role = 'owner' | 'admin' | 'member' | 'viewer';

suite('member invites with consent on PostgreSQL (issue #35)', () => {
  const dbName = `crove_test_invites_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createHttpApp>;

  const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@invites.test`, session: randomUUID(), userId: '' });

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
  async function tokenFor(who: Account, options: { mfa?: boolean; email?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: options.email ?? who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
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
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

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

  // An org owned by `owner`, with the other accounts joined through invites in the given roles.
  async function orgWith(owner: Account, members: Array<[Account, Exclude<Role, 'owner'>]> = []) {
    const created = await rpc('org/create', await tokenFor(owner), { name: `Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    const slug = String(created.body?.slug);
    const orgId = String(created.body?.orgId);
    for (const [who, role] of members) {
      const sent = await invite(owner, slug, who.email, role);
      expect(sent.status).toBe(200);
      expect((await accept(who, orgId, sent.body.inviteId)).status).toBe(200);
    }
    return { slug, orgId };
  }

  const invite = async (actor: Account, slug: string, email: string, role: string, idempotencyKey = randomUUID()) =>
    rpc('org/invite', await tokenFor(actor, { mfa: true }), { email, role, idempotencyKey }, slug);
  const revoke = async (actor: Account, slug: string, inviteId: string, idempotencyKey = randomUUID()) =>
    rpc('org/revokeInvite', await tokenFor(actor, { mfa: true }), { inviteId, idempotencyKey }, slug);
  const accept = async (who: Account, orgId: string, inviteId: string, idempotencyKey = randomUUID()) =>
    rpc('invites/accept', await tokenFor(who), { orgId, inviteId, idempotencyKey }, null);
  const decline = async (who: Account, orgId: string, inviteId: string) => rpc('invites/decline', await tokenFor(who), { orgId, inviteId }, null);
  const mine = async (who: Account) => rpc('invites/mine', await tokenFor(who), undefined, null);

  async function roles(orgId: string): Promise<Record<string, Role>> {
    return admin(async (c) => {
      const { rows } = await c.query<{ user_id: string; role: Role }>('SELECT user_id, role FROM crove_kernel.tenant_member WHERE org_id = $1', [orgId]);
      return Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
    });
  }

  async function inviteRow(orgId: string, inviteId: string) {
    return admin(async (c) => {
      const { rows } = await c.query(
        'SELECT email, role, accepted_by, declined_by, revoked_by, accepted_at IS NOT NULL AS accepted, declined_at IS NOT NULL AS declined, revoked_at IS NOT NULL AS revoked FROM crove_kernel.member_invite WHERE org_id = $1 AND id = $2',
        [orgId, inviteId],
      );
      return rows[0];
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

  // Waits until `count` backends of this database wait on a lock.
  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 100; i++) {
      const waiting = await admin(async (c) => {
        const { rows } = await c.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'", [dbName]);
        return Number(rows[0]?.n ?? 0);
      });
      if (waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the racing commands never waited on the lock');
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
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

  it('creates no membership until the invitee accepts, and then exactly the invited role, audited in the org', async () => {
    const { owner, invitee } = await signInAll('owner', 'invitee');
    const { slug, orgId } = await orgWith(owner);
    const sent = await invite(owner, slug, invitee.email, 'member');
    expect(sent).toMatchObject({ status: 200, body: { email: invitee.email, role: 'member' } });

    // Invited, not a member: the org is not theirs and every org-scoped request is refused.
    const token = await tokenFor(invitee);
    expect((await roles(orgId))[invitee.userId]).toBeUndefined();
    expect((await rpc('me/get', token, undefined, null)).body?.orgs).toEqual([]);
    expect(await rpc('org/get', token, undefined, slug)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await rpc('inbox/list', token, {}, slug)).toMatchObject({ status: 403 });

    // The invitee sees only what they need to decide.
    const listed = await mine(invitee);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(Object.keys(listed.body[0]).sort()).toEqual(['createdAt', 'expiresAt', 'inviteId', 'invitedBy', 'orgId', 'orgName', 'role']);
    expect(listed.body[0]).toMatchObject({ orgId, inviteId: sent.body.inviteId, role: 'member', invitedBy: owner.email });

    const accepted = await accept(invitee, orgId, sent.body.inviteId);
    expect(accepted).toMatchObject({ status: 200, body: { orgId, slug, role: 'member' } });
    expect((await roles(orgId))[invitee.userId]).toBe('member');
    expect(await rpc('org/get', token, undefined, slug)).toMatchObject({ status: 200, body: { role: 'member' } });
    expect(await inviteRow(orgId, sent.body.inviteId)).toMatchObject({ accepted: true, accepted_by: invitee.userId });
    expect((await mine(invitee)).body).toEqual([]);

    expect(await audit(orgId, 'kernel.member.invite')).toEqual([
      expect.objectContaining({ actor_id: owner.userId, outcome: 'ok', detail: expect.objectContaining({ invite_id: sent.body.inviteId, role: 'member' }) }),
    ]);
    expect(await audit(orgId, 'kernel.member.invite_accept')).toEqual([
      expect.objectContaining({ actor_id: invitee.userId, outcome: 'ok', target_id: sent.body.inviteId, detail: expect.objectContaining({ role: 'member', invited_by: owner.userId }) }),
    ]);
  });

  it('lets only owners and admins invite, admins only members and viewers, nobody an owner, and needs a fresh second factor', async () => {
    const { owner, admin: adminA, member, viewer, outsider, target } = await signInAll('owner', 'admin', 'member', 'viewer', 'outsider', 'target');
    const { slug, orgId } = await orgWith(owner, [
      [adminA, 'admin'],
      [member, 'member'],
      [viewer, 'viewer'],
    ]);
    await orgWith(outsider);
    for (const actor of [member, viewer]) {
      expect(await invite(actor, slug, target.email, 'viewer')).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    }
    expect(await invite(outsider, slug, target.email, 'viewer')).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await invite(adminA, slug, target.email, 'admin')).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    for (const role of ['owner', 'OWNER', 'root', '']) {
      expect(await invite(owner, slug, target.email, role)).toMatchObject({ status: 400 });
    }
    expect(await rpc('org/invite', await tokenFor(owner), { email: target.email, role: 'member', idempotencyKey: randomUUID() }, slug)).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect((await mine(target)).body).toEqual([]);
    const denied = await audit(orgId, 'kernel.member.invite');
    expect(denied.filter((r) => r.outcome === 'denied').length).toBeGreaterThanOrEqual(4);
    expect(denied.filter((r) => r.outcome === 'ok')).toHaveLength(3);

    // An admin invites members and viewers.
    expect(await invite(adminA, slug, target.email, 'viewer')).toMatchObject({ status: 200 });
  });

  it('refuses an accept by anyone but the invited address, without revealing the invite', async () => {
    const { owner, invitee, other } = await signInAll('owner', 'invitee', 'other');
    const { slug, orgId } = await orgWith(owner);
    const sent = await invite(owner, slug, invitee.email, 'admin');
    const inviteId = String(sent.body.inviteId);

    // Another account, a guessed invite id, and the right id under another org all look the same: not found.
    expect(await accept(other, orgId, inviteId)).toMatchObject({ status: 404, body: { code: 'INVITE_NOT_FOUND' } });
    expect(await accept(other, orgId, randomUUID())).toMatchObject({ status: 404, body: { code: 'INVITE_NOT_FOUND' } });
    expect(await decline(other, orgId, inviteId)).toMatchObject({ status: 404, body: { code: 'INVITE_NOT_FOUND' } });
    expect((await mine(other)).body).toEqual([]);
    // The inviter, a member of the org, cannot accept on the invitee's behalf either.
    expect(await accept(owner, orgId, inviteId)).toMatchObject({ status: 404, body: { code: 'INVITE_NOT_FOUND' } });
    // A client cannot name the address: the accept input has no email, and an extra field is not honored.
    expect(
      await rpc('invites/accept', await tokenFor(other), { orgId, inviteId, idempotencyKey: randomUUID(), email: invitee.email }, null),
    ).toMatchObject({ status: 404 });

    expect((await roles(orgId))[other.userId]).toBeUndefined();
    expect(await inviteRow(orgId, inviteId)).toMatchObject({ accepted: false, declined: false, revoked: false });
    // Refusals before membership are not written into the org's audit trail (plan §4.4 step 3).
    expect(await audit(orgId, 'kernel.member.invite_accept')).toEqual([]);

    // The invitee still can.
    expect(await accept(invitee, orgId, inviteId)).toMatchObject({ status: 200, body: { role: 'admin' } });
  });

  it('matches the account email as the verified token sets it, never a stale or client value', async () => {
    const { owner, invitee } = await signInAll('owner', 'invitee');
    const { slug, orgId } = await orgWith(owner);
    const sent = await invite(owner, slug, `  ${invitee.email.toUpperCase()} `, 'member');
    expect(sent).toMatchObject({ status: 200, body: { email: invitee.email } });
    // The invitee's account moves to another address (a new verified token): the invite no longer matches.
    const moved = `moved-${randomUUID().slice(0, 8)}@invites.test`;
    expect((await rpc('me/get', await tokenFor(invitee, { email: moved }), undefined, null)).status).toBe(200);
    expect((await rpc('invites/mine', await tokenFor(invitee, { email: moved }), undefined, null)).body).toEqual([]);
    expect(await rpc('invites/accept', await tokenFor(invitee, { email: moved }), { orgId, inviteId: sent.body.inviteId, idempotencyKey: randomUUID() }, null)).toMatchObject({
      status: 404,
    });
    expect((await roles(orgId))[invitee.userId]).toBeUndefined();
  });

  it('refuses expired, revoked, declined and already used invites', async () => {
    const { owner, a, b, c, d } = await signInAll('owner', 'a', 'b', 'c', 'd');
    const { slug, orgId } = await orgWith(owner);

    // Expired: an invite whose expiry has passed (written by the database owner).
    const expiredId = await admin(async (cl) => {
      const { rows } = await cl.query<{ id: string }>(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, created_at, expires_at)
         VALUES ($1, $2, 'member', $3, now() - interval '8 days', now() - interval '1 day') RETURNING id`,
        [orgId, a.email, owner.userId],
      );
      return rows[0]!.id;
    });
    expect((await mine(a)).body).toEqual([]);
    expect(await accept(a, orgId, expiredId)).toMatchObject({ status: 409, body: { code: 'INVITE_EXPIRED' } });
    expect(await decline(a, orgId, expiredId)).toMatchObject({ status: 409, body: { code: 'INVITE_EXPIRED' } });

    // Revoked.
    const toRevoke = await invite(owner, slug, b.email, 'member');
    expect(await revoke(owner, slug, toRevoke.body.inviteId)).toMatchObject({ status: 200 });
    expect((await mine(b)).body).toEqual([]);
    expect(await accept(b, orgId, toRevoke.body.inviteId)).toMatchObject({ status: 409, body: { code: 'INVITE_REVOKED' } });
    expect(await revoke(owner, slug, toRevoke.body.inviteId)).toMatchObject({ status: 409, body: { code: 'INVITE_CLOSED' } });
    expect(await audit(orgId, 'kernel.member.invite_revoke')).toEqual([
      expect.objectContaining({ actor_id: owner.userId, outcome: 'ok', target_id: toRevoke.body.inviteId }),
      expect.objectContaining({ actor_id: owner.userId, outcome: 'failed', detail: expect.objectContaining({ code: 'INVITE_CLOSED' }) }),
    ]);

    // Declined: audited in the org by the invitee, and final.
    const toDecline = await invite(owner, slug, c.email, 'viewer');
    expect(await decline(c, orgId, toDecline.body.inviteId)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await decline(c, orgId, toDecline.body.inviteId)).toMatchObject({ status: 200 });
    expect(await accept(c, orgId, toDecline.body.inviteId)).toMatchObject({ status: 409, body: { code: 'INVITE_CLOSED' } });
    expect(await revoke(owner, slug, toDecline.body.inviteId)).toMatchObject({ status: 409, body: { code: 'INVITE_CLOSED' } });
    expect(await audit(orgId, 'kernel.member.invite_decline')).toEqual([
      expect.objectContaining({ actor_id: c.userId, outcome: 'ok', target_id: toDecline.body.inviteId }),
    ]);

    // Used: a second accept with a new key, by the same person, finds the invite closed.
    const used = await invite(owner, slug, d.email, 'member');
    expect((await accept(d, orgId, used.body.inviteId)).status).toBe(200);
    expect(await accept(d, orgId, used.body.inviteId)).toMatchObject({ status: 409, body: { code: 'INVITE_CLOSED' } });

    const after = await roles(orgId);
    expect([a, b, c].map((p) => after[p.userId])).toEqual([undefined, undefined, undefined]);
    expect(after[d.userId]).toBe('member');
  });

  it('replays an accept with the same idempotency key and never creates a second membership', async () => {
    const { owner, invitee } = await signInAll('owner', 'invitee');
    const { slug, orgId } = await orgWith(owner);
    const sent = await invite(owner, slug, invitee.email, 'viewer');
    const key = randomUUID();
    const first = await accept(invitee, orgId, sent.body.inviteId, key);
    expect(first.status).toBe(200);
    expect(await accept(invitee, orgId, sent.body.inviteId, key)).toEqual(first);
    // The same key for another request is refused.
    expect(await accept(invitee, orgId, randomUUID(), key)).toMatchObject({ status: 422, body: { code: 'IDEMPOTENCY_MISMATCH' } });
    // One accept, plus the refused reuse of its key (the user is a member by then, so it is audited in the org).
    expect((await audit(orgId, 'kernel.member.invite_accept')).map((r) => [r.actor_id, r.outcome, r.detail.code ?? null])).toEqual([
      [invitee.userId, 'ok', null],
      [invitee.userId, 'failed', 'IDEMPOTENCY_MISMATCH'],
    ]);
    expect(Object.values(await roles(orgId)).sort()).toEqual(['owner', 'viewer']);
  });

  it('serializes two accepts, and an accept against a revoke, on the invite row', async () => {
    for (const race of ['accept', 'revoke'] as const) {
      const { owner, invitee } = await signInAll('owner', 'invitee');
      const { slug, orgId } = await orgWith(owner);
      const sent = await invite(owner, slug, invitee.email, 'member');
      const inviteId = String(sent.body.inviteId);
      // Hold the invite row so both requests queue on it, then let them go.
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM crove_kernel.member_invite WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, inviteId]);
      const first = accept(invitee, orgId, inviteId);
      await waitForLockWaiters(1);
      const second = race === 'accept' ? accept(invitee, orgId, inviteId) : revoke(owner, slug, inviteId);
      await waitForLockWaiters(2);
      await holder.query('COMMIT');
      await holder.end();
      const results = await Promise.all([first, second]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);
      const row = await inviteRow(orgId, inviteId);
      const member = (await roles(orgId))[invitee.userId];
      // Exactly one outcome: a member with an accepted invite, or no member with a revoked one.
      if (row.accepted) {
        expect(member).toBe('member');
        expect(row.revoked).toBe(false);
      } else {
        expect(race).toBe('revoke');
        expect(row.revoked).toBe(true);
        expect(member).toBeUndefined();
      }
      expect((await audit(orgId, 'kernel.member.invite_accept')).filter((r) => r.outcome === 'ok')).toHaveLength(row.accepted ? 1 : 0);
    }
  });

  it('keeps invites inside their org: other orgs cannot list, revoke or use them', async () => {
    const { ownerA, ownerB, invitee } = await signInAll('ownerA', 'ownerB', 'invitee');
    const orgA = await orgWith(ownerA);
    const orgB = await orgWith(ownerB);
    const sent = await invite(ownerA, orgA.slug, invitee.email, 'member');
    const inviteId = String(sent.body.inviteId);
    expect((await rpc('org/invites', await tokenFor(ownerB), undefined, orgB.slug)).body).toEqual([]);
    expect(await revoke(ownerB, orgB.slug, inviteId)).toMatchObject({ status: 404, body: { code: 'INVITE_NOT_FOUND' } });
    expect(await revoke(ownerB, orgA.slug, inviteId)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    // The invite under another org's id is not found, and joins nothing.
    expect(await accept(invitee, orgB.orgId, inviteId)).toMatchObject({ status: 404, body: { code: 'INVITE_NOT_FOUND' } });
    expect((await roles(orgB.orgId))[invitee.userId]).toBeUndefined();
    expect(await inviteRow(orgA.orgId, inviteId)).toMatchObject({ revoked: false, accepted: false });
    // Members and viewers of the inviting org do not see its invites (the list carries addresses).
    const { member } = await signInAll('member');
    const joined = await invite(ownerA, orgA.slug, member.email, 'member');
    expect((await accept(member, orgA.orgId, joined.body.inviteId)).status).toBe(200);
    expect(await rpc('org/invites', await tokenFor(member), undefined, orgA.slug)).toMatchObject({ status: 403 });
  });

  it("refuses an invite whose inviter lost the authority to send it (removed or demoted)", async () => {
    const { owner, coOwner, adminA, a, b, c } = await signInAll('owner', 'coOwner', 'adminA', 'a', 'b', 'c');
    const { slug, orgId } = await orgWith(owner, [
      [coOwner, 'admin'],
      [adminA, 'admin'],
    ]);
    const promote = await rpc('org/changeMemberRole', await tokenFor(owner, { mfa: true }), { userId: coOwner.userId, role: 'owner', idempotencyKey: randomUUID() }, slug);
    expect(promote.status).toBe(200);
    const fromAdmin = await invite(adminA, slug, a.email, 'member');
    const adminInvite = await invite(coOwner, slug, b.email, 'admin');
    const memberInvite = await invite(coOwner, slug, c.email, 'member');
    // The admin is removed, and the co-owner is demoted to admin.
    expect((await rpc('org/removeMember', await tokenFor(owner, { mfa: true }), { userId: adminA.userId, idempotencyKey: randomUUID() }, slug)).status).toBe(200);
    expect((await rpc('org/changeMemberRole', await tokenFor(owner, { mfa: true }), { userId: coOwner.userId, role: 'admin', idempotencyKey: randomUUID() }, slug)).status).toBe(200);
    expect((await mine(a)).body).toEqual([]);
    expect(await accept(a, orgId, fromAdmin.body.inviteId)).toMatchObject({ status: 409, body: { code: 'INVITE_STALE' } });
    // An admin may not grant admin, so the demoted co-owner's admin invite is stale too; their member invite holds.
    expect((await mine(b)).body).toEqual([]);
    expect(await accept(b, orgId, adminInvite.body.inviteId)).toMatchObject({ status: 409, body: { code: 'INVITE_STALE' } });
    expect(await accept(c, orgId, memberInvite.body.inviteId)).toMatchObject({ status: 200, body: { role: 'member' } });
    const after = await roles(orgId);
    expect([after[a.userId], after[b.userId], after[c.userId]]).toEqual([undefined, undefined, 'member']);
  });

  it('refuses inviting or joining someone who is already a member', async () => {
    const { owner, member, late } = await signInAll('owner', 'member', 'late');
    const { slug, orgId } = await orgWith(owner, [[member, 'member']]);
    expect(await invite(owner, slug, member.email, 'admin')).toMatchObject({ status: 409, body: { code: 'ALREADY_MEMBER' } });
    // An invite that was open when the person joined some other way cannot be used to change their role.
    const sent = await invite(owner, slug, late.email, 'admin');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, late.userId]));
    expect((await mine(late)).body).toEqual([]);
    expect(await accept(late, orgId, sent.body.inviteId)).toMatchObject({ status: 409, body: { code: 'ALREADY_MEMBER' } });
    expect((await roles(orgId))[late.userId]).toBe('viewer');
  });

  it('closes the definers and the table to every path but the commands (EXECUTE and privilege matrix, audit at commit)', async () => {
    const functions = [
      'crove_kernel.member_invite_accept(uuid,uuid,uuid,text)',
      'crove_kernel.member_invite_decline(uuid,uuid,uuid)',
      'crove_kernel.my_invites(uuid)',
      'crove_kernel.member_invite_lock(uuid,uuid,uuid)',
      'crove_kernel.member_invite_assert_pending(crove_kernel.member_invite)',
      'crove_kernel.member_invite_inviter_ok(uuid,uuid,text)',
      'crove_kernel.member_invite_guard()',
      'crove_kernel.member_invite_requires_audit()',
    ];
    const roleNames = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];
    const matrix = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [functions, roleNames],
      );
      return Object.fromEntries(functions.map((f) => [f, roleNames.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))]));
    });
    expect(matrix).toEqual({
      'crove_kernel.member_invite_accept(uuid,uuid,uuid,text)': ['crove_app'],
      'crove_kernel.member_invite_decline(uuid,uuid,uuid)': ['crove_app'],
      'crove_kernel.my_invites(uuid)': ['crove_app'],
      'crove_kernel.member_invite_lock(uuid,uuid,uuid)': [],
      'crove_kernel.member_invite_assert_pending(crove_kernel.member_invite)': [],
      'crove_kernel.member_invite_inviter_ok(uuid,uuid,text)': [],
      'crove_kernel.member_invite_guard()': [],
      'crove_kernel.member_invite_requires_audit()': [],
    });
    const privileges = await admin(async (c) => {
      const { rows } = await c.query<{ op: string; can: boolean }>(
        `SELECT p AS op, has_table_privilege('crove_tenant', 'crove_kernel.member_invite', p) AS can FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p`,
      );
      const { rows: cols } = await c.query<{ col: string }>(
        `SELECT attname::text AS col FROM pg_attribute WHERE attrelid = 'crove_kernel.member_invite'::regclass AND attnum > 0 AND NOT attisdropped
           AND has_column_privilege('crove_tenant', 'crove_kernel.member_invite', attname, 'UPDATE') ORDER BY attnum`,
      );
      return { table: rows.filter((r) => r.can).map((r) => r.op), updatable: cols.map((r) => r.col) };
    });
    expect(privileges).toEqual({ table: ['SELECT', 'INSERT'], updatable: ['revoked_at', 'revoked_by'] });

    // The API login role calling the accept definer outside execute() cannot commit: there is no audit row.
    const { owner, invitee } = await signInAll('owner', 'invitee');
    const { slug, orgId } = await orgWith(owner);
    const sent = await invite(owner, slug, invitee.email, 'member');
    const direct = new pg.Client({ connectionString: appUrl });
    await direct.connect();
    try {
      await direct.query('BEGIN');
      await direct.query('SELECT crove_kernel.member_invite_accept($1, $2, $3, NULL)', [invitee.userId, orgId, sent.body.inviteId]);
      await expect(direct.query('COMMIT')).rejects.toThrow(/MEMBER_INVITE_UNAUDITED/);
    } finally {
      await direct.end();
    }
    expect((await roles(orgId))[invitee.userId]).toBeUndefined();
    // Nor can the database owner accept, decline or revoke an invite by hand, or rewrite or reopen one.
    await admin(async (c) => {
      await expect(
        c.query('UPDATE crove_kernel.member_invite SET accepted_at = now(), accepted_by = $3 WHERE org_id = $1 AND id = $2', [orgId, sent.body.inviteId, invitee.userId]),
      ).rejects.toThrow(/MEMBER_INVITE_UNAUDITED/);
      await expect(c.query("UPDATE crove_kernel.member_invite SET role = 'admin' WHERE org_id = $1 AND id = $2", [orgId, sent.body.inviteId])).rejects.toThrow(
        /MEMBER_INVITE_IMMUTABLE/,
      );
      await expect(
        c.query(`UPDATE crove_kernel.member_invite SET expires_at = now() + interval '1 year' WHERE org_id = $1 AND id = $2`, [orgId, sent.body.inviteId]),
      ).rejects.toThrow(/MEMBER_INVITE_IMMUTABLE/);
    });
    // In the org, a member's code path cannot accept for someone: crove_tenant may not set accepted_at.
    const asApp = new pg.Client({ connectionString: appUrl });
    await asApp.connect();
    try {
      await asApp.query('BEGIN');
      await asApp.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, orgId]);
      await expect(
        asApp.query('UPDATE crove_kernel.member_invite SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [sent.body.inviteId, invitee.userId]),
      ).rejects.toThrow(/permission denied/);
      await asApp.query('ROLLBACK');
    } finally {
      await asApp.end();
    }
    expect(await accept(invitee, orgId, sent.body.inviteId)).toMatchObject({ status: 200 });
  });
});
