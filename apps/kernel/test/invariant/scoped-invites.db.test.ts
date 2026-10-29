// Invites scoped to legal entities (issue #1281, plan §4.6, gate row T8) on a real PostgreSQL 17: only an owner sends
// one, for a member or a viewer, naming entities of the org, and the database refuses any other scoped invite row; on
// accept the invitee joins holding one external_accountant assignment per entity, so their first sealed context is
// already limited to those entities; an invite whose inviter stopped being an owner, or one of whose entities is gone,
// adds nobody; and an invite never changes an existing member's access.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type InviteRole = 'admin' | 'member' | 'viewer';
interface Created {
  inviteId: string;
  acceptPath: string;
}

suite('invites scoped to legal entities on PostgreSQL (#1281)', () => {
  const dbName = `crove_test_scoped_invites_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '5b2e7c1a-9d4f-4e3b-8a60-2c1d0e9f7a14',
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

  async function person(name: string) {
    const email = `${name}-${randomUUID().slice(0, 8)}@scoped.test`;
    const id = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: null });
    return { id, email };
  }

  // An org with an owner, an admin, and two legal entities besides the default one.
  async function org() {
    const owner = await person('owner');
    const adminUser = await person('admin');
    const { orgId } = await createOrg(runtime, asUser(owner.id), `Scoped ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser.id]));
    const entity = async (name: string) =>
      admin(
        async (c) =>
          (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'branch', $3) RETURNING id`, [orgId, name, owner.id]))
            .rows[0]?.id as string,
      );
    const [a, b] = [await entity('Chi nhánh A'), await entity('Chi nhánh B')];
    return { orgId, owner, adminUser, a, b };
  }

  const invite = (orgId: string, inviter: string, email: string, role: InviteRole, legalEntityIds?: string[]) =>
    runtime.execute<Created>('kernel.member.invite.create', { email, role, ...(legalEntityIds ? { legalEntityIds } : {}) }, { actor: asMfa(inviter), orgId });
  const tokenOf = (created: Created) => created.acceptPath.slice(created.acceptPath.indexOf('#') + 1);
  const accept = (token: string, userId: string) => runtime.executeOrgless<{ orgId: string; role: string }>('kernel.member.invite.accept', { token }, { actor: asUser(userId) });
  const assignments = (orgId: string, userId: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ role_key: string; legal_entity_id: string | null; granted_by: string }>(
            'SELECT role_key, legal_entity_id, granted_by FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2 ORDER BY legal_entity_id',
            [orgId, userId],
          )
        ).rows,
    );
  const membership = (orgId: string, userId: string) =>
    admin(async (c) => (await c.query<{ role: string }>('SELECT role FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows[0]?.role ?? null);
  // The legal-entity scope of the user's sealed context in the org, as the API login role derives it.
  async function scopeOf(userId: string, orgId: string): Promise<string[]> {
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const { rows } = await app.query<{ scope: string[] }>('SELECT crove_kernel.ctx_le_scope() AS scope');
      await app.query('ROLLBACK');
      return [...(rows[0]?.scope ?? [])].sort();
    } finally {
      await app.end();
    }
  }
  const acceptAudit = (orgId: string, userId: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ detail: Record<string, unknown> }>(
            `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member.invite.accept' AND outcome = 'ok' AND actor_id = $2`,
            [orgId, userId],
          )
        ).rows[0]?.detail,
    );

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
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
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only an owner send a scoped invite, for a member or a viewer, naming entities of the org', async () => {
    const o = await org();
    const other = await org();
    const invitee = await person('invitee');
    await expect(invite(o.orgId, o.adminUser.id, invitee.email, 'member', [o.a])).rejects.toMatchObject({ code: 'INVITE_SCOPE_OWNER_ONLY', status: 403 });
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'admin', [o.a])).rejects.toMatchObject({ code: 'ROLE_SCOPE_NOT_FOR_ADMINS' });
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'member', [o.a, other.a])).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_FOUND' });
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'member', [o.a, o.a])).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(invite(o.orgId, o.owner.id, invitee.email, 'member', [])).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.member_invite WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);

    // The database refuses a scoped invite row from anyone but an owner of the org naming itself as the inviter, and
    // one naming another org's entity; nobody changes an invite's scope afterwards.
    const raw = async (userId: string, inviter: string, entities: string[]) => {
      const app = new pg.Client({ connectionString: appUrl });
      await app.connect();
      try {
        await app.query('BEGIN');
        await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(userId, o.orgId)]);
        await app.query(
          `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, legal_entity_ids) VALUES ($1, $2, 'member', $3, $4::uuid[])`,
          [o.orgId, `raw-${randomUUID().slice(0, 6)}@scoped.test`, inviter, entities],
        );
        await app.query('COMMIT');
      } catch (error) {
        await app.query('ROLLBACK');
        throw error;
      } finally {
        await app.end();
      }
    };
    await expect(raw(o.adminUser.id, o.adminUser.id, [o.a])).rejects.toMatchObject({ message: 'INVITE_SCOPE_OWNER_ONLY' });
    await expect(raw(o.adminUser.id, o.owner.id, [o.a])).rejects.toMatchObject({ message: 'INVITE_SCOPE_OWNER_ONLY' });
    await expect(raw(o.owner.id, o.owner.id, [other.a])).rejects.toMatchObject({ message: 'LEGAL_ENTITY_NOT_FOUND' });
    const created = await invite(o.orgId, o.owner.id, invitee.email, 'member', [o.a]);
    await expect(
      admin((c) => c.query("UPDATE crove_kernel.member_invite SET legal_entity_ids = ARRAY[$2]::uuid[] WHERE id = $1", [created.inviteId, o.b])),
    ).rejects.toMatchObject({ message: 'INVITE_IMMUTABLE' });
  });

  it('makes the invitee an external accountant of exactly those entities, from their first context', async () => {
    const o = await org();
    const invitee = await person('accountant');
    const created = await invite(o.orgId, o.owner.id, invitee.email, 'member', [o.a, o.b]);
    await expect(runtime.query('kernel.member.invites.list', {}, { actor: asUser(o.owner.id), orgId: o.orgId })).resolves.toMatchObject([
      { id: created.inviteId, legalEntityIds: [o.a, o.b] },
    ]);
    await expect(accept(tokenOf(created), invitee.id)).resolves.toMatchObject({ orgId: o.orgId, role: 'member' });
    expect(await assignments(o.orgId, invitee.id)).toEqual(
      [o.a, o.b].sort().map((id) => ({ role_key: 'external_accountant', legal_entity_id: id, granted_by: o.owner.id })),
    );
    expect(await scopeOf(invitee.id, o.orgId)).toEqual([o.a, o.b].sort());
    expect(await acceptAudit(o.orgId, invitee.id)).toMatchObject({ legal_entity_ids: [o.a, o.b], scope_applied: true, role: 'member' });

    // A viewer may be scoped too; an ordinary invite still gives the whole org.
    const viewer = await person('viewer');
    await accept(tokenOf(await invite(o.orgId, o.owner.id, viewer.email, 'viewer', [o.b])), viewer.id);
    expect(await scopeOf(viewer.id, o.orgId)).toEqual([o.b]);
    const plain = await person('plain');
    await accept(tokenOf(await invite(o.orgId, o.adminUser.id, plain.email, 'member')), plain.id);
    expect(await assignments(o.orgId, plain.id)).toEqual([]);
    expect(await scopeOf(plain.id, o.orgId)).toEqual(['*']);
  });

  it('adds nobody when the inviter is no longer an owner or an entity is gone', async () => {
    const o = await org();
    const coOwner = await person('co-owner');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'owner')", [o.orgId, coOwner.id]));
    const late = await person('late');
    const byCoOwner = await invite(o.orgId, coOwner.id, late.email, 'member', [o.a]);
    // Demoted to admin: still allowed to invite a member, no longer to scope one.
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [o.orgId, coOwner.id]));
    await expect(accept(tokenOf(byCoOwner), late.id)).rejects.toMatchObject({ code: 'INVITE_SCOPE_STALE', status: 409 });
    expect(await membership(o.orgId, late.id)).toBeNull();

    const gone = await person('gone');
    const created = await invite(o.orgId, o.owner.id, gone.email, 'member', [o.a, o.b]);
    await admin((c) => c.query('DELETE FROM crove_kernel.legal_entity WHERE org_id = $1 AND id = $2', [o.orgId, o.b]));
    await expect(accept(tokenOf(created), gone.id)).rejects.toMatchObject({ code: 'INVITE_SCOPE_STALE' });
    expect(await membership(o.orgId, gone.id)).toBeNull();
    expect(await assignments(o.orgId, gone.id)).toEqual([]);
  });

  it('never changes an existing member\'s access', async () => {
    const o = await org();
    const member = await person('member');
    await accept(tokenOf(await invite(o.orgId, o.owner.id, member.email, 'member')), member.id);
    expect(await scopeOf(member.id, o.orgId)).toEqual(['*']);
    // A scoped invite still pending when its invitee joined another way. Accepting it kept what they have and ignored
    // the scope until #1459, which refuses it instead (409 INVITE_SCOPE_ALREADY_MEMBER) and changes nothing, the invite
    // still pending: either holds until that lands. Their access is untouched either way.
    const second = await person('second');
    const pending = await invite(o.orgId, o.owner.id, second.email, 'viewer', [o.a]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, second.id]));
    const outcome = await accept(tokenOf(pending), second.id).then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; status?: number }) => ({ ok: false as const, code: error.code, status: error.status }),
    );
    if (outcome.ok) {
      expect(outcome.value).toMatchObject({ role: 'member' });
      expect(await acceptAudit(o.orgId, second.id)).toMatchObject({ already_member: true, scope_applied: false, legal_entity_ids: [o.a] });
    } else {
      expect(outcome).toEqual({ ok: false, code: 'INVITE_SCOPE_ALREADY_MEMBER', status: 409 });
      expect(await acceptAudit(o.orgId, second.id)).toBeUndefined();
      const status = await admin(
        async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.member_invite WHERE org_id = $1 AND id = $2', [o.orgId, pending.inviteId])).rows[0]?.status,
      );
      expect(status).toBe('pending');
    }
    expect(await membership(o.orgId, second.id)).toBe('member');
    expect(await assignments(o.orgId, second.id)).toEqual([]);
    expect(await scopeOf(second.id, o.orgId)).toEqual(['*']);
  });
});
