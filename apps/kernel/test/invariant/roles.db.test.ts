// Role assignments (issue #1279, plan §4.6, ADR-0021 section 3) on a real PostgreSQL 17: only an owner grants or
// revokes a role, through the audited commands or the definers behind them, never a raw write; the sealed context's
// le_scope comes from the member's assignments and a revoke never widens it; P12 eligibility reads the assignments
// (a chief accountant approves, and four-eyes counts them); the chief accountant unlocks a period; and a revoke or a
// removal applies from the member's next command.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { BUILTIN_ROLE_KEYS } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const suite = ADMIN ? describe : describe.skip;

type Actor = { type: 'user'; userId: string; aal: 'aal1' | 'aal2'; sessionId?: string; mfaAt?: number };

suite('role assignments on PostgreSQL (#1279)', () => {
  const dbName = `crove_test_roles_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const clients: pg.Client[] = [];

  const asUser = (userId: string): Actor => ({ type: 'user', userId, aal: 'aal1' });
  const asMfa = (userId: string): Actor => ({
    type: 'user',
    userId,
    aal: 'aal2',
    sessionId: '7e1c2b4a-5d6f-4a8b-9c0d-1e2f3a4b5c6d',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // Runs fn as the API login role in the user's sealed context of the org, and always rolls back.
  async function inContext<T>(userId: string, orgId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      return await fn(app);
    } finally {
      await app.query('ROLLBACK');
    }
  }

  const scopeOf = (userId: string, orgId: string) =>
    inContext(userId, orgId, async (c) => {
      const { rows } = await c.query<{ ctx: { le_scope: string[] }; scope: string[] }>(
        `SELECT current_setting('crove.ctx')::jsonb AS ctx, crove_kernel.ctx_le_scope() AS scope`,
      );
      expect(rows[0]?.ctx.le_scope).toEqual(rows[0]?.scope);
      return rows[0]?.scope;
    });

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@roles.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Roles ${randomUUID().slice(0, 6)}`);
    const [admin, member, viewer, chief] = [await person('admin'), await person('member'), await person('viewer'), await person('chief')];
    await withAdmin((c) =>
      c.query(
        "INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')",
        [orgId, admin, member, viewer, chief],
      ),
    );
    const defaultEntity = await withAdmin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string);
    const branch = await withAdmin(
      async (c) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))
          .rows[0]?.id as string,
    );
    const exec = <T>(actor: Actor, command: string, input: unknown) => rt.execute<T>(command, input, { actor, orgId, idempotencyKey: randomUUID() });
    const assign = (actor: Actor, userId: string, roleKey: string, legalEntityId: string | null = null) =>
      exec<{ assignmentId: string; created: boolean }>(actor, 'kernel.member.role.assign', { userId, roleKey, legalEntityId });
    const revoke = (actor: Actor, assignmentId: string) => exec<{ assignmentId: string }>(actor, 'kernel.member.role.revoke', { assignmentId });
    return { orgId, owner, admin, member, viewer, chief, defaultEntity, branch, exec, assign, revoke };
  }

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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('seeds the built-in roles of the plan, and only the chief accountant grants permissions', async () => {
    const { roles, permissions } = await withAdmin(async (c) => ({
      roles: (await c.query<{ key: string; scope: string }>('SELECT key, scope FROM crove_kernel.role ORDER BY key')).rows,
      permissions: (await c.query<{ role_key: string; permission: string }>('SELECT role_key, permission FROM crove_kernel.role_permission ORDER BY 1, 2')).rows,
    }));
    expect(roles.map((r) => r.key)).toEqual([...BUILTIN_ROLE_KEYS].sort());
    // The entity chief accountant (#1507) is limited to its legal entities and grants their period unlock alone.
    expect(roles.filter((r) => r.scope === 'legal_entity').map((r) => r.key)).toEqual(['external_accountant', 'finance.entity_chief_accountant']);
    expect(permissions).toEqual([
      { role_key: 'finance.chief_accountant', permission: 'finance.period.unlock' },
      { role_key: 'finance.chief_accountant', permission: 'finance.proposal.approve' },
      { role_key: 'finance.entity_chief_accountant', permission: 'finance.period.unlock' },
    ]);
    // The base roles are not assignable roles.
    expect(roles.map((r) => r.key)).not.toContain('owner');
  });

  it('keeps every write to the three tables out of reach of the runtime roles, and the definers pinned and owner-only', async () => {
    const o = await org();
    const { grants, functions } = await withAdmin(async (c) => ({
      grants: (
        await c.query<{ tbl: string; role: string; op: string }>(
          `SELECT t AS tbl, r AS role, p AS op FROM unnest($1::text[]) t, unnest($2::text[]) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
           WHERE has_table_privilege(r, t, p) ORDER BY 1, 2, 3`,
          [['crove_kernel.role', 'crove_kernel.role_permission', 'crove_kernel.role_assignment'], ROLES],
        )
      ).rows,
      functions: (
        await c.query<{ fn: string; definer: boolean; config: string[]; callers: string[] }>(
          `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config,
                  ARRAY(SELECT r FROM unnest($1::text[]) r WHERE has_function_privilege(r, p.oid, 'EXECUTE') ORDER BY r) AS callers
           FROM pg_proc p
           WHERE p.oid IN ('crove_kernel.role_assignment_grant(uuid,text,uuid)'::regprocedure, 'crove_kernel.role_assignment_revoke(uuid)'::regprocedure,
                           'crove_kernel.assert_role_manager()'::regprocedure, 'crove_kernel.ctx_has_permission(text)'::regprocedure)
           ORDER BY 1`,
          [ROLES],
        )
      ).rows,
    }));
    expect(grants).toEqual([]);
    // crove_tenant and the roles that are members of it; the definers refuse all but an owner's user context.
    const tenantOnly = ['crove_app', 'crove_definer_tenant', 'crove_tenant', 'crove_worker'];
    const pinned = ['search_path=pg_catalog, pg_temp'];
    expect(functions).toEqual([
      { fn: 'crove_kernel.assert_role_manager()', definer: false, config: pinned, callers: [] },
      { fn: 'crove_kernel.ctx_has_permission(text)', definer: false, config: pinned, callers: tenantOnly },
      { fn: 'crove_kernel.role_assignment_grant(uuid,text,uuid)', definer: true, config: pinned, callers: tenantOnly },
      { fn: 'crove_kernel.role_assignment_revoke(uuid)', definer: true, config: pinned, callers: tenantOnly },
    ]);

    // A raw write in the owner's own context is refused by privilege.
    await expect(
      inContext(o.owner, o.orgId, (c) =>
        c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'finance.chief_accountant', $2)`, [o.orgId, o.member]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(inContext(o.owner, o.orgId, (c) => c.query(`INSERT INTO crove_kernel.role (key, module, scope) VALUES ('kernel.root', 'kernel', 'org')`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      inContext(o.owner, o.orgId, (c) => c.query(`INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES ('finance.viewer', 'finance.period.unlock')`)),
    ).rejects.toThrow(/permission denied/);

    // The definer called directly by an admin, a member, or the worker in the system context grants nothing.
    for (const user of [o.admin, o.member, o.viewer]) {
      await expect(
        inContext(user, o.orgId, (c) => c.query(`SELECT * FROM crove_kernel.role_assignment_grant($1::uuid, 'finance.chief_accountant', NULL)`, [user])),
      ).rejects.toMatchObject({ code: '42501', message: 'ROLE_MANAGE_FORBIDDEN' });
    }
    const worker = await connect(workerUrl);
    await worker.query('BEGIN');
    try {
      await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
      await expect(worker.query(`SELECT * FROM crove_kernel.role_assignment_grant($1::uuid, 'finance.chief_accountant', NULL)`, [o.member])).rejects.toMatchObject({
        code: '42501',
        message: 'ROLE_MANAGE_FORBIDDEN',
      });
    } finally {
      await worker.query('ROLLBACK');
    }
    // No context at all.
    const app = await connect(appUrl);
    await expect(app.query(`SELECT * FROM crove_kernel.role_assignment_grant($1::uuid, 'finance.chief_accountant', NULL)`, [o.member])).rejects.toMatchObject({
      code: '42501',
      message: 'NO_CONTEXT',
    });
    expect((await withAdmin((c) => c.query('SELECT 1 FROM crove_kernel.role_assignment WHERE org_id = $1', [o.orgId]))).rowCount).toBe(0);
  });

  it('lets only an owner assign and revoke, with fresh MFA, audited, and refuses what the scope rules forbid', async () => {
    const o = await org();
    for (const user of [o.admin, o.member, o.viewer]) {
      await expect(o.assign(asMfa(user), o.member, 'finance.accountant')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    await expect(o.assign(asUser(o.owner), o.member, 'finance.accountant')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403 });
    const first = await o.assign(asMfa(o.owner), o.member, 'finance.accountant');
    expect(first).toMatchObject({ created: true });
    expect(await o.assign(asMfa(o.owner), o.member, 'finance.accountant')).toEqual({ assignmentId: first.assignmentId, created: false });

    const other = await org();
    const refusals: Array<[string, string, string | null, string]> = [
      [o.member, 'finance.chief_accountant', o.branch, 'ROLE_SCOPE_NOT_ALLOWED'],
      [o.member, 'external_accountant', null, 'ROLE_SCOPE_REQUIRED'],
      [o.admin, 'external_accountant', o.branch, 'ROLE_SCOPE_NOT_FOR_ADMINS'],
      [o.owner, 'external_accountant', o.branch, 'ROLE_SCOPE_NOT_FOR_ADMINS'],
      [o.member, 'external_accountant', other.branch, 'LEGAL_ENTITY_NOT_FOUND'],
      [other.member, 'finance.accountant', null, 'MEMBER_NOT_FOUND'],
    ];
    for (const [user, role, entity, code] of refusals) {
      await expect(o.assign(asMfa(o.owner), user, role, entity), `${role} ${code}`).rejects.toMatchObject({ code });
    }
    // A role of a module the deployment does not run.
    await expect(o.assign(asMfa(o.owner), o.member, 'crm.sales')).rejects.toMatchObject({ code: 'ROLE_MODULE_NOT_INSTALLED', status: 422 });
    // Another org's assignment reads like one that does not exist.
    const foreign = await other.assign(asMfa(other.owner), other.member, 'finance.accountant');
    await expect(o.revoke(asMfa(o.owner), foreign.assignmentId)).rejects.toMatchObject({ code: 'ROLE_ASSIGNMENT_NOT_FOUND', status: 404 });
    await expect(o.revoke(asMfa(o.admin), first.assignmentId)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await o.revoke(asMfa(o.owner), first.assignmentId);

    const audit = await withAdmin(
      async (c) =>
        (
          await c.query<{ command: string; outcome: string; actor_id: string; detail: Record<string, unknown> }>(
            `SELECT command, outcome, actor_id, detail FROM crove_kernel.audit_event
             WHERE org_id = $1 AND command LIKE 'kernel.member.role.%' AND outcome = 'ok' ORDER BY occurred_at, id`,
            [o.orgId],
          )
        ).rows,
    );
    expect(audit).toEqual([
      expect.objectContaining({
        command: 'kernel.member.role.assign',
        actor_id: o.owner,
        detail: expect.objectContaining({ target_user: o.member, role_key: 'finance.accountant', legal_entity_id: null, assignment_id: first.assignmentId, changed: true, aal: 'aal2' }),
      }),
      expect.objectContaining({ command: 'kernel.member.role.assign', detail: expect.objectContaining({ changed: false }) }),
      expect.objectContaining({
        command: 'kernel.member.role.revoke',
        actor_id: o.owner,
        detail: expect.objectContaining({ target_user: o.member, role_key: 'finance.accountant', assignment_id: first.assignmentId }),
      }),
    ]);
    const refused = await withAdmin(
      async (c) =>
        (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.member.role.%' AND outcome <> 'ok'`, [o.orgId]))
          .rows[0]?.n,
    );
    expect(refused).toBeGreaterThanOrEqual(refusals.length + 6);
  });

  it('derives le_scope from the assignments, never wider than before on a revoke, and cascades with the membership', async () => {
    const o = await org();
    // Owners and admins see every entity; a member with no assignment too (as before this change).
    for (const user of [o.owner, o.admin, o.member, o.viewer]) expect(await scopeOf(user, o.orgId)).toEqual(['*']);

    const scoped = await o.assign(asMfa(o.owner), o.viewer, 'external_accountant', o.branch);
    expect(await scopeOf(o.viewer, o.orgId)).toEqual([o.branch]);
    // RLS shows the scoped viewer only that entity.
    const visible = await inContext(o.viewer, o.orgId, async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity ORDER BY id')).rows.map((r) => r.id));
    expect(visible).toEqual([o.branch]);
    const second = await o.assign(asMfa(o.owner), o.viewer, 'external_accountant', o.defaultEntity);
    expect(await scopeOf(o.viewer, o.orgId)).toEqual([o.branch, o.defaultEntity].sort());

    // Revoking one of two narrows; revoking the last one would widen, so it is refused.
    await o.revoke(asMfa(o.owner), second.assignmentId);
    expect(await scopeOf(o.viewer, o.orgId)).toEqual([o.branch]);
    await expect(o.revoke(asMfa(o.owner), scoped.assignmentId)).rejects.toMatchObject({ code: 'ROLE_REVOKE_WIDENS_SCOPE', status: 409 });
    expect(await scopeOf(o.viewer, o.orgId)).toEqual([o.branch]);
    // The definer refuses it too, whatever calls it.
    await expect(inContext(o.owner, o.orgId, (c) => c.query('SELECT * FROM crove_kernel.role_assignment_revoke($1::uuid)', [scoped.assignmentId]))).rejects.toMatchObject({
      message: 'ROLE_REVOKE_WIDENS_SCOPE',
    });

    // An org-wide role would lift the scoped viewer to every entity too: refused the same way, in the definer as well.
    await expect(o.assign(asMfa(o.owner), o.viewer, 'finance.viewer')).rejects.toMatchObject({ code: 'ROLE_GRANT_WIDENS_SCOPE', status: 409 });
    await expect(
      inContext(o.owner, o.orgId, (c) => c.query(`SELECT * FROM crove_kernel.role_assignment_grant($1::uuid, 'finance.viewer', NULL)`, [o.viewer])),
    ).rejects.toMatchObject({ message: 'ROLE_GRANT_WIDENS_SCOPE' });
    expect(await scopeOf(o.viewer, o.orgId)).toEqual([o.branch]);
    // A member who already holds an org-wide role stays org-wide when given an entity role too.
    await o.assign(asMfa(o.owner), o.member, 'finance.accountant');
    await o.assign(asMfa(o.owner), o.member, 'external_accountant', o.branch);
    expect(await scopeOf(o.member, o.orgId)).toEqual(['*']);

    // Removing the member removes their assignments; they enter no more.
    await o.exec(asMfa(o.owner), 'kernel.member.remove', { userId: o.viewer });
    expect((await withAdmin((c) => c.query('SELECT 1 FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2', [o.orgId, o.viewer]))).rowCount).toBe(0);
    await expect(scopeOf(o.viewer, o.orgId)).rejects.toMatchObject({ message: 'NOT_A_MEMBER' });
  });

  it('refuses to demote an owner or admin to member or viewer while they hold org-wide and entity roles together (#1367)', async () => {
    const o = await org();
    // A member limited to the branch, made admin, then given an org-wide role (allowed for an admin).
    await o.assign(asMfa(o.owner), o.member, 'external_accountant', o.branch);
    expect(await scopeOf(o.member, o.orgId)).toEqual([o.branch]);
    await o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.member, role: 'admin' });
    await o.exec(asMfa(o.member), 'kernel.member.invite.create', { email: `pending-${randomUUID().slice(0, 8)}@roles.test`, role: 'member' });
    const orgWide = await o.assign(asMfa(o.owner), o.member, 'finance.viewer');
    // Back to member or viewer, they would read every entity with their branch role still showing: refused, unchanged.
    for (const role of ['member', 'viewer']) {
      await expect(o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.member, role })).rejects.toMatchObject({
        code: 'ROLE_DEMOTION_MIXES_SCOPE',
        status: 409,
      });
    }
    const roleOf = async () =>
      (await withAdmin((c) => c.query<{ role: string }>('SELECT role FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member]))).rows[0]?.role;
    expect(await roleOf()).toBe('admin');
    // Nothing else of the demotion happened either: the admin invites they sent are still pending.
    expect(
      (
        await withAdmin((c) =>
          c.query(`SELECT 1 FROM crove_kernel.member_invite WHERE org_id = $1 AND invited_by = $2 AND status = 'pending'`, [o.orgId, o.member]),
        )
      ).rowCount,
    ).toBe(1);
    // The first refusal is audited with the roles it would have changed (a refusal of a command is not a 403: failed).
    const refused = await withAdmin(
      async (c) =>
        (
          await c.query<{ detail: Record<string, unknown> }>(
            `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member.change_role' AND outcome = 'failed' AND target_id = $2 AND detail->>'role' = 'member'`,
            [o.orgId, o.member],
          )
        ).rows[0]?.detail,
    );
    expect(refused).toMatchObject({ code: 'ROLE_DEMOTION_MIXES_SCOPE', target_user: o.member, role: 'member', previous_role: 'admin' });
    // Once one side goes, the demotion goes through: without the org-wide role, back to the branch alone.
    await o.revoke(asMfa(o.owner), orgWide.assignmentId);
    await o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.member, role: 'member' });
    expect(await roleOf()).toBe('member');
    expect(await scopeOf(o.member, o.orgId)).toEqual([o.branch]);
    // The same holds for an owner: made owner, given an org-wide role, then refused as member until one side goes.
    await o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.member, role: 'owner' });
    const again = await o.assign(asMfa(o.owner), o.member, 'finance.viewer');
    await expect(o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.member, role: 'member' })).rejects.toMatchObject({
      code: 'ROLE_DEMOTION_MIXES_SCOPE',
    });
    expect(await roleOf()).toBe('owner');
    await o.revoke(asMfa(o.owner), again.assignmentId);
    await o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.member, role: 'member' });
    expect(await scopeOf(o.member, o.orgId)).toEqual([o.branch]);
    // An admin holding org-wide roles only is demoted as before.
    await o.assign(asMfa(o.owner), o.admin, 'finance.viewer');
    await o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.admin, role: 'viewer' });
    expect(await scopeOf(o.admin, o.orgId)).toEqual(['*']);
  });

  it('makes a chief accountant an eligible approver (P12), counted for four-eyes (P10), until the next command after a revoke', async () => {
    const o = await org();
    // An entry posted through the posting path as the API login role, committed.
    const post = async (orgId: string, userId: string) => {
        const app = await connect(appUrl);
        await app.query('BEGIN');
        try {
          await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
          const { rows } = await app.query<{ id: string }>(
            `SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'test', 'test', $1::uuid, $2::jsonb) AS id`,
            [
              randomUUID(),
              JSON.stringify([
                { line_no: 1, account_code: '6422', debit: '1000', credit: '0' },
                { line_no: 2, account_code: '1111', debit: '0', credit: '1000' },
              ]),
            ],
          );
          await app.query('COMMIT');
          return rows[0]?.id as string;
        } catch (error) {
          await app.query('ROLLBACK');
          throw error;
        }
    };
    const request = async (entryId: string) =>
      (
        await o.exec<{ proposalId: string }>(asUser(o.owner), 'kernel.proposal.request', {
          command: 'finance.journal.reverse',
          input: { entryId, entryDate: '2026-10-15', reason: 'Ghi nhầm' },
        })
      ).proposalId;
    const approve = (actor: Actor, id: string) => o.exec<{ journalEntryId: string }>(actor, 'kernel.proposal.approve', { id, revision: 1 });
    const snapshot = async (id: string) =>
      withAdmin(async (c) => (await c.query<{ e: string[] }>('SELECT eligible_approvers AS e FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0]?.e ?? []);

    // A plain member is refused by the gate, before any step-up.
    const before = await request(await post(o.orgId, o.owner));
    await expect(approve(asUser(o.chief), before)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await snapshot(before)).not.toContain(o.chief);

    // Made chief accountant org-wide: in the snapshot of later proposals, and approves one the owner raised.
    const chiefRole = await o.assign(asMfa(o.owner), o.chief, 'finance.chief_accountant');
    const p1 = await request(await post(o.orgId, o.owner));
    expect(await snapshot(p1)).toEqual([o.owner, o.admin, o.chief].sort());
    await expect(approve(asUser(o.chief), p1)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(approve(asMfa(o.chief), p1)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    const row = await withAdmin(
      async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.proposal.approve' AND target_id = $1 AND outcome = 'ok'`, [p1])).rows[0],
    );
    expect(row?.detail).toMatchObject({ policy: { P12: 'pass', P10: 'pass' }, eligible_approvers: 3 });
    // The earlier proposal's snapshot was taken before: an approver added later does not approve it.
    await expect(approve(asMfa(o.chief), before)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });

    // Four-eyes counts the chief accountant: with the owner as the only base-role approver, the owner who raised a
    // proposal may no longer approve it alone.
    await o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.admin, role: 'member' });
    const p2 = await request(await post(o.orgId, o.owner));
    expect(await snapshot(p2)).toEqual([o.owner, o.chief].sort());
    await expect(approve(asMfa(o.owner), p2)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });

    // An entity-scoped assignment is no approval right, and neither is any other role.
    await o.assign(asMfa(o.owner), o.viewer, 'external_accountant', o.branch);
    await o.assign(asMfa(o.owner), o.member, 'finance.accountant');
    await expect(approve(asMfa(o.viewer), p2)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(approve(asMfa(o.member), p2)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Revoked: refused from the very next command, and no longer counted, so the owner's own proposal is self-approved.
    await o.revoke(asMfa(o.owner), chiefRole.assignmentId);
    await expect(approve(asMfa(o.chief), p2)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(approve(asMfa(o.owner), p2)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    const selfApproved = await withAdmin(
      async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.proposal.approve' AND target_id = $1 AND outcome = 'ok'`, [p2])).rows[0],
    );
    expect(selfApproved?.detail).toMatchObject({ policy: { P12: 'pass', P10: 'self_approved' }, eligible_approvers: 1 });
  });

  it('lets a chief accountant unlock a period (ADR-0021), and nobody else but an owner', async () => {
    const o = await org();
    await o.exec(asUser(o.owner), 'finance.period.lock', { month: '2026-01' });
    const unlock = (actor: Actor) => o.exec(actor, 'finance.period.unlock', { month: '2026-01', reason: 'Sửa sai sót' });
    // An admin or a member without the role is refused by the gate; a raw call of the definer too.
    for (const user of [o.admin, o.chief]) await expect(unlock(asMfa(user))).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(inContext(o.chief, o.orgId, (c) => c.query(`SELECT crove_finance.unlock_period('2026-01-01'::date)`))).rejects.toMatchObject({
      code: '42501',
      message: 'PERIOD_LOCK_FORBIDDEN',
    });
    const accountantRole = await o.assign(asMfa(o.owner), o.chief, 'finance.chief_accountant');
    const permissions = await rt.query<{ permissions: string[] }>('kernel.org.get', {}, { actor: asUser(o.chief), orgId: o.orgId });
    expect(permissions.permissions).toEqual(['finance.period.unlock', 'finance.proposal.approve']);
    await expect(unlock(asUser(o.chief))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(unlock(asMfa(o.chief))).resolves.toMatchObject({ lockedThrough: null });
    // Revoked: the next unlock is refused.
    await o.exec(asUser(o.owner), 'finance.period.lock', { month: '2026-01' });
    await o.revoke(asMfa(o.owner), accountantRole.assignmentId);
    await expect(unlock(asMfa(o.chief))).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await rt.query<{ permissions: string[] }>('kernel.org.get', {}, { actor: asUser(o.chief), orgId: o.orgId })).permissions).toEqual([]);
    // The owner still unlocks.
    await expect(unlock(asMfa(o.owner))).resolves.toMatchObject({ lockedThrough: null });
  });

  it("lets an entity chief accountant unlock only the months of its own entities, and nobody else's (#1507)", async () => {
    const o = await org();
    for (const entity of [o.defaultEntity, o.branch]) await o.exec(asUser(o.owner), 'finance.period.lock', { month: '2026-01', legalEntityId: entity });
    const unlock = (actor: Actor, legalEntityId: string) => o.exec(actor, 'finance.period.unlock', { month: '2026-01', reason: 'Sửa sai sót', legalEntityId });
    const unlockable = async (userId: string, legalEntityId: string) =>
      (await rt.query<{ unlockable: boolean }>('finance.period.lock_state', { legalEntityId }, { actor: asUser(userId), orgId: o.orgId })).unlockable;
    // An org-wide role without permissions first (so the member keeps every entity in sight), then the branch's unlock.
    await o.assign(asMfa(o.owner), o.chief, 'finance.accountant');
    await o.assign(asMfa(o.owner), o.chief, 'finance.entity_chief_accountant', o.branch);
    // No org-wide permission comes with it: not in the org's list, and no approval (P12 counts org-wide assignments).
    expect((await rt.query<{ permissions: string[] }>('kernel.org.get', {}, { actor: asUser(o.chief), orgId: o.orgId })).permissions).toEqual([]);
    expect([await unlockable(o.chief, o.branch), await unlockable(o.chief, o.defaultEntity)]).toEqual([true, false]);
    expect([await unlockable(o.owner, o.branch), await unlockable(o.owner, o.defaultEntity)]).toEqual([true, true]);
    // The other entity's month: refused by the database, through the command and raw.
    await expect(unlock(asMfa(o.chief), o.defaultEntity)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(inContext(o.chief, o.orgId, (c) => c.query(`SELECT crove_finance.unlock_period('2026-01-01'::date, $1::uuid)`, [o.defaultEntity]))).rejects.toMatchObject({
      code: '42501',
      message: 'PERIOD_LOCK_FORBIDDEN',
    });
    // Its own entity's month, with a fresh second factor (R3).
    await expect(unlock(asUser(o.chief), o.branch)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(unlock(asMfa(o.chief), o.branch)).resolves.toMatchObject({ legalEntityId: o.branch, lockedThrough: null });
    // An admin is given no entity role (they see every entity), and a member with the entity role alone sees and unlocks
    // only that entity.
    await expect(o.assign(asMfa(o.owner), o.admin, 'finance.entity_chief_accountant', o.branch)).rejects.toMatchObject({ status: 422 });
    await o.exec(asUser(o.owner), 'finance.period.lock', { month: '2026-01', legalEntityId: o.branch });
    await o.assign(asMfa(o.owner), o.member, 'finance.entity_chief_accountant', o.branch);
    await expect(unlock(asMfa(o.member), o.defaultEntity)).rejects.toMatchObject({ status: 403 });
    await expect(unlock(asMfa(o.member), o.branch)).resolves.toMatchObject({ lockedThrough: null });
    // The default entity's month is still locked; an org-wide chief accountant unlocks it as before.
    const wide = await person('wide');
    await withAdmin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, wide]));
    await o.assign(asMfa(o.owner), wide, 'finance.chief_accountant');
    await expect(unlock(asMfa(wide), o.defaultEntity)).resolves.toMatchObject({ lockedThrough: null });
  });

  it('never gives a viewer a role that grants a permission, and a viewer demoted after the grant holds none', async () => {
    const o = await org();
    await expect(o.assign(asMfa(o.owner), o.viewer, 'finance.chief_accountant')).rejects.toMatchObject({ code: 'ROLE_PRIVILEGED_FOR_VIEWER', status: 422 });
    await expect(
      inContext(o.owner, o.orgId, (c) => c.query(`SELECT * FROM crove_kernel.role_assignment_grant($1::uuid, 'finance.chief_accountant', NULL)`, [o.viewer])),
    ).rejects.toMatchObject({ message: 'ROLE_PRIVILEGED_FOR_VIEWER' });
    // A role without permissions is fine.
    await expect(o.assign(asMfa(o.owner), o.viewer, 'finance.viewer')).resolves.toMatchObject({ created: true });

    // A chief accountant demoted to viewer keeps the row but holds nothing: no unlock, no approval, no permission shown.
    await o.assign(asMfa(o.owner), o.chief, 'finance.chief_accountant');
    await o.exec(asUser(o.owner), 'finance.period.lock', { month: '2026-01' });
    await o.exec(asMfa(o.owner), 'kernel.member.change_role', { userId: o.chief, role: 'viewer' });
    await expect(o.exec(asMfa(o.chief), 'finance.period.unlock', { month: '2026-01', reason: 'Sửa sai sót' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(inContext(o.chief, o.orgId, (c) => c.query(`SELECT crove_finance.unlock_period('2026-01-01'::date)`))).rejects.toMatchObject({
      message: 'PERIOD_LOCK_FORBIDDEN',
    });
    await expect(o.exec(asMfa(o.chief), 'kernel.proposal.approve', { id: randomUUID(), revision: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await rt.query<{ permissions: string[] }>('kernel.org.get', {}, { actor: asUser(o.chief), orgId: o.orgId })).permissions).toEqual([]);
  });
});
