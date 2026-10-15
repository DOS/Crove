// Member management flows (issue #36) against a real PostgreSQL 17: what an owner's role change or removal
// records, idempotent retries, and re-inviting a removed member. Who may do it, the last-owner rule, cross-org
// isolation and revocation on the next request are in test/invariant/members.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('member management on PostgreSQL', () => {
  const dbName = `crove_test_member_flows_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;

  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '7a1d6c1e-2f4b-4c8e-9d3a-1b5e7f9a0c11',
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

  // Members join by accepting an invite (issue #35): the inviter invites the email, the user signed in with it accepts.
  async function join(orgId: string, inviter: string, who: { id: string; email: string }, role: 'admin' | 'member' | 'viewer') {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email: who.email, role }, { actor: asMfa(inviter), orgId });
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asMfa(who.id) });
  }

  async function person(name: string) {
    const email = `${name}-${randomUUID().slice(0, 8)}@example.com`;
    const id = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: null });
    return { id, email };
  }

  async function orgWithMember(role: 'admin' | 'member' | 'viewer') {
    const owner = await person('owner');
    const member = await person('member');
    const { orgId } = await createOrg(runtime, asMfa(owner.id), `Org ${randomUUID().slice(0, 6)}`);
    await join(orgId, owner.id, member, role);
    return { orgId, owner, member };
  }

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

  it('records a role change: audit row with actor, target, old and new role and the assurance used, activity and event', async () => {
    const { orgId, owner, member } = await orgWithMember('member');
    const result = await runtime.execute('kernel.member.change_role', { userId: member.id, role: 'admin' }, { actor: asMfa(owner.id), orgId });
    expect(result).toEqual({ userId: member.id, role: 'admin', previousRole: 'member' });

    const [auditRow] = await rows(orgId, 'audit_event', "command = 'kernel.member.change_role'");
    expect(auditRow).toMatchObject({
      actor_type: 'user',
      actor_id: owner.id,
      outcome: 'ok',
      target_type: 'kernel.user',
      target_id: member.id,
      detail: { target_user_id: member.id, old_role: 'member', new_role: 'admin', changed: true, aal: 'aal2', sessionId: asMfa(owner.id).sessionId },
    });
    expect(await rows(orgId, 'activity', "kind = 'member.role_changed'")).toEqual([
      expect.objectContaining({ record_id: member.id, actor_id: owner.id, summary: `Đổi vai trò ${member.email} từ member thành admin` }),
    ]);
    expect(await rows(orgId, 'outbox_event', "type = 'kernel.member.role_changed'")).toEqual([
      expect.objectContaining({ actor_id: owner.id, payload: { userId: member.id, oldRole: 'member', newRole: 'admin' } }),
    ]);

    // Setting the role a member already has changes nothing, but is still audited.
    await runtime.execute('kernel.member.change_role', { userId: member.id, role: 'admin' }, { actor: asMfa(owner.id), orgId });
    const audits = await rows(orgId, 'audit_event', "command = 'kernel.member.change_role'");
    expect(audits.at(-1)?.detail).toMatchObject({ old_role: 'admin', new_role: 'admin', changed: false });
    expect(await rows(orgId, 'outbox_event', "type = 'kernel.member.role_changed'")).toHaveLength(1);
  });

  it('records a removal and lets the owner add the person back later', async () => {
    const { orgId, owner, member } = await orgWithMember('viewer');
    expect(await runtime.execute('kernel.member.remove', { userId: member.id }, { actor: asMfa(owner.id), orgId })).toEqual({
      userId: member.id,
      previousRole: 'viewer',
    });
    const [auditRow] = await rows(orgId, 'audit_event', "command = 'kernel.member.remove'");
    expect(auditRow).toMatchObject({
      actor_id: owner.id,
      outcome: 'ok',
      target_id: member.id,
      detail: { target_user_id: member.id, old_role: 'viewer', new_role: null, aal: 'aal2' },
    });
    expect(await rows(orgId, 'activity', "kind = 'member.removed'")).toEqual([
      expect.objectContaining({ record_id: member.id, summary: `Xóa thành viên ${member.email} (viewer)` }),
    ]);
    expect(await rows(orgId, 'outbox_event', "type = 'kernel.member.removed'")).toEqual([
      expect.objectContaining({ payload: { userId: member.id, oldRole: 'viewer' } }),
    ]);
    // Removing someone who is no longer a member is a 404, not a silent success.
    await expect(runtime.execute('kernel.member.remove', { userId: member.id }, { actor: asMfa(owner.id), orgId })).rejects.toMatchObject({
      code: 'MEMBER_NOT_FOUND',
      status: 404,
    });

    await join(orgId, owner.id, member, 'member');
    const detail = await runtime.query<{ members: Array<{ userId: string; role: string }> }>('kernel.org.get', {}, { actor: asMfa(member.id), orgId });
    expect(detail.members).toContainEqual(expect.objectContaining({ userId: member.id, role: 'member' }));
  });

  it('replays a retry with the same idempotency key and refuses the key for a different request', async () => {
    const { orgId, owner, member } = await orgWithMember('member');
    const key = randomUUID();
    const options = { actor: asMfa(owner.id), orgId, idempotencyKey: key };
    const first = await runtime.execute('kernel.member.change_role', { userId: member.id, role: 'viewer' }, options);
    const retry = await runtime.execute('kernel.member.change_role', { userId: member.id, role: 'viewer' }, options);
    expect(retry).toEqual(first);
    expect((await rows(orgId, 'audit_event', "command = 'kernel.member.change_role'")).map((r) => r.outcome)).toEqual(['ok']);
    await expect(runtime.execute('kernel.member.change_role', { userId: member.id, role: 'admin' }, options)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    });
    await expect(runtime.execute('kernel.member.remove', { userId: member.id }, options)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });

    const removeKey = randomUUID();
    const removeOptions = { actor: asMfa(owner.id), orgId, idempotencyKey: removeKey };
    const removed = await runtime.execute('kernel.member.remove', { userId: member.id }, removeOptions);
    // The retry of a removal that already happened returns the first answer instead of MEMBER_NOT_FOUND.
    expect(await runtime.execute('kernel.member.remove', { userId: member.id }, removeOptions)).toEqual(removed);
    // One removal; the other row is the refused reuse of the change_role key above.
    expect((await rows(orgId, 'audit_event', "command = 'kernel.member.remove'")).map((r) => r.outcome)).toEqual(['failed', 'ok']);
  });

  it('lets an owner promote a member to co-owner, who can then manage members', async () => {
    const { orgId, owner, member } = await orgWithMember('admin');
    await runtime.execute('kernel.member.change_role', { userId: member.id, role: 'owner' }, { actor: asMfa(owner.id), orgId });
    const third = await person('third');
    await join(orgId, member.id, third, 'member');
    await runtime.execute('kernel.member.change_role', { userId: third.id, role: 'viewer' }, { actor: asMfa(member.id), orgId });
    // The co-owner may demote the original owner, since an owner remains.
    await runtime.execute('kernel.member.change_role', { userId: owner.id, role: 'admin' }, { actor: asMfa(member.id), orgId });
    const detail = await runtime.query<{ members: Array<{ userId: string; role: string }> }>('kernel.org.get', {}, { actor: asMfa(member.id), orgId });
    expect(Object.fromEntries(detail.members.map((m) => [m.userId, m.role]))).toEqual({ [owner.id]: 'admin', [member.id]: 'owner', [third.id]: 'viewer' });
  });
});
