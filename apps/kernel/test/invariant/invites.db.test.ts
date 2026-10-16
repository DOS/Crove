// Security properties of member invites (issue #35, plan §7.3 item 2, follow-ups #134): an invite adds nobody until
// the invitee accepts; it reveals nothing about accounts, is bound to the invited email (confirmed in Supabase Auth
// on self-host), single-use, revocable and expires; it dies with its inviter's right to issue it; an admin never
// undoes an owner's invite; an accepted invite commits only with its audit row. Against a real PostgreSQL 17.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). The flows
// (what the inviter sees, lists, the HTTP API) are in test/invites.db.test.ts. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run creates and drops its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Database, type Db } from '@crove/db';
import { applyAuthGrants, migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, previewInvite, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { createSessionStatusSource } from '../../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

type InviteRole = 'admin' | 'member' | 'viewer';
interface Created {
  inviteId: string;
  email: string;
  role: InviteRole;
  expiresAt: string;
  acceptPath: string;
}

suite('member invites with consent on PostgreSQL (issue #35)', () => {
  const dbName = `crove_test_invites_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  // R3 (inviting, role changes) needs aal2 with a second factor in the last 5 minutes (policy P11).
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

  async function person(name: string, email = `${name}-${randomUUID().slice(0, 8)}@invites.test`) {
    const id = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: null });
    return { id, email };
  }

  async function orgOf(owner: { id: string }) {
    return (await createOrg(runtime, asUser(owner.id), `Org ${randomUUID().slice(0, 6)}`)).orgId;
  }

  const invite = (orgId: string, inviter: string, email: string, role: InviteRole = 'member') =>
    runtime.execute<Created>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
  const tokenOf = (created: Created) => created.acceptPath.slice(created.acceptPath.indexOf('#') + 1);
  const accept = (token: string, userId: string) => runtime.executeOrgless<{ orgId: string; role: string }>('kernel.member.invite.accept', { token }, { actor: asUser(userId) });

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers the same whether or not the email has an account, adds nobody, and stores no token', async () => {
    const owner = await person('owner');
    const known = await person('known');
    const orgId = await orgOf(owner);
    const toKnown = await invite(orgId, owner.id, known.email);
    const toNobody = await invite(orgId, owner.id, `nobody-${randomUUID().slice(0, 8)}@invites.test`);
    for (const created of [toKnown, toNobody]) {
      expect(Object.keys(created).sort()).toEqual(['acceptPath', 'email', 'expiresAt', 'inviteId', 'role']);
      expect(created.acceptPath).toMatch(/^\/-\/invite#[A-Za-z0-9_-]{43}$/);
    }
    expect(JSON.stringify(toKnown)).not.toContain(known.id);
    // There is no command that adds a member directly, and no definer that looks a user up by email.
    await expect(runtime.execute('kernel.member.add', { email: known.email, role: 'member' }, { actor: asMfa(owner.id), orgId })).rejects.toMatchObject({
      code: 'COMMAND_NOT_FOUND',
    });
    await admin(async (c) => {
      const { rows } = await c.query(`SELECT pg_catalog.to_regprocedure('crove_kernel.user_id_by_email(text)') AS fn`);
      expect(rows).toEqual([{ fn: null }]);
    });
    // Nobody joined: the invitee is not a member until they accept.
    expect(await memberships(known.id)).toEqual([]);
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(known.id), orgId })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });

    // Only the token's SHA-256 is stored; the token appears in no table.
    const token = tokenOf(toKnown);
    await admin(async (c) => {
      const { rows } = await c.query('SELECT token_sha256 FROM crove_kernel.member_invite WHERE id = $1', [toKnown.inviteId]);
      expect(rows).toEqual([{ token_sha256: createHash('sha256').update(token).digest('hex') }]);
      for (const table of ['member_invite', 'audit_event', 'activity', 'outbox_event', 'idempotency_key']) {
        const found = await c.query(`SELECT 1 FROM crove_kernel.${table} t WHERE t::text LIKE '%' || $1 || '%'`, [token]);
        expect(found.rowCount, `${table} holds the raw token`).toBe(0);
      }
      // The audit row of the invite records the invite, not the email's account.
      const audit = await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member.invite.create' AND outcome = 'ok'`, [orgId]);
      expect(JSON.stringify(audit.rows)).not.toContain(known.id);
    });
  });

  it('lets only the invited email accept, case-insensitively, and never a disabled account', async () => {
    const owner = await person('owner');
    const invitee = await person('invitee', `mixed-${randomUUID().slice(0, 8)}@invites.test`);
    const stranger = await person('stranger');
    const orgId = await orgOf(owner);
    const created = await invite(orgId, owner.id, invitee.email.toUpperCase(), 'viewer');
    expect(created.email).toBe(invitee.email);
    const token = tokenOf(created);

    // Another signed-in user holding the link: refused, before learning anything about the invite's state.
    await expect(accept(token, stranger.id)).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH', status: 403 });
    await expect(runtime.forUser(asUser(stranger.id), (trx) => previewInvite(trx, stranger.id, token, { upstream: false }))).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH' });
    // The invitee sees what they consent to.
    await expect(runtime.forUser(asUser(invitee.id), (trx) => previewInvite(trx, invitee.id, token, { upstream: false }))).resolves.toMatchObject({ role: 'viewer', invitedBy: owner.email });
    // The org owner cannot accept on the invitee's behalf either.
    await expect(accept(token, owner.id)).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH' });
    expect(await memberships(stranger.id)).toEqual([]);

    // A disabled account is refused even with the right email.
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [invitee.id]));
    await expect(accept(token, invitee.id)).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH' });
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [invitee.id]));

    await expect(accept(token, invitee.id)).resolves.toMatchObject({ orgId, role: 'viewer' });
    expect(await memberships(invitee.id)).toEqual([{ org_id: orgId, role: 'viewer' }]);
    // Malformed and unknown tokens look the same.
    await expect(accept(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, invitee.id)).rejects.toMatchObject({ code: 'INVITE_NOT_FOUND', status: 404 });
    await expect(accept('not-a-token', invitee.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('is single-use, and revoked, replaced or expired invites never grant membership', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);

    const once = await person('once');
    const token = tokenOf(await invite(orgId, owner.id, once.email));
    await accept(token, once.id);
    await expect(accept(token, once.id)).rejects.toMatchObject({ code: 'INVITE_USED', status: 409 });

    const revoked = await person('revoked');
    const toRevoke = await invite(orgId, owner.id, revoked.email);
    await runtime.execute('kernel.member.invite.revoke', { inviteId: toRevoke.inviteId }, { actor: asUser(owner.id), orgId });
    await expect(accept(tokenOf(toRevoke), revoked.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    // A revoked invite stays revoked.
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: toRevoke.inviteId }, { actor: asUser(owner.id), orgId })).rejects.toMatchObject({
      code: 'INVITE_NOT_PENDING',
    });

    // A new invite for the same email replaces the pending one: the old link stops working.
    const replaced = await person('replaced');
    const first = await invite(orgId, owner.id, replaced.email, 'viewer');
    const second = await invite(orgId, owner.id, replaced.email, 'member');
    await expect(accept(tokenOf(first), replaced.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    await expect(accept(tokenOf(second), replaced.id)).resolves.toMatchObject({ role: 'member' });

    // Created eight days ago: expired after seven.
    const late = await person('late');
    vi.useFakeTimers({ toFake: ['Date'] });
    let expired: Created;
    try {
      vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60 * 1000);
      expired = await invite(orgId, owner.id, late.email);
    } finally {
      vi.useRealTimers();
    }
    expect(new Date(expired.expiresAt).getTime()).toBeLessThan(Date.now());
    await expect(accept(tokenOf(expired), late.id)).rejects.toMatchObject({ code: 'INVITE_EXPIRED' });

    for (const who of [revoked, late]) expect(await memberships(who.id)).toEqual([]);
    expect(await memberships(replaced.id)).toEqual([{ org_id: orgId, role: 'member' }]);
  });

  it('needs an owner or admin with fresh MFA to invite, and only an owner may invite an admin', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const [adminP, memberP, viewerP] = [await person('admin'), await person('member'), await person('viewer')];
    for (const [who, role] of [
      [adminP, 'admin'],
      [memberP, 'member'],
      [viewerP, 'viewer'],
    ] as const) {
      await accept(tokenOf(await invite(orgId, owner.id, who.email, role)), who.id);
    }
    const target = `target-${randomUUID().slice(0, 8)}@invites.test`;
    for (const who of [memberP, viewerP]) {
      await expect(invite(orgId, who.id, target)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    await expect(invite(orgId, adminP.id, target, 'admin')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(runtime.execute('kernel.member.invite.create', { email: target, role: 'member' }, { actor: asUser(owner.id), orgId })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(runtime.execute('kernel.member.invite.create', { email: target, role: 'owner' }, { actor: asMfa(owner.id), orgId })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    // Members and viewers cannot see or revoke invites either.
    const pending = await invite(orgId, adminP.id, target, 'member');
    await expect(runtime.query('kernel.member.invites.list', {}, { actor: asUser(memberP.id), orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: pending.inviteId }, { actor: asUser(viewerP.id), orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const denied = await admin(
      async (c) =>
        (await c.query(`SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member.invite.create' AND outcome = 'denied'`, [orgId]))
          .rows,
    );
    expect(denied.map((r) => r.detail.code).sort()).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'STEP_UP_REQUIRED']);
  });

  async function inviteStatus(id: string) {
    return admin(async (c) => (await c.query<{ status: string; revoked_by: string | null }>('SELECT status, revoked_by FROM crove_kernel.member_invite WHERE id = $1', [id])).rows[0]);
  }
  async function lastAudit(orgId: string, command: string) {
    return admin(
      async (c) =>
        (await c.query<{ outcome: string; detail: Record<string, unknown> }>(
          'SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id DESC LIMIT 1',
          [orgId, command],
        )).rows[0],
    );
  }

  it('stops an invite when its inviter is removed or loses the right to grant its role, and revokes it right then', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const [inviterAdmin, coOwner] = [await person('admin'), await person('co-owner')];
    await accept(tokenOf(await invite(orgId, owner.id, inviterAdmin.email, 'admin')), inviterAdmin.id);
    await accept(tokenOf(await invite(orgId, owner.id, coOwner.email, 'admin')), coOwner.id);
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'owner' }, { actor: asMfa(owner.id), orgId });

    // An admin demoted to member loses every pending invite, in the same transaction as the demotion (#134).
    const [a, a2] = [await person('a'), await person('a2')];
    const byAdmin = await invite(orgId, inviterAdmin.id, a.email, 'member');
    const byAdminViewer = await invite(orgId, inviterAdmin.id, a2.email, 'viewer');
    await runtime.execute('kernel.member.change_role', { userId: inviterAdmin.id, role: 'member' }, { actor: asMfa(owner.id), orgId });
    for (const id of [byAdmin.inviteId, byAdminViewer.inviteId]) expect(await inviteStatus(id)).toEqual({ status: 'revoked', revoked_by: owner.id });
    expect((await lastAudit(orgId, 'kernel.member.change_role'))?.detail).toMatchObject({
      target_user: inviterAdmin.id,
      role: 'member',
      previous_role: 'admin',
      revoked_invites: expect.arrayContaining([byAdmin.inviteId, byAdminViewer.inviteId]),
    });
    await expect(accept(tokenOf(byAdmin), a.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    // Promoting them back does not revive the invites.
    await runtime.execute('kernel.member.change_role', { userId: inviterAdmin.id, role: 'admin' }, { actor: asMfa(owner.id), orgId });
    await expect(accept(tokenOf(byAdminViewer), a2.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });

    // A co-owner who becomes an admin loses the admin invites only (only owners grant admin); the member invite stays.
    const [b, b2] = [await person('b'), await person('b2')];
    const byCoOwner = await invite(orgId, coOwner.id, b.email, 'admin');
    const byCoOwnerMember = await invite(orgId, coOwner.id, b2.email, 'member');
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'admin' }, { actor: asMfa(owner.id), orgId });
    expect(await inviteStatus(byCoOwner.inviteId)).toEqual({ status: 'revoked', revoked_by: owner.id });
    expect(await inviteStatus(byCoOwnerMember.inviteId)).toEqual({ status: 'pending', revoked_by: null });
    expect((await lastAudit(orgId, 'kernel.member.change_role'))?.detail).toMatchObject({ revoked_invites: [byCoOwner.inviteId] });
    await expect(accept(tokenOf(byCoOwner), b.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    await expect(accept(tokenOf(byCoOwnerMember), b2.id)).resolves.toMatchObject({ orgId, role: 'member' });
    // A role change that takes nothing away revokes nothing.
    const keep = await person('keep');
    const kept = await invite(orgId, coOwner.id, keep.email, 'viewer');
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'owner' }, { actor: asMfa(owner.id), orgId });
    expect((await lastAudit(orgId, 'kernel.member.change_role'))?.detail).toMatchObject({ revoked_invites: [] });
    expect(await inviteStatus(kept.inviteId)).toEqual({ status: 'pending', revoked_by: null });
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'admin' }, { actor: asMfa(owner.id), orgId });
    expect(await inviteStatus(kept.inviteId)).toEqual({ status: 'pending', revoked_by: null });
    await runtime.execute('kernel.member.invite.revoke', { inviteId: kept.inviteId }, { actor: asUser(owner.id), orgId });

    // Any invite dies with its inviter's removal.
    const c2 = await person('c');
    const byRemoved = await invite(orgId, coOwner.id, c2.email, 'viewer');
    await runtime.execute('kernel.member.remove', { userId: coOwner.id }, { actor: asMfa(owner.id), orgId });
    await expect(accept(tokenOf(byRemoved), c2.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    // Removal also revokes the removed member's pending invites, so inviting them back does not revive them.
    const status = await admin(async (c) => (await c.query('SELECT status, revoked_by FROM crove_kernel.member_invite WHERE id = $1', [byRemoved.inviteId])).rows);
    expect(status).toEqual([{ status: 'revoked', revoked_by: owner.id }]);

    for (const who of [a, a2, b, c2]) expect(await memberships(who.id)).toEqual([]);
  });

  // Acceptance locks the inviter's membership row before the invite row, the order the member commands use, so an
  // acceptance racing its inviter's demotion never deadlocks: either the invitee joined first, or the invite is
  // revoked. Never both, never neither, never a 500.
  it('serializes an acceptance with its inviter\'s demotion, without deadlocks', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    for (let round = 0; round < 8; round++) {
      const inviter = await person(`inviter-${round}`);
      await accept(tokenOf(await invite(orgId, owner.id, inviter.email, 'admin')), inviter.id);
      const invitee = await person(`racer-${round}`);
      const created = await invite(orgId, inviter.id, invitee.email, 'member');
      const [accepted, demoted] = await Promise.allSettled([
        accept(tokenOf(created), invitee.id),
        runtime.execute('kernel.member.change_role', { userId: inviter.id, role: 'viewer' }, { actor: asMfa(owner.id), orgId }),
      ]);
      expect(demoted.status).toBe('fulfilled');
      const status = await inviteStatus(created.inviteId);
      if (accepted.status === 'fulfilled') {
        expect(status?.status).toBe('accepted');
        expect(await memberships(invitee.id)).toEqual([{ org_id: orgId, role: 'member' }]);
      } else {
        expect(accepted.reason).toMatchObject({ code: 'INVITE_REVOKED' });
        expect(status?.status).toBe('revoked');
        expect(await memberships(invitee.id)).toEqual([]);
      }
    }
  });

  it("never lets an admin's invite silently replace an owner's pending invite, nor an admin revoke one", async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const [adminP, otherAdmin] = [await person('admin'), await person('admin-2')];
    for (const who of [adminP, otherAdmin]) await accept(tokenOf(await invite(orgId, owner.id, who.email, 'admin')), who.id);

    // The owner invited someone as admin; an admin inviting the same email (as member) is refused, the owner's invite
    // stays pending and still works, and the refusal is audited with the invite it protected.
    const target = await person('target');
    const byOwner = await invite(orgId, owner.id, target.email, 'admin');
    await expect(invite(orgId, adminP.id, target.email, 'member')).rejects.toMatchObject({ code: 'INVITE_PENDING_BY_OWNER', status: 409 });
    expect(await inviteStatus(byOwner.inviteId)).toEqual({ status: 'pending', revoked_by: null });
    expect(await lastAudit(orgId, 'kernel.member.invite.create')).toMatchObject({
      outcome: 'failed',
      detail: expect.objectContaining({ code: 'INVITE_PENDING_BY_OWNER', pending_invites: [byOwner.inviteId] }),
    });
    // Nor may the admin revoke it explicitly.
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: byOwner.inviteId }, { actor: asUser(adminP.id), orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(await inviteStatus(byOwner.inviteId)).toEqual({ status: 'pending', revoked_by: null });
    await expect(accept(tokenOf(byOwner), target.id)).resolves.toMatchObject({ orgId, role: 'admin' });

    // An owner replaces any invite; an admin replaces another admin's invite, and an owner's expired one.
    const second = await person('second');
    const byOther = await invite(orgId, otherAdmin.id, second.email, 'viewer');
    const byAdmin = await invite(orgId, adminP.id, second.email, 'member');
    expect(await inviteStatus(byOther.inviteId)).toEqual({ status: 'revoked', revoked_by: adminP.id });
    const byOwner2 = await invite(orgId, owner.id, second.email, 'viewer');
    expect(await inviteStatus(byAdmin.inviteId)).toEqual({ status: 'revoked', revoked_by: owner.id });
    await expect(invite(orgId, otherAdmin.id, second.email, 'member')).rejects.toMatchObject({ code: 'INVITE_PENDING_BY_OWNER' });
    await runtime.execute('kernel.member.invite.revoke', { inviteId: byOwner2.inviteId }, { actor: asUser(owner.id), orgId });

    const third = await person('third');
    vi.useFakeTimers({ toFake: ['Date'] });
    let stale: Created;
    try {
      vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60 * 1000);
      stale = await invite(orgId, owner.id, third.email, 'viewer');
    } finally {
      vi.useRealTimers();
    }
    const fresh = await invite(orgId, adminP.id, third.email, 'member');
    expect(await inviteStatus(stale.inviteId)).toEqual({ status: 'revoked', revoked_by: adminP.id });
    await expect(accept(tokenOf(fresh), third.id)).resolves.toMatchObject({ role: 'member' });

    // An invite whose owner was demoted to admin is an admin's invite from then on.
    const fourth = await person('fourth');
    const coOwner = await person('co-owner');
    await accept(tokenOf(await invite(orgId, owner.id, coOwner.email, 'admin')), coOwner.id);
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'owner' }, { actor: asMfa(owner.id), orgId });
    const byCoOwner = await invite(orgId, coOwner.id, fourth.email, 'member');
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: byCoOwner.inviteId }, { actor: asUser(adminP.id), orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'admin' }, { actor: asMfa(owner.id), orgId });
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: byCoOwner.inviteId }, { actor: asUser(adminP.id), orgId })).resolves.toEqual({ ok: true });

    // A demoted admin can no longer revoke at all, even with a context entered before the demotion was read.
    const fifth = await person('fifth');
    const byOtherAdmin = await invite(orgId, otherAdmin.id, fifth.email, 'viewer');
    await runtime.execute('kernel.member.change_role', { userId: adminP.id, role: 'member' }, { actor: asMfa(owner.id), orgId });
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: byOtherAdmin.inviteId }, { actor: asUser(adminP.id), orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await inviteStatus(byOtherAdmin.inviteId)).toEqual({ status: 'pending', revoked_by: null });
  });

  it('keeps invites inside their org: another org can neither see, revoke nor redirect them', async () => {
    const [ownerA, ownerB, invitee] = [await person('owner-a'), await person('owner-b'), await person('invitee')];
    const [orgA, orgB] = [await orgOf(ownerA), await orgOf(ownerB)];
    const created = await invite(orgA, ownerA.id, invitee.email);

    const listedInB = await runtime.query<Array<{ id: string }>>('kernel.member.invites.list', {}, { actor: asUser(ownerB.id), orgId: orgB });
    expect(listedInB.map((i) => i.id)).not.toContain(created.inviteId);
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: created.inviteId }, { actor: asUser(ownerB.id), orgId: orgB })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // B's owner is not a member of A, so cannot act there.
    await expect(runtime.execute('kernel.member.invite.revoke', { inviteId: created.inviteId }, { actor: asUser(ownerB.id), orgId: orgA })).rejects.toMatchObject({
      code: 'NOT_A_MEMBER',
    });
    // Raw SQL as the API role in B's context reaches none of A's invites.
    const touched = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${ownerB.id}::uuid, ${orgB}::uuid)`.execute(trx);
      const seen = await sql`SELECT 1 FROM crove_kernel.member_invite WHERE id = ${created.inviteId}::uuid`.execute(trx);
      const updated = await sql`UPDATE crove_kernel.member_invite SET status = 'revoked', revoked_at = now(), revoked_by = ${ownerB.id}::uuid
                                WHERE id = ${created.inviteId}::uuid`.execute(trx);
      return seen.rows.length + Number(updated.numAffectedRows ?? 0);
    });
    expect(touched).toBe(0);

    // Accepting takes no org from the caller; the membership lands in A only.
    await expect(runtime.execute('kernel.member.invite.accept', { token: tokenOf(created) }, { actor: asUser(invitee.id), orgId: orgB })).rejects.toMatchObject({
      code: 'COMMAND_NOT_FOUND',
    });
    await expect(accept(tokenOf(created), invitee.id)).resolves.toMatchObject({ orgId: orgA });
    expect(await memberships(invitee.id)).toEqual([{ org_id: orgA, role: 'member' }]);
    // The acceptance is audited in A, by the invitee.
    const audit = await admin(
      async (c) =>
        (await c.query(`SELECT org_id, actor_id, detail FROM crove_kernel.audit_event WHERE command = 'kernel.member.invite.accept' AND actor_id = $1`, [invitee.id])).rows,
    );
    expect(audit).toEqual([{ org_id: orgA, actor_id: invitee.id, detail: expect.objectContaining({ invite_id: created.inviteId, role: 'member' }) }]);
  });

  it('lets only definers create memberships: the API role cannot insert members, nor accept, retarget or delete an invite by hand', async () => {
    const owner = await person('owner');
    const outsider = await person('outsider');
    const orgId = await orgOf(owner);
    const created = await invite(orgId, owner.id, outsider.email);
    const asApp = <T>(fn: (trx: Transaction<Database>) => Promise<T>) =>
      db.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_context(${owner.id}::uuid, ${orgId}::uuid)`.execute(trx);
        return fn(trx);
      });
    await expect(asApp((trx) => sql`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES (${orgId}::uuid, ${outsider.id}::uuid, 'member')`.execute(trx))).rejects.toThrow(
      /permission denied for table tenant_member/,
    );
    await expect(asApp((trx) => sql`UPDATE crove_kernel.tenant_member SET user_id = ${outsider.id}::uuid WHERE user_id = ${owner.id}::uuid`.execute(trx))).rejects.toThrow(
      /permission denied for table tenant_member/,
    );
    await expect(
      asApp((trx) => sql`UPDATE crove_kernel.member_invite SET accepted_at = now(), accepted_by = ${outsider.id}::uuid WHERE id = ${created.inviteId}::uuid`.execute(trx)),
    ).rejects.toThrow(/permission denied for table member_invite/);
    await expect(asApp((trx) => sql`UPDATE crove_kernel.member_invite SET status = 'accepted' WHERE id = ${created.inviteId}::uuid`.execute(trx))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(asApp((trx) => sql`UPDATE crove_kernel.member_invite SET email = 'other@invites.test' WHERE id = ${created.inviteId}::uuid`.execute(trx))).rejects.toThrow(
      /permission denied for table member_invite/,
    );
    await expect(asApp((trx) => sql`DELETE FROM crove_kernel.member_invite WHERE id = ${created.inviteId}::uuid`.execute(trx))).rejects.toThrow(
      /permission denied for table member_invite/,
    );
    expect(await memberships(outsider.id)).toEqual([]);

    // EXECUTE matrix: only the API login role accepts and previews; the helper and the triggers are nobody's.
    const functions = [
      'crove_kernel.invite_accept(uuid,text,boolean)',
      'crove_kernel.invite_peek(uuid,text,boolean)',
      'crove_kernel.invite_for_user(uuid,text,boolean,boolean)',
      'crove_kernel.auth_email_confirmed(uuid)',
      'crove_kernel.auth_email_check_ready()',
      'crove_kernel.member_invite_guard()',
      'crove_kernel.member_invite_requires_audit()',
    ];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];
    const matrix = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [functions, roles],
      );
      return Object.fromEntries(functions.map((f) => [f, roles.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))]));
    });
    expect(matrix).toEqual({
      'crove_kernel.invite_accept(uuid,text,boolean)': ['crove_app'],
      'crove_kernel.invite_peek(uuid,text,boolean)': ['crove_app'],
      'crove_kernel.invite_for_user(uuid,text,boolean,boolean)': [],
      'crove_kernel.auth_email_confirmed(uuid)': [],
      'crove_kernel.auth_email_check_ready()': [],
      'crove_kernel.member_invite_guard()': [],
      'crove_kernel.member_invite_requires_audit()': [],
    });
    // The variants without the confirmed-email flag are gone, so no caller can skip that check.
    await admin(async (c) => {
      const { rows } = await c.query(
        `SELECT pg_catalog.to_regprocedure('crove_kernel.invite_accept(uuid,text)') AS accept,
                pg_catalog.to_regprocedure('crove_kernel.invite_peek(uuid,text)') AS peek,
                pg_catalog.to_regprocedure('crove_kernel.invite_for_user(uuid,text,boolean)') AS helper`,
      );
      expect(rows).toEqual([{ accept: null, peek: null, helper: null }]);
    });
    // Table privileges on membership: no runtime role inserts, and only the role column is updatable.
    const privileges = await admin(async (c) => {
      const { rows } = await c.query(
        `SELECT r AS role,
                has_table_privilege(r, 'crove_kernel.tenant_member', 'INSERT') AS insert,
                has_table_privilege(r, 'crove_kernel.tenant_member', 'UPDATE') AS update_any,
                has_column_privilege(r, 'crove_kernel.tenant_member', 'role', 'UPDATE') AS update_role,
                has_column_privilege(r, 'crove_kernel.tenant_member', 'user_id', 'UPDATE') AS update_user,
                has_column_privilege(r, 'crove_kernel.tenant_member', 'org_id', 'UPDATE') AS update_org
         FROM unnest($1::text[]) r ORDER BY 1`,
        [roles],
      );
      return rows;
    });
    expect(privileges.filter((p) => p.insert || p.update_any || p.update_user || p.update_org)).toEqual([]);
    // Role changes (kernel.member.change_role) still update the role column.
    expect(privileges.filter((p) => ['crove_app', 'crove_tenant'].includes(p.role)).map((p) => p.update_role)).toEqual([true, true]);
  });

  it('commits an accepted invite only with its audit row, and never changes an answered invite, even for the database owner', async () => {
    const owner = await person('owner');
    const invitee = await person('invitee');
    const orgId = await orgOf(owner);
    const created = await invite(orgId, owner.id, invitee.email);
    await admin(async (c) => {
      // Calling the definer outside execute(): no audit row, so the commit is refused and nothing stays.
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.invite_accept($1::uuid, $2, false)', [invitee.id, tokenOf(created)]);
      await expect(c.query('COMMIT')).rejects.toThrow(/INVITE_ACCEPT_UNAUDITED/);
    });
    expect(await memberships(invitee.id)).toEqual([]);
    await accept(tokenOf(created), invitee.id);
    await admin(async (c) => {
      for (const change of [`status = 'pending', accepted_at = NULL, accepted_by = NULL`, `status = 'revoked', revoked_at = now(), revoked_by = '${owner.id}'`, `role = 'admin'`]) {
        await expect(c.query(`UPDATE crove_kernel.member_invite SET ${change} WHERE id = $1`, [created.inviteId])).rejects.toThrow(/INVITE_IMMUTABLE/);
      }
      // A pending invite cannot be pointed at another email or role, or extended, either.
      const other = await invite(orgId, owner.id, `other-${randomUUID().slice(0, 8)}@invites.test`);
      for (const change of [`email = 'someone@invites.test'`, `role = 'admin'`, `expires_at = expires_at + interval '1 day'`, `token_sha256 = repeat('0', 64)`]) {
        await expect(c.query(`UPDATE crove_kernel.member_invite SET ${change} WHERE id = $1`, [other.inviteId])).rejects.toThrow(/INVITE_IMMUTABLE/);
      }
    });
  });

  // Self-host (AUTH_SESSION_CHECK=db): accepting and previewing also need a confirmed email in Supabase Auth's own
  // record (#134), and fail closed (503) while the column exists but the reader cannot see it. Runs last: it creates
  // the auth tables.
  it('requires a confirmed email in Supabase Auth on self-host, and fails closed without the grant', async () => {
    await admin(async (c) => {
      await c.query('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin');
      await c.query('SET ROLE supabase_auth_admin');
      await c.query(`
        CREATE TABLE auth.users (
          id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
        CREATE TABLE auth.sessions (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, not_after timestamptz);
        CREATE TABLE auth.mfa_factors (
          id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE, status text NOT NULL);
        ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;`);
    });
    await applyAuthGrants({ adminUrl, timeoutMs: 5000 });
    const upstream = new Runtime(db, { sessions: createSessionStatusSource('db'), stepUp: 'off' }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });

    // A signed-in Supabase Auth user: an account row (confirmed or not) and one session.
    async function signedIn(name: string, confirmed: boolean) {
      const subject = randomUUID();
      const email = `${name}-${randomUUID().slice(0, 8)}@invites.test`;
      const session = randomUUID();
      await admin(async (c) => {
        await c.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, $3)', [subject, email, confirmed ? new Date() : null]);
        await c.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [session, subject]);
      });
      const id = await upsertIdentity(db, { issuer: 'test', subject, email, name: null });
      return { id, email, subject, actor: { type: 'user' as const, userId: id, aal: 'aal2' as const, sessionId: session, mfaAt: Math.floor(Date.now() / 1000) } };
    }
    const acceptUp = (token: string, who: { actor: ReturnType<typeof asMfa> }) =>
      upstream.executeOrgless<{ orgId: string; role: string }>('kernel.member.invite.accept', { token }, { actor: who.actor });
    const peekUp = (token: string, who: { id: string; actor: ReturnType<typeof asMfa> }) =>
      upstream.forUser(who.actor, (trx) => previewInvite(trx, who.id, token, { upstream: true }));

    const owner = await signedIn('owner', true);
    const orgId = (await createOrg(upstream, owner.actor, `Org ${randomUUID().slice(0, 6)}`)).orgId;
    const invitee = await signedIn('unconfirmed', false);
    const stranger = await signedIn('stranger', false);
    const created = await upstream.execute<Created>('kernel.member.invite.create', { email: invitee.email, role: 'member' }, { actor: owner.actor, orgId });
    const token = tokenOf(created);

    // Unconfirmed: refused for the invitee (who learns why), while anyone else still learns only "not for you".
    await expect(peekUp(token, invitee)).rejects.toMatchObject({ code: 'INVITE_EMAIL_UNCONFIRMED', status: 403 });
    await expect(acceptUp(token, invitee)).rejects.toMatchObject({ code: 'INVITE_EMAIL_UNCONFIRMED', status: 403 });
    await expect(acceptUp(token, stranger)).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH' });
    // The same user passes where the deployment does not read Supabase Auth (jwt, or no session check).
    await expect(runtime.forUser(asUser(invitee.id), (trx) => previewInvite(trx, invitee.id, token, { upstream: false }))).resolves.toMatchObject({ role: 'member' });
    // A confirmation dated in the future is not a confirmation.
    await admin((c) => c.query(`UPDATE auth.users SET email_confirmed_at = now() + interval '1 day' WHERE id = $1`, [invitee.subject]));
    await expect(acceptUp(token, invitee)).rejects.toMatchObject({ code: 'INVITE_EMAIL_UNCONFIRMED' });
    expect(await memberships(invitee.id)).toEqual([]);

    // Without the column grant the session check still passes, but invites fail closed (503) instead of skipping it.
    await admin((c) => c.query(`UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1`, [invitee.subject]));
    await admin((c) => c.query('REVOKE SELECT (email_confirmed_at) ON auth.users FROM crove_auth_reader'));
    await expect(upstream.query('kernel.org.get', {}, { actor: owner.actor, orgId })).resolves.toBeTruthy();
    await expect(peekUp(token, invitee)).rejects.toMatchObject({ code: 'AUTH_NOT_READY', status: 503 });
    await expect(acceptUp(token, invitee)).rejects.toMatchObject({ code: 'AUTH_NOT_READY', status: 503 });
    expect(await memberships(invitee.id)).toEqual([]);
    // auth-grants (every `docker compose up`) grants it again, and exactly that column more than the session check.
    await applyAuthGrants({ adminUrl, timeoutMs: 5000 });
    const granted = await admin(
      async (c) =>
        (await c.query(
          `SELECT column_name FROM information_schema.column_privileges
           WHERE grantee = 'crove_auth_reader' AND table_schema = 'auth' AND table_name = 'users' ORDER BY 1`,
        )).rows,
    );
    expect(granted.map((r) => r.column_name)).toEqual(['banned_until', 'deleted_at', 'email_confirmed_at', 'id']);

    // Confirmed: the invitee joins.
    await expect(peekUp(token, invitee)).resolves.toMatchObject({ role: 'member' });
    await expect(acceptUp(token, invitee)).resolves.toMatchObject({ orgId, role: 'member' });
    expect(await memberships(invitee.id)).toEqual([{ org_id: orgId, role: 'member' }]);

    // A Supabase Auth without the column: every Supabase Auth release has it, and every fake auth.users in this suite
    // now carries it (#208). Until the second step lands the check is skipped (auth-grants warns); after it, invites
    // fail closed with 503. Both are accepted here, so this copy of the suite can gate either.
    const late = await signedIn('no-column', false);
    const lateToken = tokenOf(await upstream.execute<Created>('kernel.member.invite.create', { email: late.email, role: 'viewer' }, { actor: owner.actor, orgId }));
    await admin(async (c) => {
      await c.query('SET ROLE supabase_auth_admin');
      await c.query('ALTER TABLE auth.users DROP COLUMN email_confirmed_at');
    });
    const outcome = await acceptUp(lateToken, late).then(
      (accepted) => ({ accepted }),
      (refused: unknown) => ({ refused }),
    );
    if ('accepted' in outcome) {
      expect(outcome.accepted).toMatchObject({ orgId, role: 'viewer' });
    } else {
      expect(outcome.refused).toMatchObject({ code: 'AUTH_NOT_READY', status: 503 });
      expect(await memberships(late.id)).toEqual([]);
    }
  });
});
