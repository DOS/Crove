// Security properties of member invites (issue #35, plan §7.3 item 2): an invite adds nobody until the invitee
// accepts; it reveals nothing about accounts, is bound to the invited email, single-use, revocable and expires; an
// accepted invite commits only with its audit row. Against a real PostgreSQL 17. These are ordinary DB tests: adding
// a file under test/invariant/ is a protected-path change, left to a later step of #35. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run creates and drops its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Database, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, previewInvite, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

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
    await expect(runtime.forUser(asUser(stranger.id), (trx) => previewInvite(trx, stranger.id, token))).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH' });
    // The invitee sees what they consent to.
    await expect(runtime.forUser(asUser(invitee.id), (trx) => previewInvite(trx, invitee.id, token))).resolves.toMatchObject({ role: 'viewer', invitedBy: owner.email });
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

  it('stops an invite when its inviter is removed or loses the right to grant its role', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const [inviterAdmin, coOwner] = [await person('admin'), await person('co-owner')];
    await accept(tokenOf(await invite(orgId, owner.id, inviterAdmin.email, 'admin')), inviterAdmin.id);
    await accept(tokenOf(await invite(orgId, owner.id, coOwner.email, 'admin')), coOwner.id);
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'owner' }, { actor: asMfa(owner.id), orgId });

    // An admin's member invite dies with the admin's demotion.
    const a = await person('a');
    const byAdmin = await invite(orgId, inviterAdmin.id, a.email, 'member');
    await runtime.execute('kernel.member.change_role', { userId: inviterAdmin.id, role: 'member' }, { actor: asMfa(owner.id), orgId });
    await expect(accept(tokenOf(byAdmin), a.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });

    // A co-owner's admin invite dies when the co-owner becomes an admin (only owners grant admin).
    const b = await person('b');
    const byCoOwner = await invite(orgId, coOwner.id, b.email, 'admin');
    await runtime.execute('kernel.member.change_role', { userId: coOwner.id, role: 'admin' }, { actor: asMfa(owner.id), orgId });
    await expect(accept(tokenOf(byCoOwner), b.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });

    // Any invite dies with its inviter's removal.
    const c2 = await person('c');
    const byRemoved = await invite(orgId, coOwner.id, c2.email, 'viewer');
    await runtime.execute('kernel.member.remove', { userId: coOwner.id }, { actor: asMfa(owner.id), orgId });
    await expect(accept(tokenOf(byRemoved), c2.id)).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    // Removal also revokes the removed member's pending invites, so inviting them back does not revive them.
    const status = await admin(async (c) => (await c.query('SELECT status, revoked_by FROM crove_kernel.member_invite WHERE id = $1', [byRemoved.inviteId])).rows);
    expect(status).toEqual([{ status: 'revoked', revoked_by: owner.id }]);

    for (const who of [a, b, c2]) expect(await memberships(who.id)).toEqual([]);
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
      'crove_kernel.invite_accept(uuid,text)',
      'crove_kernel.invite_peek(uuid,text)',
      'crove_kernel.invite_for_user(uuid,text,boolean)',
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
      'crove_kernel.invite_accept(uuid,text)': ['crove_app'],
      'crove_kernel.invite_peek(uuid,text)': ['crove_app'],
      'crove_kernel.invite_for_user(uuid,text,boolean)': [],
      'crove_kernel.member_invite_guard()': [],
      'crove_kernel.member_invite_requires_audit()': [],
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
      await c.query('SELECT crove_kernel.invite_accept($1::uuid, $2)', [invitee.id, tokenOf(created)]);
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
});
