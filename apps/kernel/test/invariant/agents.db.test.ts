// Invariant suite (Decision 7), External-tenant gate T18 (ADR-0029, issue #79): agents cannot raise their own power,
// launder approvals or leave their org. Against a real PostgreSQL 17, as the real login roles: the API role
// (crove_app) for users, the worker role (crove_worker) for system and agent actors. Keep this file self-contained:
// import package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { agentCommands, createOrg, decideApproval, eligibleApprovers, kernelCommands, kernelQueries, runAgentWake, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, type Actor, type AgentActor, type AgentRuntime, type CommandDef, type Risk } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

const suite = ADMIN ? describe : describe.skip;

// Commands an agent may run at all; every other command declares no agent access.
const AGENT_COMMANDS = ['kernel.task.checkout', 'kernel.task.comment', 'kernel.task.set_status', 'kernel.task.escalate', 'kernel.task.delegate'];

// Probe commands for the runtime's agent policy, each declaring agent access for any role.
const probe = (name: string, risk: Risk, taint?: 'propagate'): CommandDef<unknown, unknown> =>
  defineCommand({
    name,
    input: z.object({}),
    risk,
    access: [],
    agent: { roles: 'any', ...(taint ? { taint } : {}) },
    handler: async () => ({ ok: true }),
  }) as CommandDef<unknown, unknown>;
// t18.whoami: who the runtime runs a command as, and an activity row written in that context.
const whoami = defineCommand({
  name: 't18.whoami',
  input: z.object({ recordId: z.string() }),
  risk: 'R0',
  access: [],
  agent: { roles: 'any' },
  handler: async (ctx, input) => {
    await ctx.activity('t18.probe', input.recordId, 't18.whoami', 'probe');
    return { actor: ctx.actor, orgId: ctx.orgId, positionId: ctx.agent?.positionId ?? null };
  },
}) as CommandDef<unknown, unknown>;
const PROBES = [
  probe('t18.r1', 'R1'),
  probe('t18.r1_propagate', 'R1', 'propagate'),
  probe('t18.r2', 'R2', 'propagate'),
  probe('t18.r3', 'R3', 'propagate'),
  probe('t18.r0', 'R0'),
  whoami,
];
// Every table no agent context may write (refuse_agent_write), issue #79 and #244.
const AGENT_READ_ONLY_TABLES = [
  'crove_finance.journal_entry',
  'crove_finance.journal_line',
  'crove_finance.vendor_account_rule',
  'crove_kernel.agent',
  'crove_kernel.ai_run',
  'crove_kernel.budget_policy',
  'crove_kernel.kill_switch',
  'crove_kernel.member_invite',
  'crove_kernel.position',
  'crove_kernel.proposal',
  'crove_kernel.tenant',
  'crove_kernel.tenant_member',
];

suite('agents in the org chart: T18 negative tests on PostgreSQL (ADR-0029)', () => {
  const dbName = `crove_test_t18_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  let ownerB = '';
  let orgA = '';
  let orgB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // An agent installed from the template, holding its own position, with a live run (started through a task that
  // wakes it). Returns the agent actor and its position.
  async function liveAgent(orgId: string, ownerId: string, reportsTo: string | null = null) {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: TEMPLATE, reportsTo },
      { actor: asMfa(ownerId), orgId },
    );
    const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(ownerId), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    if (!started.runId) throw new Error('no run');
    const actor: AgentActor = { type: 'agent', agentId, runId: started.runId };
    return { actor, agentId, positionId, taskId, runId: started.runId };
  }

  async function auditRows(orgId: string, command: string) {
    return withAdmin(async (c) => {
      const { rows } = await c.query<{ actor_type: string; actor_id: string; outcome: string; detail: Record<string, unknown> }>(
        'SELECT actor_type, actor_id, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at, id',
        [orgId, command],
      );
      return rows;
    });
  }

  // Runs SQL as crove_worker inside the agent's context, always rolled back.
  async function inAgentContext<T>(orgId: string, actor: AgentActor, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, actor.agentId, actor.runId]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
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
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const target = createDb(pool);
      return {
        db: target,
        runtime: new Runtime(target).register({
          commands: [...kernelCommands, ...financeCommands, ...PROBES],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
        }),
      };
    };
    const api = runtimeFor(appUrl);
    db = api.db;
    app = api.runtime;
    worker = runtimeFor(workerUrl).runtime;
    owner = await upsertIdentity(db, { issuer: 't18', subject: 'owner', email: 'owner@t18.test', name: null });
    ownerB = await upsertIdentity(db, { issuer: 't18', subject: 'other', email: 'other@t18.test', name: null });
    orgA = (await createOrg(app, asUser(owner), 'T18 A')).orgId;
    orgB = (await createOrg(app, asUser(ownerB), 'T18 B')).orgId;
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('declares agent access only on the task commands, never on chart, agent, budget, kill-switch or approval commands', () => {
    const declared = kernelCommands.filter((c) => (c as CommandDef<unknown, unknown>).agent).map((c) => c.name);
    expect(declared.sort()).toEqual([...AGENT_COMMANDS].sort());
    expect(financeCommands.filter((c) => (c as CommandDef<unknown, unknown>).agent)).toEqual([]);
    for (const name of AGENT_COMMANDS) {
      const def = agentCommands.find((c) => c.name === name) as CommandDef<unknown, unknown>;
      expect(def.risk, name).toBe('R1');
    }
  });

  it('refuses an agent every position, holder, template, max_risk, budget and kill-switch command, audited as denied', async () => {
    const { actor, agentId, positionId } = await liveAgent(orgA, owner);
    const attempts: Array<[string, unknown]> = [
      ['kernel.position.create', { title: 'Giám đốc AI', module: 'finance', roleKey: 'owner' }],
      ['kernel.position.update', { id: positionId, roleKey: 'finance.admin' }],
      ['kernel.position.update', { id: positionId, reportsTo: null, status: 'active' }],
      ['kernel.position.assign', { id: positionId, holder: { type: 'user', userId: owner } }],
      ['kernel.agent.template.install', { templateKey: TEMPLATE }],
      ['kernel.agent.update', { id: agentId, maxRisk: 'R2' }],
      ['kernel.agent.update', { id: agentId, status: 'active', dailyRunCap: 10000 }],
      ['kernel.agent.budget.set', { scope: 'agent', target: agentId, monthlyLimit: '999999' }],
      ['kernel.agent.kill_switch.engage', { scope: 'org', target: '*' }],
      ['kernel.agent.kill_switch.release', { id: randomUUID() }],
      ['kernel.member.change_role', { userId: owner, role: 'admin' }],
      ['kernel.proposal.approve', { id: randomUUID(), revision: 1 }],
      ['kernel.task.create', { title: 'Tự giao việc', assigneePositionId: null }],
      ['kernel.agent.run.start', { agentId }],
      ['kernel.agent.run.finish', { runId: actor.runId, outcome: 'succeeded' }],
      ['kernel.agent.dispatch_event', { eventId: randomUUID() }],
    ];
    for (const [name, input] of attempts) {
      await expect(worker.execute(name, input, { actor, orgId: orgA }), name).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    const denied = await auditRows(orgA, 'kernel.agent.update');
    expect(denied.filter((r) => r.actor_type === 'agent')).toEqual([
      expect.objectContaining({ actor_id: agentId, outcome: 'denied', detail: expect.objectContaining({ code: 'FORBIDDEN', rule: 'agent_access', agentRun: actor.runId }) }),
      expect.objectContaining({ actor_id: agentId, outcome: 'denied' }),
    ]);
    // The refusals count against the agent itself (refusal tally), not against a user or the system.
    const tally = await withAdmin(async (c) =>
      (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.refusal_tally WHERE org_id = $1 AND actor_key = $2`, [orgA, `agent:${agentId}`])).rows[0],
    );
    expect(tally?.n).toBeGreaterThan(0);
    // Nothing changed.
    const state = await withAdmin(async (c) => {
      const agent = await c.query('SELECT max_risk, status, daily_run_cap FROM crove_kernel.agent WHERE id = $1', [agentId]);
      const position = await c.query('SELECT role_key, holder_agent_id FROM crove_kernel.position WHERE id = $1', [positionId]);
      const budgets = await c.query('SELECT count(*)::int AS n FROM crove_kernel.budget_policy WHERE org_id = $1', [orgA]);
      return { agent: agent.rows[0], position: position.rows[0], budgets: budgets.rows[0] };
    });
    expect(state).toEqual({
      agent: { max_risk: 'R1', status: 'active', daily_run_cap: 50 },
      position: { role_key: TEMPLATE, holder_agent_id: agentId },
      budgets: { n: 0 },
    });
    // A system actor does not reach agent-only commands either.
    await expect(worker.execute('kernel.task.checkout', { id: randomUUID() }, { actor: SYSTEM, orgId: orgA })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Queries the agent's role does not declare are refused too.
    for (const name of ['kernel.chart.get', 'kernel.inbox.list', 'kernel.org.get']) {
      await expect(worker.query(name, {}, { actor, orgId: orgA }), name).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('refuses writes to the chart, agents, runs, budgets and kill switches in an agent context, whatever the statement', async () => {
    const { actor, agentId, positionId } = await liveAgent(orgA, owner);
    // A switch on a module no agent here belongs to, for the release attempt (row triggers fire per row).
    const switchId = await withAdmin(async (c) =>
      (await c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'module', 'hr', $2) RETURNING id`, [orgA, owner])).rows[0].id as string,
    );
    const statements: Array<[string, unknown[]]> = [
      [`INSERT INTO crove_kernel.position (org_id, title, module, role_key) VALUES ($1, 'x', 'finance', 'owner')`, [orgA]],
      [`UPDATE crove_kernel.position SET role_key = 'owner' WHERE id = $1`, [positionId]],
      [`UPDATE crove_kernel.position SET holder_agent_id = NULL WHERE id = $1`, [positionId]],
      [`UPDATE crove_kernel.agent SET max_risk = 'R2' WHERE id = $1`, [agentId]],
      [`INSERT INTO crove_kernel.agent (org_id, template_key, display_name, created_by) VALUES ($1, '${TEMPLATE}', 'x', $2)`, [orgA, agentId]],
      [`UPDATE crove_kernel.ai_run SET expires_at = expires_at + interval '1 day' WHERE id = $1`, [actor.runId]],
      [`INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, updated_by) VALUES ($1, 'org', '*', 1, $2)`, [orgA, agentId]],
      [`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'agent', $2::text, $2::uuid)`, [orgA, agentId]],
      [`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $1 WHERE id = $2`, [agentId, switchId]],
    ];
    for (const [text, values] of statements) {
      await expect(
        inAgentContext(orgA, actor, (c) => c.query(text, values)),
        text,
      ).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
    }
  });

  it('applies P02, P03, P05 and P06 to agents: no R3 or R2, nothing above max_risk, no tainted write that does not propagate taint', async () => {
    const { actor, agentId } = await liveAgent(orgA, owner);
    // The run is tainted only when a claimed wake-up was; this one came from a human task.
    const run = async () => withAdmin(async (c) => (await c.query('SELECT tainted FROM crove_kernel.ai_run WHERE id = $1', [actor.runId])).rows[0]);
    expect(await run()).toEqual({ tainted: false });
    const as = { actor, orgId: orgA };
    await expect(worker.execute('t18.r3', {}, as)).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'P05' } });
    await expect(worker.execute('t18.r2', {}, as)).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'P06' } });
    await expect(worker.execute('t18.r1', {}, as)).resolves.toEqual({ ok: true });

    // max_risk R0 (set by the owner): every R1 command is refused.
    await app.execute('kernel.agent.update', { id: agentId, maxRisk: 'R0' }, { actor: asMfa(owner), orgId: orgA });
    await expect(worker.execute('t18.r1', {}, as)).rejects.toMatchObject({ details: { rule: 'P02' } });
    await expect(worker.execute('t18.r0', {}, as)).resolves.toEqual({ ok: true });
    await app.execute('kernel.agent.update', { id: agentId, maxRisk: 'R1' }, { actor: asMfa(owner), orgId: orgA });

    // A tainted run: only commands that propagate the taint run at R1.
    await withAdmin((c) => c.query('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [actor.runId]));
    await expect(worker.execute('t18.r1', {}, as)).rejects.toMatchObject({ details: { rule: 'P03' } });
    await expect(worker.execute('t18.r1_propagate', {}, as)).resolves.toEqual({ ok: true });
    await expect(worker.execute('t18.r0', {}, as)).resolves.toEqual({ ok: true });
  });

  it('never lets an agent approve, and P10 and P12 count only humans', async () => {
    const { actor } = await liveAgent(orgA, owner);
    // The org's only human is the owner; an agent holds a chief accountant position. Eligible approvers: the owner.
    const snapshot = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${owner}::uuid, ${orgA}::uuid)`.execute(trx);
      return eligibleApprovers(trx, orgA, 'finance.purchase.record');
    });
    expect(snapshot).toEqual([owner]);
    const proposal = { command: 'finance.purchase.record', status: 'pending', eligible_approvers: [owner, actor.agentId], authors: [] };
    const asAgent = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${owner}::uuid, ${orgA}::uuid)`.execute(trx);
      return {
        agent: await decideApproval(trx, orgA, actor as Actor, proposal, { lock: false }),
        owner: await decideApproval(trx, orgA, asUser(owner), proposal, { lock: false }),
      };
    });
    expect(asAgent.agent.reason).toBe('not_eligible');
    // Even listed in a snapshot, an agent is not a member, so it neither approves nor counts for four-eyes.
    expect(asAgent.owner).toMatchObject({ reason: 'ok', eligibleCount: 1 });
    await expect(worker.execute('kernel.proposal.approve', { id: randomUUID(), revision: 1 }, { actor, orgId: orgA })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses every write of a run that lost its checkout lease, and of a stale fencing token', async () => {
    const first = await liveAgent(orgA, owner);
    const as1 = { actor: first.actor, orgId: orgA };
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: first.taskId }, as1);
    await expect(worker.execute('kernel.task.comment', { id: first.taskId, fence, body: 'đang xử lý' }, as1)).resolves.toMatchObject({ commentId: expect.any(String) });

    // The run outlives its expiry (a stalled worker): it cannot enter any more, and a new run takes the task.
    await withAdmin((c) =>
      c.query(`UPDATE crove_kernel.ai_run SET started_at = now() - interval '1 hour', expires_at = now() - interval '30 minutes' WHERE id = $1`, [first.runId]),
    );
    await expect(worker.execute('kernel.task.comment', { id: first.taskId, fence, body: 'muộn' }, as1)).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_LIVE' });
    await app.execute('kernel.task.create', { title: 'Đánh thức lại', assigneePositionId: first.positionId }, { actor: asUser(owner), orgId: orgA });
    const second = await worker.execute<{ runId: string }>('kernel.agent.run.start', { agentId: first.agentId }, { actor: SYSTEM, orgId: orgA });
    expect(second.runId).toEqual(expect.any(String));
    const states = await withAdmin(async (c) => (await c.query('SELECT status FROM crove_kernel.ai_run WHERE id = $1', [first.runId])).rows[0]);
    expect(states).toEqual({ status: 'expired' });
    const as2 = { actor: { type: 'agent' as const, agentId: first.agentId, runId: second.runId }, orgId: orgA };
    const taken = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: first.taskId }, as2);
    expect(Number(taken.fence)).toBe(Number(fence) + 1);
    // The old token is refused even within the new run; the current one works.
    await expect(worker.execute('kernel.task.comment', { id: first.taskId, fence, body: 'cũ' }, as2)).rejects.toMatchObject({ code: 'LEASE_LOST', status: 409 });
    await expect(worker.execute('kernel.task.set_status', { id: first.taskId, fence, status: 'done' }, as2)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(worker.execute('kernel.task.comment', { id: first.taskId, fence: taken.fence, body: 'mới' }, as2)).resolves.toBeDefined();

    // In the database: an agent context writes no task or comment it does not hold, and cannot move a task.
    const open = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Chưa nhận', assigneePositionId: first.positionId }, { actor: asUser(owner), orgId: orgA });
    const leaseRequired = { code: '42501', message: 'AGENT_LEASE_REQUIRED' };
    await expect(inAgentContext(orgA, as2.actor, (c) => c.query(`UPDATE crove_kernel.task SET status = 'done' WHERE id = $1`, [open.taskId]))).rejects.toMatchObject(leaseRequired);
    await expect(
      inAgentContext(orgA, as2.actor, (c) => c.query(`INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'x', 'agent')`, [orgA, open.taskId])),
    ).rejects.toMatchObject(leaseRequired);
    await expect(
      inAgentContext(orgA, as2.actor, (c) => c.query(`UPDATE crove_kernel.task SET lock_expires_at = lock_expires_at + interval '1 day' WHERE id = $1`, [first.taskId])),
    ).rejects.toMatchObject(leaseRequired);
    await expect(
      inAgentContext(orgA, as2.actor, (c) => c.query(`UPDATE crove_kernel.task SET assignee_position_id = NULL WHERE id = $1`, [first.taskId])),
    ).rejects.toMatchObject({ code: '42501', message: 'AGENT_TASK_FIELD' });
  });

  it('vacates the position when its member is removed', async () => {
    const email = `m-${randomUUID().slice(0, 8)}@t18.test`;
    const memberId = await upsertIdentity(db, { issuer: 't18', subject: `m-${randomUUID()}`, email, name: null });
    const { acceptPath } = await app.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role: 'member' }, { actor: asMfa(owner), orgId: orgA });
    await app.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(memberId) });
    const { positionId } = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Kế toán viên', module: 'finance', roleKey: 'finance.accountant' }, { actor: asMfa(owner), orgId: orgA });
    await app.execute('kernel.position.assign', { id: positionId, holder: { type: 'user', userId: memberId } }, { actor: asMfa(owner), orgId: orgA });
    const holder = async () => withAdmin(async (c) => (await c.query('SELECT holder_user_id FROM crove_kernel.position WHERE id = $1', [positionId])).rows[0]);
    expect(await holder()).toEqual({ holder_user_id: memberId });
    await app.execute('kernel.member.remove', { userId: memberId }, { actor: asMfa(owner), orgId: orgA });
    expect(await holder()).toEqual({ holder_user_id: null });
  });

  it('rejects a reports_to cycle, also between two concurrent transactions', async () => {
    const make = async (title: string) =>
      (await app.execute<{ positionId: string }>('kernel.position.create', { title, module: 'finance', roleKey: 'finance.accountant' }, { actor: asMfa(owner), orgId: orgA })).positionId;
    const p = await make('P');
    const q = await make('Q');
    const r = await make('R');
    const update = (id: string, reportsTo: string | null) => app.execute('kernel.position.update', { id, reportsTo }, { actor: asMfa(owner), orgId: orgA });
    await expect(update(p, p)).rejects.toMatchObject({ code: 'POSITION_CYCLE' });
    await update(q, p);
    await update(r, q);
    await expect(update(p, r)).rejects.toMatchObject({ code: 'POSITION_CYCLE', status: 422 });

    // Two transactions: S -> T and T -> S at once. The second waits for the per-org lock and sees the first.
    const s = await make('S');
    const t = await make('T');
    const one = new pg.Client({ connectionString: appUrl });
    const two = new pg.Client({ connectionString: appUrl });
    await one.connect();
    await two.connect();
    try {
      for (const c of [one, two]) {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner, orgA]);
      }
      await one.query('UPDATE crove_kernel.position SET reports_to = $1 WHERE id = $2', [t, s]);
      const second = two.query('UPDATE crove_kernel.position SET reports_to = $1 WHERE id = $2', [s, t]).then(
        () => 'updated',
        (e: { message: string }) => e.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await one.query('COMMIT');
      expect(await second).toBe('POSITION_CYCLE');
      await two.query('ROLLBACK');
    } finally {
      await one.end();
      await two.end();
    }
    // Other isolation levels would walk an old snapshot, so they are refused.
    await expect(
      db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_context(${owner}::uuid, ${orgA}::uuid)`.execute(trx);
        await sql`UPDATE crove_kernel.position SET reports_to = ${p}::uuid WHERE id = ${s}::uuid`.execute(trx);
      }),
    ).rejects.toThrow(/POSITION_CHART_ISOLATION/);
  });

  it('keeps an agent in its org: entry is derived from the run, worker only, and reads only its own tasks', async () => {
    const { actor, positionId } = await liveAgent(orgA, owner);
    // The run's org is the only org the agent enters.
    await expect(worker.query('kernel.task.list', {}, { actor, orgId: orgB })).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_LIVE' });
    // Only the worker login role may enter an agent context (EXECUTE and session_user).
    const can = await withAdmin(async (c) => {
      const { rows } = await c.query<{ role: string; can: boolean }>(
        `SELECT r AS role, has_function_privilege(r, 'crove_kernel.enter_agent_context(uuid,uuid,uuid)', 'EXECUTE') AS can
         FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r ORDER BY 1`,
      );
      return Object.fromEntries(rows.map((row) => [row.role, row.can]));
    });
    expect(can).toEqual({ crove_app: false, crove_definer_tenant: false, crove_tenant: false, crove_worker: true });
    await expect(app.query('kernel.task.list', {}, { actor, orgId: orgA })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(app.execute('kernel.task.checkout', { id: randomUUID() }, { actor, orgId: orgA })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('GRANT EXECUTE ON FUNCTION crove_kernel.enter_agent_context(uuid,uuid,uuid) TO crove_app');
        await c.query('SET SESSION AUTHORIZATION crove_app');
        await expect(c.query('SELECT crove_kernel.enter_agent_context($1, $2, $3)', [orgA, actor.agentId, actor.runId])).rejects.toMatchObject({
          message: 'AGENT_CONTEXT_WORKER_ONLY',
        });
      } finally {
        await c.query('ROLLBACK');
      }
    });
    // Another position's task is invisible to the agent.
    const other = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Khác', module: 'finance', roleKey: 'finance.accountant' }, { actor: asMfa(owner), orgId: orgA });
    const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Không phải của AI', assigneePositionId: other.positionId }, { actor: asUser(owner), orgId: orgA });
    const { tasks } = await worker.query<{ tasks: Array<{ assigneePositionId: string }> }>('kernel.task.list', { positionId: other.positionId }, { actor, orgId: orgA });
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.assigneePositionId === positionId)).toBe(true);
    await expect(worker.query('kernel.task.get', { id: taskId }, { actor, orgId: orgA })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(worker.execute('kernel.task.checkout', { id: taskId }, { actor, orgId: orgA })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('delegates only down the subtree; escalations inherit depth and taint', async () => {
    const boss = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Trưởng phòng', module: 'finance', roleKey: 'finance.accountant' }, { actor: asMfa(owner), orgId: orgA });
    await app.execute('kernel.position.assign', { id: boss.positionId, holder: { type: 'user', userId: owner } }, { actor: asMfa(owner), orgId: orgA });
    const { actor, positionId, taskId } = await liveAgent(orgA, owner, boss.positionId);
    const below = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Nhân viên', module: 'finance', roleKey: 'finance.accountant', reportsTo: positionId }, { actor: asMfa(owner), orgId: orgA });
    const as = { actor, orgId: orgA };
    await withAdmin((c) => c.query('UPDATE crove_kernel.task SET tainted = true WHERE id = $1', [taskId]));
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, as);
    for (const target of [boss.positionId, positionId]) {
      await expect(worker.execute('kernel.task.delegate', { id: taskId, fence, assigneePositionId: target, title: 'Giao' }, as)).rejects.toMatchObject({ code: 'OUTSIDE_SUBTREE' });
    }
    const delegated = await worker.execute<{ taskId: string }>('kernel.task.delegate', { id: taskId, fence, assigneePositionId: below.positionId, title: 'Giao xuống' }, as);
    const escalated = await worker.execute<{ taskId: string; assigneePositionId: string | null }>('kernel.task.escalate', { id: taskId, fence, title: 'Cần duyệt', reason: 'Vượt quyền' }, as);
    expect(escalated.assigneePositionId).toBe(boss.positionId);
    const rows = await withAdmin(async (c) =>
      (await c.query('SELECT id, request_depth, tainted, created_by_type, created_by_id FROM crove_kernel.task WHERE id = ANY($1::uuid[]) ORDER BY id', [[delegated.taskId, escalated.taskId]])).rows,
    );
    expect(rows).toEqual(
      [delegated.taskId, escalated.taskId].sort().map((id) => ({ id, request_depth: 1, tainted: true, created_by_type: 'agent', created_by_id: actor.agentId })),
    );
    // The parent waits and its lease is gone.
    await expect(worker.execute('kernel.task.comment', { id: taskId, fence, body: 'x' }, as)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('keeps kill-switch and budget targets canonical, so an agent id in capitals still stops the agent', async () => {
    const { actor, agentId } = await liveAgent(orgA, owner);
    await app.execute('kernel.agent.kill_switch.engage', { scope: 'agent', target: agentId.toUpperCase() }, { actor: asUser(owner), orgId: orgA });
    const stored = await withAdmin(async (c) => (await c.query('SELECT target FROM crove_kernel.kill_switch WHERE org_id = $1 AND scope = $2 AND released_at IS NULL', [orgA, 'agent'])).rows);
    expect(stored).toContainEqual({ target: agentId });
    await expect(worker.query('kernel.task.list', {}, { actor, orgId: orgA })).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_LIVE' });
    const forced = await withAdmin(async (c) =>
      (await c.query(`INSERT INTO crove_kernel.ai_run (org_id, agent_id, module, expires_at) VALUES ($1, $2, 'finance', now() + interval '5 minutes') RETURNING id`, [orgA, agentId])).rows[0].id as string,
    );
    await expect(worker.query('kernel.task.list', {}, { actor: { type: 'agent', agentId, runId: forced }, orgId: orgA })).rejects.toMatchObject({ code: 'KILL_SWITCH_ON' });
    // The tables refuse a target in any other form, whoever writes it.
    for (const table of ['kill_switch', 'budget_policy']) {
      const columns = table === 'kill_switch' ? '(org_id, scope, target, engaged_by)' : '(org_id, scope, target, updated_by)';
      const extra = table === 'kill_switch' ? '' : ', monthly_limit';
      const values = table === 'kill_switch' ? '($1, $2, $3, $4)' : '($1, $2, $3, $4, 1)';
      await expect(
        withAdmin((c) => c.query(`INSERT INTO crove_kernel.${table} ${columns.replace(')', `${extra})`)} VALUES ${values}`, [orgA, 'agent', agentId.toUpperCase(), owner])),
        table,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('stops every agent of the org with the kill switch, at once and for later runs', async () => {
    const { actor, agentId, positionId } = await liveAgent(orgB, ownerB);
    const { stoppedRuns } = await app.execute<{ stoppedRuns: number }>('kernel.agent.kill_switch.engage', { scope: 'org', target: '*' }, { actor: asUser(ownerB), orgId: orgB });
    expect(stoppedRuns).toBe(1);
    await expect(worker.query('kernel.task.list', {}, { actor, orgId: orgB })).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_LIVE' });
    await app.execute('kernel.task.create', { title: 'Sau khi dừng', assigneePositionId: positionId }, { actor: asUser(ownerB), orgId: orgB });
    await expect(worker.execute('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId: orgB })).resolves.toEqual({ runId: null, reason: 'kill_switch' });
    // A run that exists while the switch is on cannot enter either.
    const forced = await withAdmin(async (c) =>
      (await c.query(`INSERT INTO crove_kernel.ai_run (org_id, agent_id, module, expires_at) VALUES ($1, $2, 'finance', now() + interval '5 minutes') RETURNING id`, [orgB, agentId])).rows[0].id as string,
    );
    await expect(worker.query('kernel.task.list', {}, { actor: { type: 'agent', agentId, runId: forced }, orgId: orgB })).rejects.toMatchObject({ code: 'KILL_SWITCH_ON' });
  });

  // Issue #244 item 1: taint flows both ways between runs and tasks.
  it('taints a run that claims a tainted task, and hides tainted tasks from an untainted run', async () => {
    const { actor, positionId } = await liveAgent(orgA, owner);
    const as = { actor, orgId: orgA };
    const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Nội dung từ tệp', assigneePositionId: positionId }, { actor: asUser(owner), orgId: orgA });
    await withAdmin((c) => c.query('UPDATE crove_kernel.task SET tainted = true WHERE id = $1', [taskId]));
    const runTainted = async () => withAdmin(async (c) => (await c.query('SELECT tainted FROM crove_kernel.ai_run WHERE id = $1', [actor.runId])).rows[0]?.tainted as boolean);
    expect(await runTainted()).toBe(false);
    // An untainted run never reads tainted content.
    const listed = await worker.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, as);
    expect(listed.tasks.map((t) => t.id)).not.toContain(taskId);
    await expect(worker.query('kernel.task.get', { id: taskId }, as)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    // Claiming it taints the run from its next context entry: P03 now refuses a write that does not propagate taint.
    await expect(worker.execute('t18.r1', {}, as)).resolves.toEqual({ ok: true });
    await worker.execute('kernel.task.checkout', { id: taskId }, as);
    expect(await runTainted()).toBe(true);
    await expect(worker.execute('t18.r1', {}, as)).rejects.toMatchObject({ details: { rule: 'P03' } });
    expect((await worker.query<{ tasks: Array<{ id: string }> }>('kernel.task.list', {}, as)).tasks.map((t) => t.id)).toContain(taskId);
  });

  it('taints every task a tainted run writes, and an agent never clears a taint', async () => {
    const { actor, positionId, taskId } = await liveAgent(orgA, owner);
    const as = { actor, orgId: orgA };
    const second = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc hai', assigneePositionId: positionId }, { actor: asUser(owner), orgId: orgA });
    const first = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, as);
    const other = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: second.taskId }, as);
    const taint = async (id: string) => withAdmin(async (c) => (await c.query('SELECT tainted FROM crove_kernel.task WHERE id = $1', [id])).rows[0]?.tainted as boolean);
    expect([await taint(taskId), await taint(second.taskId)]).toEqual([false, false]);
    // The run turns tainted (it read a tainted wake-up's content, say).
    await withAdmin((c) => c.query('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [actor.runId]));
    await worker.execute('kernel.task.comment', { id: taskId, fence: first.fence, body: 'Từ nội dung chưa tin cậy' }, as);
    expect(await taint(taskId)).toBe(true);
    await worker.execute('kernel.task.set_status', { id: second.taskId, fence: other.fence, status: 'in_review' }, as);
    expect(await taint(second.taskId)).toBe(true);
    // In the database, whatever the statement: a held task's taint cannot be cleared by the agent.
    const kept = await inAgentContext(orgA, actor, async (c) =>
      (await c.query<{ tainted: boolean }>('UPDATE crove_kernel.task SET tainted = false WHERE id = $1 RETURNING tainted', [taskId])).rows[0],
    );
    expect(kept).toEqual({ tainted: true });
  });

  it('carries a claim taint to every later write of the same transaction, so one statement batch cannot launder it', async () => {
    const { actor, positionId, taskId } = await liveAgent(orgA, owner);
    const as = { actor, orgId: orgA };
    const clean = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, as);
    const dirty = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Bẩn', assigneePositionId: positionId }, { actor: asUser(owner), orgId: orgA });
    await withAdmin((c) => c.query('UPDATE crove_kernel.task SET tainted = true WHERE id = $1', [dirty.taskId]));
    // One agent transaction: claim the tainted task (the sealed context still says untainted), then write the clean one.
    const after = await inAgentContext(orgA, actor, async (c) => {
      await c.query(
        `UPDATE crove_kernel.task SET checkout_run_id = $2, lock_expires_at = now() + interval '5 minutes', fence = fence + 1,
           status = 'in_progress' WHERE id = $1`,
        [dirty.taskId, actor.runId],
      );
      await c.query(`INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'chép lại', 'agent')`, [orgA, taskId]);
      const comment = await c.query<{ tainted: boolean }>('SELECT tainted FROM crove_kernel.task_comment WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1', [taskId]);
      const task = await c.query<{ tainted: boolean }>('SELECT tainted FROM crove_kernel.task WHERE id = $1', [taskId]);
      return { comment: comment.rows[0], task: task.rows[0] };
    });
    expect(after).toEqual({ comment: { tainted: true }, task: { tainted: true } });
    expect(clean.fence).toEqual(expect.any(String));
  });

  it('takes an agent child task provenance from its parent, never from the agent', async () => {
    const boss = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Trưởng phòng 3', module: 'finance', roleKey: 'finance.accountant' }, { actor: asMfa(owner), orgId: orgA });
    await app.execute('kernel.position.assign', { id: boss.positionId, holder: { type: 'user', userId: owner } }, { actor: asMfa(owner), orgId: orgA });
    const { actor, taskId } = await liveAgent(orgA, owner, boss.positionId);
    await worker.execute('kernel.task.checkout', { id: taskId }, { actor, orgId: orgA });
    const child = await inAgentContext(orgA, actor, async (c) =>
      (
        await c.query(
          `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, parent_task_id, source, source_ref, source_event_id,
             created_by_type, status, due, created_at)
           VALUES ($1, 'x', 'escalation', $2, $3, 'event', $4, $5, 'system', 'done', now() + interval '1 day', now() - interval '1 year')
           RETURNING source, source_ref, source_event_id, status, due, created_by_type, created_at > now() - interval '1 minute' AS fresh`,
          [orgA, boss.positionId, taskId, JSON.stringify({ type: 'kernel.proposal', id: randomUUID() }), randomUUID()],
        )
      ).rows[0],
    );
    expect(child).toEqual({ source: 'human', source_ref: null, source_event_id: null, status: 'todo', due: null, created_by_type: 'agent', fresh: true });
  });

  it('lets an agent context write its own run only to taint it', async () => {
    const { actor } = await liveAgent(orgA, owner);
    const other = await liveAgent(orgA, owner);
    // Allowed: false to true on the context's own run, nothing else changed.
    const own = await inAgentContext(orgA, actor, async (c) =>
      (await c.query<{ tainted: boolean }>('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1 RETURNING tainted', [actor.runId])).rows[0],
    );
    expect(own).toEqual({ tainted: true });
    await withAdmin((c) => c.query('UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [actor.runId]));
    const refused: Array<[string, unknown[]]> = [
      ['UPDATE crove_kernel.ai_run SET tainted = false WHERE id = $1', [actor.runId]],
      [`UPDATE crove_kernel.ai_run SET tainted = true, expires_at = expires_at + interval '1 day' WHERE id = $1`, [other.runId]],
      ['UPDATE crove_kernel.ai_run SET tainted = true WHERE id = $1', [other.runId]],
    ];
    for (const [text, values] of refused) {
      await expect(inAgentContext(orgA, actor, (c) => c.query(text, values)), text).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
    }
    // An untainted run cannot take a wider write either.
    await expect(
      inAgentContext(orgA, other.actor, (c) => c.query(`UPDATE crove_kernel.ai_run SET tainted = true, cost = 0 WHERE id = $1`, [other.runId])),
    ).resolves.toBeDefined();
    await expect(
      inAgentContext(orgA, other.actor, (c) => c.query(`UPDATE crove_kernel.ai_run SET tainted = true, error = 'x' WHERE id = $1`, [other.runId])),
    ).rejects.toMatchObject({ message: 'AGENT_FORBIDDEN' });
  });

  // Issue #244 item 3: the database checks where an agent sends work, not only the runtime.
  it('refuses an agent task insert outside its subtree, to another escalation target, or of another kind', async () => {
    const boss = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Trưởng phòng 2', module: 'finance', roleKey: 'finance.accountant' }, { actor: asMfa(owner), orgId: orgA });
    await app.execute('kernel.position.assign', { id: boss.positionId, holder: { type: 'user', userId: owner } }, { actor: asMfa(owner), orgId: orgA });
    const { actor, positionId, taskId } = await liveAgent(orgA, owner, boss.positionId);
    const below = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Nhân viên 2', module: 'finance', roleKey: 'finance.accountant', reportsTo: positionId }, { actor: asMfa(owner), orgId: orgA });
    const sideways = await app.execute<{ positionId: string }>('kernel.position.create', { title: 'Ngang hàng', module: 'finance', roleKey: 'finance.accountant', reportsTo: boss.positionId }, { actor: asMfa(owner), orgId: orgA });
    await worker.execute('kernel.task.checkout', { id: taskId }, { actor, orgId: orgA });
    const insert = (kind: string, assignee: string | null) => (c: pg.Client) =>
      c.query(
        `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, parent_task_id, source, created_by_type)
         VALUES ($1, 'x', $2, $3, $4, 'human', 'agent') RETURNING id`,
        [orgA, kind, assignee, taskId],
      );
    const refusals: Array<[string, string | null, string]> = [
      ['delegation', boss.positionId, 'AGENT_DELEGATION_SUBTREE'],
      ['delegation', positionId, 'AGENT_DELEGATION_SUBTREE'],
      ['delegation', sideways.positionId, 'AGENT_DELEGATION_SUBTREE'],
      ['delegation', null, 'AGENT_DELEGATION_SUBTREE'],
      ['escalation', null, 'AGENT_ESCALATION_TARGET'],
      ['escalation', below.positionId, 'AGENT_ESCALATION_TARGET'],
      ['escalation', sideways.positionId, 'AGENT_ESCALATION_TARGET'],
      ['general', boss.positionId, 'AGENT_TASK_KIND'],
      ['proposal_review', positionId, 'AGENT_TASK_KIND'],
    ];
    for (const [kind, assignee, message] of refusals) {
      await expect(inAgentContext(orgA, actor, insert(kind, assignee)), `${kind} -> ${assignee}`).rejects.toMatchObject({ code: '42501', message });
    }
    // The two the commands make are allowed: down the subtree, and up to the nearest human-held position.
    await expect(inAgentContext(orgA, actor, insert('delegation', below.positionId))).resolves.toMatchObject({ rowCount: 1 });
    await expect(inAgentContext(orgA, actor, insert('escalation', boss.positionId))).resolves.toMatchObject({ rowCount: 1 });
    // With no human up the chart, the escalation target is the owners (no position) and nothing else.
    await app.execute('kernel.position.assign', { id: boss.positionId, holder: null }, { actor: asMfa(owner), orgId: orgA });
    await expect(inAgentContext(orgA, actor, insert('escalation', boss.positionId))).rejects.toMatchObject({ message: 'AGENT_ESCALATION_TARGET' });
    await expect(inAgentContext(orgA, actor, insert('escalation', null))).resolves.toMatchObject({ rowCount: 1 });
  });

  it('refuses writes to the tenant, members, invites, proposals and human-confirmed finance rows in an agent context', async () => {
    const { actor } = await liveAgent(orgA, owner);
    const proposalId = await withAdmin(async (c) =>
      (await c.query(`INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload) VALUES ($1, 't18', 't18', 'rejected', 'T18', '{}') RETURNING id`, [orgA])).rows[0].id as string,
    );
    const statements: Array<[string, unknown[]]> = [
      [`UPDATE crove_kernel.tenant SET name = 'AI' WHERE org_id = $1`, [orgA]],
      [`UPDATE crove_kernel.tenant_member SET role = 'owner' WHERE org_id = $1`, [orgA]],
      [`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgA, owner]],
      [`INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by) VALUES ($1, 'ai@t18.test', 'admin', $2)`, [orgA, owner]],
      [`INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload) VALUES ($1, 't18', 't18', 'AI', '{}')`, [orgA]],
      [`UPDATE crove_kernel.proposal SET status = 'approved', decided_by = $2 WHERE id = $1`, [proposalId, owner]],
      [`INSERT INTO crove_finance.vendor_account_rule (org_id, party_id, debit_account) VALUES ($1, $2, '156')`, [orgA, randomUUID()]],
    ];
    for (const [text, values] of statements) {
      await expect(inAgentContext(orgA, actor, (c) => c.query(text, values)), text).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
    }
    // The ledger is closed to agents whoever holds the privilege: even a superuser writing in an agent context.
    await expect(
      withAdmin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgA, actor.agentId, actor.runId]);
          await c.query(`INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, current_date, 'AI', 't18', $2)`, [orgA, randomUUID()]);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
    // Every such table carries the guard on insert, update and delete.
    const guarded = await withAdmin(async (c) =>
      (
        await c.query<{ name: string }>(
          `SELECT n.nspname || '.' || c.relname AS name FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE t.tgname = 'refuse_agent_write' AND NOT t.tgisinternal AND t.tgenabled = 'O'
             AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 28) = 28
           ORDER BY 1`,
        )
      ).rows.map((r) => r.name),
    );
    expect(guarded).toEqual(AGENT_READ_ONLY_TABLES);
  });

  // Issue #244 item 8: activity rows name the agent, from the sealed context.
  it('stamps the agent on activity rows written in its context, and never lets a writer choose it', async () => {
    const { actor } = await liveAgent(orgA, owner);
    const other = await liveAgent(orgA, owner);
    const recordId = randomUUID();
    await worker.execute('t18.whoami', { recordId }, { actor, orgId: orgA });
    const rows = async (id: string) =>
      withAdmin(async (c) => (await c.query('SELECT actor_id, agent_id FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2', [orgA, id])).rows);
    expect(await rows(recordId)).toEqual([{ actor_id: null, agent_id: actor.agentId }]);
    // A direct insert in the agent context names that agent, not a user or another agent.
    const stamped = await inAgentContext(orgA, actor, async (c) =>
      (
        await c.query(
          `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id, agent_id)
           VALUES ($1, 't18', $2, 't18', 'x', $3, $4) RETURNING actor_id, agent_id`,
          [orgA, randomUUID(), owner, other.agentId],
        )
      ).rows[0],
    );
    expect(stamped).toEqual({ actor_id: null, agent_id: actor.agentId });
    // A user context cannot attribute its activity to an agent.
    const asHuman = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${owner}::uuid, ${orgA}::uuid)`.execute(trx);
      const { rows: inserted } = await sql<{ agent_id: string | null }>`
        INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id, agent_id)
        VALUES (${orgA}::uuid, 't18', ${randomUUID()}::uuid, 't18', 'x', ${owner}::uuid, ${actor.agentId}::uuid) RETURNING agent_id`.execute(trx);
      return inserted[0];
    });
    expect(asHuman).toEqual({ agent_id: null });
  });

  // Issue #244 item 2: a program gets a facade bound to its run, never the Runtime.
  it('gives an agent program only a frozen facade bound to its agent, org and run', async () => {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: TEMPLATE },
      { actor: asMfa(owner), orgId: orgA },
    );
    await app.execute('kernel.task.create', { title: 'Chạy thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId: orgA });
    let seen: AgentRuntime | null = null;
    let answers: unknown[] = [];
    const program = async (agent: AgentRuntime) => {
      seen = agent;
      // Options the facade does not take (an actor, an org) are ignored: it always runs as its own agent and org.
      const forged = { actor: SYSTEM, orgId: orgB } as unknown as { idempotencyKey?: string };
      answers = [await agent.execute('t18.whoami', { recordId: randomUUID() }), await agent.execute('t18.whoami', { recordId: randomUUID() }, forged)];
    };
    const result = await runAgentWake({ runtime: worker, programs: { [TEMPLATE]: program } }, orgA, agentId);
    expect(result).toMatchObject({ outcome: 'succeeded' });
    const facade = seen as unknown as AgentRuntime;
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual(['agentId', 'execute', 'orgId', 'query', 'runId']);
    expect(facade).toMatchObject({ orgId: orgA, agentId, runId: result.runId });
    const expected = { actor: { type: 'agent', agentId, runId: result.runId }, orgId: orgA, positionId };
    expect(answers).toEqual([expected, expected]);
  });
});
