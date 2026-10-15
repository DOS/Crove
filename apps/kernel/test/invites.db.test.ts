// Member invite flows (issue #35) against a real PostgreSQL 17: replacing an open invite, the org's invite list,
// inviting someone who has no account yet, what an invite and an accept record, the open-invite limit and admin
// limits on revoking. Who may invite and accept, expiry, revocation, replays, races and cross-org isolation are in
// test/invariant/invites.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its
// own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_OPEN_INVITES, acceptInvite, createOrg, declineInvite, kernelCommands, kernelQueries, myInvites, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

interface OrgInvite {
  inviteId: string;
  email: string;
  role: string;
  status: string;
  invitedBy: string | null;
}

suite('member invites on PostgreSQL', () => {
  const dbName = `crove_test_invite_flows_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: '0f6f2a7e-5b3c-4d8e-9a1b-2c3d4e5f6a7b' });
  const asMfa = (userId: string) => ({ ...asUser(userId), aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function person(name: string, displayName: string | null = null) {
    const email = `${name}-${randomUUID().slice(0, 8)}@example.com`;
    const id = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: displayName });
    return { id, email };
  }

  async function orgOf(owner: { id: string }) {
    return (await createOrg(runtime, asMfa(owner.id), `Org ${randomUUID().slice(0, 6)}`)).orgId;
  }

  const invite = (actorId: string, orgId: string, email: string, role: string, idempotencyKey?: string) =>
    runtime.execute<{ inviteId: string; email: string; role: string; expiresAt: string }>(
      'kernel.member.invite',
      { email, role },
      { actor: asMfa(actorId), orgId, ...(idempotencyKey ? { idempotencyKey } : {}) },
    );
  const orgInvites = (actorId: string, orgId: string) => runtime.query<OrgInvite[]>('kernel.member.invites', {}, { actor: asUser(actorId), orgId });

  const rows = (orgId: string, table: 'audit_event' | 'activity' | 'outbox_event', where: string) =>
    admin(async (c) => (await c.query(`SELECT * FROM crove_kernel.${table} WHERE org_id = $1 AND ${where} ORDER BY id`, [orgId])).rows);

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
    runtime = new Runtime(db).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('records an invite and an accept: audit rows, activity and events', async () => {
    const owner = await person('owner', 'Chủ Cửa Hàng');
    const invitee = await person('invitee');
    const orgId = await orgOf(owner);
    const sent = await invite(owner.id, orgId, invitee.email, 'member');
    expect(new Date(sent.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);

    expect(await rows(orgId, 'audit_event', "command = 'kernel.member.invite'")).toEqual([
      expect.objectContaining({ actor_id: owner.id, outcome: 'ok', detail: expect.objectContaining({ invite_id: sent.inviteId, role: 'member', replaced_invite_id: null, aal: 'aal2' }) }),
    ]);
    expect(await rows(orgId, 'activity', "kind = 'member.invited'")).toEqual([
      expect.objectContaining({ record_id: sent.inviteId, actor_id: owner.id, summary: `Mời ${invitee.email} tham gia (member)` }),
    ]);
    expect(await rows(orgId, 'outbox_event', "type = 'kernel.member.invited'")).toEqual([
      expect.objectContaining({ payload: { inviteId: sent.inviteId, role: 'member' } }),
    ]);
    expect(await myInvites(runtime, asUser(invitee.id))).toEqual([
      expect.objectContaining({ orgId, inviteId: sent.inviteId, role: 'member', invitedBy: 'Chủ Cửa Hàng' }),
    ]);

    const joined = await acceptInvite(runtime, asUser(invitee.id), { orgId, inviteId: sent.inviteId });
    expect(joined).toMatchObject({ orgId, role: 'member' });
    expect(await rows(orgId, 'activity', "kind = 'member.joined'")).toEqual([expect.objectContaining({ record_id: invitee.id, actor_id: invitee.id })]);
    expect(await rows(orgId, 'outbox_event', "type = 'kernel.member.joined'")).toEqual([
      expect.objectContaining({ payload: { userId: invitee.id, role: 'member', inviteId: sent.inviteId } }),
    ]);
    // Accepted invites leave the org's list; the new member is in the member list instead.
    expect(await orgInvites(owner.id, orgId)).toEqual([]);
    const detail = await runtime.query<{ members: Array<{ userId: string; role: string }> }>('kernel.org.get', {}, { actor: asUser(invitee.id), orgId });
    expect(detail.members).toContainEqual(expect.objectContaining({ userId: invitee.id, role: 'member' }));
  });

  it('replaces an open invite to the same address: the old one is revoked (audited) and the new role applies', async () => {
    const owner = await person('owner');
    const invitee = await person('invitee');
    const orgId = await orgOf(owner);
    const first = await invite(owner.id, orgId, invitee.email, 'viewer');
    const second = await invite(owner.id, orgId, invitee.email.toUpperCase(), 'admin');
    expect(second.inviteId).not.toBe(first.inviteId);
    expect(await rows(orgId, 'audit_event', "command = 'kernel.member.invite_revoke'")).toEqual([
      expect.objectContaining({ actor_id: owner.id, outcome: 'ok', target_id: first.inviteId }),
    ]);
    expect((await rows(orgId, 'audit_event', "command = 'kernel.member.invite'")).at(-1)?.detail).toMatchObject({ replaced_invite_id: first.inviteId });
    expect((await orgInvites(owner.id, orgId)).map((i) => [i.inviteId, i.role, i.status])).toEqual([[second.inviteId, 'admin', 'pending']]);
    await expect(acceptInvite(runtime, asUser(invitee.id), { orgId, inviteId: first.inviteId })).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    expect(await acceptInvite(runtime, asUser(invitee.id), { orgId, inviteId: second.inviteId })).toMatchObject({ role: 'admin' });
  });

  it('replays an invite retried with the same idempotency key', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const key = randomUUID();
    const email = `nobody-${randomUUID().slice(0, 8)}@example.com`;
    const first = await invite(owner.id, orgId, email, 'member', key);
    expect(await invite(owner.id, orgId, email, 'member', key)).toEqual(first);
    expect(await orgInvites(owner.id, orgId)).toHaveLength(1);
  });

  it('invites an address that has no account yet; the person sees it after signing up', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const email = `newcomer-${randomUUID().slice(0, 8)}@example.com`;
    const sent = await invite(owner.id, orgId, email, 'viewer');
    const newcomer = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: email.toUpperCase(), name: null });
    expect(await myInvites(runtime, asUser(newcomer))).toEqual([expect.objectContaining({ inviteId: sent.inviteId })]);
    expect(await acceptInvite(runtime, asUser(newcomer), { orgId, inviteId: sent.inviteId })).toMatchObject({ role: 'viewer' });
  });

  it("lists the org's pending, expired and recently declined invites with the inviter's name", async () => {
    const owner = await person('owner', 'Owner Name');
    const decliner = await person('decliner');
    const orgId = await orgOf(owner);
    const pending = await invite(owner.id, orgId, `pending-${randomUUID().slice(0, 6)}@example.com`, 'member');
    const declined = await invite(owner.id, orgId, decliner.email, 'viewer');
    await declineInvite(runtime, asUser(decliner.id), { orgId, inviteId: declined.inviteId });
    const revoked = await invite(owner.id, orgId, `revoked-${randomUUID().slice(0, 6)}@example.com`, 'member');
    await runtime.execute('kernel.member.invite_revoke', { inviteId: revoked.inviteId }, { actor: asUser(owner.id), orgId });
    const expiredId = await admin(async (c) => {
      const { rows: inserted } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, created_at, expires_at)
         VALUES ($1, 'expired@example.com', 'member', $2, now() - interval '9 days', now() - interval '2 days') RETURNING id`,
        [orgId, owner.id],
      );
      return inserted[0]!.id;
    });
    const listed = await orgInvites(owner.id, orgId);
    expect(Object.fromEntries(listed.map((i) => [i.inviteId, i.status]))).toEqual({
      [pending.inviteId]: 'pending',
      [declined.inviteId]: 'declined',
      [expiredId]: 'expired',
    });
    expect(listed.every((i) => i.invitedBy === 'Owner Name')).toBe(true);
    // An expired invite can be revoked to clear it, or replaced by a new invite to the same address.
    const renewed = await invite(owner.id, orgId, 'expired@example.com', 'member');
    expect((await orgInvites(owner.id, orgId)).find((i) => i.email === 'expired@example.com')).toMatchObject({ inviteId: renewed.inviteId, status: 'pending' });
    // A declined address can be invited again.
    expect((await invite(owner.id, orgId, decliner.email, 'viewer')).inviteId).not.toBe(declined.inviteId);
  });

  it('limits the open invites of an org', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by)
         SELECT $1, 'bulk-' || g || '@example.com', 'viewer', $2 FROM generate_series(1, $3::int) g`,
        [orgId, owner.id, MAX_OPEN_INVITES],
      ),
    );
    await expect(invite(owner.id, orgId, 'one-more@example.com', 'viewer')).rejects.toMatchObject({ code: 'INVITE_LIMIT', status: 429 });
    // Replacing one of the open invites does not add to the count.
    await expect(invite(owner.id, orgId, 'bulk-1@example.com', 'member')).resolves.toMatchObject({ role: 'member' });
  });

  it('lets admins revoke member and viewer invites but not admin invites', async () => {
    const owner = await person('owner');
    const adminUser = await person('admin');
    const orgId = await orgOf(owner);
    const adminInvite = await invite(owner.id, orgId, adminUser.email, 'admin');
    await acceptInvite(runtime, asUser(adminUser.id), { orgId, inviteId: adminInvite.inviteId });
    const forAdmin = await invite(owner.id, orgId, `next-admin-${randomUUID().slice(0, 6)}@example.com`, 'admin');
    const forMember = await invite(adminUser.id, orgId, `member-${randomUUID().slice(0, 6)}@example.com`, 'member');
    await expect(
      runtime.execute('kernel.member.invite_revoke', { inviteId: forAdmin.inviteId }, { actor: asUser(adminUser.id), orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Nor may an admin replace an owner's admin invite by inviting the same address again.
    const adminEmail = (await orgInvites(owner.id, orgId)).find((i) => i.inviteId === forAdmin.inviteId)!.email;
    await expect(invite(adminUser.id, orgId, adminEmail, 'viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.execute('kernel.member.invite_revoke', { inviteId: forMember.inviteId }, { actor: asUser(adminUser.id), orgId })).resolves.toEqual({
      inviteId: forMember.inviteId,
    });
  });

  it('lets a removed member be invited back', async () => {
    const owner = await person('owner');
    const member = await person('member');
    const orgId = await orgOf(owner);
    const first = await invite(owner.id, orgId, member.email, 'member');
    await acceptInvite(runtime, asUser(member.id), { orgId, inviteId: first.inviteId });
    await runtime.execute('kernel.member.remove', { userId: member.id }, { actor: asMfa(owner.id), orgId });
    const again = await invite(owner.id, orgId, member.email, 'viewer');
    expect(await myInvites(runtime, asUser(member.id))).toEqual([expect.objectContaining({ inviteId: again.inviteId, role: 'viewer' })]);
    expect(await acceptInvite(runtime, asUser(member.id), { orgId, inviteId: again.inviteId })).toMatchObject({ role: 'viewer' });
  });
});
