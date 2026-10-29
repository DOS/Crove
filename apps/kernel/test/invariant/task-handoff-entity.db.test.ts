// Delegation and escalation within a task's legal entity (#1788, T18 targets checked by the database) on PostgreSQL, as
// the real login roles. Since #1762 a task carries its record's legal entity under the RESTRICTIVE le_scope policy, and
// a delegated or escalated child takes its parent's. So an agent hands such a task only to a position whose holder reads
// that entity: an agent or a vacant position by its le_scope, a person by the scope enter_context seals for them (their
// role assignments), which an agent limited to some entities cannot see in full and asks the definer
// member_covers_legal_entity for. The commands refuse first (OUTSIDE_LEGAL_ENTITY, the entity-aware escalation target),
// and the task trigger refuses the same rows written straight in SQL. Org-level tasks are unaffected.
// Part of the invariant suite: keep it self-contained (package code under test, no helpers from outside
// test/invariant/). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type AgentActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

suite('delegation and escalation within the task legal entity on PostgreSQL (#1788)', () => {
  const dbName = `crove_test_task_scope_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  // Members limited to the branch, to the default entity (two of them), and one with no assignment (every entity).
  let branchManager = '';
  let defaultManager = '';
  let defaultClerk = '';
  let plainMember = '';
  let orgId = '';
  let defaultEntity = '';
  let branch = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // An agent installed from the template with the given scope under the given position, with an org-level task of its
  // own and a live run.
  async function liveAgent(leScope: string[], reportsTo: string | null) {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: TEMPLATE, leScope, reportsTo },
      { actor: asMfa(owner), orgId },
    );
    const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc chung', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    if (!started.runId) throw new Error('no run');
    const actor: AgentActor = { type: 'agent', agentId, runId: started.runId };
    return { actor, positionId, orgTask: taskId };
  }

  // A position held by a person, reporting to another.
  async function personPosition(title: string, holder: string, reportsTo: string | null) {
    const { positionId } = await app.execute<{ positionId: string }>(
      'kernel.position.create',
      { title, module: 'finance', roleKey: 'finance.accountant', reportsTo },
      { actor: asMfa(owner), orgId },
    );
    await app.execute('kernel.position.assign', { id: positionId, holder: { type: 'user', userId: holder } }, { actor: asMfa(owner), orgId });
    return positionId;
  }

  // A task about the entity (its source_ref names it, so the trigger stamps it) for the position.
  const entityTask = (entity: string, positionId: string) =>
    admin(async (c) => {
      const { rows } = await c.query<{ id: string; e: string }>(
        `INSERT INTO crove_kernel.task (org_id, title, assignee_position_id, source, source_ref, created_by_type)
         VALUES ($1, 'Việc của pháp nhân', $2, 'human', $3, 'user') RETURNING id, legal_entity_id AS e`,
        [orgId, positionId, JSON.stringify({ type: 'kernel.legal_entity', id: entity })],
      );
      expect(rows[0]?.e).toBe(entity);
      return rows[0]?.id as string;
    });

  const taskRow = (id: string) =>
    admin(
      async (c) =>
        (await c.query<{ assignee: string | null; entity: string | null }>('SELECT assignee_position_id AS assignee, legal_entity_id AS entity FROM crove_kernel.task WHERE id = $1', [id]))
          .rows[0],
    );

  // A child task written straight in SQL as the worker in the agent's context, past the command's own checks: the task
  // trigger alone decides. Always rolled back.
  async function rawChild(actor: AgentActor, parentId: string, kind: 'delegation' | 'escalation', assignee: string | null) {
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, actor.agentId, actor.runId]);
      await c.query(
        `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, parent_task_id, source, created_by_type)
         VALUES ($1, 'Thẳng', $2, $3, $4, 'human', 'agent')`,
        [orgId, kind, assignee, parentId],
      );
      return 'inserted';
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  const listed = async (userId: string) =>
    (await app.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, { actor: asUser(userId), orgId })).tasks.map((t) => t.id);

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
    const runtimeFor = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      return new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    };
    app = runtimeFor('crove_app', 'test-app-pw');
    worker = runtimeFor('crove_worker', 'test-worker-pw');
    const db = createDb(pools[0] as pg.Pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 't1788', subject: randomUUID(), email: `${name}@t1788.test`, name: null });
    owner = await person('owner');
    branchManager = await person('branch-manager');
    defaultManager = await person('default-manager');
    defaultClerk = await person('default-clerk');
    plainMember = await person('plain-member');
    ({ orgId } = await createOrg(app, asUser(owner), 'T1788'));
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      for (const user of [branchManager, defaultManager, defaultClerk, plainMember]) {
        await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, user]);
      }
      for (const [user, entity] of [
        [branchManager, branch],
        [defaultManager, defaultEntity],
        [defaultClerk, defaultEntity],
      ] as const) {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          user,
          entity,
          owner,
        ]);
      }
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('delegates a task only to a position whose holder reads its legal entity; org-level tasks go anywhere below', async () => {
    const lead = await liveAgent([branch], null);
    const as = { actor: lead.actor, orgId };
    // Below the branch agent: agents and people of either entity, a person with no assignment, and a vacant position
    // (whose scope is the org's default entity, for an agent placed there later).
    const agentOfDefault = await liveAgent([defaultEntity], lead.positionId);
    const agentOfBranch = await liveAgent([branch], lead.positionId);
    const personOfDefault = await personPosition('Kế toán trụ sở', defaultManager, lead.positionId);
    const personOfBranch = await personPosition('Kế toán chi nhánh', branchManager, lead.positionId);
    const personOfAll = await personPosition('Kế toán chung', plainMember, lead.positionId);
    const { positionId: vacant } = await app.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Chưa có người', module: 'finance', roleKey: 'finance.accountant', reportsTo: lead.positionId },
      { actor: asMfa(owner), orgId },
    );

    const branchTask = await entityTask(branch, lead.positionId);
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: branchTask }, as);
    for (const target of [agentOfDefault.positionId, personOfDefault, vacant]) {
      await expect(worker.execute('kernel.task.delegate', { id: branchTask, fence, assigneePositionId: target, title: 'Giao' }, as), target).rejects.toMatchObject({
        code: 'OUTSIDE_LEGAL_ENTITY',
        details: { rule: 'delegation_legal_entity' },
      });
      // The database refuses it on its own.
      expect(await rawChild(lead.actor, branchTask, 'delegation', target)).toBe('AGENT_DELEGATION_SUBTREE');
    }
    expect(await rawChild(lead.actor, branchTask, 'delegation', personOfBranch)).toBe('inserted');
    const delegated: Record<string, string> = {};
    for (const target of [agentOfBranch.positionId, personOfBranch, personOfAll]) {
      const { taskId } = await worker.execute<{ taskId: string }>('kernel.task.delegate', { id: branchTask, fence, assigneePositionId: target, title: 'Giao' }, as);
      expect(await taskRow(taskId)).toEqual({ assignee: target, entity: branch });
      delegated[target] = taskId;
    }
    // Each holder can see what it was given.
    expect(await listed(branchManager)).toContain(delegated[personOfBranch]);
    expect(await listed(plainMember)).toContain(delegated[personOfAll]);
    const seenByAgent = await worker.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, { actor: agentOfBranch.actor, orgId });
    expect(seenByAgent.tasks.map((t) => t.id)).toContain(delegated[agentOfBranch.positionId]);

    // An org-level task goes to any position below, whatever its scope.
    const { fence: orgFence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: lead.orgTask }, as);
    for (const target of [agentOfDefault.positionId, personOfDefault, vacant]) {
      const { taskId } = await worker.execute<{ taskId: string }>('kernel.task.delegate', { id: lead.orgTask, fence: orgFence, assigneePositionId: target, title: 'Giao chung' }, as);
      expect(await taskRow(taskId)).toEqual({ assignee: target, entity: null });
    }
  });

  it('escalates to the nearest person up the chart who reads the task, else the owner; org-level tasks to the nearest person', async () => {
    // The branch's manager on top, the default entity's manager below, the branch agent below that.
    const top = await personPosition('Giám đốc chi nhánh', branchManager, null);
    const middle = await personPosition('Trưởng phòng trụ sở', defaultManager, top);
    const agent = await liveAgent([branch], middle);
    const as = { actor: agent.actor, orgId };

    const branchTask = await entityTask(branch, agent.positionId);
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: branchTask }, as);
    // The database takes only the entity-aware target: not the nearest person, who cannot read the task.
    expect(await rawChild(agent.actor, branchTask, 'escalation', middle)).toBe('AGENT_ESCALATION_TARGET');
    expect(await rawChild(agent.actor, branchTask, 'escalation', top)).toBe('inserted');
    const up = await worker.execute<{ taskId: string; assigneePositionId: string | null }>('kernel.task.escalate', { id: branchTask, fence, title: 'Cần duyệt', reason: 'Vượt quyền' }, as);
    // The default entity's manager is skipped: the task lands with the branch's.
    expect(up.assigneePositionId).toBe(top);
    expect(await taskRow(up.taskId)).toEqual({ assignee: top, entity: branch });
    expect(await listed(branchManager)).toContain(up.taskId);
    expect(await listed(defaultManager)).not.toContain(up.taskId);

    // An org-level task still goes to the nearest person.
    const { fence: orgFence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: agent.orgTask }, as);
    const orgUp = await worker.execute<{ assigneePositionId: string | null }>('kernel.task.escalate', { id: agent.orgTask, fence: orgFence, title: 'Cần duyệt', reason: 'Vượt quyền' }, as);
    expect(orgUp.assigneePositionId).toBe(middle);

    // Nobody up the chart reads the branch: the owner gets it (no assignee).
    const alone = await personPosition('Kế toán trưởng trụ sở', defaultClerk, null);
    const lonely = await liveAgent([branch], alone);
    const lonelyTask = await entityTask(branch, lonely.positionId);
    const { fence: lonelyFence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: lonelyTask }, { actor: lonely.actor, orgId });
    const toOwner = await worker.execute<{ taskId: string; assigneePositionId: string | null }>(
      'kernel.task.escalate',
      { id: lonelyTask, fence: lonelyFence, title: 'Cần duyệt', reason: 'Không ai xem được' },
      { actor: lonely.actor, orgId },
    );
    expect(toOwner.assigneePositionId).toBeNull();
    expect(await listed(owner)).toContain(toOwner.taskId);
  });

  it('lets only the worker run the three helpers (EXECUTE matrix), and answers a person scope only for an entity the caller reads', async () => {
    const functions = [
      'crove_kernel.member_covers_legal_entity(uuid,uuid)',
      'crove_kernel.position_reads_legal_entity(uuid,uuid,uuid)',
      'crove_kernel.task_escalation_target(uuid,uuid,uuid)',
    ];
    const matrix = await admin(async (c) =>
      (
        await c.query<{ fn: string; callers: string[]; definer: boolean; config: string[] }>(
          `SELECT f AS fn, p.prosecdef AS definer, p.proconfig AS config,
                  ARRAY(SELECT r FROM unnest(ARRAY['PUBLIC', 'crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
                        WHERE CASE r WHEN 'PUBLIC' THEN EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
                                     ELSE has_function_privilege(r, p.oid, 'EXECUTE') END) AS callers
           FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid = f::regprocedure ORDER BY 1`,
          [functions],
        )
      ).rows,
    );
    expect(matrix).toEqual(
      functions.map((fn) => ({ fn, definer: fn.includes('member_covers'), config: ['search_path=pg_catalog, pg_temp'], callers: ['crove_worker'] })),
    );

    const agent = await liveAgent([branch], null);
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.actor.agentId, agent.actor.runId]);
      const covers = async (user: string, entity: string | null) =>
        (await c.query<{ v: boolean }>('SELECT crove_kernel.member_covers_legal_entity($1::uuid, $2::uuid) AS v', [user, entity])).rows[0]?.v;
      // The branch agent sees none of the default entity's assignments, yet learns that its manager is limited elsewhere.
      expect(await c.query('SELECT 1 FROM crove_kernel.role_assignment WHERE user_id = $1', [defaultManager]).then((r) => r.rowCount)).toBe(0);
      expect(await covers(defaultManager, branch)).toBe(false);
      expect(await covers(branchManager, branch)).toBe(true);
      expect(await covers(plainMember, branch)).toBe(true);
      expect(await covers(owner, branch)).toBe(true);
      expect(await covers(defaultManager, null)).toBe(true);
      // An entity outside the caller's own scope, a stranger and an unknown id answer false.
      expect(await covers(defaultManager, defaultEntity)).toBe(false);
      expect(await covers(owner, defaultEntity)).toBe(false);
      expect(await covers(randomUUID(), branch)).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  });

  // Each branch of member_covers_legal_entity has a holder that only it lets through, or one it must not (#1804): a
  // member with assignments in two entities, one with an org-wide assignment beside an entity one, an owner and an admin
  // who kept an entity assignment from before a promotion, and a holder removed from the org (the seat vacated by
  // position_holder_user_fk, so no position keeps them).
  it('covers a holder through any of their entity assignments, an org-wide one or their role, and never a removed member (#1804)', async () => {
    const person = (name: string) =>
      upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 't1804', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@t1804.test`, name: null });
    const [twoEntities, orgWideToo, scopedAdmin, scopedOwner, removed] = [
      await person('two-entities'),
      await person('org-wide-too'),
      await person('scoped-admin'),
      await person('scoped-owner'),
      await person('removed'),
    ];
    await admin(async (c) => {
      for (const [user, role] of [
        [twoEntities, 'member'],
        [orgWideToo, 'member'],
        [scopedAdmin, 'admin'],
        [scopedOwner, 'owner'],
        [removed, 'member'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      }
      const assign = (user: string, roleKey: string, entity: string | null) =>
        c.query('INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, $3, $4, $5)', [
          orgId,
          user,
          roleKey,
          entity,
          owner,
        ]);
      await assign(twoEntities, 'external_accountant', defaultEntity);
      await assign(twoEntities, 'external_accountant', branch);
      await assign(orgWideToo, 'finance.viewer', null);
      await assign(orgWideToo, 'external_accountant', defaultEntity);
      await assign(scopedAdmin, 'external_accountant', defaultEntity);
      await assign(scopedOwner, 'external_accountant', defaultEntity);
      await assign(removed, 'external_accountant', branch);
    });
    const seat = await personPosition('Kế toán sẽ nghỉ', removed, null);
    await app.execute('kernel.member.remove', { userId: removed }, { actor: asMfa(owner), orgId });
    expect(
      await admin(async (c) => (await c.query<{ holder: string | null }>('SELECT holder_user_id AS holder FROM crove_kernel.position WHERE org_id = $1 AND id = $2', [orgId, seat])).rows[0]?.holder),
    ).toBeNull();

    // An agent that reads both entities asks for each holder.
    const agent = await liveAgent([branch, defaultEntity], null);
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.actor.agentId, agent.actor.runId]);
      const covers = async (user: string, entity: string | null) =>
        (await c.query<{ v: boolean }>('SELECT crove_kernel.member_covers_legal_entity($1::uuid, $2::uuid) AS v', [user, entity])).rows[0]?.v;
      // Two entity assignments: either entity, through its own row.
      expect(await covers(twoEntities, branch)).toBe(true);
      expect(await covers(twoEntities, defaultEntity)).toBe(true);
      // An org-wide assignment beside an entity one reads every entity: the branch only through the org-wide row.
      expect(await covers(orgWideToo, branch)).toBe(true);
      expect(await covers(orgWideToo, defaultEntity)).toBe(true);
      // An owner or admin reads every entity whatever assignment they kept: the branch only through their role.
      expect(await covers(scopedAdmin, branch)).toBe(true);
      expect(await covers(scopedOwner, branch)).toBe(true);
      // A removed member covers nothing: their assignments went with the membership.
      expect(await covers(removed, branch)).toBe(false);
      expect(await covers(removed, null)).toBe(false);
      // The members limited to one entity still read only that one.
      expect(await covers(defaultManager, branch)).toBe(false);
      expect(await covers(branchManager, defaultEntity)).toBe(false);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  });
});
